"""S3-зеркалирование фото внешних лотов (docs/REDESIGN/11 §3-§4)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.infrastructure.workers import fetch as fetch_mod


class _FakePhotos:
    enabled = True

    def __init__(self) -> None:
        self.mirrored: list[tuple[str, str, int]] = []
        self.deleted: list[tuple[str, str]] = []
        self.has: set = set()

    async def has_mirror(self, source, source_id):
        return (source, source_id) in self.has

    async def mirror_photo(self, source, source_id, index, content, ext):
        self.mirrored.append((source, source_id, index))
        return f"http://s3/mirror/{source}/{source_id}/{index:03d}.{ext}"

    async def delete_lot_mirror(self, source, source_id):
        self.deleted.append((source, source_id))
        return 1


class _Resp:
    def __init__(self, ctype="image/jpeg"):
        self.content = b"x"
        self.headers = {"content-type": ctype}

    def raise_for_status(self):
        return None


_ROWS = [(10, "encar", "111", ["u1", "u2"]), (11, "kcar", "222", ["a"])]
_REPLACED: list = []


class _Exec:
    def __init__(self, rows=None):
        self._rows = rows

    def all(self):
        return self._rows


class _Sess:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return None

    async def execute(self, *a, **kw):
        return _Exec(_ROWS)

    async def commit(self):
        return None


def _patch_common(monkeypatch, rows=None):
    photos = _FakePhotos()
    # SEC-01: зеркало качает через photos.download_photo (SSRF-гвард);
    # в этих тестах проверяется логика задачи, сеть подменена стабом.
    import app.infrastructure.storage.photos as phmod

    async def fake_download(url, **kw):
        return b"\xff\xd8\xffimage", "jpg"

    monkeypatch.setattr(phmod, "download_photo", fake_download)
    sess = _Sess()
    if rows is not None:

        async def _execute(*a, **kw):
            return _Exec(rows)

        sess.execute = _execute
    monkeypatch.setattr(fetch_mod, "session_factory", lambda: sess)
    return photos


@pytest.mark.asyncio
async def test_mirror_task_full_success(monkeypatch):
    photos = _patch_common(monkeypatch)
    res = await fetch_mod.mirror_photos_task({"photos_storage": photos}, "encar")
    assert res["mirrored"] == 3  # 2 лота × 5→фактически 2+1 фото


@pytest.mark.asyncio
async def test_mirror_task_skips_existing(monkeypatch):
    """Скип — по зеркальным URL в БД (_is_mirrored, B-06), не по S3-head."""
    rows = [
        (10, "encar", "111", ["http://s3/mirror/encar/111/000.jpg"]),
        (11, "kcar", "222", ["http://s3/mirror/kcar/222/000.jpg"]),
    ]
    photos = _patch_common(monkeypatch, rows=rows)
    res = await fetch_mod.mirror_photos_task({"photos_storage": photos}, "encar")
    assert res["mirrored"] == 0 and res["skipped"] == 2


@pytest.mark.asyncio
async def test_mirror_task_remirrors_after_hash_change(monkeypatch):
    """B-06: объекты зеркала в S3 живы (has_mirror=True), но в БД исходные
    URL — upsert при смене content_hash вернул исходники, и зеркало
    перезаливается, а не скипается (раньше has_mirror глотал такие лоты)."""
    photos = _patch_common(monkeypatch)  # _ROWS с исходными URL
    photos.has.update({("encar", "111")})  # раньше этого хватало для скипа
    res = await fetch_mod.mirror_photos_task({"photos_storage": photos}, "encar")
    assert ("encar", "111", 0) in photos.mirrored
    assert res["mirrored"] == 3


@pytest.mark.asyncio
async def test_mirror_task_disabled(monkeypatch):
    photos = _FakePhotos()
    photos.enabled = False
    res = await fetch_mod.mirror_photos_task({"photos_storage": photos}, "encar")
    assert res == {"mirrored": 0, "skipped": "disabled"}


@pytest.mark.asyncio
async def test_stale_purge_calls_delete(monkeypatch):
    """stale_check_job чистит S3 исчезнувших внешних лотов (best-effort)."""
    from app.infrastructure.db.repositories import listings_writer as lw

    rows = [(1, "encar", "111", "raw/k"), (2, "kcar", "222", None)]

    async def fake_mark_stale(session):
        return [1, 2]

    class _W:
        def __init__(self, s):
            pass

        async def gone_external_rows(self, ids):
            return rows

    class _S3:
        async def delete(self, key):
            return None

    class _Photos:
        async def delete_lot_mirror(self, s, sid):
            return 1

    monkeypatch.setattr(fetch_mod, "mark_stale", fake_mark_stale)
    monkeypatch.setattr(lw, "SqlAlchemyListingsWriter", _W)
    import app.infrastructure.storage.photos as phmod

    monkeypatch.setattr(phmod, "photos_storage_from_settings", lambda: _Photos())
    import app.infrastructure.storage.s3 as s3mod

    monkeypatch.setattr(s3mod, "get_settings", lambda: SimpleNamespace(
        s3_endpoint_url="http://minio:9000"))
    monkeypatch.setattr(s3mod, "storage_from_settings", lambda: _S3())
    monkeypatch.setattr(fetch_mod, "session_factory", lambda: _Sess())
    monkeypatch.setattr(
        fetch_mod, "enqueue_status_scan", lambda *a, **kw: _noop()
    )

    async def _noop():
        return None

    monkeypatch.setattr(
        fetch_mod, "enqueue_status_scan",
        lambda ctx, kind, ids: _noop(),
    )
    res = await fetch_mod.stale_check_job({})
    assert res == {"gone": 2}
