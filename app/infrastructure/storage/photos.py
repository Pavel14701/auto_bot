"""PhotosStorage — публичный bucket фотографий лотов рынка (MinIO/S3).

Редизайн часть 7 §1: `POST /api/market/photos` кладёт файл в bucket
`market-photos` и отдаёт публичный URL — фронт грузит `<img>` напрямую,
без presign (fallback на presign не нужен: policy public-read ставится
при создании bucket).

Ключ: `photos/{user_id}/{uuid4}.{ext}` — uuid, а не hash контента:
endpoint идемпотентен по факту загрузки (повтор = новый объект, лимит
10 фото на лот держит фронт). Публичный URL собирается из `S3_PUBLIC_URL`
(адрес MinIO, доступный браузеру; `minio:9000` из docker-сети с хоста
не резолвится).

Отдельный класс от `S3Storage`: у фото другой жизненный цикл (нет
retention/raw-префикса, есть bucket policy), общие креды/endpoint —
из тех же настроек `S3_*`.
"""

import asyncio
import ipaddress
import logging
import socket
from typing import Any
from urllib.parse import urljoin, urlsplit
from uuid import uuid4

import httpx

logger = logging.getLogger(__name__)

# Content-type по расширению (ext уже проверен снифом магических байтов).
_CONTENT_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}

# --- SSRF-гвард зеркала фото (SEC-01, аудит 2026-10-29) ---
# Тело скачанного фото попадает в ПУБЛИЧНЫЙ bucket: слепой SSRF здесь —
# это exfiltration (ответ внутренней сети становится публично читаемым).
# Поэтому зеркальная загрузка проходит тот же фильтр, что и link_preview:
# схема http/https, все A/AAAA-адреса публичны, редиректы — вручную и с
# перепроверкой каждого хопа, тело ограничено по размеру.

_MIRROR_MAX_BYTES = 10 * 1024 * 1024  # фото с источника — не больше 10 МБ
_MIRROR_TIMEOUT_SEC = 10.0
_MIRROR_MAX_REDIRECTS = 3
_REDIRECT_STATUSES = (301, 302, 303, 307, 308)


class UnsafePhotoUrlError(ValueError):
    """URL фото ведёт в приватную/служебную сеть или схему не http(s).

    SSRF-гвард SEC-01: приватные/loopback/link-local/reserved/multicast
    адреса (IPv4 и IPv6, включая IPv4-mapped) запрещены.
    """


def _is_forbidden_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Адрес из закрытого диапазона (IPv4+IPv6, включая IPv4-mapped)."""
    # ::ffff:127.0.0.1 не помечается is_loopback сам по себе — разворачиваем
    # IPv4-mapped адрес в исходный IPv4 перед проверкой.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def assert_public_photo_url(url: str, resolver: Any = None) -> None:
    """Схема http/https и ВСЕ адреса хоста публичны (иначе UnsafePhotoUrlError).

    Как ``_assert_public_host`` в link_preview: резолвим хост и проверяем
    каждый адрес — DNS-rebinding с одним публичным и одним приватным
    A-рекордом не проходит. ``resolver`` — точка внедрения мока в тестах
    (сигнатура как у ``socket.getaddrinfo``).
    """
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        raise UnsafePhotoUrlError(f"scheme_forbidden: {parsed.scheme or '?'}")
    host = parsed.hostname
    if not host:
        raise UnsafePhotoUrlError("host_missing: некорректный URL")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    resolve = resolver or socket.getaddrinfo
    try:
        infos = resolve(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafePhotoUrlError(f"dns_failed: {host}") from exc
    for info in infos:
        if _is_forbidden_ip(ipaddress.ip_address(info[4][0])):
            raise UnsafePhotoUrlError(f"private_address_forbidden: {host}")


async def download_photo(
    url: str,
    *,
    max_bytes: int = _MIRROR_MAX_BYTES,
    timeout: float = _MIRROR_TIMEOUT_SEC,
    max_redirects: int = _MIRROR_MAX_REDIRECTS,
    resolver: Any = None,
) -> tuple[bytes, str]:
    """Скачать фото для зеркала с SSRF-гвардом SEC-01 → ``(content, ext)``.

    - хост проверяется перед КАЖДЫМ запросом, включая редиректы
      (следуем Location вручную: автоматические redirects httpx не дают
      возможности перехватить и проверить промежуточный хоп);
    - тело обрезается по ``max_bytes``: в публичный бакет не должно
      попасть ничего крупнее заявленного фото;
    - формат проверяем снифом магических байтов (content-type заголовку
      верить нельзя — как и в загрузках рынка).

    Raises:
        UnsafePhotoUrlError: Схема/хост/хоп редиректа запрещены (SEC-01).
        ValueError: Тело не JPEG/PNG/WebP по магическим байтам.
        httpx.HTTPError: Сеть/таймаут/HTTP-статус (зеркало опционально,
            вызывающий трактует как «фото не скачалось»).
    """
    # Ленивый импорт: модуль приложения не должен тянуться при импорте
    # инфраструктурного модуля в тестах без БД.
    from app.application.market.photos import sniff_image_ext

    current = url
    hops = 0
    async with httpx.AsyncClient(
        follow_redirects=False, timeout=timeout
    ) as client:
        while True:
            # getaddrinfo блокирует event loop — уводим в поток.
            await asyncio.to_thread(assert_public_photo_url, current, resolver)
            async with client.stream("GET", current) as resp:
                if resp.status_code in _REDIRECT_STATUSES:
                    location = resp.headers.get("Location")
                    if not location or hops >= max_redirects:
                        raise httpx.HTTPError("too_many_redirects")
                    hops += 1
                    current = urljoin(current, location)
                    continue
                resp.raise_for_status()
                buffer = bytearray()
                async for chunk in resp.aiter_bytes():
                    buffer.extend(chunk)
                    if len(buffer) > max_bytes:
                        raise ValueError("photo_too_large")
                break
    content = bytes(buffer)
    ext = sniff_image_ext(content)
    if not ext:
        raise ValueError("unsupported_media_type: не JPEG/PNG/WebP")
    return content, ext


class PhotosStorage:
    """Публичное хранилище фото лотов: ensure_bucket (lazy) + upload."""

    def __init__(
        self,
        *,
        endpoint_url: str = "",
        bucket: str = "market-photos",
        public_url: str = "http://localhost:9000",
        access_key: str = "",
        secret_key: str = "",
        region: str = "us-east-1",
        connect_timeout: float = 5.0,
        read_timeout: float = 30.0,
        max_attempts: int = 3,
    ) -> None:
        self.endpoint_url = endpoint_url.rstrip("/")
        self.bucket = bucket
        self.public_url = public_url.rstrip("/")
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self.max_attempts = max_attempts
        self._ensured = False
        self._ensure_lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return bool(self.endpoint_url)

    def _make_client(self) -> Any:
        # Ленивый импорт (как S3Storage): aioboto3 тяжёлый, модуль должен
        # импортироваться в тестах без сетевых зависимостей.
        import aioboto3  # noqa: PLC0415
        from botocore.config import Config  # noqa: PLC0415

        session = aioboto3.Session(
            aws_access_key_id=self.access_key or None,
            aws_secret_access_key=self.secret_key or None,
            region_name=self.region,
        )
        return session.client(
            "s3",
            endpoint_url=self.endpoint_url,
            config=Config(
                connect_timeout=self.connect_timeout,
                read_timeout=self.read_timeout,
                retries={"max_attempts": self.max_attempts},
            ),
        )

    async def ensure_bucket(self) -> bool:
        """Создать bucket при отсутствии + повесить public-read policy.

        Policy перезаписывается идемпотентно: MinIO не отдаёт «текущую»
        policy дешёвой проверкой, а повторный put_bucket_policy той же
        политики безвреден. Ошибка — warning в лог (raw-подход S3Storage):
        upload всё равно попробует и упадёт с внятной ошибкой.
        """
        if not self.enabled:
            return False
        try:
            async with self._make_client() as s3:
                try:
                    await s3.head_bucket(Bucket=self.bucket)
                except Exception:  # noqa: BLE001 — 404 = bucket нет
                    await s3.create_bucket(Bucket=self.bucket)
                    logger.info("photos_bucket_created: %s", self.bucket)
                await s3.put_bucket_policy(
                    Bucket=self.bucket,
                    Policy=_policy_json(self.bucket),
                )
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("photos_ensure_bucket_failed: %s", exc)
            return False


    # --- Зеркалирование фото внешних лотов (docs/REDESIGN/11 §3-§4) ---

    async def mirror_photo(
        self, source: str, source_id: str, index: int, content: bytes, ext: str
    ) -> str:
        """Сохранить фото внешнего лота с индексом в ключе (порядок).

        Ключ mirror/{source}/{source_id}/{index:03d}.{ext}: лексикографическая
        сортировка ключей = порядок фото на источнике.
        """
        key = f"mirror/{source}/{source_id}/{index:03d}.{ext}"
        await self._ensure_once()
        async with self._make_client() as s3:
            await s3.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=content,
                ContentType={
                    "jpg": "image/jpeg", "jpeg": "image/jpeg",
                    "png": "image/png", "webp": "image/webp",
                }.get(ext, "application/octet-stream"),
            )
        return f"{self.public_url}/{self.bucket}/{key}"

    async def has_mirror(self, source: str, source_id: str) -> bool:
        """Есть ли уже зеркало у лота (head префикса)."""
        prefix = f"mirror/{source}/{source_id}/"
        if not self.enabled:
            return False
        async with self._make_client() as s3:
            resp = await s3.list_objects_v2(
                Bucket=self.bucket, Prefix=prefix, MaxKeys=1
            )
            return int(resp.get("KeyCount") or 0) > 0

    async def delete_lot_mirror(self, source: str, source_id: str) -> int:
        """Удалить зеркало фото лота (лот исчез с источника). Возвращает кол-во."""
        prefix = f"mirror/{source}/{source_id}/"
        removed = 0
        if not self.enabled:
            return 0
        async with self._make_client() as s3:
            paginator = s3.get_paginator("list_objects_v2")
            async for page in paginator.paginate(
                Bucket=self.bucket, Prefix=prefix, PaginationConfig={"PageSize": 100}
            ):
                objects = [
                    {"Key": obj["Key"]} for obj in page.get("Contents", [])
                ]
                if objects:
                    await s3.delete_objects(
                        Bucket=self.bucket, Delete={"Objects": objects}
                    )
                    removed += len(objects)
        return removed

    async def _ensure_once(self) -> None:
        """ensure_bucket при первом использовании (один раз на процесс)."""
        if self._ensured:
            return
        async with self._ensure_lock:
            if not self._ensured:
                await self.ensure_bucket()
                self._ensured = True

    async def upload(self, user_id: int, content: bytes, ext: str) -> str:
        """Положить фото и вернуть публичный URL.

        Raises:
            RuntimeError: Хранилище выключено или S3 отклонил объект.
        """
        await self._ensure_once()
        if not self.enabled:
            raise RuntimeError("photos_disabled: S3_ENDPOINT_URL не задан")
        key = f"photos/{user_id}/{uuid4()}.{ext}"
        content_type = _CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            async with self._make_client() as s3:
                await s3.put_object(
                    Bucket=self.bucket,
                    Key=key,
                    Body=content,
                    ContentType=content_type,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("photos_put_failed: %s: %s", key, exc)
            raise RuntimeError(f"photos_put_failed: {key}") from exc
        return self.public_url_for(key)

    def public_url_for(self, key: str) -> str:
        """Публичный URL объекта: `{S3_PUBLIC_URL}/{bucket}/{key}`."""
        return f"{self.public_url}/{self.bucket}/{key}"


def _policy_json(bucket: str) -> str:
    """Policy public-read как JSON-строка (bucket подставлен в Resource)."""
    import json  # noqa: PLC0415

    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": "*",
                "Action": ["s3:GetObject"],
                "Resource": [f"arn:aws:s3:::{bucket}/*"],
            }
        ]
    }
    return json.dumps(policy)


def photos_storage_from_settings() -> PhotosStorage:
    """Сборка фото-хранилища из настроек (креды общие с raw-payload)."""
    from app.config import get_settings  # noqa: PLC0415

    s = get_settings()
    return PhotosStorage(
        endpoint_url=s.s3_endpoint_url,
        bucket=s.s3_photos_bucket,
        public_url=s.s3_public_url,
        access_key=s.s3_access_key,
        secret_key=s.s3_secret_key.get_secret_value(),
        region=s.s3_region,
    )
