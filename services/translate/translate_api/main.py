"""Translate API — лёгкий HTTP-сервис перевода тайтлов (PLAN.md, фаза 5).

Optional-сервис: бэкенд включен флагом TRANSLATE_ENABLED + TRANSLATE_SERVICE_URL;
аутентификация — Bearer API_TOKEN, токен ОБЯЗАТЕЛЕН: пустой/отсутствующий
API_TOKEN = отказ всем (fail-closed, INFRA-02 аудит 2026-10-29 — раньше
пустой токен открывал NLLB-инференс анонимно). Сравнение timing-safe.
Модель грузится и прогревается на старте (иначе первый батч после
рестарта бэкенд перевёл бы с fallback на оригинал); инференс —
в threadpool, т.к. transformers синхронный.

    POST /translate {"texts": [...], "source_lang": "auto", "target_lang": "rus_Cyrl"}
    → {"translations": ["...", null, ...]}   # null = не удалось перевести
    GET  /health → {"status": "ok", "model": "...", "loaded": true}
"""

import hmac
import os
from contextlib import asynccontextmanager
from typing import Any

import anyio
from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from translate_api.nllb import NLLBTranslator

MODEL_NAME = os.getenv("TRANSLATE_MODEL", "facebook/nllb-200-distilled-600M")
API_TOKEN = os.getenv("API_TOKEN", "")
WARMUP = os.getenv("TRANSLATE_WARMUP", "1").lower() not in {"0", "false", "no"}
# Сторож памяти: NLLB на CPU при постоянных батчах накапливает RSS (кэши
# слоёв transformers не возвращаются системе). При превышении порога процесс
# завершается — docker restart: unless-stopped поднимает его заново с прогревом
# (~30с), бэкенд в это время переводит fallback'ом на оригинальные тайтлы.
# Плюс жёсткий mem_limit в docker-compose — двойная страховка от OOM-kill узла.
MAX_RSS_MB = int(os.getenv("TRANSLATE_MAX_RSS_MB", "2800"))
_RSS_CHECK_SEC = 60

translator = NLLBTranslator(MODEL_NAME)


def _rss_mb() -> int | None:
    """Текущий RSS процесса в МБ (Linux-контейнер); None = не смогли измерить."""
    try:
        with open("/proc/self/status", encoding="ascii") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    try:
        import resource  # noqa: PLC0415

        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) // 1024
    except Exception:  # noqa: BLE001 — без метрики сторож просто молчит
        return None


async def _rss_watchdog() -> None:
    import asyncio  # noqa: PLC0415

    while True:
        await asyncio.sleep(_RSS_CHECK_SEC)
        rss = _rss_mb()
        if rss is not None and rss > MAX_RSS_MB:
            import logging  # noqa: PLC0415

            logging.getLogger(__name__).critical(
                "translate_rss_limit_exceeded: %sMB > %sMB — restart for clean memory",
                rss, MAX_RSS_MB,
            )
            os._exit(1)  # without cleanup: docker will restart


@asynccontextmanager
async def _lifespan(app: FastAPI):
    if WARMUP:
        await anyio.to_thread.run_sync(translator.warmup)
    import asyncio  # noqa: PLC0415

    task = asyncio.create_task(_rss_watchdog())
    yield
    task.cancel()


app = FastAPI(title="translate-service", lifespan=_lifespan)


class TranslateRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)
    source_lang: str = "auto"  # NLLB-код или "auto" (детект по письменности)
    target_lang: str = "rus_Cyrl"


class TranslateResponse(BaseModel):
    translations: list[str | None]


def _check_token(authorization: str | None) -> None:
    """Аутентификация Bearer — fail-closed (INFRA-02, аудит 2026-10-29).

    Пустой API_TOKEN = токен не настроен → ОТКАЗ (раньше пустой токен
    означал «эндпоинт открыт», и NLLB-инференс гонял кто угодно).
    Сравнение timing-safe через hmac.compare_digest по байтам —
    str-вариант падает TypeError на non-ASCII заголовке.
    """
    if not API_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API token not configured",
        )
    expected = f"Bearer {API_TOKEN}".encode()
    provided = (authorization or "").encode()
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token"
        )


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "model": MODEL_NAME, "loaded": translator.loaded}


@app.post("/translate", response_model=TranslateResponse)
async def translate(
    req: TranslateRequest, authorization: str | None = Header(default=None)
) -> TranslateResponse:
    _check_token(authorization)
    translations = await anyio.to_thread.run_sync(
        lambda: translator.translate_batch(
            req.texts, req.source_lang, req.target_lang
        )
    )
    return TranslateResponse(translations=translations)


def serve() -> None:
    import uvicorn  # noqa: PLC0415

    uvicorn.run(
        app, host="0.0.0.0", port=int(os.getenv("PORT", "8200")), log_level="info"
    )


if __name__ == "__main__":
    serve()