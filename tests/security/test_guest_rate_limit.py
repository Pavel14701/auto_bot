"""TECHDEBT 1.4: IP-rate-limit на POST /api/auth/guest."""

from app.config import get_settings
from app.infrastructure.security.ip_limit import client_ip, guest_ip_allowed
from tests.conftest import FakeRedis


def test_client_ip_takes_last_forwarded_hop():
    """AUTH-01: берём ПРАВЫЙ IP цепочки XFF — его дописал доверенный прокси.

    Спуф-префикс клиента слева («1.2.3.4, ...») не должен подменять ключ
    лимита: реальный клиент — последний элемент.
    """
    assert client_ip("1.2.3.4, 203.0.113.9", "testclient") == "203.0.113.9"
    assert client_ip("1.2.3.4", None) == "1.2.3.4"  # один хоп — как есть
    # пустые элементы цепочки пропускаются справа налево
    assert client_ip("1.2.3.4, , 203.0.113.9,", None) == "203.0.113.9"


def test_client_ip_prefers_real_ip():
    """X-Real-IP (его ставит наш nginx) приоритетнее XFF."""
    assert (
        client_ip("1.2.3.4, 10.0.0.1", "testclient", real_ip="203.0.113.7")
        == "203.0.113.7"
    )


def test_client_ip_fallbacks():
    assert client_ip(None, "5.6.7.8") == "5.6.7.8"
    assert client_ip(None, None) == "unknown"
    assert client_ip("", "  ") == "unknown"


async def test_guest_ip_allowed_within_limit():
    r = FakeRedis()
    for _ in range(5):
        assert await guest_ip_allowed(r, "1.2.3.4") is True
    assert await guest_ip_allowed(r, "1.2.3.4") is False


async def test_guest_ip_limit_per_ip_isolated():
    r = FakeRedis()
    assert await guest_ip_allowed(r, "1.1.1.1") is True
    for _ in range(5):
        await guest_ip_allowed(r, "2.2.2.2")
    assert await guest_ip_allowed(r, "2.2.2.2") is False
    assert await guest_ip_allowed(r, "1.1.1.1") is True


async def test_guest_ip_custom_limit():
    r = FakeRedis()
    assert await guest_ip_allowed(r, "3.3.3.3", limit=2) is True
    assert await guest_ip_allowed(r, "3.3.3.3", limit=2) is True
    assert await guest_ip_allowed(r, "3.3.3.3", limit=2) is False


async def test_redis_down_fail_open():
    class Broken:
        async def incr(self, key):  # pragma: no cover — путь исключения
            raise ConnectionError("redis down")

    assert await guest_ip_allowed(Broken(), "4.4.4.4") is True  # fail-open


async def test_api_guest_rate_limited(client, monkeypatch):
    """Интеграция: превышение лимита → 429 (лимит занижен через Settings)."""
    monkeypatch.setattr(get_settings(), "guest_ip_rate_limit", 2)
    first = await client.post("/api/auth/guest")
    second = await client.post("/api/auth/guest")
    third = await client.post("/api/auth/guest")
    assert first.status_code == 201
    assert second.status_code == 201
    assert third.status_code == 429