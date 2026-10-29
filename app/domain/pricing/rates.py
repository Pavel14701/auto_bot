"""Фикс-курсы MVP для конвертации цен объявлений в USD.

Единая таблица курсов бэкенда (лента: фильтр/сортировка цены). Значения
синхронизированы с `frontend/src/lib/fx.ts` — править только в обеих
сторонах одновременно; позже оба конца переезжают на ежедневный курс
ЦБ/НРБ (один источник бот+веб).

Семантика (повторяет `toUsd` фронта):
- `UNITS_PER_USD` — «N единиц валюты за 1 USD»: USD = price / rate
  (KRW÷1350, KZT÷480, CNY÷7.1, AED÷3.6725, RUB÷92, BYN÷3.05);
- `USD_PER_EUR` — цены в EUR конвертируются умножением: USD = price × 1.08
  (курс котируется «доллар за евро», поэтому направление обратное);
- `USD` — базовая валюта, цена проходит как есть;
- неизвестная/NULL-валюта → конвертация невозможна → NULL (такое
  объявление выпадает из ценовых фильтров и уходит в конец сортировки,
  но остаётся в выдаче без ценовых условий).
"""

from __future__ import annotations

from typing import Any

# Сколько единиц валюты за 1 USD: USD = price / rate (fx.ts: *_PER_USD).
UNITS_PER_USD: dict[str, float] = {
    "KRW": 1350.0,
    "KZT": 480.0,
    "CNY": 7.1,
    "AED": 3.6725,
    "RUB": 92.0,
    "BYN": 3.05,
}

# EUR котируется «долларов за евро»: USD = price × 1.08 (fx.ts: EUR_PER_USD).
USD_PER_EUR = 1.08

# Валюты с обратным направлением конвертации (умножение, не деление).
MULTIPLY_TO_USD: dict[str, float] = {"EUR": USD_PER_EUR}


def to_usd(price: Any, currency: str | None) -> float | None:
    """Конвертация цены в USD по фикс-курсам MVP (parity с fx.ts `toUsd`).

    Args:
        price: Цена в валюте источника (int/float/Decimal/None).
        currency: ISO-код валюты; `None`/пустая → считается неизвестной.

    Returns:
        Цена в USD; `None`, если цены нет, она не положительна или
        валюта неизвестна (NULL-семантика SQL-выражения `_usd_price_expr`).
    """
    if price is None:
        return None
    try:
        value = float(price)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    code = (currency or "").strip().upper()
    if code == "USD":
        return value
    if code in UNITS_PER_USD:
        return value / UNITS_PER_USD[code]
    if code in MULTIPLY_TO_USD:
        return value * MULTIPLY_TO_USD[code]
    return None
