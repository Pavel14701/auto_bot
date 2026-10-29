"""Лента объявлений для Mini App (этап 5, ТЗ п. 9.2.4–9.2.5).

Тонкий транспорт: разбор query-параметров, вызов сценария и маппинг в
Pydantic-схемы. Фильтрация, keyset-пагинация, `count(*)` только в
offset-режиме, best-effort enrichment и analytics — в
`app.application.listings.use_cases`; SQL — в репозитории чтения
объявлений (`infrastructure/db/repositories/listings_read`).
"""


from __future__ import annotations
from app.transport.http.deps.dishka import DishkaRoute

import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Path, Query, status
from pydantic import BaseModel

from app.application.catalog.dto import (
    InspectionUpdate,
    ListingFeedQuery,
)
from app.application.errors import (
    AppError,
    Conflict,
    Forbidden,
    InvalidInput,
    NotFound,
)
from app.application.listings.use_cases import normalize_url
from app.transport.http.deps.auth import CurrentUserDep
from app.transport.http.deps.internal import RedisDep
from app.transport.http.deps.use_cases import (
    BuildHistoryReportDep,
    GetInspectionDep,
    GetListingByUrlDep,
    GetListingDep,
    ListListingFacetsDep,
    ListListingsDep,
    UpsertInspectionDep,
)
from app.transport.http.schemas.listing import (
    InspectionReportIn,
    InspectionReportOut,
    ListingListOut,
    ListingOut,
    PricePointOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(route_class=DishkaRoute, prefix="/api/listings", tags=["listings"])

_FACETS_CACHE_TTL_SEC = 300
_STATUS_BY_ERROR = (
    (NotFound, status.HTTP_404_NOT_FOUND),
    (Forbidden, status.HTTP_403_FORBIDDEN),
    (Conflict, status.HTTP_409_CONFLICT),
    (InvalidInput, 422),
)

# Обратная совместимость: тесты и бот импортируют `_norm_url` из роутера.
_norm_url = normalize_url


def _to_http(exc: AppError) -> HTTPException:
    """Перевести прикладную ошибку в HTTP-статус с публичным текстом."""
    for error_type, code in _STATUS_BY_ERROR:
        if isinstance(exc, error_type):
            return HTTPException(status_code=code, detail=exc.public_message)
    return HTTPException(status_code=400, detail=exc.public_message)


# ---------------------------------------------------------------------------
# Лента с фильтрами
# ---------------------------------------------------------------------------


@router.get("", response_model=ListingListOut)
async def list_listings(
    use_case: ListListingsDep,
    make: str | None = None,
    model: str | None = None,
    year_from: int | None = Query(default=None, ge=1900),
    year_to: int | None = Query(default=None, ge=1900),
    price_min: float | None = Query(default=None, ge=0),
    price_max: float | None = Query(default=None, ge=0),
    currency: str | None = None,
    mileage_min: int | None = Query(default=None, ge=0),
    mileage_max: int | None = Query(default=None, ge=0),
    body_type: str | None = None,
    fuel: str | None = None,
    transmission: str | None = None,
    drive: str | None = None,
    engine_volume_min: float | None = Query(default=None, ge=0, le=20),
    engine_volume_max: float | None = Query(default=None, ge=0, le=20),
    color: str | None = None,
    source: str | None = None,
    country: str | None = Query(
        default=None, pattern="^[A-Za-z]{2}$", description="ISO-3166 alpha-2"
    ),
    cursor: str | None = None,
    sort: str = Query(
        default="new",
        pattern="^(new|price_asc|price_desc|mileage_asc|year_desc)$",
    ),
    limit: int = Query(default=20, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
) -> ListingListOut:
    """Лента с фильтрами и сортировкой (offset или keyset-курсор).

    `cursor` работает только с `sort=new`; в keyset-запросе `total` = 0 и
    `count(*)` не выполняется. Контракт `total`/`items`/`next_cursor`/
    `has_more` не меняется. `country` (GEO-V1 §2) — точный ISO-2: чипсы
    «Корея/Китай/ОАЭ/США/Казахстан», одна страна без CSV.
    """
    try:
        page = await use_case.execute(
            ListingFeedQuery(
                make=make,
                model=model,
                year_from=year_from,
                year_to=year_to,
                price_min=price_min,
                price_max=price_max,
                currency=currency,
                mileage_min=mileage_min,
                mileage_max=mileage_max,
                body_type=body_type,
                fuel=fuel,
                transmission=transmission,
                drive=drive,
                engine_volume_min=engine_volume_min,
                engine_volume_max=engine_volume_max,
                color=color,
                source=source,
                country=country,
                cursor=cursor,
                sort=sort,
                limit=limit,
                offset=offset,
            )
        )
    except AppError as exc:
        raise _to_http(exc) from exc

    return ListingListOut(
        total=page.total,
        items=[ListingOut.model_validate(card) for card in page.items],
        next_cursor=page.next_cursor,
        has_more=page.has_more,
    )


# ---------------------------------------------------------------------------
# Facets (справочник для зависимых селектов)
# ---------------------------------------------------------------------------


@router.get("/facets")
async def listing_facets(
    redis: RedisDep,
    use_case: ListListingFacetsDep,
    make: str | None = Query(
        default=None, max_length=64, pattern=r"^[^\n\r]*$"
    ),
    country: str | None = Query(
        default=None, pattern="^[A-Za-z]{2}$", description="ISO-3166 alpha-2"
    ),
) -> dict[str, list[str]]:
    """Справочник для селектов фильтров (марки / модели марки / страны).

    Кэш в Redis на 5 минут; `is_active` — только по актуальным объявлениям.
    `countries` (GEO-V1 §2) — distinct страны по активным листингам, частые
    первыми; `country` сужает марки/модели до страны. Ключ `facets:v2:…` —
    форма ответа изменилась (добавлен `countries`).
    """
    if make:
        cache_key = f"facets:v2:models:{make.strip().lower()}"
    else:
        cache_key = "facets:v2:makes"
    if country:
        cache_key += f":{country.upper()}"

    try:
        cached = await redis.get(cache_key)
        if cached is not None:
            return json.loads(cached)
    except Exception:  # noqa: BLE001 — кэш не критичен
        logger.warning("facets_cache_get_failed", exc_info=True)

    result = await use_case.execute(make, country=country)

    try:
        await redis.setex(cache_key, _FACETS_CACHE_TTL_SEC, json.dumps(result))
    except Exception:  # noqa: BLE001 — кэш не критичен
        logger.warning("facets_cache_set_failed", exc_info=True)

    return result


# ---------------------------------------------------------------------------
# By URL (бот: «скинь ссылку, покажу карточку»)
# ---------------------------------------------------------------------------


@router.get("/by-url", response_model=ListingOut)
async def get_listing_by_url(
    use_case: GetListingByUrlDep,
    url: str = Query(min_length=8, max_length=512),
) -> ListingOut:
    """Объявление по ссылке (0 совпадений → 404, >1 → 409)."""
    try:
        card = await use_case.execute(url)
    except AppError as exc:
        raise _to_http(exc) from exc
    return ListingOut.model_validate(card)


# ---------------------------------------------------------------------------
# PDP (карточка)
# ---------------------------------------------------------------------------


@router.get("/{listing_id}", response_model=ListingOut)
async def get_listing(
    use_case: GetListingDep,
    listing_id: int = Path(ge=1),
) -> ListingOut:
    """Карточка объявления (PDP) с историей цен."""
    try:
        detail = await use_case.execute(listing_id)
    except AppError as exc:
        raise _to_http(exc) from exc

    out = ListingOut.model_validate(detail.card)
    out.price_history = [
        PricePointOut(
            price=float(point.price),
            currency=point.currency,
            recorded_at=point.recorded_at,
        )
        for point in detail.price_history
    ]
    return out


# ---------------------------------------------------------------------------
# Осмотр (карта повреждений + чек-лист)
# ---------------------------------------------------------------------------


@router.get("/{listing_id}/inspection", response_model=InspectionReportOut)
async def get_inspection(
    user: CurrentUserDep,
    use_case: GetInspectionDep,
    listing_id: int = Path(ge=1),
) -> InspectionReportOut:
    """Отчёт осмотра для PDP.

    Чеки — платные данные: Free получает 403 (приглашение к Pro),
    админ видит всегда. 404 — осмотра нет или объявление неактивно.
    """
    try:
        view = await use_case.execute(
            listing_id,
            user_id=user.telegram_id,
            is_admin=getattr(user, "role", None) == "admin",
        )
    except AppError as exc:
        raise _to_http(exc) from exc
    return InspectionReportOut.model_validate(view)


@router.put("/{listing_id}/inspection", response_model=InspectionReportOut)
async def upsert_inspection(
    payload: InspectionReportIn,
    user: CurrentUserDep,
    use_case: UpsertInspectionDep,
    listing_id: int = Path(ge=1),
) -> InspectionReportOut:
    """Создать/заменить отчёт осмотра. Только admin (ручной осмотр).

    Admin может осматривать и неактивные объявления.
    """
    if getattr(user, "role", None) != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin only"
        )

    try:
        view = await use_case.execute(
            listing_id,
            InspectionUpdate(
                source=payload.source,
                inspector=payload.inspector,
                inspected_at=payload.inspected_at,
                grade=payload.grade,
                summary=payload.summary,
                marks=[mark.model_dump() for mark in payload.marks],
                items=[item.model_dump() for item in payload.items],
                images=list(payload.images),
            ),
        )
    except AppError as exc:
        raise _to_http(exc) from exc

    logger.info(
        "inspection_upserted listing_id=%s user_id=%s grade=%s",
        listing_id, user.telegram_id, view.grade,
    )
    return InspectionReportOut.model_validate(view)


# ---------------------------------------------------------------------------
# AI-отчёт истории (12 §1): факты ДТП/владельцев + LLM-вывод
# ---------------------------------------------------------------------------


class HistoryReportOut(BaseModel):
    """Отчёт истории лота: факты + абзац-вывод LLM (12 §1)."""

    listing_id: int
    facts: dict[str, Any]
    llm_summary: str | None = None
    generated_at: str


@router.get("/{listing_id}/history-report", response_model=HistoryReportOut)
async def get_history_report(
    user: CurrentUserDep,
    use_case: BuildHistoryReportDep,
    listing_id: int = Path(ge=1),
) -> HistoryReportOut:
    """Отчёт истории лота (VIN/лот → русский отчёт, 12 §1).

    Гость — 403 (как AI-анализ). Факты: ДТП из чека осмотра (счётчик +
    последнее ДТП из record/open), владельцы, пробег подтверждён, чек-лист;
    сверху — LLM-абзац «стоит ли смотреть». Данных нет — 404
    no_history_data. Готовый отчёт кэшируется в Redis на 24 часа.
    """
    try:
        view = await use_case.execute(user.telegram_id, listing_id)
    except AppError as exc:
        raise _to_http(exc) from exc
    return HistoryReportOut(
        listing_id=view.listing_id,
        facts=view.facts,
        llm_summary=view.llm_summary,
        generated_at=view.generated_at,
    )
