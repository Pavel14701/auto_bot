"""SQLAlchemy-реализация чтения объявлений: лента, facets, URL, PDP, осмотр.

Здесь живёт весь SQL read-эндпоинтов `/api/listings`: нормализация
make/model/спеков (`app.infrastructure.sources.common.normalize`), цена в
USD, keyset-условие, `count(*)` только в offset-режиме и запись события
поиска в analytics.
"""

from __future__ import annotations

import dataclasses

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import exists
from sqlalchemy import case, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.application.catalog.dto import (
    FeedCursor,
    InspectionUpdate,
    InspectionView,
    ListingCard,
    ListingFeedQuery,
    PricePoint,
)
from app.application.market.dto import LISTING_STATUS_ACCEPTED
from app.domain.pricing.rates import MULTIPLY_TO_USD, UNITS_PER_USD
from app.infrastructure.db.models import (
    InspectionReport,
    Listing,
    ListingPriceHistory,
)
from app.infrastructure.services.analytics import EVENT_SEARCH_COMPLETED, track
from app.infrastructure.services.fetch import enrich_listing_specs
from app.infrastructure.sources.common.normalize import (
    normalize_body,
    normalize_color,
    normalize_drive,
    normalize_fuel,
    normalize_make,
    normalize_transmission,
)

# Курс для нормализации сортировки/фильтра в USD живёт в
# `app.domain.pricing.rates` (единая таблица, синхронизирована с frontend).
_FACETS_LIMIT = 500
# Окно цены для «похожих» машин: ±35% от цены исходного объявления.
_SIMILAR_PRICE_TOLERANCE = Decimal("0.35")


def _usd_price_expr():
    """SQL-выражение `price` в USD (фикс-курсы MVP, `app.domain.pricing.rates`).

    KRW/KZT/CNY/AED/RUB/BYN — «N единиц за доллар» (`price / rate`),
    EUR — цена × 1.08 (котируется «долларов за евро», как на фронте),
    USD — как есть. Неизвестная/NULL-валюта → NULL: такое объявление
    выпадает из ценовых фильтров и уходит в конец сортировки
    (`nulls_last`), но остаётся в выдаче без ценовых условий.
    """
    branches = [
        (func.upper(Listing.currency) == code, Listing.price / rate)
        for code, rate in UNITS_PER_USD.items()
    ]
    branches.extend(
        (func.upper(Listing.currency) == code, Listing.price * rate)
        for code, rate in MULTIPLY_TO_USD.items()
    )
    branches.append((func.upper(Listing.currency) == "USD", Listing.price))
    # else → NULL: невалюта не участвует в ценовых сравнениях.
    return case(*branches)


def _escape_like(value: str) -> str:
    """Экранирует `%`, `_` и `\\` для `ILIKE ... ESCAPE '\\\\'`."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# Значение `source`-фильтра, включающее внутренний рынок (06 §4).
_MARKET_SOURCE = "market"


def _is_market_feed(query: ListingFeedQuery) -> bool:
    """Чипс «🏪 Рынок»: source=market → owner-лоты (owner_type IS NOT NULL)."""
    return bool(query.source) and query.source.strip().lower() == _MARKET_SOURCE


def _to_card(row: Listing) -> ListingCard:
    """ORM → DTO (единственное место, где они встречаются)."""
    is_active = getattr(row, "is_active", True)
    return ListingCard(
        id=row.id,
        source=row.source,
        source_id=row.source_id,
        url=row.url,
        parsed_at=row.parsed_at,
        make=getattr(row, "make", None),
        model=getattr(row, "model", None),
        year=getattr(row, "year", None),
        price=getattr(row, "price", None),
        currency=getattr(row, "currency", None),
        mileage_km=getattr(row, "mileage_km", None),
        vin=getattr(row, "vin", None),
        body_type=getattr(row, "body_type", None),
        fuel=getattr(row, "fuel", None),
        transmission=getattr(row, "transmission", None),
        drive=getattr(row, "drive", None),
        engine_volume=getattr(row, "engine_volume", None),
        color=getattr(row, "color", None),
        images=tuple(getattr(row, "images", None) or ()),
        options=[str(o) for o in (getattr(row, "options", None) or [])],
        is_active=True if is_active is None else bool(is_active),
        # Владелец лота рынка (06 §4): бейдж «🏪 Салон»/«👤 Частник» на PDP.
        owner_type=getattr(row, "owner_type", None),
        owner_description=getattr(row, "owner_description", None),
        # История машины (07 §3): события партнёра для PDP-таймлайна.
        owner_history=[
            dict(event)
            for event in (getattr(row, "owner_history", None) or [])
        ],
        # Гео (GEO-V1 §2): бейдж-флаг страны на карточке; город — рынок.
        country=getattr(row, "country", None),
        city=getattr(row, "city", None),
        first_seen_at=getattr(row, "first_seen_at", None),
        last_seen_at=getattr(row, "last_seen_at", None),
        updated_at=getattr(row, "updated_at", None),
        price_changed_at=getattr(row, "price_changed_at", None),
        title_raw=getattr(row, "title_raw", None),
        title_ru=getattr(row, "title_ru", None),
        source_language=getattr(row, "source_language", None),
    )


def _to_inspection(row: InspectionReport) -> InspectionView:
    """ORM → DTO отчёта осмотра."""
    return InspectionView(
        source=row.source or "manual",
        inspector=getattr(row, "inspector", None),
        inspected_at=getattr(row, "inspected_at", None),
        grade=getattr(row, "grade", None),
        summary=getattr(row, "summary", None),
        marks=[dict(mark) for mark in (getattr(row, "marks", None) or [])],
        items=[dict(item) for item in (getattr(row, "items", None) or [])],
        images=[str(u) for u in (getattr(row, "images", None) or [])],
    )


class SqlAlchemyListingReadRepository:
    """Репозиторий чтения объявлений на SQLAlchemy 2.0 async."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ------------------------------------------------------------------
    # Лента
    # ------------------------------------------------------------------

    async def page(
        self, query: ListingFeedQuery, cursor: FeedCursor | None
    ) -> tuple[list[ListingCard], int | None, bool]:
        """Страница ленты, `total` (None в keyset) и `has_more`."""
        conditions = self._conditions(query)
        usd_price = _usd_price_expr()
        order = {
            "new": (Listing.parsed_at.desc(), Listing.id.desc()),
            "price_asc": (usd_price.asc().nulls_last(), Listing.id.desc()),
            "price_desc": (usd_price.desc().nulls_last(), Listing.id.desc()),
            "mileage_asc": (
                Listing.mileage_km.asc().nulls_last(),
                Listing.id.desc(),
            ),
            "year_desc": (Listing.year.desc().nulls_last(), Listing.id.desc()),
        }[query.sort]

        limit = max(1, query.limit)
        # Чипс «🏪 Рынок» (06 §4): owner-лоты — фильтр owner_type IS NOT NULL
        # (JOIN partner_offers из ленты убран: рынок = лоты с владельцем).
        # Бейдж «чек есть» (аудит F7) — EXISTS в том же запросе, без N+1.
        # «🏪 Рынок» (06 §4) — owner_type самой строки, отдельный EXISTS не нужен.
        has_check = exists().where(InspectionReport.listing_id == Listing.id)
        stmt = select(
            Listing,
            has_check.label("has_inspection"),
            Listing.owner_type.is_not(None).label("has_market"),
        ).where(*conditions)
        if cursor is not None:
            # Keyset: строго после позиции курсора, без offset и count(*).
            stmt = stmt.where(
                tuple_(Listing.parsed_at, Listing.id)
                < tuple_(cursor.parsed_at, cursor.listing_id)
            )
        elif query.offset:
            stmt = stmt.offset(query.offset)

        # limit + 1 — чтобы отличить «страница заполнена» от «есть продолжение».
        result_rows = (
            await self._session.execute(
                stmt.order_by(*order).limit(limit + 1)
            )
        ).all()
        has_more = len(result_rows) > limit
        items = []
        for entry in result_rows[:limit]:
            # (Listing, has_inspection, has_market); фейки в тестах отдают
            # только ORM-строку — недостающие флаги считаем False.
            try:
                row, *flags = entry
                has_insp = bool(flags[0]) if len(flags) > 0 else False
                has_mkt = bool(flags[1]) if len(flags) > 1 else False
            except (TypeError, ValueError):
                row, has_insp, has_mkt = entry, False, False
            card = _to_card(row)
            if has_insp:
                card = dataclasses.replace(card, has_inspection=True)
            if has_mkt:
                card = dataclasses.replace(card, has_market=True)
            items.append(card)

        total: int | None = None
        if cursor is None:
            count_stmt = select(func.count()).select_from(Listing).where(
                *conditions
            )
            total = (await self._session.execute(count_stmt)).scalar_one()
        return items, total, has_more

    def _conditions(self, query: ListingFeedQuery) -> list:
        """SQL-условия ленты; нормализация — на границе адаптера."""
        # is_active — обязательный фильтр, не считается «пользовательским».
        conditions: list = [Listing.is_active.is_(True)]

        if _is_market_feed(query):
            # Рынок = owner-лоты (06 §4): владелец юзер или партнёр,
            # источник лота (source='market') не фильтруется отдельно.
            conditions.append(Listing.owner_type.is_not(None))
            # Жизненный цикл (10 §1): только одобренные — draft/moderation/
            # rejected/expired в ленте не видны. Внешним лотам backfill
            # миграции 0030 проставил 'accepted' — условие единое для всех.
            conditions.append(Listing.status == LISTING_STATUS_ACCEPTED)
        elif query.source:
            conditions.append(func.lower(Listing.source) == query.source.lower())
        elif not query.country:
            # MVP: только Корея — без `source` отдаём encar+kcar. Явный
            # `country` (GEO-V1 §2) расширяет ленту на все источники
            # страны: чипс «🇨🇳 Китай» не должен глохнуть на дефолте.
            conditions.append(func.lower(Listing.source).in_(("encar", "kcar")))
        else:
            # Есть `country`, но нет `source`: границы ленты задаёт
            # страна (исключение — рынок выше по ветке source=market).
            conditions.append(Listing.source != "market")

        # Точный ISO-2 (GEO-V1 §2): одна страна, без CSV.
        if query.country:
            conditions.append(func.upper(Listing.country) == query.country.upper())

        if query.make:
            m = (normalize_make(query.make) or query.make).lower()
            conditions.append(func.lower(Listing.make) == m)
        if query.model:
            conditions.append(func.lower(Listing.model) == query.model.lower())

        if query.year_from is not None:
            conditions.append(Listing.year >= query.year_from)
        if query.year_to is not None:
            conditions.append(Listing.year <= query.year_to)

        # Цена: нормализуем в USD (как и сортировка).
        usd_price = _usd_price_expr()
        if query.price_min is not None:
            conditions.append(usd_price >= query.price_min)
        if query.price_max is not None:
            conditions.append(usd_price <= query.price_max)

        if query.currency:
            conditions.append(func.lower(Listing.currency) == query.currency.lower())

        if query.mileage_min is not None:
            conditions.append(Listing.mileage_km >= query.mileage_min)
        if query.mileage_max is not None:
            conditions.append(Listing.mileage_km <= query.mileage_max)

        # Спеки: нормализуем к канону (sedan/suv/petrol/...) и сравниваем
        # case-insensitive. Сырое значение — fallback, если нормализатор
        # не знает (например, «купе-стрела»).
        for param, column, normalizer in (
            (query.body_type, Listing.body_type, normalize_body),
            (query.fuel, Listing.fuel, normalize_fuel),
            (query.transmission, Listing.transmission, normalize_transmission),
            (query.drive, Listing.drive, normalize_drive),
            (query.color, Listing.color, normalize_color),
        ):
            if param:
                normalized = normalizer(param) or param
                conditions.append(func.lower(column) == normalized.lower())

        if query.engine_volume_min is not None:
            conditions.append(Listing.engine_volume >= query.engine_volume_min)
        if query.engine_volume_max is not None:
            conditions.append(Listing.engine_volume <= query.engine_volume_max)

        return conditions

    async def record_search(
        self, user_id: int | None, *, results: int, filters: int
    ) -> None:
        """Записать `search_completed` (сбой не глотается — решает сценарий)."""
        await track(
            self._session,
            user_id,
            EVENT_SEARCH_COMPLETED,
            {"results": results, "filters": filters},
        )

    # ------------------------------------------------------------------
    # Facets
    # ------------------------------------------------------------------

    async def facets(
        self, make: str | None, *, country: str | None = None
    ) -> dict[str, list[str]]:
        """Марки (без `make`) или модели марки + страны для чипсов GEO-V1.

        `country` сужает марки/модели до одной страны (сегмент фильтра
        «Страна»); `countries` — distinct по активным объявлениям, порядок
        по частоте (сколько лотов страны в базе).
        """
        # Чипсы-страны (GEO-V1 §2): частые первыми — KR/CN/AE/US/KZ.
        country_rows = (
            await self._session.execute(
                select(Listing.country, func.count())
                .where(
                    Listing.is_active.is_(True),
                    Listing.country.is_not(None),
                )
                .group_by(Listing.country)
                .order_by(func.count().desc(), Listing.country)
                .limit(_FACETS_LIMIT)
            )
        ).all()
        countries = [row[0] for row in country_rows]

        country_cond = (
            func.upper(Listing.country) == country.upper() if country else None
        )
        if make:
            m_norm = (normalize_make(make) or make).lower()
            conditions = [
                Listing.is_active.is_(True),
                func.lower(Listing.make) == m_norm,
                Listing.model.is_not(None),
                Listing.model != "",
            ]
            if country_cond is not None:
                conditions.append(country_cond)
            rows = (
                await self._session.execute(
                    select(Listing.model)
                    .where(*conditions)
                    .distinct()
                    .order_by(Listing.model)
                    .limit(_FACETS_LIMIT)
                )
            ).all()
            return {"models": [row[0] for row in rows], "countries": countries}

        conditions = [
            Listing.is_active.is_(True),
            Listing.make.is_not(None),
            Listing.make != "",
        ]
        if country_cond is not None:
            conditions.append(country_cond)
        rows = (
            await self._session.execute(
                select(Listing.make)
                .where(*conditions)
                .distinct()
                .order_by(Listing.make)
                .limit(_FACETS_LIMIT)
            )
        ).all()
        return {"makes": [row[0] for row in rows], "countries": countries}

    # ------------------------------------------------------------------
    # By URL
    # ------------------------------------------------------------------

    async def find_by_url(self, needle: str) -> list[ListingCard]:
        """До двух активных объявлений по нормализованному хвосту URL."""
        escaped = _escape_like(needle)
        rows = (
            await self._session.execute(
                select(Listing)
                .where(
                    Listing.url.ilike(f"%{escaped}%", escape="\\"),
                    Listing.is_active.is_(True),
                )
                .limit(2)
            )
        ).scalars().all()
        return [_to_card(row) for row in rows]

    # ------------------------------------------------------------------
    # PDP
    # ------------------------------------------------------------------

    async def get_active(self, listing_id: int) -> ListingCard | None:
        """Активное объявление или None.

        Жизненный цикл (10 §1): владелец-лоты видны только в статусе
        'accepted' (draft/moderation/rejected/expired → 404 на PDP);
        внешние лоты после backfill 0030 всегда 'accepted', неактивные
        по-прежнему отсекаются is_active.
        """
        row = await self._session.get(Listing, listing_id)
        if row is None or not getattr(row, "is_active", True):
            return None
        # None толерантен только для нефлашнутых ORM-объектов в тестовых
        # фейках: в БД колонка NOT NULL (миграция 0030).
        if getattr(row, "status", LISTING_STATUS_ACCEPTED) not in (
            None,
            LISTING_STATUS_ACCEPTED,
        ):
            return None
        return _to_card(row)

    async def enrich(self, listing_id: int) -> ListingCard | None:
        """Догрузить спеки из detail источника и вернуть карточку."""
        row = await self._session.get(Listing, listing_id)
        if row is None:
            return None
        await enrich_listing_specs(self._session, row)
        return _to_card(row)

    async def price_history(self, listing_id: int) -> list[PricePoint]:
        """История цен объявления (хронологически)."""
        rows = (
            await self._session.execute(
                select(
                    ListingPriceHistory.price,
                    ListingPriceHistory.currency,
                    ListingPriceHistory.recorded_at,
                )
                .where(ListingPriceHistory.listing_id == listing_id)
                .order_by(
                    ListingPriceHistory.recorded_at, ListingPriceHistory.id
                )
            )
        ).all()
        return [
            PricePoint(
                price=Decimal(row.price),
                currency=row.currency,
                recorded_at=row.recorded_at,
            )
            for row in rows
        ]

    # ------------------------------------------------------------------
    # Похожие (кнопка «Найти похожие»)
    # ------------------------------------------------------------------

    async def similar_candidates(
        self, listing_id: int, *, limit: int = 24
    ) -> list[ListingCard]:
        """Кандидаты «похожих машин» (та же модель, ±3 года, цена ±35%).

        Активные объявления с той же `lower(make)`/`lower(model)`, кроме
        исходного. Фильтр и сортировка по цене применяются только если у
        исходного есть цена (иначе — только марка/модель/год); кандидат
        без года включается, если фильтр года задан.
        """
        source = await self._session.get(Listing, listing_id)
        if source is None:
            return []

        conditions: list = [Listing.is_active.is_(True), Listing.id != listing_id]
        if source.make:
            conditions.append(func.lower(Listing.make) == source.make.lower())
        if source.model:
            conditions.append(func.lower(Listing.model) == source.model.lower())
        if source.year is not None:
            # Кандидаты без года не отсекаются — «похоже и без года» лучше пустоты.
            conditions.append(
                Listing.year.is_(None)
                | Listing.year.between(source.year - 3, source.year + 3)
            )

        price = source.price
        if price is not None:
            conditions.append(Listing.price.isnot(None))
            # Окно «цена ±35%» (нечто похожее |price - исходная| <= 0.35*исходной).
            conditions.extend(
                (
                    Listing.price >= price - price * _SIMILAR_PRICE_TOLERANCE,
                    Listing.price <= price + price * _SIMILAR_PRICE_TOLERANCE,
                )
            )
            order = (func.abs(Listing.price - price).asc(), Listing.id.desc())
        else:
            # Нечего сравнивать по цене — свежие кандидаты первыми (как лента).
            order = (Listing.parsed_at.desc(), Listing.id.desc())

        rows = (
            await self._session.execute(
                select(Listing).where(*conditions).order_by(*order).limit(limit)
            )
        ).scalars().all()
        return [_to_card(row) for row in rows]

    # ------------------------------------------------------------------
    # Осмотр
    # ------------------------------------------------------------------

    async def exists(self, listing_id: int) -> bool:
        """Есть ли объявление с таким id (в любом статусе)."""
        return await self._session.get(Listing, listing_id) is not None

    async def get_report(self, listing_id: int) -> InspectionView | None:
        """Отчёт осмотра или None."""
        row = (
            await self._session.execute(
                select(InspectionReport).where(
                    InspectionReport.listing_id == listing_id
                )
            )
        ).scalar_one_or_none()
        return _to_inspection(row) if row is not None else None

    async def upsert_report(
        self, listing_id: int, update: InspectionUpdate
    ) -> InspectionView:
        """Создать/заменить отчёт осмотра (commit — в сценарии)."""
        row = (
            await self._session.execute(
                select(InspectionReport).where(
                    InspectionReport.listing_id == listing_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            row = InspectionReport(listing_id=listing_id)
            self._session.add(row)

        row.source = update.source
        row.inspector = update.inspector
        row.inspected_at = update.inspected_at
        row.grade = update.grade
        row.summary = update.summary
        row.marks = [dict(mark) for mark in update.marks]
        row.items = [dict(item) for item in update.items]
        row.images = [str(u) for u in update.images]
        row.updated_at = datetime.now(UTC)
        await self._session.flush()
        return _to_inspection(row)
