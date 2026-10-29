"""IP-rate-limit для незащищённых эндпоинтов (TECHDEBT 1.4).

Фиксированное окно в Redis: `INCR` + `EXPIRE` при создании ключа.
Не атомарно (в отличие от Lua-квот 5.4), но для защиты от массового
создания гостей это осознанный компромисс: в худшем случае окно
первого запроса чуть «растягивается», злоумышленнику это не помощь.

IP клиента (AUTH-01, аудит 2026-10-29): `X-Real-IP`, иначе ПРАВЫЙ
(последний) IP цепочки `X-Forwarded-For` — его дописал доверенный
прокси (nginx миниаппа ставит `$proxy_add_x_forwarded_for`), а не
клиент; левую часть цепочки клиент подделывает одним заголовком.
Fallback — `request.client.host`.
"""

from __future__ import annotations

import logging
import time

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

_GUEST_LIMIT_DEFAULT = 5  # созданий сессий с одного IP в минуту
_WINDOW_SEC = 60
_PREFIX = "rl:guest"


async def guest_ip_allowed(
    redis: Redis,
    ip: str,
    *,
    limit: int = _GUEST_LIMIT_DEFAULT,
    window_sec: int = _WINDOW_SEC,
) -> bool:
    """`True`, если с этого IP ещё можно создать гостевую сессию.

    Args:
        redis: Клиент Redis (счётчик `rl:guest:{ip}:{window_number}`).
        ip: IP клиента (после normalизации X-Forwarded-For).
        limit: Максимум созданий за окно.
        window_sec: Размер окна, секунд.

    Returns:
        `False`, если лимит исчерпан (транспорт отвечает 429).
    """
    bucket = int(_now() // window_sec)
    key = f"{_PREFIX}:{ip}:{bucket}"
    try:
        count = int(await redis.incr(key))  # type: ignore[attr-defined]
        if count == 1:
            await redis.expire(key, window_sec + 5)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 — Redis лёг: не блокируем гостей (fail-open)
        logger.warning("guest_rate_limit_unavailable", exc_info=True)
        return True
    return count <= limit


def client_ip(
    forwarded_for: str | None, host: str | None, real_ip: str | None = None
) -> str:
    """IP клиента для rate-limit: `X-Real-IP` → правый XFF → host.

    AUTH-01: ПЕРВЫЙ элемент `X-Forwarded-For` полностью контролируется
    клиентом (один заголовок — и лимит ключуется по новому «IP»), поэтому
    берём ПОСЛЕДНИЙ непустой элемент цепочки: его дописал доверенный
    прокси на пути к нам, и это адрес, который прокси видел как адрес
    клиента. `X-Real-IP` (тоже ставит наш nginx) приоритетнее, потому
    что не накапливает хвосты чужих прокси. Fallback — прямой адрес
    соединения `request.client.host`.

    Args:
        forwarded_for: Заголовок `X-Forwarded-For` или `None`.
        host: `request.client.host` или `None`.
        real_ip: Заголовок `X-Real-IP` или `None`.

    Returns:
        Нормализованный IP (или `"unknown"`).
    """
    if real_ip and real_ip.strip():
        return real_ip.strip()
    if forwarded_for:
        # Справа налево: спуф-префиксы клиента слева игнорируем.
        for part in reversed(forwarded_for.split(",")):
            candidate = part.strip()
            if candidate:
                return candidate
    return (host or "unknown").strip() or "unknown"


def _now() -> float:
    """Текущее время (вынесено для тестов)."""
    return time.time()