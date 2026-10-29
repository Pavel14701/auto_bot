"""Дедупликация (ТЗ п. 6.10).

- Внутри источника: уникальный индекс `(source, source_id)` в БД; повторный
  фетч известной пары ДОЛЖЕН доходить до upsert (обновление цены/контента,
  `last_seen_at`), поэтому src-ключи своего источника не считаются дублем.
- Между источниками: кросс-ключи по VIN или fuzzy-хэш (без source),
  TTL 48 часов в Redis — «первый источник выигрывает» для НОВЫХ лотов.
  Повторный фетч лота, уже известного в своей паре `(source, source_id)`,
  дедупом не отбрасывается (см. `_RedisDuplicates` в services/fetch.py).

Ключи версионированы: при изменении состава/нормализации ключа нужно
поднять `_DEDUP_VERSION` — старые ключи истекут за TTL, ручная миграция
не требуется.
"""

import hashlib
import logging
from typing import Any

from redis.asyncio import Redis

from app.domain.listings.unified import UnifiedListing

logger = logging.getLogger(__name__)

DEDUP_TTL_SEC = 48 * 60 * 60  # 48 часов
# Формат кросс-ключей не менялся с v3; src-ключи (`...:src:{source}:...`) —
# новое пространство имён внутри той же версии: in-flight кросс-claim'ы
# деплоя переживают, bump версии не нужен.
_DEDUP_VERSION = "v3"  # bump при изменении состава/normalization ключей
# TECHDEBT 3.2: пробег в fuzzy-ключе округляется до кратного 1000 км —
# счётчик пробега гуляет между заходами парсера на единицы км.
_MILEAGE_ROUND_KM = 1000

# Атомарно (B-04): KEYS[1..ARGV[1]] — src-ключи СВОЕГО источника, остальные
# KEYS — кросс-ключи. Если существует любой src-ключ → это повторный фетч
# лота своим источником: вернуть 1 («не дубль»), состояние не менять —
# апдейт должен дойти до upsert. Иначе если существует любой кросс-ключ →
# лот уже забрал другой источник: вернуть 0 (межисточниковый дубль).
# Иначе выставить ВСЕ ключи с TTL и вернуть 1. Без «всё или ничего»
# частичный SET «отравлял» бы ключи отклонённых объявлений.
_CLAIM_SCRIPT = """
local nsrc = tonumber(ARGV[1])
for i = 1, nsrc do
    if redis.call("EXISTS", KEYS[i]) == 1 then
        return 1
    end
end
for i = 1, #KEYS do
    if redis.call("EXISTS", KEYS[i]) == 1 then
        return 0
    end
end
for i = 1, #KEYS do
    redis.call("SET", KEYS[i], "1", "EX", ARGV[2])
end
return 1
"""

_RELEASE_SCRIPT = """
local deleted = 0
for i = 1, #KEYS do
    deleted = deleted + redis.call("DEL", KEYS[i])
end
return deleted
"""


def _norm_str(value: str | None) -> str:
    """Нормализует строковое поле: trim, lower, коллапс внутренних пробелов.

    Args:
        value: Исходное значение или `None`.

    Returns:
        Нормализованная строка; `"-"` для `None`/пустой строки.
    """
    if value is None:
        return "-"
    normalized = " ".join(value.strip().lower().split())
    return normalized or "-"


def _norm_int(value: Any) -> str:
    """Канонизирует числовое поле в целое.

    `Decimal("50000.0")` и `Decimal("50000")` дают один и тот же ключ.

    Args:
        value: Исходное значение (int/float/Decimal/str/None).

    Returns:
        Строка целого числа; `"-"` для `None`/невалидного значения.
    """
    if value is None:
        return "-"
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return "-"


def _norm_price(value: Any) -> str:
    """Канонизирует цену: округление до целого доллара, явное поведение.

    Раньше использовался `int(price)` (truncation) — `$19,999.99` и
    `$20,000.00` давали разные ключи, а `$20,000.01` и `$20,000.99` — один.
    `round()` семантически корректнее для «цены в целых долларах».

    Args:
        value: Исходное значение цены (int/float/Decimal/str/None).

    Returns:
        Строка целого числа; `"-"` для `None`/невалидного значения.
    """
    if value is None:
        return "-"
    try:
        return str(int(round(float(value))))
    except (TypeError, ValueError, OverflowError):
        return "-"


def _norm_mileage(value: Any) -> str:
    """Канонизирует пробег: целое, округлённое до кратного 1000 км.

    TECHDEBT 3.2: парсер может прочитать 84 350 км в одном заходе и
    84 410 км в следующем — без округления это «два разных объявления».

    Args:
        value: Исходное значение пробега (int/float/Decimal/str/None).

    Returns:
        Строка целого, кратного `_MILEAGE_ROUND_KM`; `"-"` для
        `None`/невалидного значения.
    """
    if value is None:
        return "-"
    try:
        km = int(round(float(value)))
    except (TypeError, ValueError, OverflowError):
        return "-"
    rounded = int(round(km / _MILEAGE_ROUND_KM)) * _MILEAGE_ROUND_KM
    return str(rounded)


def vin_key(vin: str) -> str:
    """Redis-КРОСС-ключ дедупа по VIN (межисточниковый, без source).

    Args:
        vin: VIN (непустой после `.strip()`).

    Returns:
        Ключ вида `dedup:{ver}:vin:{sha256}`.

    Raises:
        ValueError: Если VIN пустой после нормализации (защита от коллизии
            `sha256("")` для всех пустых VIN).
    """
    normalized = vin.strip().upper()
    if not normalized:
        raise ValueError("VIN is empty after normalization")
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return f"dedup:{_DEDUP_VERSION}:vin:{digest}"


def fuzzy_key(listing: UnifiedListing) -> str:
    """Redis-КРОСС-ключ по make+model+year+mileage (без цены и source).

    TECHDEBT 3.2: `price` исключён — смена цены («снизил цену, чтобы
    продать») не должна рождать «новое» объявление: это тот же лот.
    `mileage_km` округляется до 1000 км — счётчик пробега гуляет между
    заходами парсера, точное равенство здесь вредно.

    Числовые поля канонизируются (`_norm_int`/`_norm_mileage`), чтобы
    `Decimal("50000")` и `Decimal("50000.0")` давали одинаковый ключ.

    Args:
        listing: Унифицированное объявление.

    Returns:
        Ключ вида `dedup:{ver}:fuzzy:{sha256}`.
    """
    parts = "|".join(
        (
            _norm_str(listing.make),
            _norm_str(listing.model),
            _norm_int(listing.year),
            _norm_mileage(listing.mileage_km),
        )
    )
    digest = hashlib.sha256(parts.encode("utf-8")).hexdigest()
    return f"dedup:{_DEDUP_VERSION}:fuzzy:{digest}"


def _dedup_keys(listing: UnifiedListing) -> list[str]:
    """Собирает непустые КРОСС-ключи дедупа (межисточниковые).

    Пустые/пробельные VIN, make, model игнорируются: `sha256("")` иначе
    схлопнул бы все такие объявления в один «дубль».

    Args:
        listing: Унифицированное объявление.

    Returns:
        Список ключей (0, 1 или 2 элемента).
    """
    keys: list[str] = []
    vin = (listing.vin or "").strip()
    if vin:
        keys.append(vin_key(vin))
    make = (listing.make or "").strip()
    model = (listing.model or "").strip()
    if make and model:
        keys.append(fuzzy_key(listing))
    return keys


def _source_keys(listing: UnifiedListing, cross_keys: list[str]) -> list[str]:
    """Src-ключи СВОЕГО источника — зеркально кросс-ключам с prefix source.

    Существование src-ключа = «этот источник уже недавно фетчил этот лот» —
    повторный фетч (апдейт цены/контента), а не новый межисточниковый дубль.

    Args:
        listing: Унифицированное объявление (source нормализуется lower).
        cross_keys: Кросс-ключи из `_dedup_keys` (хранят тип vin/fuzzy).

    Returns:
        Ключи вида `dedup:{ver}:src:{source}:{vin|fuzzy}:{sha256}`;
        порядок соответствует `cross_keys`.
    """
    source = (listing.source or "").strip().lower()
    # Кросс-ключ имеет вид `dedup:{ver}:{kind}:{digest}` — вставляем src.
    return [key.replace(f":{_DEDUP_VERSION}:", f":{_DEDUP_VERSION}:src:{source}:", 1)
            for key in cross_keys]


async def claim(redis: Redis, listing: UnifiedListing) -> bool:
    """Атомарно «забирает» объявление: `True` — новое/повтор своего источника.

    Семантика (B-04):
    - существует src-ключ своего источника → `True` (повторный фетч того же
      лота, состояние Redis не меняется — апдейт дойдёт до upsert);
    - существует кросс-ключ (у другого источника) → `False` (межисточниковый
      дубль нового лота, состояние не меняется);
    - иначе выставляются ВСЕ ключи (src + кросс) с TTL → `True`.

    Если после `claim` вставка в БД упала — вызывающий **обязан** вызвать
    `release(redis, listing)`, иначе объявление потеряется до истечения TTL.

    Args:
        redis: Клиент Redis.
        listing: Унифицированное объявление.

    Returns:
        `True` — лот новый или повторно фетчится своим источником;
        `False` — новый лот, дублирующий другой источник.
    """
    cross_keys = _dedup_keys(listing)
    if not cross_keys:
        return True  # нечего дедуплицировать — считаем новым
    src_keys = _source_keys(listing, cross_keys)
    keys = [*src_keys, *cross_keys]
    result = await redis.eval(
        _CLAIM_SCRIPT, len(keys), *keys, len(src_keys), DEDUP_TTL_SEC
    )
    claimed = bool(result)
    if not claimed:
        logger.debug(
            "dedup rejected listing source=%s id=%s", listing.source, listing.source_id
        )
    return claimed


async def release(redis: Redis, listing: UnifiedListing) -> None:
    """Откатывает `claim` (best-effort): удаляет ключи объявления.

    Вызывать при любом исключении после успешного `claim`, но до
    подтверждённой вставки в БД (commit/refresh).

    Args:
        redis: Клиент Redis.
        listing: Унифицированное объявление.
    """
    cross_keys = _dedup_keys(listing)
    if not cross_keys:
        return
    keys = [*(_source_keys(listing, cross_keys)), *cross_keys]
    try:
        await redis.eval(_RELEASE_SCRIPT, len(keys), *keys)
    except Exception:  # noqa: BLE001 — release не должен маскировать исходную ошибку
        logger.exception(
            "dedup release failed source=%s id=%s", listing.source, listing.source_id
        )


async def is_duplicate(redis: Redis, listing: UnifiedListing) -> bool:
    """True, если НОВЫЙ лот дублирует другой источник за TTL.

    Повторный фетч лота своим источником (src-ключ существует) — не дубль.
    Обёртка над `claim` для обратной совместимости. **Побочный эффект
    сохранён**: при `False` ключи выставлены. Вызывающий код должен
    обрабатывать откат через `release` при ошибке вставки в БД.

    Args:
        redis: Клиент Redis.
        listing: Унифицированное объявление.

    Returns:
        `True` — межисточниковый дубль, `False` — новое/повтор своего источника.
    """
    return not await claim(redis, listing)


def raw_payload(listing: UnifiedListing) -> dict[str, Any]:
    """Сырые данные объявления для S3-объекта (перепарсинг; PLAN.md, фаза 6).

    Раньше писалcя в колонку listings.raw_payload (миграция 0012 выпилила её):
    теперь кладётся в MinIO ключом raw/{source}/{yyyy}/{mm}/{id}_{hash}.json.

    `dedup_keys` помечены `_internal` — формат служебный, не для внешних
    потребителей; SHA-256 от VIN не должен утекать в публичные артефакты.

    Args:
        listing: Унифицированное объявление.

    Returns:
        Словарь для сериализации в S3.
    """
    return {
        "source": listing.source,
        "schema_version": listing.schema_version,
        "raw": listing.raw,
        "_internal": {"dedup_keys": _dedup_keys(listing)},
    }
