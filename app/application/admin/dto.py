"""DTO админ-контура: панель, дашборды, ParserDoctor, метрики.

SSRF-проверки и префиксы `credentials_ref` — чистые функции без
зависимостей: их использует сценарий, а транспорт только отдаёт
результат клиенту.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, ValidationInfo, field_validator

from app.application.shared.ports import LLMPort

# Префиксы credentials_ref, разрешённые для назначения источнику.
ALLOWED_CREDENTIAL_PREFIXES: tuple[str, ...] = (
    "ADAPTER_",
    "SOURCE_",
    "SECRET_",
    "CREDENTIALS_",
)
# Приватные/служебные сети — запрещены как base_url (SSRF).
FORBIDDEN_HOSTNAMES: frozenset[str] = frozenset(
    {"localhost", "metadata.google.internal"}
)
# Поля config, которые обязаны указывать на внешний http(s)-хост.
# GEO-адаптеры склеивают base_url + list_path: без валидации list_path
# конструкция "user@host" в пути уводила запрос на чужой хост (SEC-02).
SOURCE_URL_KEYS: tuple[str, ...] = (
    "base_url",
    "detail_url_template",
    "list_url",
    "list_path",
)
SOURCE_NAME_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,63}$"
DEFAULT_RETRY_POLICY: dict[str, Any] = {"max": 3, "backoff": "exponential"}


def is_safe_external_url(url: str) -> bool:
    """Проверяет, что URL — http(s) и не указывает на приватный/loopback хост.

    Защита от SSRF: admin не должен мочь направить адаптер на
    `169.254.169.254` (AWS metadata), `10.0.0.1` (внутренняя сеть),
    `localhost` (внутренние сервисы).

    Caveat: DNS rebinding не покрывается (имя может резолвиться в
    приватный IP). Для полной защиты нужен allowlist хостов по
    adapter_class.

    Args:
        url: Значение `config.base_url` (или другого URL-поля).

    Returns:
        `True`, если URL безопасен для внешнего запроса.
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    if host in FORBIDDEN_HOSTNAMES:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True  # не IP — доменное имя, пропускаем
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
    )


def is_allowed_credentials_ref(ref: str | None) -> bool:
    """Проверяет префикс `credentials_ref` (defense-in-depth к EnvSecretStore).

    Args:
        ref: Имя env-переменной или `None`.

    Returns:
        `True`, если префикс разрешён (пустое значение тоже допустимо).
    """
    if not ref:
        return True
    return ref.startswith(ALLOWED_CREDENTIAL_PREFIXES)


class SourceConfigDTO(BaseModel):
    """Источник в API-контракте админки (тело запроса и ответ)."""

    name: str
    adapter_class: str
    kind: Literal["api", "parser", "hybrid"]
    enabled: bool = True
    priority: int = 100
    schedule_cron: str | None = None
    rate_limit_per_min: int = 60
    max_concurrency: int = 3
    timeout_sec: int = 30
    retry_policy: dict[str, Any] = Field(
        default_factory=lambda: dict(DEFAULT_RETRY_POLICY)
    )
    credentials_ref: str | None = None
    capabilities: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)

    @field_validator("retry_policy", "capabilities", "config", mode="before")
    @classmethod
    def _none_to_default(cls, value: Any, info: ValidationInfo) -> Any:
        """NULL-колонки БД → дефолты (иначе GET /sources падает с 500)."""
        if value is None:
            if info.field_name == "retry_policy":
                return dict(DEFAULT_RETRY_POLICY)
            return {}
        return value


@dataclass(frozen=True, slots=True)
class SourceState:
    """Словари источника, нужные для слияния при обновлении."""

    retry_policy: dict[str, Any] = field(default_factory=dict)
    capabilities: dict[str, Any] = field(default_factory=dict)
    config: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class LeadsQuery:
    """Фильтры списка лидов для админ-панели."""

    status: str | None = None
    partner_id: int | None = None
    limit: int = 50
    offset: int = 0


@dataclass(frozen=True, slots=True)
class UpsertSourceCommand:
    """Создать/обновить источник."""

    name: str
    config: SourceConfigDTO


@dataclass(frozen=True, slots=True)
class TriggerFetchCommand:
    """Поставить задачу парсинга источника в очередь."""

    source_name: str
    criteria: dict[str, Any] | None
    max_pages: int
    enqueue: Callable[[str, str, dict[str, Any] | None, int], Awaitable[str]]


@dataclass(frozen=True, slots=True)
class AssistantQuery:
    """Один ход AI-помощника админа."""

    message: str
    history: list[dict[str, str]]
    llm_factory: Callable[[], LLMPort]


# ---------------------------------------------------------------------------
# Дашборды воронки (dto/analytics)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EventCount:
    """Сколько distinct-пользователей сделали событие."""

    name: str
    users: int


@dataclass(frozen=True, slots=True)
class CohortRow:
    """Агрегат по когорте: размер и вернувшиеся на D1/D7."""

    day: date
    cohort: int
    d1: int | None = None
    d7: int | None = None


# ---------------------------------------------------------------------------
# ParserDoctor (dto/doctor)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SourceConfig:
    """Конфиг источника (селекторы, base_url, режим врача)."""

    name: str
    config: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ListPage:
    """Ответ страницы списка: код, HTML или сетевая ошибка."""

    status: int | None = None
    html: str | None = None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class DoctorResult:
    """Итог работы врача; `to_payload` — контракт результата (dict)."""

    source: str
    status: str
    items: int | None = None
    proposed: dict[str, Any] | None = None
    http_status: int | None = None
    error: str | None = None

    def to_payload(self) -> dict[str, Any]:
        """Собрать результат в том же виде, что отдавал сервис."""
        payload: dict[str, Any] = {"source": self.source, "status": self.status}
        if self.items is not None:
            payload["items"] = self.items
        if self.proposed is not None:
            payload["proposed"] = self.proposed
        if self.http_status is not None:
            payload["http_status"] = self.http_status
        if self.error:
            payload["error"] = self.error
        return payload


# ---------------------------------------------------------------------------
# Метрики мониторинга (снимок `/metrics`)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CountMetrics:
    """Пара «всего / за окно» для сущности."""

    total: int | None = None
    new_24h: int | None = None


@dataclass(frozen=True, slots=True)
class SourceHealthMetrics:
    """Здоровье одного источника в снимке."""

    source_name: str
    avg_latency_ms: int | None = None
    error_streak: int | None = None
    last_success_at: str | None = None
    last_error_at: str | None = None


@dataclass(frozen=True, slots=True)
class MetricsSnapshot:
    """Снимок метрик для ответа `/metrics`."""

    generated_at: datetime
    users_total: int | None = None
    users_new_24h: int | None = None
    users_by_tier: dict[str, int] = field(default_factory=dict)
    filters: CountMetrics = field(default_factory=CountMetrics)
    listings: CountMetrics = field(default_factory=CountMetrics)
    leads: CountMetrics = field(default_factory=CountMetrics)
    price_analyses: CountMetrics = field(default_factory=CountMetrics)
    notifications_sent_24h: int | None = None
    sources: list[SourceHealthMetrics] = field(default_factory=list)
    events_24h: dict[str, int] = field(default_factory=dict)
