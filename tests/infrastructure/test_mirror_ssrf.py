"""SEC-01 (аудит 2026-10-29): SSRF-гвард зеркалирования фото.

URL из listings.images может вести куда угодно (внешние адаптеры,
MITM http-источника, ошибка конфига sources), а тело ответа попадает
в ПУБЛИЧНЫЙ бакет market-photos/mirror/... — слепой SSRF превращается
в exfiltration. Тесты проверяют: приватные/loopback/link-local хосты
(IPv4+IPv6, включая IPv4-mapped) отклоняются до запроса, редирект на
закрытую сеть отклоняется на хопе, публичный хост проходит.
"""

from __future__ import annotations

import ipaddress
import socket

import httpx
import pytest

import app.infrastructure.storage.photos as phmod
from app.infrastructure.storage.photos import (
    UnsafePhotoUrlError,
    assert_public_photo_url,
    download_photo,
)


def _resolver(mapping: dict[str, str]):
    """Мок socket.getaddrinfo: хост → заранее заданный IP (без сети)."""

    def resolve(host, port, proto=socket.IPPROTO_TCP):
        ip = mapping.get(host)
        if ip is None:
            raise socket.gaierror(f"unknown host {host}")
        return [(socket.AF_INET, socket.SOCK_STREAM, proto, "", (ip, port))]

    return resolve


PUBLIC = {"img.example.com": "93.184.216.34"}


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.10",
        "172.16.0.1",
        "169.254.169.254",   # cloud metadata
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fe80::1",
        "fd00::1",           # ULA
        "::ffff:127.0.0.1",  # IPv4-mapped loopback
    ],
)
def test_guard_blocks_closed_networks(ip: str):
    """Приватные/loopback/link-local/metadata адреса запрещены (IPv4+IPv6)."""
    with pytest.raises(UnsafePhotoUrlError):
        assert_public_photo_url(
            "http://h.example/img.jpg", resolver=_resolver({"h.example": ip})
        )


def test_guard_blocks_non_http_scheme():
    with pytest.raises(UnsafePhotoUrlError):
        assert_public_photo_url(
            "ftp://img.example.com/img.jpg", resolver=_resolver(PUBLIC)
        )


def test_guard_blocks_mixed_dns_rebinding():
    """Один приватный A-рекорд среди публичных — уже отказ."""
    infos = [
        (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80)),
        (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.1", 80)),
    ]

    def resolve(host, port, proto=0):
        return infos

    with pytest.raises(UnsafePhotoUrlError):
        assert_public_photo_url("http://img.example.com/x.jpg", resolver=resolve)


def test_guard_allows_public_host():
    """Публичный хост проходит (наш собственный CDN — легитимный случай)."""
    assert_public_photo_url(
        "https://img.example.com/a.jpg", resolver=_resolver(PUBLIC)
    ) is None


# --- download_photo: httpx подменяется, резолвер — мок ---


class _FakeResponse:
    def __init__(self, status_code=200, body=b"", headers=None):
        self.status_code = status_code
        self.body = body
        self.headers = headers or {}

    async def aiter_bytes(self):
        yield self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "http error", request=None, response=None
            )


class _FakeStream:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self._resp

    async def __aexit__(self, *a):
        return None


class _FakeClient:
    """Роутер URL → ответ; 302 обрабатывает сам download_photo."""

    def __init__(self, router):
        self._router = router

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return None

    def stream(self, method, url):
        return _FakeStream(self._router(url))


def _patch_httpx(monkeypatch, router):
    monkeypatch.setattr(
        phmod.httpx, "AsyncClient", lambda **kw: _FakeClient(router)
    )


_JPEG = b"\xff\xd8\xff" + b"body" * 100


@pytest.mark.asyncio
async def test_download_public_photo_ok(monkeypatch):
    """Публичный хост + JPEG-магика → (контент, ext)."""
    _patch_httpx(monkeypatch, lambda url: _FakeResponse(body=_JPEG))
    content, ext = await download_photo(
        "https://img.example.com/a.jpg", resolver=_resolver(PUBLIC)
    )
    assert content == _JPEG and ext == "jpg"


@pytest.mark.asyncio
async def test_download_rejects_metadata_url(monkeypatch):
    """169.254.169.254 отклоняется ДО запроса (роутер бы поднял AssertionError)."""
    def router(url):
        raise AssertionError("запрос к закрытой сети прошёл SSRF-гвард")

    _patch_httpx(monkeypatch, router)
    with pytest.raises(UnsafePhotoUrlError):
        await download_photo(
            "http://169.254.169.254/latest/meta-data/",
            resolver=_resolver({"169.254.169.254": "169.254.169.254"}),
        )


@pytest.mark.asyncio
async def test_download_rechecks_redirect_target(monkeypatch):
    """Редирект с публичного хоста на приватный отклоняется на хопе."""
    def router(url):
        if url.startswith("https://img.example.com"):
            return _FakeResponse(
                status_code=302,
                headers={"Location": "http://192.168.0.1/steal.jpg"},
            )
        raise AssertionError(f"запрос к {url} не должен был состояться")

    _patch_httpx(monkeypatch, router)
    resolver = _resolver(
        {"img.example.com": "93.184.216.34", "192.168.0.1": "192.168.0.1"}
    )
    with pytest.raises(UnsafePhotoUrlError):
        await download_photo("https://img.example.com/a.jpg", resolver=resolver)


@pytest.mark.asyncio
async def test_download_size_cap(monkeypatch):
    """Тело больше max_bytes обрывается сразу, не выкачиваясь целиком."""
    big = bytearray()
    step = _JPEG * 50

    async def chunks():
        for _ in range(100):  # 100 × ~2КБ — заведомо больше лимита
            yield step

    class _Endless(_FakeResponse):
        async def aiter_bytes(self):
            async for chunk in chunks():
                yield chunk

    _patch_httpx(monkeypatch, lambda url: _Endless(body=b""))
    with pytest.raises(ValueError, match="photo_too_large"):
        await download_photo(
            "https://img.example.com/a.jpg",
            max_bytes=1024,
            resolver=_resolver(PUBLIC),
        )


@pytest.mark.asyncio
async def test_download_rejects_non_image(monkeypatch):
    """HTML/текст вместо фото (например, страница ошибки) не зеркалится."""
    _patch_httpx(monkeypatch, lambda url: _FakeResponse(body=b"<html>err</html>"))
    with pytest.raises(ValueError, match="unsupported_media_type"):
        await download_photo(
            "https://img.example.com/a.jpg", resolver=_resolver(PUBLIC)
        )


@pytest.mark.asyncio
async def test_mirror_task_skips_ssrf_listing(monkeypatch):
    """Интеграция: лот с URL в метадату не зеркалится (SEC-01 в задаче)."""
    from types import SimpleNamespace

    from app.infrastructure.workers import fetch as fetch_mod

    class _Photos:
        enabled = True

        async def has_mirror(self, source, source_id):
            return False

        async def mirror_photo(self, source, source_id, index, content, ext):
            raise AssertionError("зеркалирование закрытого URL состоялось")

        async def delete_lot_mirror(self, source, source_id):
            return 0

    rows = [(1, "kolesa", "abc", ["http://169.254.169.254/x.jpg"])]

    class _Exec:
        def all(self):
            return rows

    class _Sess:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def execute(self, *a, **kw):
            return _Exec()

    monkeypatch.setattr(fetch_mod, "session_factory", lambda: _Sess())
    res = await fetch_mod.mirror_photos_task(
        {"photos_storage": _Photos()}, "kolesa"
    )
    assert res["mirrored"] == 0
