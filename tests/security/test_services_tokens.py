"""INFRA-02/INFRA-03 (аудит 2026-10-29): токены translate/rag — fail-closed.

Раньше: пустой API_TOKEN у translate открывал /translate анонимно
(`if API_TOKEN and ...`), у rag — то же + словарный дефолт change-me-rag
и сравнение != без constant-time. Теперь: токен обязателен (нет/пуст →
401 ВСЕМ), сравнение через hmac.compare_digest.

Тяжёлые зависимости сервисов (transformers/structlog/orjson) в venv
тестов отсутствуют — подменяются стабами до импорта main-модулей;
логика аутентификации от них не зависит.
"""

from __future__ import annotations

import json
import logging
import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_ROOT = Path(__file__).resolve().parents[2]
for _svc in ("services/translate", "services/rag"):
    _p = str(_ROOT / _svc)
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _ensure_module(name: str, **attrs) -> None:
    """Модуль есть — не трогаем; нет — ставим лёгкий стаб (тесты без Docker)."""
    if name in sys.modules:
        return
    try:
        __import__(name)
        return
    except Exception:  # noqa: BLE001 — нет библиотеки в venv тестов
        pass
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod


class _FakeNLLB:
    """Снимок поведения NLLBTranslator без загрузки модели (~2.4 ГБ)."""

    loaded = True

    def warmup(self) -> None:
        return None

    def translate_batch(self, texts, source_lang, target_lang):
        return list(texts)


_ensure_module("translate_api.nllb", NLLBTranslator=_FakeNLLB)
_ensure_module(
    "structlog",
    get_logger=lambda name: logging.getLogger(name),
)
_ensure_module(
    "orjson",
    dumps=lambda obj: json.dumps(obj).encode(),
    loads=lambda s: json.loads(s),
)

import translate_api.main as translate_main  # noqa: E402
import rag_api.main as rag_main  # noqa: E402


# ---------- translate (INFRA-02) ----------


def _translate_client(monkeypatch) -> TestClient:
    """Клиент без прогрева NLLB (torch в venv тестов отсутствует)."""
    monkeypatch.setattr(translate_main, "WARMUP", False)
    monkeypatch.setattr(translate_main, "translator", _FakeNLLB())
    return TestClient(translate_main.app)


def test_translate_without_configured_token_denies_everyone(monkeypatch):
    """Пустой API_TOKEN — 401 даже без заголовка (fail-closed, не fail-open)."""
    monkeypatch.setattr(translate_main, "API_TOKEN", "")
    client = _translate_client(monkeypatch)
    resp = client.post(
        "/translate", json={"texts": ["현대 그랜저"], "source_lang": "kor_Hang"}
    )
    assert resp.status_code == 401


def test_translate_rejects_missing_and_wrong_token(monkeypatch):
    monkeypatch.setattr(translate_main, "API_TOKEN", "s3cret-token")
    client = _translate_client(monkeypatch)
    no_header = client.post("/translate", json={"texts": ["a"]})
    wrong = client.post(
        "/translate", json={"texts": ["a"]}, headers={"Authorization": "Bearer nope"}
    )
    assert no_header.status_code == 401
    assert wrong.status_code == 401


def test_translate_accepts_correct_bearer(monkeypatch):
    monkeypatch.setattr(translate_main, "API_TOKEN", "s3cret-token")
    client = _translate_client(monkeypatch)
    resp = client.post(
        "/translate",
        json={"texts": ["현대"], "source_lang": "kor_Hang", "target_lang": "rus_Cyrl"},
        headers={"Authorization": "Bearer s3cret-token"},
    )
    assert resp.status_code == 200
    assert resp.json()["translations"] == ["현대"]


def test_translate_check_token_non_ascii_no_type_error(monkeypatch):
    """compare_digest по байтам: non-ASCII заголовок → 401, не TypeError/500.

    (httpx-клиент сам не пропускает non-ASCII в заголовках — проверяем
    гард напрямую, как это сделано в deps/internal.py монолита.)
    """
    from fastapi import HTTPException

    monkeypatch.setattr(translate_main, "API_TOKEN", "s3cret-token")
    with pytest.raises(HTTPException) as exc:
        translate_main._check_token("Bearer странный-токен")
    assert exc.value.status_code == 401


def test_translate_health_open(monkeypatch):
    """liveness остаётся открытым (docker healthcheck ходит без токена)."""
    monkeypatch.setattr(translate_main, "API_TOKEN", "s3cret-token")
    client = _translate_client(monkeypatch)
    assert client.get("/health").status_code == 200


# ---------- rag_api (INFRA-03) ----------


def test_rag_without_configured_token_denies_everyone(monkeypatch):
    monkeypatch.setattr(rag_main, "API_TOKEN", "")
    client = TestClient(rag_main.app)
    resp = client.post("/api/v1/ask", json={"question": "тест"})
    assert resp.status_code == 401


def test_rag_rejects_missing_and_wrong_token(monkeypatch):
    """Без токена / с неверным Bearer / с неверным X-API-Key — 401."""
    monkeypatch.setattr(rag_main, "API_TOKEN", "rag-s3cret")
    client = TestClient(rag_main.app)
    assert client.post("/api/v1/ask", json={"question": "q"}).status_code == 401
    assert (
        client.post(
            "/api/v1/ask",
            json={"question": "q"},
            headers={"Authorization": "Bearer change-me-rag"},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/v1/ask",
            json={"question": "q"},
            headers={"X-API-Token": "wrong"},
        ).status_code
        == 401
    )
