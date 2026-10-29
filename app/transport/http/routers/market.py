"""Внутренний рынок: витрина, лоты юзеров, размещения партнёров (§5-§6).

Три контура:
- `market_router` — витрина (JWT) + лоты юзера с размещением по правилам
  §3 редизайна части 6 (free-период / включённый / Stars);
- `partner_router` — витрина, размещения (пакеты слотов) и чаты счёта
  по X-API-Key. Живут в chat-сервисе: gateway заводит /api/market,
  /api/partner/market, /api/partner/offers и /api/partner/chats в chat,
  остальной /api/partner — в partners.
"""

from __future__ import annotations

from app.transport.http.deps.dishka import DishkaRoute, InternalDishkaRoute

import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from dishka.integrations.fastapi import FromDishka
from fastapi import (
    APIRouter,
    File,
    HTTPException,
    Path,
    Query,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field, field_validator

from app.application.catalog.dto import InspectionUpdate
from app.application.chat.dto import ParticipantRef, ThreadView
from app.application.dialog.use_cases import AiUnavailable
from app.application.errors import AppError
from app.application.market.description import (
    DescriptionCommand,
    DescriptionLimitExceeded,
)
from app.application.market.dto import (
    CreateLotCommand,
    LotPatch,
    MarketLotSnapshot,
    MarketOfferView,
    MyLotView,
)
from app.application.market.photos import MAX_PHOTO_BYTES
from app.application.shared.ports import CachePort
from app.config import get_settings
from app.transport.http.deps.partner import (
    PartnerAuthDep,
    RateLimitDep,
    enforce_rate_limit,
)
from app.transport.http.deps.use_cases import (
    AddMarketOfferDep,
    BuyPackageDep,
    CloseMarketLotDep,
    ClosePartnerLotDep,
    CreateMarketLotDep,
    CreatePartnerLotDep,
    ExtendLotDep,
    GenerateDescriptionDep,
    GetOnlineUsersDep,
    GetPartnerInspectionDep,
    IssueWsTokenDep,
    JoinByCodeDep,
    ListMarketOffersDep,
    ListMarketLotsDep,
    ListMessagesDep,
    ListModerationQueueDep,
    ListMyLotsDep,
    ListPackagesDep,
    ListPartnerLotsDep,
    ListPartnerOffersDep,
    ListPartnerThreadsDep,
    MarkReadDep,
    ModerateLotDep,
    ModeratePatchDep,
    RemoveMarketOfferDep,
    ReportThreadDep,
    SendTypingDep,
    SendMessageDep,
    SubmitLotDep,
    SummarizeThreadDep,
    UpdateLotDep,
    UpdatePartnerLotHistoryDep,
    UploadMarketPhotoDep,
    UpsertPartnerInspectionDep,
)
from app.transport.http.deps.auth import CurrentUserDep
from app.transport.http.routers.chats import (
    IdempotencyKeyHeader,
    JoinIn,
    JoinOut,
    MessageIn,
    MessageOut,
    ReadIn,
    ReportIn,
    ThreadOut,
    WsTokenOut,
    _enforce_message_rate_limit,
    _enforce_typing_rate_limit,
    _message_out,
    _norm_idempotency_key,
    _parse_online_ids,
    _raise_app_error,
    _reject_guest,
    _remember_idempotent,
    _replayed_message,
    _thread_out,
)
from app.transport.http.routers.payments import _create_invoice_link
from app.transport.http.schemas.listing import (
    InspectionReportIn,
    InspectionReportOut,
)

logger = logging.getLogger(__name__)

PartnerThreadIdPath = Annotated[UUID, Path()]

# Коды ошибок сценариев → HTTP (как chats.py + 402 для баланса партнёра;
# 413/415 — фото: размер и тип файла, 07 §1).
_STATUS_BY_CODE = {
    "not_found": status.HTTP_404_NOT_FOUND,
    "forbidden": status.HTTP_403_FORBIDDEN,
    "conflict": status.HTTP_409_CONFLICT,
    "invalid_input": status.HTTP_400_BAD_REQUEST,
    "payment_required": status.HTTP_402_PAYMENT_REQUIRED,
    "file_too_large": status.HTTP_413_CONTENT_TOO_LARGE,
    "unsupported_media_type": status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
    # Хранилище выключено/лежит: 503 с внятным кодом вместо 500 (07 §1).
    "photos_unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
}


def _raise_market_error(exc: AppError) -> None:
    """Прикладная ошибка рынка → HTTPException (402 для баланса)."""
    raise HTTPException(
        _STATUS_BY_CODE.get(exc.code, status.HTTP_400_BAD_REQUEST),
        exc.public_message,
    ) from exc


class MarketOfferOut(BaseModel):
    """Лот витрины: листинг-карточка + note + бейдж рынка."""

    listing_id: int
    partner_id: int
    note: str | None = None
    make: str | None = None
    model: str | None = None
    year: int | None = None
    price: float | None = None
    currency: str | None = None
    mileage_km: int | None = None
    url: str | None = None
    image: str | None = None
    has_market: bool = True


class OfferIn(BaseModel):
    """Постановка лота в витрину."""

    listing_id: int = Field(ge=1)
    note: str | None = Field(default=None, max_length=500)


class OfferResultOut(BaseModel):
    """Результат постановки/reuse."""

    listing_id: int


def _offer_out(offer: MarketOfferView) -> MarketOfferOut:
    """MarketOfferView → схема ответа."""
    return MarketOfferOut.model_validate(offer, from_attributes=True)


# =========================================================================
# Схемы лотов рынка с владельцем (§2-§3)
# =========================================================================


class MarketLotIn(BaseModel):
    """Форма размещения лота (user и partner, §2)."""

    make: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=64)
    year: int = Field(ge=1900, le=2100)
    price: Decimal = Field(gt=0)
    currency: Literal["KRW", "USD", "RUB"]
    mileage_km: int | None = Field(default=None, ge=0)
    fuel: str | None = Field(default=None, max_length=32)
    transmission: str | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, max_length=2000)
    photos: list[str] = Field(default_factory=list, max_length=10)
    # Гео (GEO-V1 §2): страна продавца — обязательна для owner-лота при
    # создании (enum известных + свобода, ISO-3166 alpha-2); город опционален.
    country: str = Field(pattern=r"^[A-Za-z]{2}$")
    city: str | None = Field(default=None, max_length=64)
    # 10 §4: true = сразу прогнать модерацию (партнёрам — всегда true).
    submit: bool = False

    @field_validator("country")
    @classmethod
    def _country_upper(cls, value: str) -> str:
        """ISO-2 в верхний регистр («ru» → «RU»)."""
        return value.strip().upper()

    @field_validator("city")
    @classmethod
    def _city_trim(cls, value: str | None) -> str | None:
        """Trim города; пустая строка — не передан."""
        return (value or "").strip() or None

    @field_validator("photos")
    @classmethod
    def _photos_https(cls, value: list[str]) -> list[str]:
        """Только http/https-ссылки (фронт грузит их в <img>)."""
        for url in value:
            if not url.startswith("https://"):
                raise ValueError("photo_url_invalid: только http/https-ссылки")
        return value


def _validate_patch_photos(value: list[str] | None) -> list[str] | None:
    """Фото патча: только http/https-ссылки (как в MarketLotIn)."""
    if value is None:
        return None
    for url in value:
        if not url.startswith("https://"):
            raise ValueError("photo_url_invalid: только http/https-ссылки")
    return value


class MarketLotPatchIn(BaseModel):
    """PATCH лота (10 §4): заданы только передаваемые поля.

    draft/rejected обновляются напрямую; accepted → версия-на-модерации
    (pending_patch); moderation/archived/expired → 409.
    """

    make: str | None = Field(default=None, min_length=1, max_length=64)
    model: str | None = Field(default=None, min_length=1, max_length=64)
    year: int | None = Field(default=None, ge=1900, le=2100)
    price: Decimal | None = Field(default=None, gt=0)
    currency: Literal["KRW", "USD", "RUB"] | None = None
    mileage_km: int | None = Field(default=None, ge=0)
    fuel: str | None = Field(default=None, max_length=32)
    transmission: str | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, max_length=2000)
    photos: list[str] | None = Field(default=None, max_length=10)
    # Гео (GEO-V1 §2): страна/город правятся как остальные поля патча
    # (не передано — не меняется).
    country: str | None = Field(default=None, pattern=r"^[A-Za-z]{2}$")
    city: str | None = Field(default=None, max_length=64)

    @field_validator("country")
    @classmethod
    def _country_upper(cls, value: str | None) -> str | None:
        """ISO-2 в верхний регистр (не передано — None)."""
        return value.strip().upper() if value else value

    @field_validator("photos")
    @classmethod
    def _photos_https(cls, value: list[str] | None) -> list[str] | None:
        return _validate_patch_photos(value)


class QualityOut(BaseModel):
    """«Качество объявления» (12 §2): score 0-100 + советы."""

    score: int
    tips: list[str] = Field(default_factory=list)


class CreatedLotOut(BaseModel):
    """Итог размещения: id + placement-статус и статус.lifecycle (§2, 10 §4)."""

    listing_id: int
    placement_status: str
    is_active: bool
    needs_payment: bool = False
    # Статус жизненного цикла (10 §1): draft | accepted | moderation.
    status: str = "draft"
    # Качество объявления по полям формы (12 §2).
    quality: QualityOut | None = None


class SubmitLotOut(BaseModel):
    """Итог submit: вердикт модерации + placement (10 §4)."""

    listing_id: int
    status: str
    placement_status: str
    is_active: bool
    needs_payment: bool = False
    rejected_reason: str | None = None
    violations: list[dict] = Field(default_factory=list)


class MyLotOut(BaseModel):
    """«Мои объявления»: карточка + placement/lifecycle-статусы (§2, 10 §4)."""

    model_config = {"from_attributes": True}

    listing_id: int
    placement_status: str
    is_active: bool
    placement_free_until: datetime | None = None
    placement_paid_until: datetime | None = None
    placement_deadline: datetime | None = None
    make: str | None = None
    model: str | None = None
    year: int | None = None
    price: float | None = None
    currency: str | None = None
    mileage_km: int | None = None
    images: list[str] = Field(default_factory=list)
    url: str | None = None
    owner_description: str | None = None
    # Гео (GEO-V1 §2): страна/город owner-лота (бейдж «🇷🇺 RU · Москва»).
    country: str | None = None
    city: str | None = None
    # Жизненный цикл (10 §1): статус-пилюля, причина отказа, сработавшие
    # правила и патч на проверке (patch_reject_reason при отказе).
    status: str = "accepted"
    rejected_reason: str | None = None
    violations: list[dict] = Field(default_factory=list)
    pending_patch: dict | None = None
    # Качество объявления (12 §2): score + советы my-lots/SellCar.
    quality: QualityOut | None = None


class ModerationQueueItemOut(BaseModel):
    """Строка админ-очереди модерации (10 §2): карточка + вердикт/патч."""

    model_config = {"from_attributes": True}

    listing_id: int
    owner_type: str
    owner_user_id: int | None = None
    owner_partner_id: int | None = None
    status: str
    risk_score: int = 0
    violations: list[dict] = Field(default_factory=list)
    pending_patch: dict | None = None
    make: str | None = None
    model: str | None = None
    year: int | None = None
    price: float | None = None
    currency: str | None = None
    mileage_km: int | None = None
    images: list[str] = Field(default_factory=list)
    owner_description: str | None = None
    created_at: datetime | None = None


class ModerationOutcomeOut(BaseModel):
    """Итог решения администратора (10 §2)."""

    listing_id: int
    status: str
    placement_status: str | None = None
    reason: str | None = None


class ModerationReasonIn(BaseModel):
    """Тело reject-действий админ-модерации: причина (опциональна)."""

    reason: str | None = Field(default=None, max_length=500)


class PackageOut(BaseModel):
    """Пакет размещений: размер + цена (₽) из конфига (§2).

    `slots_free` — только в ответе покупки (остаток мест после списания).
    """

    size: int
    price_rub: float
    slots_free: int | None = None


class PackageIn(BaseModel):
    """Покупка пакета размещений."""

    size: int = Field(gt=0, le=100000)


class ExtendIn(BaseModel):
    """Продление размещения лота: окно 1 или 4 недели (§2)."""

    weeks: Literal[1, 4]


class PlacementInvoiceOut(BaseModel):
    """Инвойс Stars на продление размещения (kind='placement', §2)."""

    payment_id: int
    invoice_url: str
    amount: int  # в Stars
    currency: str = "XTR"
    listing_id: int
    weeks: int


class PhotoOut(BaseModel):
    """Публичный URL загруженного фото лота (07 §1)."""

    url: str


class OwnerHistoryEventIn(BaseModel):
    """Событие истории машины: дата, заголовок, опц. заметка (07 §3)."""

    date: date
    title: str = Field(min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=300)


class OwnerHistoryIn(BaseModel):
    """Замена истории машины своего лота: <=50 событий (07 §3)."""

    events: list[OwnerHistoryEventIn] = Field(max_length=50)


def _my_lot_out(lot: MyLotView) -> MyLotOut:
    """MyLotView → схема ответа (Decimal/tuple приводятся pydantic)."""
    return MyLotOut.model_validate(lot, from_attributes=True)


def _moderation_item_out(lot: MarketLotSnapshot) -> ModerationQueueItemOut:
    """Снимок лота → строка админ-очереди (риск/нарушения из payload)."""
    payload = lot.moderation_payload or {}
    return ModerationQueueItemOut(
        listing_id=lot.listing_id,
        owner_type=lot.owner_type,
        owner_user_id=lot.owner_user_id,
        owner_partner_id=lot.owner_partner_id,
        status=lot.status,
        risk_score=int(payload.get("risk_score") or 0),
        violations=list(payload.get("violations") or []),
        pending_patch=dict(lot.pending_patch) if lot.pending_patch else None,
        make=lot.make,
        model=lot.model,
        year=lot.year,
        price=float(lot.price) if lot.price is not None else None,
        currency=lot.currency,
        mileage_km=lot.mileage_km,
        images=list(lot.images),
        owner_description=lot.owner_description,
        created_at=lot.created_at,
    )


# =========================================================================
# Витрина для пользователей: /api/market
# =========================================================================

market_router = APIRouter(
    route_class=DishkaRoute, prefix="/api/market", tags=["market"]
)


@market_router.get("/offers", response_model=list[MarketOfferOut])
async def market_offers(
    user: CurrentUserDep,
    use_case: ListMarketOffersDep,
    make: str | None = Query(default=None, max_length=64),
    price_max: Decimal | None = Query(default=None, gt=0),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[MarketOfferOut]:
    """Лента витрины: карточки лотов + partner note + has_market (§5)."""
    offers = await use_case.execute(make=make, price_max=price_max, limit=limit)
    return [_offer_out(offer) for offer in offers]


@market_router.post(
    "/photos", response_model=PhotoOut, status_code=status.HTTP_201_CREATED
)
async def upload_market_photo(
    user: CurrentUserDep,
    use_case: UploadMarketPhotoDep,
    file: UploadFile = File(...),
) -> PhotoOut:
    """Загрузить фото лота (07 §1): multipart, <=8 МБ, JPEG/PNG/WebP.

    Тип проверяется по магическим байтам (content-type из multipart не
    доверяем); файл уходит в публичный bucket MinIO, ответ — готовый URL
    для <img>. Гость — 403 (размещение после входа, как /lots).
    """
    _reject_guest(user.telegram_id)
    # Ранний отсев по content-length парта (UploadFile.size): гигабайтный
    # файл не читается в память целиком — лимит фактических байтов
    # ниже проверяет сценарий (заголовку не доверяем).
    if file.size is not None and file.size > MAX_PHOTO_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            "file_too_large: файл больше 8 МБ",
        )
    content = await file.read()
    try:
        url = await use_case.execute(user.telegram_id, content)
    except AppError as exc:
        _raise_market_error(exc)
    return PhotoOut(url=url)


class DescriptionIn(BaseModel):
    """Поля черновика SellCar для генерации описания (12 §2)."""

    make: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=64)
    year: int = Field(ge=1900, le=2100)
    price: Decimal | None = Field(default=None, gt=0)
    currency: str | None = Field(default=None, max_length=8)
    mileage_km: int | None = Field(default=None, ge=0)
    fuel: str | None = Field(default=None, max_length=32)
    transmission: str | None = Field(default=None, max_length=32)
    photos_count: int = Field(default=0, ge=0, le=10)


@market_router.post("/description")
async def generate_description(
    body: DescriptionIn,
    user: CurrentUserDep,
    use_case: GenerateDescriptionDep,
) -> dict[str, str]:
    """Сгенерировать продающее описание лота (12 §2).

    Продающий текст 400-800 знаков на русском строго из полей входа
    (промпт-гварды: без выдуманных фактов, обещаний и гарантий). Лимит
    free-тарифа — 5 генераций в день; сверх — 429 ai_generation_limit.
    Гость — 403 (как размещение лотов). LLM не настроена — 503.
    """
    _reject_guest(user.telegram_id)
    try:
        text = await use_case.execute(
            user.telegram_id,
            DescriptionCommand(
                make=body.make.strip(),
                model=body.model.strip(),
                year=body.year,
                price=body.price,
                currency=body.currency,
                mileage_km=body.mileage_km,
                fuel=body.fuel,
                transmission=body.transmission,
                photos_count=body.photos_count,
            ),
        )
    except DescriptionLimitExceeded as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, exc.public_message
        ) from exc
    except AiUnavailable as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, exc.public_message
        ) from exc
    except AppError as exc:
        _raise_market_error(exc)
    return {"text": text}


# =========================================================================
# Лоты юзера: размещение / мои объявления / продление (§2-§3, JWT)
# =========================================================================


@market_router.post(
    "/lots", response_model=CreatedLotOut, status_code=status.HTTP_201_CREATED
)
async def create_market_lot(
    body: MarketLotIn,
    user: CurrentUserDep,
    use_case: CreateMarketLotDep,
) -> CreatedLotOut:
    """Создать лот: черновик по умолчанию, submit=true — сразу модерация
    (10 §4; гость — 403).

    Черновик не виден в ленте и не запускает placement; submit=true
    прогоняет авто-модерацию синхронно: accept → placement-правила §3
    (первый лот free/included, доп. — needs_payment), reject/manual —
    статус в ответе.
    """
    try:
        result = await use_case.execute(
            user.telegram_id,
            CreateLotCommand(
                make=body.make.strip(),
                model=body.model.strip(),
                year=body.year,
                price=body.price,
                currency=body.currency,
                mileage_km=body.mileage_km,
                fuel=body.fuel,
                transmission=body.transmission,
                description=body.description,
                photos=tuple(body.photos),
                country=body.country,
                city=body.city,
            ),
            submit=body.submit,
        )
    except AppError as exc:
        _raise_market_error(exc)
    return CreatedLotOut(
        listing_id=result.listing_id,
        placement_status=result.placement_status,
        is_active=result.is_active,
        needs_payment=result.needs_payment,
        status=result.status,
        quality=result.quality,
    )


@market_router.post(
    "/lots/{listing_id}/submit", response_model=SubmitLotOut
)
async def submit_market_lot(
    user: CurrentUserDep,
    use_case: SubmitLotDep,
    listing_id: int = Path(ge=1),
) -> SubmitLotOut:
    """Отправить лот на публикацию: draft/rejected → модерация (10 §4).

    Вердикт выносится синхронно (правила быстрые): accepted (placement-
    правила применяются здесь), moderation (ждёт админа) или rejected
    (причина + сработавшие правила). Повторный submit возможен после
    исправления отклонённого лота (rejected → moderation).
    """
    try:
        result = await use_case.execute(user.telegram_id, listing_id)
    except AppError as exc:
        _raise_market_error(exc)
    return SubmitLotOut(
        listing_id=result.listing_id,
        status=result.status,
        placement_status=result.placement_status,
        is_active=result.is_active,
        needs_payment=result.needs_payment,
        rejected_reason=result.rejected_reason,
        violations=list(result.violations),
    )


@market_router.patch("/lots/{listing_id}", response_model=MyLotOut)
async def update_market_lot(
    body: MarketLotPatchIn,
    user: CurrentUserDep,
    use_case: UpdateLotDep,
    listing_id: int = Path(ge=1),
) -> MyLotOut:
    """Правка лота с версионностью (10 §1, §4).

    draft/rejected — прямое обновление; accepted — патч уходит в
    pending_patch (лента показывает старые данные до решения админа);
    moderation/archived/expired — 409 invalid_state.
    """
    provided = body.model_dump(exclude_unset=True)
    patch = LotPatch(
        make=provided.get("make"),
        model=provided.get("model"),
        year=provided.get("year"),
        price=provided.get("price"),
        currency=provided.get("currency"),
        mileage_km=provided.get("mileage_km"),
        fuel=provided.get("fuel"),
        transmission=provided.get("transmission"),
        description=provided.get("description"),
        photos=tuple(provided["photos"]) if "photos" in provided else None,
        country=provided.get("country"),
        city=provided.get("city"),
    )
    try:
        view = await use_case.execute(user.telegram_id, listing_id, patch)
    except AppError as exc:
        _raise_market_error(exc)
    return _my_lot_out(view)


@market_router.get("/lots", response_model=list[MyLotOut])
async def market_lots(
    user: CurrentUserDep,
    use_case: ListMarketLotsDep,
    country: str | None = Query(
        default=None, pattern="^[A-Za-z]{2}$", description="ISO-3166 alpha-2"
    ),
    limit: int = Query(default=60, ge=1, le=100),
) -> list[MyLotOut]:
    """Витрина опубликованных лотов рынка (GEO-V1 §2).

    Активные accepted owner-лоты; `country` — фильтр чипсов стран сверху
    (точный ISO-2). Черновики/модерация/отклонённые не видны.
    """
    lots = await use_case.execute(
        country=country.strip().upper() if country else None, limit=limit
    )
    return [_my_lot_out(lot) for lot in lots]


@market_router.get("/my-lots", response_model=list[MyLotOut])
async def my_lots(
    user: CurrentUserDep, use_case: ListMyLotsDep
) -> list[MyLotOut]:
    """Мои объявления: карточка + placement-статус и дедлайны (§2)."""
    lots = await use_case.execute(user.telegram_id)
    return [_my_lot_out(lot) for lot in lots]


@market_router.delete("/lots/{listing_id}")
async def close_market_lot(
    user: CurrentUserDep,
    use_case: CloseMarketLotDep,
    listing_id: int = Path(ge=1),
) -> dict[str, bool]:
    """Снять лот с продажи (is_active=false); чужой/несуществующий → 404."""
    if not await use_case.execute(user.telegram_id, listing_id):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "lot_not_found: лот не найден"
        )
    return {"removed": True}


@market_router.post(
    "/lots/{listing_id}/extend", response_model=PlacementInvoiceOut
)
async def extend_market_lot(
    body: ExtendIn,
    user: CurrentUserDep,
    use_case: ExtendLotDep,
    listing_id: int = Path(ge=1),
) -> PlacementInvoiceOut:
    """Инвойс Stars на продление размещения (kind='placement', §2).

    Как подписки: pending-платёж → createInvoiceLink; вебхук продлевает
    `placement_paid_until` (ConfirmPayment), повторная доставка —
    идемпотентна.
    """
    settings = get_settings()
    if not settings.bot_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bot token is not configured",
        )
    try:
        draft = await use_case.execute(
            user.telegram_id, listing_id, body.weeks
        )
    except AppError as exc:
        _raise_market_error(exc)
    url = await _create_invoice_link(
        bot_token=settings.bot_token.get_secret_value(),
        payload=f"plc:{draft.payment_id}",
        title="Продление объявления",
        description=f"Размещение объявления на {draft.weeks} нед.",
        amount=draft.amount,
    )
    return PlacementInvoiceOut(
        payment_id=draft.payment_id,
        invoice_url=url,
        amount=draft.amount,
        listing_id=draft.listing_id,
        weeks=draft.weeks,
    )


# =========================================================================
# Партнёрский контур витрины и чатов: /api/partner (X-API-Key)
# =========================================================================

partner_router = APIRouter(
    route_class=DishkaRoute, prefix="/api/partner", tags=["market-partner"]
)


@partner_router.get("/offers", response_model=list[MarketOfferOut])
async def partner_offers(
    auth: PartnerAuthDep,
    use_case: ListPartnerOffersDep,
    rate: RateLimitDep,
) -> list[MarketOfferOut]:
    """Витрина своего счёта (мои лоты + заметки)."""
    await enforce_rate_limit(rate, auth.partner_id)
    offers = await use_case.execute(auth.partner_id)
    return [_offer_out(offer) for offer in offers]


@partner_router.post("/offers", response_model=OfferResultOut)
async def add_partner_offer(
    body: OfferIn,
    auth: PartnerAuthDep,
    use_case: AddMarketOfferDep,
    rate: RateLimitDep,
    response: Response,
) -> OfferResultOut:
    """Выставить лот (201) или обновить свою заметку (200); чужой — 409."""
    await enforce_rate_limit(rate, auth.partner_id)
    try:
        created = await use_case.execute(
            auth.partner_id, body.listing_id, body.note
        )
    except AppError as exc:
        _raise_app_error(exc)
    response.status_code = (
        status.HTTP_201_CREATED if created else status.HTTP_200_OK
    )
    return OfferResultOut(listing_id=body.listing_id)


@partner_router.delete("/offers/{listing_id}")
async def remove_partner_offer(
    auth: PartnerAuthDep,
    use_case: RemoveMarketOfferDep,
    rate: RateLimitDep,
    listing_id: int = Path(ge=1),
) -> dict[str, bool]:
    """Снять свой лот с витрины (чужой/несуществующий → 404)."""
    await enforce_rate_limit(rate, auth.partner_id)
    if not await use_case.execute(auth.partner_id, listing_id):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "offer_not_found: лот не в вашей витрине"
        )
    return {"removed": True}


@partner_router.get("/chats", response_model=list[ThreadOut])
async def partner_chats(
    auth: PartnerAuthDep,
    use_case: ListPartnerThreadsDep,
    rate: RateLimitDep,
) -> list[ThreadOut]:
    """Seller/deal-треды счёта с unread по участнику-партнёру (§5)."""
    await enforce_rate_limit(rate, auth.partner_id)
    views: list[ThreadView] = await use_case.execute(auth.partner_id)
    return [_thread_out(view) for view in views]


@partner_router.get("/chats/ws-token", response_model=WsTokenOut)
async def partner_ws_token(
    auth: PartnerAuthDep, use_case: IssueWsTokenDep, rate: RateLimitDep
) -> WsTokenOut:
    """Браузерный JWT кабинета: sub=partner:{id}, exp=+12ч (§4)."""
    await enforce_rate_limit(rate, auth.partner_id)
    view = await use_case.execute(f"partner:{auth.partner_id}")
    return WsTokenOut(token=view.token, url=view.url)


@partner_router.get("/chats/online")
async def partner_chats_online(
    auth: PartnerAuthDep,
    use_case: GetOnlineUsersDep,
    rate: RateLimitDep,
    ids: str = Query(min_length=1, max_length=600),
) -> dict[str, list[int]]:
    """Онлайн-статусы юзеров комнаты (09 §1): presence user:{tg_id}.

    Кабинет спрашивает тех же юзеров, что и мини-апп (личные каналы
    user:{id} общие для обоих контуров).
    """
    await enforce_rate_limit(rate, auth.partner_id)
    return {"online": await use_case.execute(_parse_online_ids(ids))}


@partner_router.post("/chats/{thread_id}/typing")
async def partner_send_typing(
    auth: PartnerAuthDep,
    use_case: SendTypingDep,
    rate: RateLimitDep,
    cache: FromDishka[CachePort],
    thread_id: PartnerThreadIdPath,
) -> dict[str, bool]:
    """«Печатает» от партнёра (зеркало /api/chats/{id}/typing, 09 §1).

    `user_type='partner'` в payload; доставляется ДРУГИМ участникам
    (юзеру-владельцу треда и остальным), себе — нет. Rate 1/2с.
    """
    await enforce_rate_limit(rate, auth.partner_id)
    sender = _partner_ref(auth.partner_id)
    await _enforce_typing_rate_limit(cache, thread_id, sender)
    try:
        await use_case.execute(thread_id, sender)
    except AppError as exc:
        _raise_app_error(exc)
    return {"typing": True}


@partner_router.get(
    "/chats/{thread_id}/messages", response_model=list[MessageOut]
)
async def partner_list_messages(
    auth: PartnerAuthDep,
    use_case: ListMessagesDep,
    rate: RateLimitDep,
    thread_id: PartnerThreadIdPath,
    before_id: int | None = Query(default=None, ge=1),
    after_id: int | None = Query(default=None, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
) -> list[MessageOut]:
    """Сообщения треда счёта (участие проверяет сценарий)."""
    await enforce_rate_limit(rate, auth.partner_id)
    ref = _partner_ref(auth.partner_id)
    try:
        messages = await use_case.execute(
            thread_id, ref, before_id=before_id, after_id=after_id, limit=limit
        )
    except AppError as exc:
        _raise_app_error(exc)
    return [_message_out(m) for m in messages]


@partner_router.post(
    "/chats/{thread_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def partner_send_message(
    body: MessageIn,
    auth: PartnerAuthDep,
    use_case: SendMessageDep,
    list_messages: ListMessagesDep,
    rate: RateLimitDep,
    cache: FromDishka[CachePort],
    response: Response,
    thread_id: PartnerThreadIdPath,
    idempotency_key: IdempotencyKeyHeader = None,
) -> MessageOut:
    """Сообщение партнёра в тред своего лота/лида (§5).

    `Idempotency-Key` (необязательный, долг №7): повтор запроса с тем же
    ключом возвращает сохранённое сообщение (200) без новой записи и
    повторной публикации в centrifugo.

    Антифрод (08 §4): 20 сообщений/мин на (партнёр, тред) — сверх
    лимита 429 `message_rate_limit` (зеркало юзерского эндпоинта).
    """
    await enforce_rate_limit(rate, auth.partner_id)
    sender = _partner_ref(auth.partner_id)
    key = _norm_idempotency_key(idempotency_key)
    replayed = await _replayed_message(
        list_messages, cache, thread_id, sender, key
    )
    if replayed is not None:
        response.status_code = status.HTTP_200_OK
        return _message_out(replayed)
    await _enforce_message_rate_limit(cache, thread_id, sender)
    try:
        message = await use_case.execute(thread_id, sender, body.body)
    except AppError as exc:
        _raise_app_error(exc)
    await _remember_idempotent(cache, sender, key, message.id)
    return _message_out(message)


@partner_router.post("/chats/{thread_id}/read")
async def partner_mark_read(
    body: ReadIn,
    auth: PartnerAuthDep,
    use_case: MarkReadDep,
    rate: RateLimitDep,
    thread_id: PartnerThreadIdPath,
) -> dict[str, int]:
    """Read-маркер партнёра в треде счёта."""
    await enforce_rate_limit(rate, auth.partner_id)
    try:
        marker = await use_case.execute(
            thread_id, _partner_ref(auth.partner_id), body.last_read_message_id
        )
    except AppError as exc:
        _raise_app_error(exc)
    return {"last_read_message_id": marker}


class ThreadSummaryOut(BaseModel):
    """LLM-выжимка треда для менеджера/партнёра (12 §3)."""

    thread_id: UUID
    summary: str
    last_message_id: int
    generated_at: str


@partner_router.post("/chats/{thread_id}/summary", response_model=ThreadSummaryOut)
async def partner_thread_summary(
    auth: PartnerAuthDep,
    use_case: SummarizeThreadDep,
    rate: RateLimitDep,
    thread_id: PartnerThreadIdPath,
) -> ThreadSummaryOut:
    """LLM-выжимка треда счёта (12 §3): что хочет клиент, обсуждаемые
    лоты, сомнения, следующий шаг (≤600 знаков).

    Доступ — как у partner messages (участие проверяет сценарий, чужой
    тред — 404). Кэш 1 час по последнему сообщению; LLM не настроена —
    503.
    """
    await enforce_rate_limit(rate, auth.partner_id)
    try:
        view = await use_case.execute(thread_id, _partner_ref(auth.partner_id))
    except AiUnavailable as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, exc.public_message
        ) from exc
    except AppError as exc:
        _raise_app_error(exc)
    return ThreadSummaryOut(
        thread_id=view.thread_id,
        summary=view.summary,
        last_message_id=view.last_message_id,
        generated_at=view.generated_at,
    )


@partner_router.post("/chats/join", response_model=JoinOut)
async def partner_join_by_code(
    body: JoinIn,
    response: Response,
    auth: PartnerAuthDep,
    use_case: JoinByCodeDep,
    rate: RateLimitDep,
) -> JoinOut:
    """Партнёр входит в переговорную по коду (зеркало /api/chats/join).

    Участник — partner (та же строка chat_participants, те же лимиты
    до 5 человек); юзер шарит код, партнёр джойнится из кабинета (07 §2).
    """
    await enforce_rate_limit(rate, auth.partner_id)
    try:
        thread_id, joined = await use_case.execute(
            body.code, _partner_ref(auth.partner_id)
        )
    except AppError as exc:
        _raise_app_error(exc)
    response.status_code = (
        status.HTTP_201_CREATED if joined else status.HTTP_200_OK
    )
    return JoinOut(thread_id=thread_id)


@partner_router.post(
    "/chats/{thread_id}/report", status_code=status.HTTP_201_CREATED
)
async def partner_report_thread(
    body: ReportIn,
    auth: PartnerAuthDep,
    use_case: ReportThreadDep,
    rate: RateLimitDep,
    response: Response,
    thread_id: PartnerThreadIdPath,
) -> dict[str, bool]:
    """Жалоба партнёра на тред (зеркало /api/chats/{id}/report, 08 §4).

    Идемпотентна, пока «открыта»: повтор с той же причиной — 200 без
    новой строки (partial unique 0029). Чужой тред — 404.
    """
    await enforce_rate_limit(rate, auth.partner_id)
    try:
        created = await use_case.execute(
            thread_id,
            _partner_ref(auth.partner_id),
            body.reason,
            body.comment,
        )
    except AppError as exc:
        _raise_app_error(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return {"reported": created}


def _partner_ref(partner_id: int) -> ParticipantRef:
    """ParticipantRef партнёра (id счёта)."""
    return ParticipantRef(user_type="partner", user_id=partner_id)


# =========================================================================
# Размещения партнёра: пакеты слотов + лоты (X-API-Key, §2)
# =========================================================================


@partner_router.get(
    "/market/packages",
    response_model=list[PackageOut],
    response_model_exclude_none=True,
)
async def market_packages(
    auth: PartnerAuthDep,
    use_case: ListPackagesDep,
    rate: RateLimitDep,
) -> list[PackageOut]:
    """Пакеты размещений `{size, price_rub}` из конфига (§2)."""
    await enforce_rate_limit(rate, auth.partner_id)
    return [
        PackageOut(size=p.size, price_rub=float(p.price_rub))
        for p in await use_case.execute()
    ]


@partner_router.post(
    "/market/packages",
    response_model=PackageOut,
    status_code=status.HTTP_201_CREATED,
)
async def buy_market_package(
    body: PackageIn,
    auth: PartnerAuthDep,
    use_case: BuyPackageDep,
    rate: RateLimitDep,
) -> PackageOut:
    """Купить пакет со баланса: balance-=price, slots+=size (атомарно).

    Не хватает баланса — 402 `insufficient_balance` (§2).
    """
    await enforce_rate_limit(rate, auth.partner_id)
    try:
        package = await use_case.execute(auth.partner_id, body.size)
    except AppError as exc:
        _raise_market_error(exc)
    return PackageOut(
        size=package.size,
        price_rub=float(package.price_rub),
        slots_free=package.slots_free,
    )


@partner_router.get("/market/lots", response_model=list[MyLotOut])
async def partner_market_lots(
    auth: PartnerAuthDep,
    use_case: ListPartnerLotsDep,
    rate: RateLimitDep,
) -> list[MyLotOut]:
    """Размещения счёта (включая снятые) со placement-статусом slot (§2)."""
    await enforce_rate_limit(rate, auth.partner_id)
    lots = await use_case.execute(auth.partner_id)
    return [_my_lot_out(lot) for lot in lots]


@partner_router.post(
    "/market/lots", response_model=CreatedLotOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_partner_market_lot(
    body: MarketLotIn,
    auth: PartnerAuthDep,
    use_case: CreatePartnerLotDep,
    rate: RateLimitDep,
) -> CreatedLotOut:
    """Разместить лот партнёра за слот (бессрочный, без placement-дат).

    Свободных слотов нет — 409 `placement_slots_exhausted` (§2).
    Submit партнёра автоматический (10 §4): 201 всегда, но 10% лотов
    (сэмплинг контроля качества) уходит в ручную модерацию — статус
    виден в поле `status` ответа.
    """
    await enforce_rate_limit(rate, auth.partner_id)
    try:
        result = await use_case.execute(
            auth.partner_id,
            CreateLotCommand(
                make=body.make.strip(),
                model=body.model.strip(),
                year=body.year,
                price=body.price,
                currency=body.currency,
                mileage_km=body.mileage_km,
                fuel=body.fuel,
                transmission=body.transmission,
                description=body.description,
                photos=tuple(body.photos),
                country=body.country,
                city=body.city,
            ),
        )
    except AppError as exc:
        _raise_market_error(exc)
    return CreatedLotOut(
        listing_id=result.listing_id,
        placement_status=result.placement_status,
        is_active=result.is_active,
        needs_payment=result.needs_payment,
        status=result.status,
        quality=result.quality,
    )


@partner_router.delete("/market/lots/{listing_id}")
async def close_partner_market_lot(
    auth: PartnerAuthDep,
    use_case: ClosePartnerLotDep,
    rate: RateLimitDep,
    listing_id: int = Path(ge=1),
) -> dict[str, bool]:
    """Снять размещение (слот не возвращается); чужой → 404 (§2)."""
    await enforce_rate_limit(rate, auth.partner_id)
    if not await use_case.execute(auth.partner_id, listing_id):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "lot_not_found: лот не найден"
        )
    return {"removed": True}


# =========================================================================
# Партнёрские чеки и история машины (07 §3): свои лоты по owner_partner_id
# =========================================================================


@partner_router.get(
    "/listings/{listing_id}/inspection", response_model=InspectionReportOut
)
async def partner_get_inspection(
    auth: PartnerAuthDep,
    use_case: GetPartnerInspectionDep,
    rate: RateLimitDep,
    listing_id: int = Path(ge=1),
) -> InspectionReportOut:
    """Чек осмотра своего лота для кабинета (без тарифного гейта).

    Чужой/несуществующий лот — 404 (неотличимы); чека нет — тоже 404.
    """
    await enforce_rate_limit(rate, auth.partner_id)
    try:
        view = await use_case.execute(auth.partner_id, listing_id)
    except AppError as exc:
        _raise_market_error(exc)
    return InspectionReportOut.model_validate(view)


@partner_router.put(
    "/listings/{listing_id}/inspection", response_model=InspectionReportOut
)
async def partner_upsert_inspection(
    payload: InspectionReportIn,
    auth: PartnerAuthDep,
    use_case: UpsertPartnerInspectionDep,
    rate: RateLimitDep,
    listing_id: int = Path(ge=1),
) -> InspectionReportOut:
    """Создать/заменить чек своего лота (тело = admin InspectionReportIn).

    `source` форсируется в 'partner' независимо от поля тела (аудит
    происхождения). Право владения проверяет сценарий: чужой лот — 404.
    """
    await enforce_rate_limit(rate, auth.partner_id)
    try:
        view = await use_case.execute(
            auth.partner_id,
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
        _raise_market_error(exc)
    return InspectionReportOut.model_validate(view)


@partner_router.put("/listings/{listing_id}/history")
async def partner_update_history(
    body: OwnerHistoryIn,
    auth: PartnerAuthDep,
    use_case: UpdatePartnerLotHistoryDep,
    rate: RateLimitDep,
    listing_id: int = Path(ge=1),
) -> dict[str, bool]:
    """Заменить историю машины своего лота (события <=50, 07 §3).

    Сохраняется сортировка по дате убыванием; чтение — открытым PDP
    (`GET /api/listings/{id}` → ListingOut.owner_history).
    """
    await enforce_rate_limit(rate, auth.partner_id)
    events = [event.model_dump(mode="json") for event in body.events]
    try:
        await use_case.execute(auth.partner_id, listing_id, events)
    except AppError as exc:
        _raise_market_error(exc)
    return {"updated": True}


# =========================================================================
# Админ-модерация: /api/admin/moderation (X-Internal-Token, 10 §2)
# =========================================================================


admin_router = APIRouter(
    route_class=InternalDishkaRoute,
    prefix="/api/admin/moderation",
    tags=["admin-moderation"],
)


@admin_router.get("", response_model=list[ModerationQueueItemOut])
async def moderation_queue(
    use_case: ListModerationQueueDep,
    queue: Literal["moderation", "patch"] = Query(default="moderation"),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[ModerationQueueItemOut]:
    """Очередь ручной модерации (10 §2).

    `queue=moderation` — лоты на проверке (риск убыванием, сверху
    рискованные); `queue=patch` — правки опубликованных лотов
    (pending_patch, новые первыми).
    """
    try:
        lots = await use_case.execute(queue, limit=limit)
    except AppError as exc:
        _raise_market_error(exc)
    return [_moderation_item_out(lot) for lot in lots]


@admin_router.post(
    "/{listing_id}/approve", response_model=ModerationOutcomeOut
)
async def moderation_approve_lot(
    use_case: ModerateLotDep, listing_id: int = Path(ge=1)
) -> ModerationOutcomeOut:
    """Одобрить лот из очереди: placement-правила §3 + accepted (10 §2).

    Партнёрскому лоту (сэмплинг) placement не нужен — слот оплачен.
    Решение уходит владельцу событием listing_status в личный канал.
    """
    try:
        outcome = await use_case.execute(listing_id, approve=True)
    except AppError as exc:
        _raise_market_error(exc)
    return ModerationOutcomeOut(
        listing_id=outcome.listing_id,
        status=outcome.status,
        placement_status=outcome.placement_status,
        reason=outcome.reason,
    )


@admin_router.post("/{listing_id}/reject", response_model=ModerationOutcomeOut)
async def moderation_reject_lot(
    body: ModerationReasonIn,
    use_case: ModerateLotDep,
    listing_id: int = Path(ge=1),
) -> ModerationOutcomeOut:
    """Отклонить лот на модерации: rejected + причина (10 §2)."""
    try:
        outcome = await use_case.execute(
            listing_id, approve=False, reason=body.reason
        )
    except AppError as exc:
        _raise_market_error(exc)
    return ModerationOutcomeOut(
        listing_id=outcome.listing_id,
        status=outcome.status,
        placement_status=outcome.placement_status,
        reason=outcome.reason,
    )


@admin_router.post(
    "/{listing_id}/patch_accept", response_model=ModerationOutcomeOut
)
async def moderation_accept_patch(
    use_case: ModeratePatchDep, listing_id: int = Path(ge=1)
) -> ModerationOutcomeOut:
    """Применить версию-на-модерации к опубликованному лоту (10 §1)."""
    try:
        outcome = await use_case.execute(listing_id, accept=True)
    except AppError as exc:
        _raise_market_error(exc)
    return ModerationOutcomeOut(
        listing_id=outcome.listing_id,
        status=outcome.status,
        placement_status=outcome.placement_status,
        reason=outcome.reason,
    )


@admin_router.post(
    "/{listing_id}/patch_reject", response_model=ModerationOutcomeOut
)
async def moderation_reject_patch(
    body: ModerationReasonIn,
    use_case: ModeratePatchDep,
    listing_id: int = Path(ge=1),
) -> ModerationOutcomeOut:
    """Отклонить правки: patch_reject_reason внутри pending_patch (10 §1)."""
    try:
        outcome = await use_case.execute(
            listing_id, accept=False, reason=body.reason
        )
    except AppError as exc:
        _raise_market_error(exc)
    return ModerationOutcomeOut(
        listing_id=outcome.listing_id,
        status=outcome.status,
        placement_status=outcome.placement_status,
        reason=outcome.reason,
    )
