"""Юнит-тесты фикс-курсов MVP (B-03).

Parity с `frontend/src/lib/fx.ts::toUsd` — значения здесь и там должны
меняться одновременно (см. докстринг `app.domain.pricing.rates`).
"""

from decimal import Decimal

from app.domain.pricing.rates import UNITS_PER_USD, to_usd


def test_to_usd_divide_currencies():
    """«N единиц за доллар»: KRW/KZT/CNY/AED/RUB/BYN делятся на курс."""
    assert to_usd(30_000_000, "KRW") == 30_000_000 / 1350
    assert to_usd(12_200_000, "kzt") == 12_200_000 / 480  # регистр неважен
    assert to_usd(Decimal("213000"), "CNY") == 213000 / 7.1
    assert to_usd(73_450, "AED") == 73_450 / 3.6725
    assert to_usd(920_000, "RUB") == 920_000 / 92
    assert to_usd(3_050, "BYN") == 3_050 / 3.05


def test_to_usd_eur_multiplied():
    """EUR котируется «долларов за евро»: цена × 1.08 (fx.ts: EUR_PER_USD)."""
    assert to_usd(10_000, "EUR") == 10_800
    assert to_usd(Decimal("9999"), "eur") == 9999 * 1.08


def test_to_usd_usd_identity_and_unknown_null():
    """USD — как есть; невалюта/пустая цена → None (SQL-семантика NULL)."""
    assert to_usd(20_000, "USD") == 20_000
    assert to_usd(20_000, None) is None
    assert to_usd(20_000, "XYZ") is None
    assert to_usd(None, "KRW") is None
    assert to_usd(0, "KRW") is None
    assert to_usd(-5, "USD") is None


def test_rates_table_covers_geo_sources():
    """Все валюты источников GEO-V1 присутствуют в таблице курсов."""
    for code in ("KRW", "KZT", "CNY", "AED"):
        assert code in UNITS_PER_USD
