"""Фасад ингеста объявлений (обратная совместимость, PLAN.md, фазы 1–3, 6).

Сам код переехал по слоям:
- правила (хэш, поля, статистика) — `domain/listings/ingestion.py`;
- SQL upsert/история цен/stale — `infrastructure/db/repositories/listings_writer.py`;
- сценарий (дедуп → запись → raw в S3) — `application/listings/ingest.py`.

Здесь остаётся только сборка зависимостей: сессия → писатель, Redis →
гвард дублей, S3Storage → порт объектного хранилища. Воркер и роутеры
продолжают звать `save_listings` / `mark_stale` / `enrich_listing_specs`.
"""

import logging
from datetime import datetime, timezone
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.application.listings.ingest import IngestListings
from app.application.catalog.ports import ObjectStoragePort
from app.domain.listings.ingestion import IngestStats, compute_content_hash
from app.domain.listings.ports import DuplicateGuard
from app.domain.listings.unified import UnifiedListing
from app.infrastructure.db.models import Listing
from app.infrastructure.db.repositories.listings_writer import SqlAlchemyListingsWriter
from app.infrastructure.sources.common.dedup import is_duplicate, raw_payload
from app.infrastructure.sources.common.normalize import (
    normalize_body,
    normalize_color,
    normalize_drive,
    normalize_engine_volume,
    normalize_fuel,
    normalize_transmission,
)

__all__ = [
    "compute_content_hash",
    "enrich_listing_specs",
    "mark_stale",
    "save_listings",
]

logger = logging.getLogger(__name__)


class _RedisDuplicates:
    """Порт `DuplicateGuard`: кросс-дедуп в Redis + пропуск известных пар.

    B-04: лот, уже существующий в БД в своей паре `(source, source_id)`,
    дедупом не отбрасывается — это повторный фетч (апдейт цены/контента,
    `last_seen_at`), а не межисточниковый дубль. `known_pairs` — множество
    пар, предзапрошенное фасадом одним SELECT (см. `_known_pairs`).
    """

    def __init__(self, redis: Redis, known_pairs: frozenset[tuple[str, str]]) -> None:
        self._redis = redis
        self._known_pairs = known_pairs

    async def is_duplicate(self, item: UnifiedListing) -> bool:
        """`True`, если НОВЫЙ лот дублирует другой источник (ключи ставятся)."""
        if (item.source, str(item.source_id)) in self._known_pairs:
            return False  # повторный фетч своей пары — доходит до upsert
        return await is_duplicate(self._redis, item)


async def _known_pairs(
    session: AsyncSession, items: list[UnifiedListing]
) -> frozenset[tuple[str, str]]:
    """Пары `(source, source_id)`, уже существующие в БД (одним запросом).

    Победитель race «инсерт против инсерт» определяется уникальным
    индексом; здесь достаточно read-committed снимка перед дедупом.
    """
    pairs = {(item.source, str(item.source_id)) for item in items}
    if not pairs:
        return frozenset()
    rows = await session.execute(
        select(Listing.source, Listing.source_id).where(
            tuple_(Listing.source, Listing.source_id).in_(pairs)
        )
    )
    return frozenset((row[0], str(row[1])) for row in rows.all())


def _object_storage(storage: Any | None) -> ObjectStoragePort | None:
    """Порт хранилища; `None`, если S3 не сконфигурирован (disabled).

    `S3Storage` реализует `ObjectStoragePort` сам, промежуточная обёртка
    не нужна: raw_payload пишется JSON-объектом по ключу
    `raw/{source}/{yyyy}/{mm}/{id}_{hash}.json`, ошибка put → raw_key NULL.
    """
    if storage is None or not getattr(storage, "enabled", False):
        return None
    return storage


async def _duplicate_guard(
    session: AsyncSession, redis: Redis | None, items: list[UnifiedListing]
) -> DuplicateGuard | None:
    """Гвард межИсточниковых дублей; `None` — проверка не нужна.

    Известные в БД пары `(source, source_id)` передаются гварду сразу:
    повторные фетчи своих лотов дедуп не отбрасывает (B-04), кросс-сурс
    дедуп остаётся только для НОВЫХ лотов.
    """
    if redis is None:
        return None
    return _RedisDuplicates(redis, await _known_pairs(session, items))


def _legacy_stats(stats: IngestStats) -> dict[str, Any]:
    """Плоский dict с id-списками — контракт воркера и тестов (фазы 1–2)."""
    return {
        "new": stats.new,
        "updated": stats.updated,
        "unchanged": stats.unchanged,
        "price_changed": stats.price_changed,
        "reactivated": stats.reactivated,
        "cross_dup": stats.cross_dup,
        "price_changed_ids": list(stats.price_changed_ids),
        "reactivated_ids": list(stats.reactivated_ids),
        "translate_ids": list(stats.translate_ids),
    }


async def save_listings(
    session: AsyncSession,
    redis: Redis | None,
    items: list[UnifiedListing],
    storage: Any | None = None,
) -> dict[str, Any]:
    """Сохраняет объявления с отслеживанием изменений (PLAN.md, фазы 1–2).

    Cross-dup по Redis проверяется ДО записи в БД (B-04: только для НОВЫХ
    лотов — повторный фетч известной пары `(source, source_id)` доходит до
    upsert и обновляет цену/контент/`last_seen_at`). Дальше — CTE-upsert
    одним запросом (старые + новые значения сразу); точка цены пишется
    в listing_price_history при изменении пары (price, currency), для NEW —
    первая точка.

    storage (S3Storage, фаза 6) — raw_payload NEW/изменившихся объявлений
    уходит в MinIO; в listings пишется только ключ (raw_key). Хэш не
    изменился → объект не перезаписываем. Ошибка S3 → raw_key NULL,
    сохранение объявлений не ломается.

    Возвращает счётчики {"new", "updated", "unchanged", "price_changed",
    "reactivated", "cross_dup"} + id-списки "price_changed_ids" /
    "reactivated_ids" (аудитория статусных уведомлений, фаза 3) и
    "translate_ids" — NEW + смена content_hash (триггер повторного
    перевода тайтла, фаза 5).
    """
    use_case = IngestListings(
        SqlAlchemyListingsWriter(session),
        _object_storage(storage),
        duplicates=await _duplicate_guard(session, redis, items),
        payload_of=raw_payload,
    )
    return _legacy_stats(await use_case.execute(items))


async def mark_stale(
    session: AsyncSession, *, max_age_days: int | None = None
) -> list[int]:
    """Пометить устаревшие объявления (PLAN.md, фаза 3).

    is_active=false + disappeared_at для активных строк с last_seen_at старше
    порога (STALE_MAX_AGE_DAYS, по умолчанию 3 дня). Источники в circuit
    breaker (error_streak >= SOURCE_CB_ERROR_STREAK) пропускаются: источник
    лежит, его объявления не могли видеться. Возвращает id деактивированных
    (для «gone»-уведомлений).
    """
    writer = SqlAlchemyListingsWriter(session)
    return await writer.mark_stale(max_age_days=max_age_days)


# --- Обогащение из detail encar / kcar (миграция 0017) -----------------------

# Detail API encar отдаёт спеки, которых нет в list-API: displacement (см³),
# colorName (корейский), bodyName. KCar detail (`bc/car-info-detail-of-ng`,
# воспроизведено из фронтового бандла www.kcar.com chunk359): rvo с engdispmnt
# (см³), drvgYnNm (привод, корейский), extrColorNm, vin, fuelTypecdNm,
# trnsmsncdNm, carctgr. Тянем лениво (PDP) — обогащаем только просмотренные
# лоты, а не весь каталог.
_KCAR_DETAIL_URL = (
    "https://api.kcar.com/bc/car-info-detail-of-ng"
    "?i_sCarCd={source_id}&i_sPassYn=&i_sPosYn=&bltbdKnd=CM050"
)


async def enrich_listing_specs(session: AsyncSession, listing: Listing) -> bool:
    """Догрузка спеков из detail источника (encar / kcar).

    Только если чего-то не хватает (1 запрос на лот, повторные открытия PDP
    бесплатны). Возвращает True, если обновили хоть одно поле.

    TECHDEBT 3.7: попытка enrichment — одна на лот (`specs_enriched_at`).
    Раньше, если источник не возвращал часть полей (у kcar часто нет rvo),
    каждый открытие PDP делало внешний запрос к encar/kcar.
    """
    if getattr(listing, "specs_enriched_at", None) is not None:
        return False  # уже пробовали — внешний запрос не повторяем
    spec_fields = ("body_type", "fuel", "transmission", "engine_volume", "color")
    if listing.source == "encar":
        if all(getattr(listing, f) is not None for f in spec_fields):
            return False
        detail_url = f"https://api.encar.com/v1/readside/vehicle/{listing.source_id}"
    elif listing.source == "kcar":
        if all(
            getattr(listing, f, None) is not None
            for f in (*spec_fields, "drive", "vin")
        ):
            return False
        # detail-of-ng ждёт id с префиксом EC (EC61405190); рент-лоты уже
        # приходят с префиксом (RC148047) — их не трогаем.
        source_id = listing.source_id
        detail_id = f"EC{source_id}" if source_id.isdigit() else source_id
        detail_url = _KCAR_DETAIL_URL.format(source_id=detail_id)
    else:
        return False

    from app.infrastructure.sources.common.http import HttpClient

    try:
        http = HttpClient(timeout=10, max_retries=1)
        payload = await http.get_json(detail_url)
    except Exception as exc:  # noqa: BLE001 — enrichment не должен ломать PDP
        logger.warning("enrich_fetch_failed: %s: %s", listing.source_id, exc)
        return False

    if listing.source == "encar":
        spec = payload.get("spec") or {}
        pairs: dict[str, Any] = {
            "body_type": normalize_body(spec.get("bodyName")),
            "fuel": normalize_fuel(spec.get("fuelName")),
            "transmission": normalize_transmission(spec.get("transmissionName")),
            "engine_volume": normalize_engine_volume(spec.get("displacement")),
            "color": normalize_color(spec.get("colorName")),
        }
    else:  # kcar: rvo может отсутствовать («차량정보가 없습니다») — не ошибка
        rvo = (payload.get("data") or {}).get("rvo") or {}
        if not rvo:
            return False
        pairs = {
            "body_type": normalize_body(rvo.get("carctgr")),
            "fuel": normalize_fuel(rvo.get("fuelTypecdNm")),
            "transmission": normalize_transmission(rvo.get("trnsmsncdNm")),
            "engine_volume": normalize_engine_volume(rvo.get("engdispmnt")),
            "color": normalize_color(rvo.get("extrColorNm")),
            "drive": normalize_drive(rvo.get("drvgYnNm")),
            "vin": (rvo.get("vin") or "").strip() or None,
        }

    updates: dict[str, Any] = {}
    for field, value in pairs.items():
        if value is not None and getattr(listing, field, None) is None:
            setattr(listing, field, value)
            updates[field] = value
    # Остатки хангыля (цвет «진주색» и пр., мимо глоссария normalize_*)
    # → русский через микросервис; сбой не мешает обогащению.
    await _translate_enriched_values(updates)
    for field, value in updates.items():
        setattr(listing, field, value)
    # 3.7: флаг ставится после ЛЮБОЙ попытки (успешной или «источник ничего
    # не отдал») — второй раз наружу за этим лотом не ходим.
    listing.specs_enriched_at = datetime.now(timezone.utc)
    if updates:
        await session.commit()
        logger.info("enriched: id=%s %s", listing.id, sorted(updates))
    else:
        await session.commit()
    return bool(updates)


async def _translate_enriched_values(updates: dict[str, Any]) -> None:
    """Перевести корейские значения обогащения (in-place в `updates`)."""
    from app.domain.translation.glossary import apply_glossary
    from app.infrastructure.sources.common.translate import HANGUL_RE

    hangul = {
        field: value
        for field, value in updates.items()
        if isinstance(value, str) and HANGUL_RE.search(value)
    }
    if not hangul:
        return
    from app.infrastructure.services.translate_client import (
        translate_client_from_settings,
    )

    try:
        translator = translate_client_from_settings()
        translated = await translator.translate(
            [apply_glossary(v)[:500] for v in hangul.values()],
            source_lang="ko",
            target_lang="ru",
        )
    except Exception:  # noqa: BLE001 — перевод не должен ломать enrichment
        logger.warning("enrich_translate_failed fields=%s", sorted(hangul))
        return
    for (field, original), value in zip(hangul.items(), translated or []):
        if value:
            updates[field] = value
