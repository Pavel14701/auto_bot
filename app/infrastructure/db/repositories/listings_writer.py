"""SQLAlchemy-реализация порта `ListingWriter` (PLAN.md, фазы 1–3, 6).

Дедуп внутри источника — `ON CONFLICT (source, source_id) DO UPDATE`;
межИсточниковый дедуп делает сценарий до вызова этого адаптера.

Upsert одним запросом: CTE `existing` (FOR UPDATE) даёт значения ДО
обновления, RETURNING — после; LEFT JOIN возвращает строку и для NEW.
Статистику и побочные эффекты решает домен (`decide`/`summarize`),
адаптер лишь исполняет SQL и готовит raw-объекты к загрузке.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Sequence

from sqlalchemy import DateTime, bindparam, func, select, text, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.domain.listings.ingestion import (
    ExistingState,
    IngestStats,
    ItemOutcome,
    PendingRawUpload,
    clean_value,
    compute_content_hash,
    decide,
    row_values,
    summarize,
)
from app.domain.listings.unified import UnifiedListing
from app.infrastructure.db.models import Listing, SourceHealth
from app.infrastructure.sources.common.normalize import (
    normalize_body,
    normalize_color,
    normalize_drive,
    normalize_engine_volume,
    normalize_fuel,
    normalize_transmission,
)
from app.infrastructure.services.storage import build_raw_key

logger = logging.getLogger(__name__)

# Upsert одним запросом: CTE `existing` (FOR UPDATE) даёт значения ДО
# обновления, RETURNING — после; LEFT JOIN возвращает строку и для NEW.
# - first_seen_at НЕ входит в DO UPDATE SET — не сбрасывается при парсинге;
# - disappeared_at = NULL безусловно — реактивация возвращённого объявления;
# - raw_payload в БД больше не пишется (фаза 6): ключ S3-объекта ставит
#   отдельный UPDATE после загрузки (raw_key = NULL, если MinIO недоступен).
_UPSERT_SQL = text("""
WITH existing AS (
    SELECT id, price, currency, content_hash, is_active
    FROM listings
    WHERE source = :source AND source_id = :source_id
    FOR UPDATE
),
upserted AS (
    INSERT INTO listings (
        source, source_id, url, make, model, year, price, currency,
        mileage_km, vin, images, options, schema_version, parsed_at,
        body_type, fuel, transmission, drive, engine_volume, color,
        content_hash, is_active, first_seen_at, last_seen_at, title_raw,
        country
    ) VALUES (
        :source, :source_id, :url, :make, :model, :year, :price, :currency,
        :mileage_km, :vin, :images, :options, :schema_version, :parsed_at,
        :body_type, :fuel, :transmission, :drive, :engine_volume, :color,
        :content_hash, TRUE, now(), now(), :title_raw,
        :country
    )
    ON CONFLICT ON CONSTRAINT uq_listings_source_source_id DO UPDATE SET
        url = EXCLUDED.url,
        make = EXCLUDED.make,
        model = EXCLUDED.model,
        year = EXCLUDED.year,
        price = EXCLUDED.price,
        currency = EXCLUDED.currency,
        mileage_km = EXCLUDED.mileage_km,
        vin = COALESCE(EXCLUDED.vin, listings.vin),
        -- B-06: «unchanged»-лот (хэш совпал, лот активен) не откатываем на
        -- исходные URL, пока в БД стоят S3-зеркала (`/mirror/…`) — иначе
        -- следующий фетч молча отвязывал карточку от зеркал, а
        -- mirror_photos_task её больше не возвращал (has_mirror → skip).
        -- При смене content_hash или после purge исчезавшего лота
        -- (реактивация: is_active было false, зеркала удалены из S3) —
        -- пишем исходные URL, зеркало перезальётся.
        images = CASE
            WHEN listings.is_active
                 AND listings.content_hash = EXCLUDED.content_hash
                 AND listings.images ->> 0 LIKE '%/mirror/%'
            THEN listings.images
            ELSE EXCLUDED.images
        END,
        options = EXCLUDED.options,
        schema_version = EXCLUDED.schema_version,
        parsed_at = EXCLUDED.parsed_at,
        body_type = COALESCE(EXCLUDED.body_type, listings.body_type),
        fuel = COALESCE(EXCLUDED.fuel, listings.fuel),
        transmission = COALESCE(EXCLUDED.transmission, listings.transmission),
        drive = COALESCE(EXCLUDED.drive, listings.drive),
        engine_volume = COALESCE(EXCLUDED.engine_volume, listings.engine_volume),
        color = COALESCE(EXCLUDED.color, listings.color),
        -- Страна (GEO-V1 §2): адаптер мог не проставить — не сбрасываем
        -- бэкфилл миграции 0031 и значение прошлых прогонов.
        country = COALESCE(EXCLUDED.country, listings.country),
        content_hash = EXCLUDED.content_hash,
        is_active = TRUE,
        disappeared_at = NULL,
        last_seen_at = EXCLUDED.last_seen_at,
        title_raw = EXCLUDED.title_raw,
        updated_at = now()
    RETURNING id
)
SELECT e.id AS old_id, e.price AS old_price, e.currency AS old_currency,
       e.content_hash AS old_hash, e.is_active AS was_active, u.id AS listing_id
FROM upserted u LEFT JOIN existing e ON TRUE
""").bindparams(
    bindparam("images", type_=JSONB),
    bindparam("options", type_=JSONB),
)

_PRICE_POINT_SQL = text(
    "INSERT INTO listing_price_history (listing_id, price, currency) "
    "VALUES (:listing_id, :price, :currency)"
)

# Отчёт осмотра из источника. Ручные отчёты не перетираем: DO UPDATE
# срабатывает только если текущая строка — тоже парсерная (`source='encar'`).
# При вставке inspector/inspected_at остаются NULL (ручных данных нет).
def _coerce_dt(value: Any) -> datetime | None:
    """Дата осмотра из адаптера (`'2026-08-21'`/ISO/datetime) → aware datetime.

    asyncpg принимает в timestamptz только datetime; наивному проставляем UTC.
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip())
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


_INSPECTION_SQL = text(
    """
    INSERT INTO inspection_reports
        (listing_id, source, inspector, inspected_at, grade, summary,
         marks, items, images)
    VALUES (:listing_id, :source, :inspector, :inspected_at, :grade, :summary,
            :marks, :items, :images)
    ON CONFLICT (listing_id) DO UPDATE SET
        source = EXCLUDED.source,
        inspector = EXCLUDED.inspector,
        inspected_at = EXCLUDED.inspected_at,
        grade = COALESCE(EXCLUDED.grade, inspection_reports.grade),
        summary = EXCLUDED.summary,
        marks = EXCLUDED.marks,
        items = EXCLUDED.items,
        images = EXCLUDED.images,
        updated_at = now()
    WHERE inspection_reports.source = 'encar'
    """
).bindparams(
    bindparam("marks", type_=JSONB),
    bindparam("items", type_=JSONB),
    bindparam("images", type_=JSONB),
    bindparam("inspected_at", type_=DateTime(timezone=True)),
)


class SqlAlchemyListingsWriter:
    """Пишет объявления пачкой: upsert, история цен, raw_key, stale."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert_many(
        self, items: Sequence[UnifiedListing], raw_keys: Mapping[int, str]
    ) -> IngestStats:
        """Upsert пачки: точки цены при изменении и `raw_keys` в той же транзакции.

        Args:
            items: Объявления источника (межИсточниковый дедуп уже сделан).
            raw_keys: Готовые ключи S3 по id объявления (`{}` — загрузим позже).

        Returns:
            Статистика вместе с `pending_uploads` для сценария.
        """
        outcomes: list[ItemOutcome] = []
        uploads: list[PendingRawUpload] = []
        inspections: list[tuple[int, dict[str, Any]]] = []
        for item in items:
            params = self._params(item)
            row = (await self._session.execute(_UPSERT_SQL, params)).mappings().first()
            if row is None:  # CTE всегда возвращает строку; защита от аномалий
                continue
            outcome = decide(
                item,
                listing_id=row["listing_id"],
                content_hash=params["content_hash"],
                previous=ExistingState.from_row(row),
            )
            outcomes.append(outcome)
            if item.inspection:
                inspections.append((outcome.listing_id, item.inspection))
            if outcome.price_point:
                await self._session.execute(
                    _PRICE_POINT_SQL,
                    {
                        "listing_id": outcome.listing_id,
                        "price": item.price,
                        "currency": item.currency,
                    },
                )
            if outcome.needs_raw_upload:
                uploads.append(
                    PendingRawUpload(
                        key=build_raw_key(
                            item.source,
                            outcome.listing_id,
                            outcome.content_hash,
                            when=item.parsed_at,
                        ),
                        listing_id=outcome.listing_id,
                        content_hash=outcome.content_hash,
                        item=item,
                    )
                )
        if raw_keys:
            await self._apply_raw_keys(raw_keys)
        if inspections:
            await self._upsert_inspections(inspections)
        await self._session.commit()
        stats = summarize(outcomes, uploads=uploads)
        if stats.touched:
            logger.info("listings_saved: %s", _counters(stats))
        return stats

    async def _upsert_inspections(
        self, rows: Sequence[tuple[int, dict[str, Any]]]
    ) -> None:
        """Записать отчёты осмотра источника (без commit — транзакция вызывающего).

        Ручные отчёты (source != 'encar') не перетираются — см. WHERE в
        `_INSPECTION_SQL`. Ошибка пачки не должна ронять сохранение
        объявлений: выполняется в SAVEPOINT, при сбое откатывается только он.
        """
        params = [
            {
                "listing_id": listing_id,
                "source": str(report.get("source") or "encar"),
                "inspector": report.get("inspector"),
                "inspected_at": _coerce_dt(report.get("inspected_at")),
                "grade": report.get("grade"),
                "summary": report.get("summary"),
                "marks": report.get("marks") or [],
                "items": report.get("items") or [],
                "images": report.get("images") or [],
            }
            for listing_id, report in rows
        ]
        try:
            async with self._session.begin_nested():
                await self._session.execute(_INSPECTION_SQL, params)
        except Exception:
            logger.warning(
                "inspection_upsert_failed: %d rows skipped", len(params), exc_info=True
            )

    async def attach_raw_keys(self, raw_keys: Mapping[int, str]) -> None:
        """Записать `raw_key` после успешной загрузки raw в S3."""
        if not raw_keys:
            return
        await self._apply_raw_keys(raw_keys)
        await self._session.commit()

    async def mark_stale(self, *, max_age_days: int | None = None) -> list[int]:
        """Пометить устаревшие объявления (PLAN.md, фаза 3).

        is_active=false + disappeared_at для активных строк с last_seen_at
        старше порога (STALE_MAX_AGE_DAYS, по умолчанию 3 дня). Источники
        в circuit breaker (error_streak >= SOURCE_CB_ERROR_STREAK)
        пропускаются: источник лежит, его объявления не могли видеться.

        Owner-лоты рынка (owner_type IS NOT NULL: user/partner) никогда не
        сталеют: их last_seen_at — время создания (пере-фетча нет), а жизнь
        управляется placement/lifecycle (`market_placement_expiry`,
        `deactivate_lot`), а не источником. Без фильтра ночной stale-check
        через 3 дня убивал оплаченные размещения и слоты (B-01).

        Args:
            max_age_days: Порог в днях; `None` — из настроек.

        Returns:
            id деактивированных (для «gone»-уведомлений).
        """
        settings = get_settings()
        age = settings.stale_max_age_days if max_age_days is None else max_age_days
        threshold = datetime.now(timezone.utc) - timedelta(days=age)
        cb_sources = (
            (
                await self._session.execute(
                    select(SourceHealth.source_name).where(
                        SourceHealth.error_streak >= settings.source_cb_error_streak
                    )
                )
            )
            .scalars()
            .all()
        )
        stmt = update(Listing).where(
            Listing.is_active.is_(True),
            Listing.last_seen_at < threshold,
            # B-01: owner-лоты рынка не сталеют — только внешние (encar/kcar/…)
            # имеют осмысленный last_seen_at; owner-жизнь — placement/lifecycle.
            Listing.owner_type.is_(None),
        )
        if cb_sources:
            stmt = stmt.where(Listing.source.not_in(list(cb_sources)))
        result = await self._session.execute(
            stmt.values(is_active=False, disappeared_at=func.now()).returning(
                Listing.id
            )
        )
        ids = list(result.scalars().all())
        await self._session.commit()
        if ids:
            logger.info("mark_stale_done: gone=%s", len(ids))
        return ids

    async def gone_external_rows(self, listing_ids: list[int]) -> list[Any]:
        """Данные исчезнувших ВНЕШНИХ лотов для очистки S3 (11 §4).

        Внешние = owner_type IS NULL (encar/kcar): owner-лоты рынка —
        пользовательский контент, не трогаем.
        """
        if not listing_ids:
            return []
        result = await self._session.execute(
            select(
                Listing.id,
                Listing.source,
                Listing.source_id,
                Listing.raw_key,
            ).where(
                Listing.id.in_(listing_ids),
                Listing.owner_type.is_(None),
                Listing.disappeared_at.is_not(None),
            )
        )
        return list(result.all())

    async def _apply_raw_keys(self, raw_keys: Mapping[int, str]) -> None:
        """UPDATE listings.raw_key пачкой (без commit — транзакция вызывающего)."""
        stmt = (
            update(Listing)
            .where(Listing.id == bindparam("b_id"))
            .values(raw_key=bindparam("b_key"))
        )
        await self._session.execute(
            stmt, [{"b_id": lid, "b_key": key} for lid, key in raw_keys.items()]
        )

    def _params(self, item: UnifiedListing) -> dict[str, Any]:
        """Параметры upsert: очищенные поля + канон спеков + content_hash."""
        values = row_values(item)
        return values | {
            "body_type": normalize_body(item.body_type) or values["body_type"],
            "fuel": normalize_fuel(item.fuel) or values["fuel"],
            "transmission": normalize_transmission(item.transmission)
            or values["transmission"],
            "drive": normalize_drive(item.drive) or values["drive"],
            "engine_volume": normalize_engine_volume(item.engine_volume),
            "color": normalize_color(item.color),
            # Страна (GEO-V1 §2): адаптер проставил ISO2; NULL — источник
            # страну пока не отдаёт (в БД останется прежнее значение).
            "country": clean_value((item.country or "").upper()),
            "content_hash": compute_content_hash(item),
        }


def _counters(stats: IngestStats) -> dict[str, int]:
    """Счётчики без id-списков и uploads — для лога."""
    return {
        "new": stats.new,
        "updated": stats.updated,
        "unchanged": stats.unchanged,
        "price_changed": stats.price_changed,
        "reactivated": stats.reactivated,
        "cross_dup": stats.cross_dup,
    }
