"""Тесты для /api/listings (лента, facets, by-url, PDP, inspection)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.db.models import (
    InspectionReport,
    Listing,
    ListingPriceHistory,
)
from app.infrastructure.db.repositories.listings_read import (
    SqlAlchemyListingReadRepository,
)
from app.main_api import app as fastapi_app
from conftest import install_test_container


# =========================================================================
# Redis-стаб для facets-кэша
# =========================================================================


class _FakeRedis:
    """Мини-стаб Redis: ровно те команды, что использует facets-кэш."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def get(self, key: str) -> str | None:
        return self.data.get(key)

    async def setex(self, key: str, ttl: int, value: str) -> bool:
        self.data[key] = value
        self.ttls[key] = ttl
        return True

    async def delete(self, *keys: str) -> int:
        removed = 0
        for key in keys:
            if key in self.data:
                del self.data[key]
                removed += 1
        return removed

    async def exists(self, key: str) -> int:
        return 1 if key in self.data else 0


@pytest.fixture
def fake_redis() -> _FakeRedis:
    return _FakeRedis()


@pytest.fixture(autouse=True)
async def _override_facets_redis(fake_redis: _FakeRedis):
    """facets кэширует в Redis через get_redis.

    Без подмены запрос уходит в настоящий Redis и может вернуть значение,
    оставшееся от другого прогона (acets:makes живёт 5 минут) — тесты
    становятся зависимыми от истории запусков.
    """
    _prev = fastapi_app.state.dishka_container
    _container = install_test_container(fastapi_app, redis=fake_redis)
    try:
        yield
    finally:
        fastapi_app.state.dishka_container = _prev
        await _container.close()


# =========================================================================
# Фабрики (локальные, чтобы тесты были самодостаточны)
# =========================================================================


async def _make_listing(
    session: AsyncSession,
    *,
    source: str = "encar",
    source_id: str | None = None,
    make: str | None = "Toyota",
    model: str | None = "Camry",
    year: int | None = 2020,
    price: Decimal | None = Decimal("20000"),
    currency: str = "USD",
    mileage_km: int | None = 50000,
    body_type: str | None = "sedan",
    fuel: str | None = "petrol",
    transmission: str | None = "automatic",
    drive: str | None = "fwd",
    color: str | None = "white",
    engine_volume: Decimal | None = Decimal("2.0"),
    url: str | None = None,
    is_active: bool = True,
    parsed_at: datetime | None = None,
) -> Listing:
    """Создаёт Listing и коммитит (session-scoped fixture-сессия)."""
    if source_id is None:
        source_id = f"{source}-{make}-{model}-{year}-{price}"
    listing = Listing(
        source=source,
        source_id=source_id,
        make=make,
        model=model,
        year=year,
        price=price,
        currency=currency,
        mileage_km=mileage_km,
        body_type=body_type,
        fuel=fuel,
        transmission=transmission,
        drive=drive,
        color=color,
        engine_volume=engine_volume,
        url=url or f"https://www.{source}.com/a/{source_id}/",
        is_active=is_active,
        parsed_at=parsed_at or datetime.now(UTC),
    )
    session.add(listing)
    await session.commit()
    await session.refresh(listing)
    return listing


async def _make_price_history(
    session: AsyncSession,
    listing_id: int,
    points: list[tuple[float, datetime]],
) -> None:
    for price, recorded_at in points:
        session.add(
            ListingPriceHistory(
                listing_id=listing_id,
                price=Decimal(str(price)),
                currency="USD",
                recorded_at=recorded_at,
            )
        )
    await session.commit()


async def _make_inspection(
    session: AsyncSession,
    listing_id: int,
    *,
    grade: str = "good",
) -> InspectionReport:
    report = InspectionReport(
        listing_id=listing_id,
        source="manual",
        inspector="inspector-1",
        inspected_at=datetime.now(UTC),
        grade=grade,
        summary="ok",
        marks=[],
        items=[],
        updated_at=datetime.now(UTC),
    )
    session.add(report)
    await session.commit()
    await session.refresh(report)
    return report


# =========================================================================
# list_listings — is_active
# =========================================================================


@pytest.mark.asyncio
async def test_listings_excludes_inactive(
    client: AsyncClient, session: AsyncSession,
):
    active = await _make_listing(session, source_id="act-1", make="Toyota")
    inactive = await _make_listing(
        session, source_id="inact-1", make="Toyota", is_active=False,
    )
    r = await client.get("/api/listings")
    assert r.status_code == 200
    ids = [item["id"] for item in r.json()["items"]]
    assert active.id in ids
    assert inactive.id not in ids


@pytest.mark.asyncio
async def test_listings_default_sources(client: AsyncClient, session: AsyncSession):
    """Без `source` — только encar+kcar; che168 не попадает."""
    encar = await _make_listing(session, source="encar", source_id="e1")
    kcar = await _make_listing(session, source="kcar", source_id="k1")
    che168 = await _make_listing(session, source="che168", source_id="c1")
    r = await client.get("/api/listings")
    ids = [item["id"] for item in r.json()["items"]]
    assert encar.id in ids
    assert kcar.id in ids
    assert che168.id not in ids


@pytest.mark.asyncio
async def test_listings_explicit_source(client: AsyncClient, session: AsyncSession):
    encar = await _make_listing(session, source="encar", source_id="e2")
    che168 = await _make_listing(session, source="che168", source_id="c2")
    r = await client.get("/api/listings", params={"source": "che168"})
    ids = [item["id"] for item in r.json()["items"]]
    assert che168.id in ids
    assert encar.id not in ids


@pytest.mark.asyncio
async def test_listings_source_case_insensitive(
    client: AsyncClient, session: AsyncSession,
):
    l = await _make_listing(session, source="encar", source_id="e3")
    r = await client.get("/api/listings", params={"source": "ENCAR"})
    ids = [item["id"] for item in r.json()["items"]]
    assert l.id in ids


# =========================================================================
# list_listings — нормализация make/model/спеков
# =========================================================================


@pytest.mark.asyncio
async def test_listings_make_normalized(client: AsyncClient, session: AsyncSession):
    """«тойота» (рус.) находит «Toyota» (в БД)."""
    toyota = await _make_listing(session, make="Toyota", source_id="t1")
    kia = await _make_listing(session, make="Kia", source_id="k1")
    r = await client.get("/api/listings", params={"make": "тойота"})
    ids = [item["id"] for item in r.json()["items"]]
    assert toyota.id in ids
    assert kia.id not in ids


@pytest.mark.asyncio
async def test_listings_make_case_insensitive(
    client: AsyncClient, session: AsyncSession,
):
    l = await _make_listing(session, make="BMW", source_id="bmw1")
    r = await client.get("/api/listings", params={"make": "bmw"})
    assert l.id in [item["id"] for item in r.json()["items"]]


@pytest.mark.asyncio
async def test_listings_body_type_normalized(
    client: AsyncClient, session: AsyncSession,
):
    """«седан» (рус.) находит body_type='sedan'."""
    sedan = await _make_listing(
        session, body_type="sedan", make="Toyota", source_id="s1",
    )
    suv = await _make_listing(
        session, body_type="suv", make="Toyota", source_id="sv1",
    )
    r = await client.get("/api/listings", params={"body_type": "седан"})
    ids = [item["id"] for item in r.json()["items"]]
    assert sedan.id in ids
    assert suv.id not in ids


@pytest.mark.asyncio
async def test_listings_fuel_normalized(
    client: AsyncClient, session: AsyncSession,
):
    petrol = await _make_listing(session, fuel="petrol", source_id="p1")
    diesel = await _make_listing(session, fuel="diesel", source_id="d1")
    r = await client.get("/api/listings", params={"fuel": "бензин"})
    ids = [item["id"] for item in r.json()["items"]]
    assert petrol.id in ids
    assert diesel.id not in ids


@pytest.mark.asyncio
async def test_listings_unknown_body_type_fallback(
    client: AsyncClient, session: AsyncSession,
):
    """Неизвестное значение («купе-стрела») — fallback на raw, не 500."""
    await _make_listing(session, source_id="x1")
    r = await client.get("/api/listings", params={"body_type": "купе-стрела"})
    assert r.status_code == 200
    assert r.json()["items"] == []  # нет совпадений, но не падение


# =========================================================================
# list_listings — цена в USD
# =========================================================================


@pytest.mark.asyncio
async def test_listings_price_filter_normalized_krw(
    client: AsyncClient, session: AsyncSession,
):
    """KRW-объявление ~$22k (30M KRW / 1350) проходит price_min=20000."""
    krw = await _make_listing(
        session,
        source="encar",
        source_id="krw-1",
        price=Decimal("30000000"),
        currency="KRW",
    )
    usd = await _make_listing(
        session,
        source="encar",
        source_id="usd-1",
        price=Decimal("10000"),
        currency="USD",
    )
    r = await client.get(
        "/api/listings", params={"price_min": 20000, "price_max": 25000},
    )
    ids = [item["id"] for item in r.json()["items"]]
    assert krw.id in ids
    assert usd.id not in ids


@pytest.mark.asyncio
async def test_listings_price_filter_converts_kzt(
    client: AsyncClient, session: AsyncSession,
):
    """B-03: kolesa-лот 12.2M KZT (÷480 ≈ $25.4k) попадает в окно 20000–30000."""
    kzt = await _make_listing(
        session,
        source="kolesa",
        source_id="kzt-1",
        price=Decimal("12200000"),
        currency="KZT",
    )
    cheap = await _make_listing(
        session,
        source="kolesa",
        source_id="kzt-2",
        price=Decimal("2400000"),  # $5 000 — вне окна
        currency="KZT",
    )
    r = await client.get(
        "/api/listings",
        params={"source": "kolesa", "price_min": 20000, "price_max": 30000},
    )
    ids = [item["id"] for item in r.json()["items"]]
    assert kzt.id in ids
    assert cheap.id not in ids


@pytest.mark.asyncio
async def test_listings_price_filter_converts_aed_and_cny(
    client: AsyncClient, session: AsyncSession,
):
    """B-03: AED (÷3.6725) и CNY (÷7.1) тоже конвертируются в USD."""
    aed = await _make_listing(
        session,
        source="dubizzle",
        source_id="aed-1",
        price=Decimal("73450"),  # ≈ $20 000
        currency="AED",
    )
    cny = await _make_listing(
        session,
        source="che168",
        source_id="cny-1",
        price=Decimal("213000"),  # = $30 000
        currency="CNY",
    )
    r_aed = await client.get(
        "/api/listings", params={"source": "dubizzle", "price_min": 19000},
    )
    assert aed.id in [item["id"] for item in r_aed.json()["items"]]
    r_cny = await client.get(
        "/api/listings",
        params={"source": "che168", "price_min": 19000, "price_max": 25000},
    )
    cny_ids = [item["id"] for item in r_cny.json()["items"]]
    assert cny.id not in cny_ids  # $30k выше верхней границы окна
    r_cny_full = await client.get(
        "/api/listings", params={"source": "che168", "price_min": 19000},
    )
    assert cny.id in [item["id"] for item in r_cny_full.json()["items"]]


@pytest.mark.asyncio
async def test_listings_sort_mixed_currencies(
    client: AsyncClient, session: AsyncSession,
):
    """B-03: сортировка price_asc смешивает валюты по USD-эквиваленту."""
    usd_20k = await _make_listing(
        session, source="encar", source_id="mix-usd",
        price=Decimal("20000"), currency="USD",
    )
    kzt = await _make_listing(
        session, source="kcar", source_id="mix-kzt",
        price=Decimal("9600000"), currency="KZT",  # = $20 000 ровно
    )
    krw = await _make_listing(
        session, source="encar", source_id="mix-krw",
        price=Decimal("40500000"), currency="KRW",  # = $30 000
    )
    cny = await _make_listing(
        session, source="kcar", source_id="mix-cny",
        price=Decimal("78000"), currency="CNY",  # ≈ $10 986
    )
    r = await client.get("/api/listings", params={"sort": "price_asc"})
    ids = [item["id"] for item in r.json()["items"]]
    assert ids.index(cny.id) < ids.index(usd_20k.id)
    assert ids.index(kzt.id) < ids.index(krw.id)


@pytest.mark.asyncio
async def test_listings_unknown_currency_excluded_from_price_filter(
    client: AsyncClient, session: AsyncSession,
):
    """B-03: невалюта → NULL → вне ценового окна и в конце сортировки."""
    weird = await _make_listing(
        session, source="encar", source_id="cur-x",
        price=Decimal("25000"), currency="XYZ",
    )
    no_currency = await _make_listing(
        session, source="encar", source_id="cur-null",
        price=Decimal("25000"), currency=None,
    )
    priced = await _make_listing(
        session, source="encar", source_id="cur-usd",
        price=Decimal("25000"), currency="USD",
    )
    r = await client.get("/api/listings", params={"price_min": 20000})
    ids = [item["id"] for item in r.json()["items"]]
    assert priced.id in ids
    assert weird.id not in ids
    assert no_currency.id not in ids

    r_sort = await client.get("/api/listings", params={"sort": "price_asc"})
    ids_sort = [item["id"] for item in r_sort.json()["items"]]
    # Невалюта — в конце (nulls_last), но из выдачи не пропадает.
    assert ids_sort.index(priced.id) < ids_sort.index(weird.id)
    assert ids_sort.index(priced.id) < ids_sort.index(no_currency.id)


@pytest.mark.asyncio
async def test_listings_currency_filter(client: AsyncClient, session: AsyncSession):
    krw = await _make_listing(
        session, source_id="krw-2", currency="KRW",
        price=Decimal("30000000"),
    )
    usd = await _make_listing(
        session, source_id="usd-2", currency="USD",
        price=Decimal("20000"),
    )
    r = await client.get("/api/listings", params={"currency": "KRW"})
    ids = [item["id"] for item in r.json()["items"]]
    assert krw.id in ids
    assert usd.id not in ids


@pytest.mark.asyncio
async def test_listings_price_min_max_inverted_422(client: AsyncClient):
    r = await client.get(
        "/api/listings", params={"price_min": 50000, "price_max": 10000},
    )
    assert r.status_code == 422
    assert "price_min" in r.json()["detail"]


# =========================================================================
# list_listings — cross-field валидация
# =========================================================================


@pytest.mark.asyncio
async def test_listings_year_inverted_422(client: AsyncClient):
    r = await client.get(
        "/api/listings", params={"year_from": 2024, "year_to": 2020},
    )
    assert r.status_code == 422
    assert "year_from" in r.json()["detail"]


@pytest.mark.asyncio
async def test_listings_mileage_inverted_422(client: AsyncClient):
    r = await client.get(
        "/api/listings", params={"mileage_min": 100000, "mileage_max": 1000},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_listings_engine_volume_inverted_422(client: AsyncClient):
    r = await client.get(
        "/api/listings",
        params={"engine_volume_min": 3.0, "engine_volume_max": 1.0},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_listings_engine_volume_bounds(client: AsyncClient):
    """le=20 на engine_volume — 25 отклоняется."""
    r = await client.get("/api/listings", params={"engine_volume_min": 25})
    assert r.status_code == 422


# =========================================================================
# list_listings — сортировка
# =========================================================================


@pytest.mark.asyncio
async def test_listings_sort_price_asc_normalizes_krw(
    client: AsyncClient, session: AsyncSession,
):
    """Сортировка price_asc: KRW $22k идёт после USD $20k."""
    usd_20k = await _make_listing(
        session, source_id="u20", price=Decimal("20000"), currency="USD",
    )
    krw_30m = await _make_listing(
        session, source_id="k30", price=Decimal("30000000"), currency="KRW",
    )
    r = await client.get("/api/listings", params={"sort": "price_asc"})
    ids = [item["id"] for item in r.json()["items"]]
    assert ids.index(usd_20k.id) < ids.index(krw_30m.id)


@pytest.mark.asyncio
async def test_listings_sort_price_nulls_last(
    client: AsyncClient, session: AsyncSession,
):
    priced = await _make_listing(
        session, source_id="priced", price=Decimal("20000"),
    )
    no_price = await _make_listing(session, source_id="noprice", price=None)
    r = await client.get("/api/listings", params={"sort": "price_asc"})
    ids = [item["id"] for item in r.json()["items"]]
    assert ids.index(priced.id) < ids.index(no_price.id)


@pytest.mark.asyncio
async def test_listings_sort_invalid_422(client: AsyncClient):
    r = await client.get("/api/listings", params={"sort": "invalid"})
    assert r.status_code == 422


# =========================================================================
# list_listings — пагинация + track
# =========================================================================


@pytest.mark.asyncio
async def test_listings_pagination(client: AsyncClient, session: AsyncSession):
    for i in range(5):
        await _make_listing(session, source_id=f"pag-{i}")
    r = await client.get("/api/listings", params={"limit": 2, "offset": 0})
    body = r.json()
    assert body["total"] == 5
    assert len(body["items"]) == 2

    r2 = await client.get("/api/listings", params={"limit": 2, "offset": 4})
    assert len(r2.json()["items"]) == 1


@pytest.mark.asyncio
async def test_listings_limit_capped(client: AsyncClient):
    r = await client.get("/api/listings", params={"limit": 1000})
    assert r.status_code == 422  # le=50


@pytest.mark.asyncio
async def test_listings_track_failure_does_not_500(
    client: AsyncClient, session: AsyncSession, monkeypatch,
):
    """Сбой analytics не роняет ленту."""
    await _make_listing(session, make="Toyota", source_id="track-1")

    async def failing_track(*a, **kw):
        raise RuntimeError("analytics down")

    monkeypatch.setattr(
        SqlAlchemyListingReadRepository, "record_search", failing_track
    )
    r = await client.get("/api/listings", params={"make": "Toyota"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_listings_no_track_without_user_filters(
    client: AsyncClient, session: AsyncSession, monkeypatch,
):
    """Без пользовательских фильтров track не вызывается."""
    await _make_listing(session, source_id="notrack-1")
    calls = {"n": 0}

    async def counting_track(*a, **kw):
        calls["n"] += 1

    monkeypatch.setattr(
        SqlAlchemyListingReadRepository, "record_search", counting_track
    )
    await client.get("/api/listings")  # без фильтров
    assert calls["n"] == 0


# =========================================================================
# listing_facets
# =========================================================================


@pytest.mark.asyncio
async def test_facets_makes(client: AsyncClient, session: AsyncSession):
    await _make_listing(session, make="Toyota", source_id="f-t")
    await _make_listing(session, make="Kia", source_id="f-k")
    r = await client.get("/api/listings/facets")
    makes = r.json()["makes"]
    assert "Toyota" in makes
    assert "Kia" in makes


@pytest.mark.asyncio
async def test_facets_models_for_make(
    client: AsyncClient, session: AsyncSession,
):
    await _make_listing(session, make="Toyota", model="Camry", source_id="fm-c")
    await _make_listing(session, make="Toyota", model="Corolla", source_id="fm-co")
    await _make_listing(session, make="Kia", model="K5", source_id="fm-k")
    r = await client.get("/api/listings/facets", params={"make": "Toyota"})
    models = r.json()["models"]
    assert "Camry" in models
    assert "Corolla" in models
    assert "K5" not in models


@pytest.mark.asyncio
async def test_facets_make_normalized(
    client: AsyncClient, session: AsyncSession,
):
    """make='тойота' → находит модели Toyota."""
    await _make_listing(session, make="Toyota", model="Camry", source_id="fn-1")
    r = await client.get("/api/listings/facets", params={"make": "тойота"})
    assert "Camry" in r.json()["models"]


@pytest.mark.asyncio
async def test_facets_excludes_inactive(
    client: AsyncClient, session: AsyncSession,
):
    await _make_listing(
        session, make="InactiveBrand", source_id="fi-1", is_active=False,
    )
    r = await client.get("/api/listings/facets")
    assert "InactiveBrand" not in r.json()["makes"]


@pytest.mark.asyncio
async def test_facets_cached_in_redis(
    client: AsyncClient, session: AsyncSession, fake_redis,
):
    """Второй вызов — из кэша; ключ `facets:v2:makes` в Redis (GEO-V1 §2)."""
    await _make_listing(session, make="Toyota", source_id="fc-1")
    await fake_redis.delete("facets:v2:makes")  # на случай предыдущих тестов
    await client.get("/api/listings/facets")
    assert await fake_redis.exists("facets:v2:makes") == 1
    cached_raw = await fake_redis.get("facets:v2:makes")
    assert "Toyota" in json.loads(cached_raw)["makes"]


@pytest.mark.asyncio
async def test_facets_models_cached_per_make(
    client: AsyncClient, session: AsyncSession, fake_redis,
):
    await _make_listing(session, make="Toyota", model="Camry", source_id="fcm-1")
    await fake_redis.delete("facets:v2:models:toyota")
    await client.get("/api/listings/facets", params={"make": "Toyota"})
    assert await fake_redis.exists("facets:v2:models:toyota") == 1


# =========================================================================
# get_listing_by_url
# =========================================================================


@pytest.mark.asyncio
async def test_by_url_found(client: AsyncClient, session: AsyncSession):
    l = await _make_listing(
        session, source_id="url-1", url="https://www.encar.com/a/url-1/",
    )
    r = await client.get(
        "/api/listings/by-url", params={"url": "https://www.encar.com/a/url-1/"},
    )
    assert r.status_code == 200
    assert r.json()["id"] == l.id


@pytest.mark.asyncio
async def test_by_url_normalizes_scheme_and_www(
    client: AsyncClient, session: AsyncSession,
):
    """http://m.encar.com/a/x/ и https://www.encar.com/a/x/ — эквивалентны."""
    l = await _make_listing(
        session, source_id="url-norm",
        url="https://www.encar.com/a/url-norm/",
    )
    r = await client.get(
        "/api/listings/by-url",
        params={"url": "http://m.encar.com/a/url-norm/"},
    )
    assert r.status_code == 200
    assert r.json()["id"] == l.id


@pytest.mark.asyncio
async def test_by_url_not_found(client: AsyncClient):
    r = await client.get(
        "/api/listings/by-url", params={"url": "https://www.encar.com/a/missing/"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_by_url_escapes_percent(
    client: AsyncClient, session: AsyncSession,
):
    """URL с `%` не должен матчить всё подряд (не 500, не чужой листинг)."""
    await _make_listing(session, source_id="esc-1", url="https://www.encar.com/a/1/")
    r = await client.get(
        "/api/listings/by-url", params={"url": "https://www.encar.com/a/1%"},
    )
    # 422 (слишком короткий? 1% + префикс — норм) или 404 — но не 500
    assert r.status_code in (404, 409)


@pytest.mark.asyncio
async def test_by_url_escapes_underscore(
    client: AsyncClient, session: AsyncSession,
):
    """`_` в URL не должен быть wildcard'ом."""
    l = await _make_listing(
        session, source_id="esc-u", url="https://www.encar.com/a/esc-u/",
    )
    r = await client.get(
        "/api/listings/by-url", params={"url": "https://www.encar.com/a/esc-u/"},
    )
    assert r.status_code == 200
    assert r.json()["id"] == l.id


@pytest.mark.asyncio
async def test_by_url_ambiguous_409(
    client: AsyncClient, session: AsyncSession,
):
    """Два объявления с похожим URL → 409, не 500."""
    await _make_listing(
        session, source_id="amb-1", url="https://www.encar.com/a/123/",
    )
    await _make_listing(
        session, source_id="amb-2", url="https://www.encar.com/a/123/x/",
    )
    r = await client.get(
        "/api/listings/by-url", params={"url": "https://www.encar.com/a/123/"},
    )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_by_url_too_short_422(client: AsyncClient):
    """min_length=8 в Query ловит, но needle < 10 после _norm_url — 422."""
    r = await client.get("/api/listings/by-url", params={"url": "https://a.b/"})
    # "https://a.b/" = 12 символов, needle = "a.b/" (4 символа) → 422
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_by_url_excludes_inactive(
    client: AsyncClient, session: AsyncSession,
):
    await _make_listing(
        session, source_id="inact-url",
        url="https://www.encar.com/a/inact-url/",
        is_active=False,
    )
    r = await client.get(
        "/api/listings/by-url",
        params={"url": "https://www.encar.com/a/inact-url/"},
    )
    assert r.status_code == 404


# =========================================================================
# get_listing (PDP)
# =========================================================================


@pytest.mark.asyncio
async def test_pdp_found_with_price_history(
    client: AsyncClient, session: AsyncSession,
):
    l = await _make_listing(session, source_id="pdp-1")
    now = datetime.now(UTC)
    await _make_price_history(
        session, l.id,
        [(25000.0, now - timedelta(days=30)), (22000.0, now - timedelta(days=1))],
    )
    r = await client.get(f"/api/listings/{l.id}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == l.id
    assert len(body["price_history"]) == 2
    # Хронологический порядок: старые сначала
    assert body["price_history"][0]["price"] > body["price_history"][1]["price"]


@pytest.mark.asyncio
async def test_pdp_inactive_404(client: AsyncClient, session: AsyncSession):
    l = await _make_listing(session, source_id="pdp-inact", is_active=False)
    r = await client.get(f"/api/listings/{l.id}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_pdp_not_found(client: AsyncClient):
    r = await client.get("/api/listings/999999999")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_pdp_id_zero_rejected(client: AsyncClient):
    r = await client.get("/api/listings/0")
    assert r.status_code == 422  # Path(ge=1)


@pytest.mark.asyncio
async def test_pdp_enrich_failure_does_not_500(
    client: AsyncClient, session: AsyncSession, monkeypatch,
):
    l = await _make_listing(session, source_id="pdp-enrich")

    async def failing_enrich(*a, **kw):
        raise RuntimeError("encar timeout")

    monkeypatch.setattr(
        SqlAlchemyListingReadRepository, "enrich", failing_enrich
    )
    r = await client.get(f"/api/listings/{l.id}")
    assert r.status_code == 200
    assert r.json()["id"] == l.id


# =========================================================================
# get_inspection
# =========================================================================


@pytest.mark.asyncio
async def test_inspection_found(
    client: AsyncClient, session: AsyncSession, user, auth_headers_user
):
    # Чеки — платные данные (экономика 2026-10): смотрит pro-пользователь.
    user.subscription_tier = "pro"
    user.subscription_until = datetime.now(UTC) + timedelta(days=30)
    await session.flush()
    l = await _make_listing(session, source_id="insp-1")
    report = await _make_inspection(session, l.id, grade="excellent")
    r = await client.get(f"/api/listings/{l.id}/inspection",
                         headers=auth_headers_user)
    assert r.status_code == 200
    # InspectionReportOut — публичная схема PDP: id/listing_id наружу не отдаются
    assert r.json()["inspector"] == report.inspector
    assert r.json()["grade"] == "excellent"


@pytest.mark.asyncio
async def test_inspection_not_found(
    client: AsyncClient, session: AsyncSession, user, auth_headers_user
):
    user.subscription_tier = "pro"
    user.subscription_until = datetime.now(UTC) + timedelta(days=30)
    await session.flush()
    l = await _make_listing(session, source_id="insp-none")
    r = await client.get(f"/api/listings/{l.id}/inspection",
                         headers=auth_headers_user)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_inspection_locked_for_free(
    client: AsyncClient, session: AsyncSession, user, auth_headers_user
):
    """Free не видит чеки — 403 с приглашением на Pro."""
    l = await _make_listing(session, source_id="insp-free")
    await _make_inspection(session, l.id)
    r = await client.get(f"/api/listings/{l.id}/inspection",
                         headers=auth_headers_user)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_inspection_inactive_listing_404(
    client: AsyncClient, session: AsyncSession, user, auth_headers_user
):
    user.subscription_tier = "pro"
    user.subscription_until = datetime.now(UTC) + timedelta(days=30)
    await session.flush()
    l = await _make_listing(session, source_id="insp-inact", is_active=False)
    await _make_inspection(session, l.id)
    r = await client.get(f"/api/listings/{l.id}/inspection",
                         headers=auth_headers_user)
    assert r.status_code == 404


# =========================================================================
# upsert_inspection
# =========================================================================


@pytest.mark.asyncio
async def test_upsert_inspection_requires_admin(
    client: AsyncClient, session: AsyncSession, auth_headers_user,
):
    l = await _make_listing(session, source_id="ups-403")
    r = await client.put(
        f"/api/listings/{l.id}/inspection",
        json=_inspection_payload(),
        headers=auth_headers_user,
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_upsert_inspection_creates(
    client: AsyncClient, session: AsyncSession, auth_headers_admin,
):
    l = await _make_listing(session, source_id="ups-create")
    r = await client.put(
        f"/api/listings/{l.id}/inspection",
        json=_inspection_payload(grade="good"),
        headers=auth_headers_admin,
    )
    assert r.status_code == 200
    assert r.json()["grade"] == "good"
    saved = (
        await session.execute(
            select(InspectionReport).where(InspectionReport.listing_id == l.id)
        )
    ).scalars().all()
    assert [x.listing_id for x in saved] == [l.id]


@pytest.mark.asyncio
async def test_upsert_inspection_updates_existing(
    client: AsyncClient, session: AsyncSession, auth_headers_admin,
):
    l = await _make_listing(session, source_id="ups-update")
    await _make_inspection(session, l.id, grade="fair")
    r = await client.put(
        f"/api/listings/{l.id}/inspection",
        json=_inspection_payload(grade="excellent"),
        headers=auth_headers_admin,
    )
    assert r.status_code == 200
    assert r.json()["grade"] == "excellent"

    # Проверяем, что в БД одна запись, а не две
    count = (
        await session.execute(
            select(InspectionReport).where(InspectionReport.listing_id == l.id)
        )
    ).scalars().all()
    assert len(count) == 1


@pytest.mark.asyncio
async def test_upsert_inspection_listing_not_found(
    client: AsyncClient, auth_headers_admin,
):
    r = await client.put(
        "/api/listings/999999999/inspection",
        json=_inspection_payload(),
        headers=auth_headers_admin,
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_upsert_inspection_allows_inactive_listing(
    client: AsyncClient, session: AsyncSession, auth_headers_admin,
):
    """Admin может осматривать неактивные объявления."""
    l = await _make_listing(session, source_id="ups-inact", is_active=False)
    r = await client.put(
        f"/api/listings/{l.id}/inspection",
        json=_inspection_payload(),
        headers=auth_headers_admin,
    )
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_upsert_inspection_sets_updated_at(
    client: AsyncClient, session: AsyncSession, auth_headers_admin,
):
    l = await _make_listing(session, source_id="ups-updated")
    r = await client.put(
        f"/api/listings/{l.id}/inspection",
        json=_inspection_payload(),
        headers=auth_headers_admin,
    )
    assert r.status_code == 200
    # updated_at не входит в InspectionReportOut — проверяем значение в БД
    report = (
        await session.execute(
            select(InspectionReport).where(InspectionReport.listing_id == l.id)
        )
    ).scalar_one_or_none()
    assert report is not None and report.updated_at is not None
    parsed = report.updated_at
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    assert (datetime.now(UTC) - parsed).total_seconds() < 60


@pytest.mark.asyncio
async def test_upsert_inspection_id_zero_rejected(
    client: AsyncClient, auth_headers_admin,
):
    r = await client.put(
        "/api/listings/0/inspection",
        json=_inspection_payload(),
        headers=auth_headers_admin,
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_upsert_inspection_logs(
    client: AsyncClient, session: AsyncSession, auth_headers_admin, caplog,
):
    import logging
    l = await _make_listing(session, source_id="ups-log")
    with caplog.at_level(logging.INFO):
        await client.put(
            f"/api/listings/{l.id}/inspection",
            json=_inspection_payload(grade="poor"),
            headers=auth_headers_admin,
        )
    assert "inspection_upserted" in caplog.text
    assert f"listing_id={l.id}" in caplog.text


# =========================================================================
# Хелперы
# =========================================================================


def _inspection_payload(*, grade: str = "good") -> dict:
    return {
        "source": "manual",
        "inspector": "inspector-1",
        "inspected_at": datetime.now(UTC).isoformat(),
        "grade": grade,
        "summary": "ok",
        "marks": [],
        "items": [],
    }


# =========================================================================
# Требуемые фикстуры (в conftest.py)
# =========================================================================
"""
@pytest.fixture
async def client(app) -> AsyncClient: ...

@pytest.fixture
async def session(engine) -> AsyncSession: ...

@pytest.fixture
async def fake_redis() -> Redis: ...
    # fakeredis.FakeAsyncRedis(decode_responses=False)
    # ВАЖНО: decode_responses=False, иначе json.loads(bytes) упадёт в facets
    # (мы возвращаем bytes и делаем json.loads — работает для bytes и str).

@pytest.fixture
async def user(session) -> User: ...

@pytest.fixture
async def admin(session) -> User:
    # role="admin"

@pytest.fixture
async def inactive_user(session) -> User:
    # is_active=False

@pytest.fixture
async def auth_headers_user(user) -> dict:
    # JWT с sub=user.telegram_id

@pytest.fixture
async def auth_headers_admin(admin) -> dict:
    # JWT с sub=admin.telegram_id

@pytest.fixture
async def internal_token() -> str:
    # значение из settings.internal_token

Фикстуры `client`, `session`, `fake_redis`, `auth_headers_*` —
стандартные для проекта. Если в `conftest.py` они называются иначе,
адаптировать имена в этом файле.
"""