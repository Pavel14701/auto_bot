"""Тесты дедупликации (ТЗ п. 6.10)."""

import asyncio
from decimal import Decimal

import pytest

from app.infrastructure.sources.common.dedup import (
    _dedup_keys,
    claim,
    fuzzy_key,
    is_duplicate,
    release,
    vin_key,
)
from app.domain.listings.unified import UnifiedListing
from tests.conftest import FakeRedis


class _EvalRedis(FakeRedis):
    """FakeRedis + `eval()` для Lua-скриптов claim/release из dedup.py.

    Повторяет `_CLAIM_SCRIPT` (B-04): src-ключи своего источника — проход
    (повторный фетч), кросс-ключи — дубль; иначе выставить всё с TTL.
    """

    async def eval(self, script: str, numkeys: int, *args):
        keys = [str(k) for k in args[:numkeys]]
        if "EXISTS" in script:  # _CLAIM_SCRIPT
            nsrc = int(args[numkeys]) if len(args) > numkeys else 0
            ttl = int(args[numkeys + 1]) if len(args) > numkeys + 1 else None
            src_keys, cross_keys = keys[:nsrc], keys[nsrc:]
            if any(k in self.data for k in src_keys):
                return 1  # свой источник уже фетчил лот — не дубль
            if any(k in self.data for k in keys):
                return 0  # кросс-ключ занят другим источником
            for key in keys:
                self.data[key] = "1"
                if ttl:
                    self.ttls[key] = ttl
            return 1
        removed = 0  # _RELEASE_SCRIPT
        for key in keys:
            if key in self.data:
                del self.data[key]
                removed += 1
        return removed


@pytest.fixture
def fake_redis() -> _EvalRedis:
    """Local override: conftest.FakeRedis не реализует `eval()`."""
    return _EvalRedis()


def _listing(**overrides) -> UnifiedListing:
    defaults = dict(
        source="encar",
        source_id="1",
        url="https://encar.com/1",
        make="Hyundai",
        model="Palisade",
        year=2022,
        mileage_km=42000,
        price=38500000,
        currency="KRW",
    )
    defaults.update(overrides)
    return UnifiedListing(**defaults)


def test_vin_key_deterministic_and_normalized():
    assert vin_key("ABC123") == vin_key(" abc123 ")
    assert vin_key("ABC123") != vin_key("XYZ789")
    assert vin_key("ABC123").startswith("dedup:v3:vin:")


def test_fuzzy_key_same_car():
    assert fuzzy_key(_listing()) == fuzzy_key(_listing(source="kcar", source_id="999"))


def test_fuzzy_key_different_car():
    assert fuzzy_key(_listing()) != fuzzy_key(_listing(year=2023))


async def test_is_duplicate_first_time_false(fake_redis: FakeRedis):
    assert await is_duplicate(fake_redis, _listing(vin="VIN123")) is False
    # B-04: повторный фетч того же лота СВОИМ источником — не дубль
    # (апдейт цены/контента должен доходить до upsert, а не ждать TTL).
    assert await is_duplicate(fake_redis, _listing(vin="VIN123")) is False
    # другой источник с тем же VIN — межисточниковый дубль.
    assert await is_duplicate(
        fake_redis, _listing(vin="VIN123", source="kcar", source_id="42")
    ) is True


async def test_is_duplicate_cross_source(fake_redis: FakeRedis):
    first = _listing()  # без VIN → fuzzy
    second = _listing(source="kcar", source_id="777")
    assert await is_duplicate(fake_redis, first) is False
    assert await is_duplicate(fake_redis, second) is True


async def test_same_source_refetch_not_dropped(fake_redis: FakeRedis):
    """B-04: повторный фетч того же (source, source_id) проходит к upsert."""
    first = _listing(vin="KMHxx", source="encar", source_id="100")
    assert await claim(fake_redis, first) is True
    # тот же лот повторно (цена могла измениться) — не отбрасывать.
    again = _listing(vin="KMHxx", source="encar", source_id="100", price=1)
    assert await claim(fake_redis, again) is True
    # а новый лот другого источника с тем же VIN — дубль.
    assert await claim(
        fake_redis, _listing(vin="KMHxx", source="kcar", source_id="900")
    ) is False



# tests/core/test_dedup.py

@pytest.mark.asyncio
async def test_partial_claim_does_not_poison_vin(fake_redis):
    """Регрессия: при кросс-дубле по fuzzy VIN не должен оставаться занятым."""
    a = _listing(vin="1HGCM", make="Toyota", model="Camry", year=2020,
                 mileage_km=50000, price=20000)
    assert await claim(fake_redis, a) is True

    b = _listing(vin="2XYZ", source="kcar", source_id="8", make="Toyota",
                 model="Camry", year=2020,
                 mileage_km=50000, price=20000)  # другой VIN, те же цифры
    assert await claim(fake_redis, b) is False  # кросс-дубль по fuzzy

    # VIN 2XYZ не должен быть занят: следующий листинг с этим VIN — новый
    c = _listing(vin="2XYZ", make="Honda", model="Accord", year=2021,
                 mileage_km=10000, price=25000)
    assert await claim(fake_redis, c) is True


@pytest.mark.asyncio
async def test_release_allows_retry(fake_redis):
    a = _listing(vin="1HGCM", make="Toyota", model="Camry", year=2020,
                 mileage_km=50000, price=20000)
    assert await claim(fake_redis, a) is True
    await release(fake_redis, a)              # имитация сбоя commit
    assert await claim(fake_redis, a) is True  # ретрай проходит


def test_empty_vin_skipped():
    l = _listing(vin="   ", make="Toyota", model="Camry", year=2020,
                 mileage_km=50000, price=20000)
    keys = _dedup_keys(l)
    assert all(":vin:" not in k for k in keys)


def test_fuzzy_decimal_mileage_same_key():
    a = _listing(vin=None, make="Toyota", model="Camry", year=2020,
                 mileage_km=Decimal("50000"), price=20000)
    b = _listing(vin=None, make="Toyota", model="Camry", year=2020,
                 mileage_km=Decimal("50000.0"), price=20000)
    assert fuzzy_key(a) == fuzzy_key(b)


def test_fuzzy_price_ignored():
    """TECHDEBT 3.2: цена не входит в fuzzy-ключ — смена цены = тот же лот."""
    a = _listing(vin=None, make="X", model="Y", year=2020,
                 mileage_km=1, price=19999.6)
    b = _listing(vin=None, make="X", model="Y", year=2020,
                 mileage_km=1, price=20000.0)
    c = _listing(vin=None, make="X", model="Y", year=2020,
                 mileage_km=1, price=None)
    assert fuzzy_key(a) == fuzzy_key(b) == fuzzy_key(c)


def test_fuzzy_mileage_rounds_to_1000():
    """TECHDEBT 3.2: пробег округляется до 1000 км (счётчик гуляет)."""
    a = _listing(vin=None, make="X", model="Y", year=2020, mileage_km=84350)
    b = _listing(vin=None, make="X", model="Y", year=2020, mileage_km=84410)
    c = _listing(vin=None, make="X", model="Y", year=2020, mileage_km=85000)
    assert fuzzy_key(a) == fuzzy_key(b)
    assert fuzzy_key(a) != fuzzy_key(c)


def test_fuzzy_case_and_whitespace():
    a = _listing(vin=None, make="TOYOTA", model="Camry  LE", year=2020,
                 mileage_km=1, price=20000)
    b = _listing(vin=None, make="toyota", model="camry le", year=2020,
                 mileage_km=1, price=20000)
    assert fuzzy_key(a) == fuzzy_key(b)


@pytest.mark.asyncio
async def test_concurrent_claim_one_wins(fake_redis):
    """Lua атомарен: параллельный claim двух источников — один выигрывает."""
    l = _listing(vin="1HGCM", make="Toyota", model="Camry", year=2020,
                 mileage_km=50000, price=20000)
    other = _listing(vin="1HGCM", source="kcar", source_id="7",
                     make="Toyota", model="Camry", year=2020,
                     mileage_km=50000, price=20000)
    results = await asyncio.gather(claim(fake_redis, l), claim(fake_redis, other))
    assert sorted(results) == [False, True]


@pytest.mark.asyncio
async def test_concurrent_refetch_same_source_both_pass(fake_redis):
    """B-04: параллельные повторные фетчи СВОЕГО лота оба проходят."""
    l = _listing(vin="1HGCM", make="Toyota", model="Camry", year=2020,
                 mileage_km=50000, price=20000)
    twin = _listing(vin="1HGCM", source_id="1",
                    make="Toyota", model="Camry", year=2020,
                    mileage_km=50000, price=21000)
    first = await claim(fake_redis, l)
    results = await asyncio.gather(claim(fake_redis, twin), claim(fake_redis, l))
    assert first is True
    assert results == [True, True]  # src-ключ стоит — повтор не дропается