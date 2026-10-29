"""Fetch Worker — этап 2 (ТЗ п. 4.6, 14.3). Очередь: RabbitMQ (`fetch`).

Запуск: python -m app.infrastructure.workers.fetch

Достаёт адаптер из реестра, вызывает fetch(), валидирует (Pydantic),
сохраняет в listings с дедупом, обновляет source_health, после успеха —
ставит скан фильтров в очередь `send` (notify_new_listings).
"""

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import bindparam, func, select, text, update

from app.infrastructure.sources.registry import AdapterRegistry
from app.infrastructure.sources.common.dedup import release as release_duplicate
from app.infrastructure.sources.common.proxy import build_proxy_pool
from app.config import get_settings
from app.infrastructure.db.models import Listing, Source
from app.infrastructure.db.session import session_factory
from app.infrastructure.messaging.legacy_worker import QUEUE_FETCH, CronSpec, IntervalSpec, TaskWorker, enqueue_task
from app.domain.search.criteria import SearchCriteria
from app.domain.scheduling.cron import cron_matches
from app.domain.translation.glossary import apply_glossary
from app.infrastructure.services.fetch import mark_stale, save_listings
from app.infrastructure.services.source_health import record_error, record_success, should_skip_source
from app.infrastructure.services.storage import storage_from_settings
from app.infrastructure.services.translate_client import translate_client_from_settings

logger = logging.getLogger(__name__)


async def fetch_source_task(
    ctx: dict[str, Any],
    source_name: str,
    criteria: dict[str, Any] | None = None,
    max_pages: int | None = None,
) -> dict[str, Any]:
    """Задача: выкачать порцию объявлений с источника и сохранить."""
    max_pages = max_pages or 3  # None из очереди не должен рвать сравнение
    registry: AdapterRegistry = ctx["registry"]
    redis: Redis = ctx["redis"]

    async with session_factory() as session:
        if await should_skip_source(session, source_name):
            logger.warning("source_skipped_circuit_breaker: %s", source_name)
            return {"source": source_name, "skipped": True}

        criteria_obj = SearchCriteria(**criteria) if criteria else SearchCriteria()

        try:
            adapter = registry.get(source_name)
        except KeyError:
            logger.error("adapter_not_loaded: %s", source_name)
            return {"source": source_name, "error": "adapter not loaded"}

        totals = {
            "new": 0,
            "updated": 0,
            "unchanged": 0,
            "price_changed": 0,
            "reactivated": 0,
            "cross_dup": 0,
        }
        # id-списки для статусных уведомлений (price_drop/returned, фаза 3)
        # и перевода тайтлов (фаза 5)
        event_ids: dict[str, list[int]] = {"price_drop": [], "returned": []}
        translate_ids: list[int] = []
        cursor: str | None = None
        pages = 0
        parsed_total = 0
        try:
            while pages < max_pages:
                started = time.perf_counter()
                result = await adapter.fetch(criteria_obj, cursor)
                latency_ms = int((time.perf_counter() - started) * 1000)

                try:
                    stats = await save_listings(
                        session, redis, result.items, storage=ctx.get("storage")
                    )
                except BaseException:
                    # B-10: контракт claim→release (dedup.py) — save упал после
                    # claim ключей дедупа. Не отпустить = ретрай задачи увидит
                    # пачку «дублями» и потеряет новые лоты до конца TTL (48 ч).
                    # Отпускаем и ключи cross_dup-предметов: уникальный индекс
                    # (source, source_id) в БД всё равно защищает от дублей.
                    if redis is not None:
                        for item in result.items:
                            await release_duplicate(redis, item)
                    raise
                # Зеркалирование — фоновой задачей: не удлиняет fetch
                # (encar с чеками уже упирается в job-timeout очереди).
                pub = ctx.get("publisher")
                if pub is not None and (
                    stats.get("new") or stats.get("updated")
                ):
                    await pub.enqueue("mirror_photos_task", source_name)
                for key, value in stats.items():
                    if key == "price_changed_ids":
                        event_ids["price_drop"].extend(value)
                    elif key == "reactivated_ids":
                        event_ids["returned"].extend(value)
                    elif key == "translate_ids":
                        translate_ids.extend(value)
                    else:
                        totals[key] += value
                parsed_total += len(result.items)

                await record_success(
                    session, source_name, latency_ms=latency_ms, fetched=len(result.items)
                )
                pages += 1

                if not result.has_more or not result.next_cursor:
                    break
                cursor = result.next_cursor
        except Exception as exc:
            logger.exception("fetch_failed: %s", source_name)
            await _record_ingest_error(session, source_name, exc)
            return {
                "source": source_name,
                "error": str(exc),
                "new": totals["new"],
                "pages": pages,
            }

        if totals["new"] or totals["price_changed"] or totals["reactivated"]:
            await enqueue_notify_scan(ctx, source_name)

        for kind, ids in event_ids.items():
            if ids:
                await enqueue_status_scan(ctx, kind, ids)

        if translate_ids:
            await enqueue_translate(ctx, source_name, translate_ids)

        if pages and parsed_total == 0:
            # Источник отвечает, но карточек 0 — вероятнее всего сменилась
            # вёрстка. Зовём ИИ-ремонтника (fire-and-forget, не ломает фетч).
            _fire_doctor(ctx, source_name, adapter)

        return {"source": source_name, "pages": pages, **totals}


async def _record_ingest_error(
    session: Any, source_name: str, exc: Exception
) -> None:
    """Записать ошибку источника, пережив абортнутую транзакцию ингеста (B-05).

    `save_listings` мог уронить транзакцию (IntegrityError/обрыв коннекта):
    сессия остаётся в aborted state, и `record_error` падал на первом же
    запросе `PendingRollbackError`'ом — `error_streak` не рос и circuit
    breaker не открывался никогда. Сначала rollback, а неудача самой
    записи здоровья не должна маскировать исходную ошибку фетча.
    """
    try:
        await session.rollback()
    except Exception:  # noqa: BLE001 — воркер должен дожить до record_error
        logger.warning("fetch_rollback_failed: %s", source_name, exc_info=True)
    try:
        await record_error(session, source_name, str(exc))
    except Exception:  # noqa: BLE001
        logger.warning("record_error_failed: %s", source_name, exc_info=True)


def _fire_doctor(ctx: dict[str, Any], source_name: str, adapter: Any) -> None:
    """Запуск ParserDoctor без блокировки фетча: ошибки — только в лог."""
    try:
        from app.infrastructure.services.alerting import fire
        from app.infrastructure.services.parser_doctor import repair_parser

        fire(
            repair_parser(
                source_name,
                adapter,
                registry=ctx.get("registry"),
                redis=ctx.get("redis"),
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("parser_doctor_spawn_failed: %s", exc)


async def schedule_fetch_due(ctx: dict[str, Any]) -> dict[str, Any]:
    """Планировщик парсинга (ТЗ п. 4.6): sources.schedule_cron → очередь fetch.

    Запускается каждую минуту (IntervalSpec): источники enabled с schedule_cron,
    подходящим под текущую минуту UTC, ставятся в очередь `fetch`.
    - circuit breaker проверяется внутри fetch_source_task → упавшие
      источники не фетчатся и не всплывают в алертах лишний раз;
    - дубли между воркерами и повторные прогоны в ту же минуту отсечены
      Redis-локом `sched:{source}:{YYYYMMDDHHMM}`.
    """
    redis: Redis | None = ctx.get("redis")
    now = datetime.now(timezone.utc)
    scheduled = 0
    session = session_factory()
    try:
        result = await session.execute(
            select(Source).where(
                Source.enabled.is_(True), Source.schedule_cron.is_not(None)
            )
        )
        for src in result.scalars().all():
            if not src.enabled or not src.schedule_cron:
                continue  # защита на случай фильтрации только на уровне SQL-заглушки в тестах
            if not cron_matches(src.schedule_cron, now):
                continue
            lock_key = f"sched:{src.name}:{now.strftime('%Y%m%d%H%M')}"
            if redis is not None:
                got = await redis.set(lock_key, "1", nx=True, ex=120)
                if not got:
                    continue
            await enqueue_task("fetch_source_task", src.name)
            scheduled += 1
    finally:
        await session.close()
    if scheduled:
        logger.info("schedule_fetch_due: scheduled=%s", scheduled)
    return {"scheduled": scheduled}


async def enqueue_notify_scan(ctx: dict[str, Any], source_name: str) -> bool:
    """После парсинга — скан фильтров уведомлений (ТЗ п. 8.6 instant).

    Не критично для парсинга: ошибка очереди не ломает fetch.
    """
    try:
        await enqueue_task("notify_new_listings", source_name)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("enqueue_notify_scan_failed: %s", exc)
        return False


async def enqueue_status_scan(
    ctx: dict[str, Any], kind: str, listing_ids: list[int]
) -> bool:
    """Статусные уведомления (price_drop/gone/returned) — не критичны для fetch."""
    try:
        await enqueue_task("listing_status_scan", kind, listing_ids)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("enqueue_status_scan_failed: %s", exc)
        return False


async def enqueue_translate(
    ctx: dict[str, Any], source_name: str, listing_ids: list[int]
) -> bool:
    """Перевод тайтлов (фаза 5) — не критичен для fetch: упал enqueue →
    title_ru останется NULL, UI покажет оригинал.

    Идёсы дробятся на чанки: job_timeout очереди 120s, а CPU-инференс NLLB
    большую пачку не укладывает → задача умирала по TimeoutError, не записав
    ничего. Чанк 16: kcar-тайтлы длинные (~2-4 c/лот) — 32 вылезали за 120s.
    """
    chunk_size = min(16, max(8, get_settings().translate_batch_size))
    ok = True
    for start in range(0, len(listing_ids), chunk_size):
        chunk = listing_ids[start : start + chunk_size]
        try:
            await enqueue_task("translate_listings", source_name, chunk)
        except Exception as exc:  # noqa: BLE001
            logger.warning("enqueue_translate_failed: %s", exc)
            ok = False
    return ok


async def translate_listings(
    ctx: dict[str, Any], source_name: str, listing_ids: list[int]
) -> dict[str, Any]:
    """Перевод тайтлов через services/translate (PLAN.md, фаза 5).

    Батчами (TRANSLATE_BATCH_SIZE), кэш в Redis внутри клиента. Сервис
    недоступен → title_ru остаётся NULL, следующий парсинг NEW/хэша повторит
    попытку. source_language пишем тот, что задан для источника
    (translate_source_langs; "auto" — детект по письменности в сервисе).
    """
    client = ctx.get("translate")
    if client is None or not client.enabled or not listing_ids:
        return {"translated": 0, "skipped": True}
    settings = get_settings()
    source_lang = settings.translate_source_langs.get(source_name, "auto")

    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Listing.id, Listing.title_raw)
                .where(Listing.id.in_(listing_ids))
                .where(Listing.title_raw.is_not(None))
            )
        ).all()
        translations: dict[int, str] = {}
        for start in range(0, len(rows), settings.translate_batch_size):
            chunk = rows[start : start + settings.translate_batch_size]
            translated = await client.translate(
                # Глоссарий до NLLB: бренды/модели hangul-ом («현대», «싼타페»)
                # иначе модель переводит как нарицательные («современный», «голод»).
                [apply_glossary(row.title_raw) for row in chunk],
                source_lang=source_lang,
            )
            for row, ru in zip(chunk, translated):
                if ru:
                    translations[row.id] = ru
        if translations:
            # Core-таблица вместо ORM-маппера: bulk UPDATE по PK с доп. WHERE
            # в ORM требует sync-семантики и PK-ключей в params — Core проще.
            stmt = (
                update(Listing.__table__)
                .where(Listing.__table__.c.id == bindparam("b_id"))
                .values(
                    title_ru=bindparam("b_ru"),
                    source_language=source_lang,
                    translated_at=func.now(),
                )
            )
            await session.execute(
                stmt,
                [{"b_id": lid, "b_ru": ru} for lid, ru in translations.items()],
            )
            await session.commit()
    logger.info(
        "translate_done: source=%s requested=%d translated=%d",
        source_name, len(listing_ids), len(translations),
    )
    if not translations:
        # 0 из N при непустых тайтлах = сеть/DNS/сервис флапнули: кидаем,
        # чтобы воркер отретраил задачу (attempt 3/3), а не «успешно» пропустил.
        raise RuntimeError(
            f"translate_all_failed: source={source_name} n={len(listing_ids)}"
        )
    return {"translated": len(translations)}


async def raw_retention_job(ctx: dict[str, Any]) -> dict[str, Any]:
    """Cron 03:30 UTC (PLAN.md, фаза 6): удалить raw-объекты старше
    RAW_RETENTION_DAYS и обнулить listings.raw_key удалённых — иначе админка
    генерит presigned URL на несуществующие объекты.

    Гонка с fetch не страшна: save_listings ставит raw_key только для
    NEW/смены content_hash, а ключ содержит yyyy/mm парсинга — совпасть с
    удаляемым (>= RAW_RETENTION_DAYS назад) ключом он не может. Обнуляем
    только точные совпадения ключей.
    """
    storage = ctx.get("storage")
    if storage is None or not storage.enabled:
        return {"deleted": 0, "skipped": True}
    settings = get_settings()
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.raw_retention_days)
    keys = await storage.delete_older_than(cutoff)
    if keys:
        async with session_factory() as session:
            for start in range(0, len(keys), 1000):
                await session.execute(
                    text("UPDATE listings SET raw_key = NULL WHERE raw_key = ANY(:keys)"),
                    {"keys": keys[start : start + 1000]},
                )
            await session.commit()
    logger.info("raw_retention_done: deleted=%d cutoff=%s", len(keys), cutoff.date())
    return {"deleted": len(keys)}


async def stale_check_job(ctx: dict[str, Any]) -> dict[str, Any]:
    """Cron 04:00 UTC (PLAN.md, фаза 3): устаревшие объявления → is_active=false.

    Источники в circuit breaker пропускаются внутри mark_stale; owner-лоты
    рынка (user/partner) не сталеют вообще — их жизнь управляется
    placement/lifecycle, а не фетчем источника (B-01). Для деактивированных
    внешних лотов ставится скан «gone»-уведомлений (аудитория sent_log).
    Исчезнувшие ВНЕШНИЕ лоты чистятся из S3 (docs/REDESIGN/11 §4):
    зеркало фото и raw-объект.
    """
    async with session_factory() as session:
        gone_ids = await mark_stale(session)
    if gone_ids:
        await enqueue_status_scan(ctx, "gone", gone_ids)
        await _purge_gone_storage(gone_ids)
    logger.info("stale_check_done: gone=%s", len(gone_ids))
    return {"gone": len(gone_ids)}


async def _purge_gone_storage(listing_ids: list[int]) -> dict[str, int]:
    """Удалить S3-объекты исчезнувших внешних лотов (best-effort).

    Ошибки логируются: очистка не должна ронять stale-check.
    """
    from app.infrastructure.db.repositories.listings_writer import (
        SqlAlchemyListingsWriter,
    )
    from app.infrastructure.storage.photos import photos_storage_from_settings
    from app.infrastructure.storage.s3 import storage_from_settings

    settings = get_settings()
    stats = {"mirrors": 0, "raws": 0}
    photos = photos_storage_from_settings()
    raw_store = storage_from_settings() if settings.s3_endpoint_url else None
    try:
        async with session_factory() as session:
            rows = await SqlAlchemyListingsWriter(session).gone_external_rows(
                listing_ids
            )
        for _id, source, source_id, raw_key in rows:
            try:
                stats["mirrors"] += await photos.delete_lot_mirror(source, source_id)
            except Exception:  # noqa: BLE001 — очистка best-effort
                logger.warning("purge_mirror_failed %s/%s", source, source_id)
            if raw_store is not None and raw_key:
                try:
                    await raw_store.delete(raw_key)
                    stats["raws"] += 1
                except Exception:  # noqa: BLE001
                    logger.warning("purge_raw_failed key=%s", raw_key)
        if stats["mirrors"] or stats["raws"]:
            logger.info("stale_purge_storage: %s", stats)
    except Exception:  # noqa: BLE001 — сама выборка тоже best-effort
        logger.warning("stale_purge_select_failed", exc_info=True)
    return stats


async def startup(ctx: dict[str, Any]) -> None:
    settings = get_settings()
    redis = Redis.from_url(settings.redis_url)
    # Прокси-пул: DataImpulse-шлюз (если настроен) или статический пул из Redis.
    # Подключается только к источникам с capabilities.use_proxy=true.
    # Переводчик (NLLB): адаптерам с корейским контентом (encar) — полей
    # объявления и отчёта осмотра; при TRANSLATE_ENABLED=false отдаёт None.
    translate = translate_client_from_settings(redis)
    registry = AdapterRegistry(
        session_factory, proxy_pool=build_proxy_pool(settings, redis),
        translator=translate,
    )
    await registry.load()
    ctx["registry"] = registry
    ctx["redis"] = redis
    # Клиент перевода (фаза 5): тот же инстанс, что и у адаптеров.
    ctx["translate"] = translate
    # S3-хранилище raw_payload (фаза 6): disabled, если S3_ENDPOINT_URL пуст
    storage = storage_from_settings()
    try:
        await storage.ensure_bucket()
    except Exception:  # noqa: BLE001 — TECHDEBT 8.8: S3 мог лежать на старте;
        # воркер должен подняться (fetch работает, raw_payload деградирует)
        logger.warning("ensure_bucket_failed: raw_payload may be unavailable", exc_info=True)
    ctx["storage"] = storage
    # Фото-хранилище (зеркалирование внешних лотов + загрузки рынка)
    from app.infrastructure.storage.photos import photos_storage_from_settings

    ctx["photos_storage"] = photos_storage_from_settings()
    # Publisher (зеркалирование уходит фоновой задачей в очередь)
    from app.infrastructure.messaging.legacy_worker import TaskPublisher

    ctx["publisher"] = TaskPublisher(settings.rabbitmq_url)
    logger.info("fetch_worker_started: sources=%s", [a.source_name for a in registry.all()])


async def shutdown(ctx: dict[str, Any]) -> None:
    registry: AdapterRegistry | None = ctx.get("registry")
    if registry:
        await registry.aclose()
    redis: Redis | None = ctx.get("redis")
    if redis:
        await redis.aclose()
    logger.info("fetch_worker_stopped")


_MIRROR_URL_MARK = "/mirror/"


def _is_mirrored(urls: list[str]) -> bool:
    """Фото лота в БД — уже S3-зеркала (`…/mirror/{source}/{id}/…`, B-06)?

    Признак — префикс зеркала в первом фото: `mirror_photo` собирает
    публичный URL `{public_url}/{bucket}/mirror/…`.
    """
    return bool(urls) and _MIRROR_URL_MARK in urls[0]


async def mirror_photos_task(ctx: dict[str, Any], source: str) -> dict[str, Any]:
    """Фоновое зеркалирование фото внешних лотов (docs/REDESIGN/11 §3).

    Берёт свежие активные лоты источника (parsed_at DESC, лимит на прогон
    mirror_batch) и зеркалит первые N фото. Скип — по зеркальным URL в БД,
    а не по факту объектов в S3 (B-06): после смены content_hash upsert
    возвращает исходные URL — зеркало должно перезалиться, даже если
    старые объекты в S3 ещё живы (ключи `mirror/{source}/{id}/{idx}`
    перезаписываются).
    """
    from sqlalchemy import select as _select

    from app.infrastructure.db.models import Listing as _Listing

    settings = get_settings()
    limit = settings.market_photo_mirror_limit
    photos = ctx.get("photos_storage")
    if limit <= 0 or photos is None or not photos.enabled:
        return {"mirrored": 0, "skipped": "disabled"}

    from app.infrastructure.db.models import Listing

    batch = settings.market_mirror_batch
    mirrored = skipped = 0
    try:
        async with session_factory() as session:
            rows = (
                (
                    await session.execute(
                        _select(
                            Listing.id, Listing.source, Listing.source_id,
                            Listing.images,
                        )
                        .where(
                            Listing.source == source,
                            Listing.is_active.is_(True),
                            Listing.owner_type.is_(None),
                        )
                        .order_by(Listing.parsed_at.desc())
                        .limit(batch)
                    )
                ).all()
            )
        # SEC-01: загрузка только через SSRF-гвард (скачивать напрямую
        # нельзя — тело ответа уходит в публичный бакет). Импорт внутри
        # функции: тесты подменяют download_photo в модуле photos.
        from app.infrastructure.storage.photos import download_photo

        replaced: list[tuple[int, list[str]]] = []
        for _id, src, sid, images in rows:
            urls = [u for u in (images or []) if isinstance(u, str) and u]
            if not urls:
                continue
            if _is_mirrored(urls):
                skipped += 1
                continue
            out: list[str] = []
            ok = True
            for idx, url in enumerate(urls[:limit]):
                try:
                    # SEC-01: приватные/loopback/link-local хосты и хопы
                    # редиректов запрещены, размер и формат — с проверкой.
                    content, ext = await download_photo(url)
                    out.append(await photos.mirror_photo(src, sid, idx, content, ext))
                except Exception:  # noqa: BLE001 — фото опционально
                    ok = False
                    break
            if ok and len(out) == min(len(urls), limit):
                mirrored += len(out)
                replaced.append((_id, out))
            elif out:  # частичное — убрать, не ломать порядок
                await photos.delete_lot_mirror(src, sid)
        if replaced:
            async with session_factory() as session:
                for lid, new_urls in replaced:
                    await session.execute(
                        _Listing.__table__.update()
                        .where(_Listing.id == lid)
                        .values(images=new_urls)
                    )
                await session.commit()
    except Exception:  # noqa: BLE001 — фоновая задача
        logger.warning("mirror_task_failed source=%s", source, exc_info=True)
    logger.info("mirror_done: source=%s mirrored=%s skipped=%s", source, mirrored, skipped)
    return {"mirrored": mirrored, "skipped": skipped}


HANDLERS = {
    "fetch_source_task": fetch_source_task,
    "mirror_photos_task": mirror_photos_task,
    "stale_check_job": stale_check_job,
    "translate_listings": translate_listings,
    "raw_retention_job": raw_retention_job,
}


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    settings = get_settings()
    ctx: dict[str, Any] = {}
    await startup(ctx)
    # Heartbeat для healthcheck (консюмер без HTTP-порта)
    from app.infrastructure.runtime.heartbeat import start_heartbeat

    await start_heartbeat("fetch")
    worker = TaskWorker(
        amqp_url=settings.rabbitmq_url,
        bindings={QUEUE_FETCH: list(HANDLERS)},
        handlers=HANDLERS,
        ctx=ctx,
        concurrency=3,   # как arq max_jobs=3
        job_timeout=360,  # encar: чеки+перевод+NLLB — 120s не хватало
        interval_jobs=[IntervalSpec(schedule_fetch_due, every_sec=60)],
        cron_jobs=[
            CronSpec(stale_check_job, hour=4, minute=0),
            CronSpec(raw_retention_job, hour=3, minute=30),  # фаза 6: retention raw
        ],
    )
    try:
        await worker.run()
    finally:
        await shutdown(ctx)


if __name__ == "__main__":
    asyncio.run(main())
