"""Чаты (JWT): треды, сообщения, ws-токены, subscribe-proxy, превью (§5).

Тонкий транспорт: валидация ввода — Pydantic-схемы, правила доступа и
длина сообщения — сценарии (`app.application.chat`), SQL — репозиторий.
Создание треда идемпотентно (partial unique): создан → 201, reuse → 200.
"""

from __future__ import annotations

from app.transport.http.deps.dishka import DishkaRoute, InternalDishkaRoute

import hmac
import logging
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from dishka.integrations.fastapi import FromDishka
from fastapi import APIRouter, Header, HTTPException, Path, Query, Response, status
from pydantic import BaseModel, Field

from app.application.chat.dto import (
    MAX_MESSAGE_LEN,
    MessageView,
    OperatorThreadView,
    ParticipantRef,
    ThreadView,
)
from app.application.chat.ports import LinkBlockedError
from app.application.chat.use_cases import ONLINE_IDS_MAX, ListMessages
from app.application.dialog.use_cases import AiUnavailable
from app.application.errors import AppError
from app.application.shared.ports import CachePort
from app.config import Settings
from app.transport.http.deps.auth import CurrentUserDep
from app.transport.http.deps.use_cases import (
    AdminKickDep,
    ArchiveThreadDep,
    CountOperatorUnreadDep,
    CreateGroupThreadDep,
    CreateInviteDep,
    CreateSellerThreadDep,
    CreateSupportThreadDep,
    GetLinkPreviewDep,
    GetOnlineUsersDep,
    HandleReportDep,
    HandleSubscribeProxyDep,
    IssueWsTokenDep,
    JoinByCodeDep,
    KickParticipantDep,
    LeaveThreadDep,
    ListAdminReportsDep,
    ListMessagesDep,
    ListMyThreadsDep,
    ListOperatorMessagesDep,
    ListOperatorThreadsDep,
    ListThreadEventsDep,
    MarkReadDep,
    ReportThreadDep,
    SendTypingDep,
    SendMessageDep,
    SendOperatorMessageDep,
    SummonOperatorDep,
    SupportBotSpawnerDep,
    SummarizeThreadDep,
    ToggleMuteDep,
)

logger = logging.getLogger(__name__)

router = APIRouter(route_class=DishkaRoute, prefix="/api/chats", tags=["chats"])

# Операторский контур (§2/§6): та же авторизация, что у всего /api/admin —
# X-Internal-Token в route-классе (как admin.py/leads.py): админка входит
# по internal-токену, персонального operator-id пока нет (MVP).
admin_router = APIRouter(
    route_class=InternalDishkaRoute,
    prefix="/api/admin/chats",
    tags=["admin-chats"],
)

ThreadIdPath = Annotated[UUID, Path()]

# Гостям чаты закрыты целиком (06 §5): RAG-ответы и ws-подписки —
# только после входа/регистрации (вектор расхода квот гостями).
CHATS_REGISTRATION_REQUIRED = (
    "chats_registration_required: чаты доступны после входа или регистрации"
)


def _reject_guest(telegram_id: int) -> None:
    """Гостевые сессии сайта (синтетический id < 0) чатов не видят."""
    if telegram_id < 0:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, CHATS_REGISTRATION_REQUIRED
        )


# Коды ошибок сценариев → HTTP (как deals.py).
_STATUS_BY_CODE = {
    "not_found": status.HTTP_404_NOT_FOUND,
    "forbidden": status.HTTP_403_FORBIDDEN,
    "conflict": status.HTTP_409_CONFLICT,
    "invalid_input": status.HTTP_400_BAD_REQUEST,
}


def _raise_app_error(exc: AppError) -> None:
    """Прикладная ошибка → HTTPException с публичным текстом."""
    raise HTTPException(
        _STATUS_BY_CODE.get(exc.code, status.HTTP_400_BAD_REQUEST),
        exc.public_message,
    ) from exc


class ThreadCreatedOut(BaseModel):
    """Идентификация треда после создания/reuse."""

    thread_id: UUID


class SubjectOut(BaseModel):
    """Мини-карточка предмета треда."""

    id: int
    make: str | None = None
    model: str | None = None
    year: int | None = None
    price: float | None = None
    currency: str | None = None
    url: str | None = None
    image: str | None = None


class LastMessageOut(BaseModel):
    """Последнее сообщение треда (плоский текст)."""

    body: str
    created_at: datetime
    sender: str
    sender_id: int | None = None


class ParticipantOut(BaseModel):
    """Участник переговорной: субъект, имя, роль (08 §2)."""

    user_type: str
    user_id: int
    name: str | None = None
    role: str = "member"


class ThreadOut(BaseModel):
    """Тред в списке чатов."""

    id: UUID
    type: str
    title: str
    status: str
    unread: int
    last_message: LastMessageOut | None = None
    subject: SubjectOut | None = None
    # Deal-тред: лид заявки + партнёрский статус (claimed/.../deal) —
    # партнёрский кабинет рисует CTA «Отметить сделкой» (долг №6).
    lead_id: int | None = None
    lead_status: str | None = None
    # Переговорная (07 §2): флаг + участники с именами для шапки комнаты.
    is_group: bool = False
    participants: list[ParticipantOut] = Field(default_factory=list)
    # Говернанс (08 §2/§6): своя роль ('owner'|'member') и свой mute
    # (muted-тред не инкрементит бейдж конверта — фильтрует фронт).
    role: str = "member"
    muted: bool = False


class GroupIn(BaseModel):
    """Создание переговорной: лот обязателен (08 §1), title — опционален.

    listing_id опционален на уровне схемы, чтобы «без лота» возвращал
    409 `group_needs_listing` из сценария (ТЗ 08 §1), а не 422 схемы.
    Пустой title → автогенерация «Переговоры: Make Model Year».
    """

    title: str = Field(default="", max_length=120)
    listing_id: int | None = Field(default=None, ge=1)


class InviteOut(BaseModel):
    """Код приглашения в переговорную (6 символов base32, TTL 7 дней)."""

    invite_code: str


class JoinIn(BaseModel):
    """Вход в переговорную по коду."""

    code: str = Field(min_length=6, max_length=6)


class JoinOut(BaseModel):
    """Идентификация треда после join/rejoin."""

    thread_id: UUID


class MessageOut(BaseModel):
    """Сообщение чата."""

    id: int
    sender_type: str
    sender_id: int | None
    body: str
    created_at: datetime


class MessageIn(BaseModel):
    """Markdown-тело сообщения (§3: <=4000)."""

    body: str = Field(min_length=1, max_length=MAX_MESSAGE_LEN)


class ReadIn(BaseModel):
    """Read-маркер; без поля — прочитать всё до последнего."""

    last_read_message_id: int | None = Field(default=None, ge=0)


class WsTokenOut(BaseModel):
    """Браузерный JWT + адрес centrifugo (§4)."""

    token: str
    url: str


class SummonOut(BaseModel):
    """Результат зова оператора (§6): пауза стоит + system-строка."""

    bot_paused: bool
    message: MessageOut | None = None


class ReportIn(BaseModel):
    """Жалоба на тред (08 §4): причина + опциональный комментарий."""

    reason: Literal["spam", "fraud", "offtop", "abuse"]
    comment: str | None = Field(default=None, max_length=1000)


class ReportStatusIn(BaseModel):
    """Обработка жалобы модерацией (08 §4)."""

    status: Literal["resolved", "dismissed"]


class AdminReportOut(BaseModel):
    """Жалоба в списке модерации: репорт + контекст треда (08 §4)."""

    id: int
    thread_id: UUID
    reporter_type: str
    reporter_id: int
    reporter_name: str | None = None
    reason: str
    comment: str | None = None
    status: str
    created_at: datetime
    handled_at: datetime | None = None
    thread_title: str | None = None
    thread_snippet: str | None = None


class ChatEventOut(BaseModel):
    """Строка ленты событий треда (08 §5)."""

    id: int
    thread_id: UUID
    actor_type: str
    actor_id: int | None = None
    event: str
    payload: dict[str, Any] | None = None
    created_at: datetime


class OperatorThreadOut(BaseModel):
    """Тред в списке оператора поддержки (GET /api/admin/chats)."""

    id: UUID
    type: str
    status: str
    bot_paused: bool
    user_id: int
    user_name: str | None = None
    last_user_message_at: datetime | None = None
    last_user_message_snippet: str | None = None


class SubscribeProxyIn(BaseModel):
    """Тело subscribe-proxy от centrifugo v6: user = sub connection-JWT."""

    client: str | None = None
    channel: str
    user: str | None = None
    data: dict[str, Any] | None = None


def _thread_out(view: ThreadView) -> ThreadOut:
    """ThreadView → схема ответа."""
    return ThreadOut(
        id=view.id,
        type=view.type,
        title=view.title,
        status=view.status,
        unread=view.unread,
        last_message=(
            LastMessageOut(
                body=view.last_message.body_plain,
                created_at=view.last_message.created_at,
                sender=view.last_message.sender_type,
                sender_id=view.last_message.sender_id,
            )
            if view.last_message is not None
            else None
        ),
        subject=(
            SubjectOut.model_validate(view.subject, from_attributes=True)
            if view.subject is not None
            else None
        ),
        lead_id=view.lead_id,
        lead_status=view.lead_status,
        is_group=view.is_group,
        participants=[
            ParticipantOut.model_validate(p, from_attributes=True)
            for p in view.participants
        ],
        role=view.role,
        muted=view.muted,
    )


def _message_out(message: MessageView) -> MessageOut:
    """MessageView → схема ответа."""
    return MessageOut.model_validate(message, from_attributes=True)


def _operator_thread_out(view: OperatorThreadView) -> OperatorThreadOut:
    """OperatorThreadView → схема ответа админ-списка."""
    return OperatorThreadOut.model_validate(view, from_attributes=True)


# --------------------------------------------------------------------------
# Идемпотентность POST /messages (долг ревизора №7): необязательный заголовок
# Idempotency-Key — повтор того же запроса (сетевой ретрай прокси/клиента)
# возвращает сохранённое сообщение (200) без новой записи и публикации.
# --------------------------------------------------------------------------

# TTL ключа идемпотентности: сутки — окно любых вменяемых ретраев.
IDEMPOTENCY_TTL_SEC = 24 * 60 * 60

IdempotencyKeyHeader = Annotated[
    str | None, Header(alias="Idempotency-Key", max_length=128)
]


def _idem_redis_key(sender: ParticipantRef, key: str) -> str:
    """Ключ Redis: скоуп отправителя, чтобы ключи разных субъектов
    не пересекались (`chat:idem:{user_type}:{user_id}:{key}`)."""
    return f"chat:idem:{sender.user_type}:{sender.user_id}:{key}"


def _norm_idempotency_key(raw: str | None) -> str | None:
    """Заголовок → ключ: пустой/пробельный — как непереданный."""
    if raw is None:
        return None
    return raw.strip() or None


async def _replayed_message(
    list_messages: ListMessages,
    cache: CachePort,
    thread_id: UUID,
    sender: ParticipantRef,
    key: str | None,
) -> MessageView | None:
    """Сохранённое сообщение этого отправителя с тем же ключом или None.

    Чтение кэша — best-effort: лежачий Redis не блокирует отправку
    (как fire-and-forget у publisher'а).
    """
    if key is None:
        return None
    try:
        raw = await cache.get(_idem_redis_key(sender, key))
    except Exception:  # noqa: BLE001 — идемпотентность не ломает отправку
        logger.warning("idempotency_lookup_failed", exc_info=True)
        return None
    if raw is None:
        return None
    try:
        message_id = int(raw)
    except (TypeError, ValueError):
        return None
    # after_id = id-1 → первая запись начиная с этого сообщения;
    # ListMessages заодно проверяет доступ субъекта к треду.
    try:
        tail = await list_messages.execute(
            thread_id, sender, after_id=message_id - 1, limit=1
        )
    except AppError as exc:
        _raise_app_error(exc)
    found = tail[0] if tail else None
    if found is None or found.id != message_id:
        # Записи нет (например, транзакция откатилась) — шлём как новую.
        return None
    if found.sender_type != sender.user_type or found.sender_id != (
        sender.user_id
    ):
        # Под ключ попало чужое сообщение — не возвращаем его (защита
        # от подбора ключа): обрабатываем запрос как новый.
        return None
    return found


async def _remember_idempotent(
    cache: CachePort, sender: ParticipantRef, key: str | None, message_id: int
) -> None:
    """Запомнить message_id под ключ (SETNX, TTL 24ч); сбой — не роняет POST."""
    if key is None:
        return
    try:
        await cache.set_if_absent(
            _idem_redis_key(sender, key), str(message_id), IDEMPOTENCY_TTL_SEC
        )
    except Exception:  # noqa: BLE001 — идемпотентность не ломает отправку
        logger.warning("idempotency_store_failed", exc_info=True)


# --------------------------------------------------------------------------
# Антифрод: лимит сообщений 20/мин на (субъект, тред) — redis INCR+EXPIRE
# (08 §4). Тот же паттерн, что и идемпотентность выше: Redis напрямую из
# роутера через CachePort; лежачий Redis не блокирует отправку (fail-open).
# --------------------------------------------------------------------------

MESSAGE_RATE_LIMIT = 20
MESSAGE_RATE_WINDOW_SEC = 60


def _rate_limit_key(sender: ParticipantRef, thread_id: UUID) -> str:
    """Ключ Redis: chat:rl:{user_type}:{user_id}:{thread} (08 §4)."""
    return f"chat:rl:{sender.user_type}:{sender.user_id}:{thread_id}"


async def _enforce_message_rate_limit(
    cache: CachePort, thread_id: UUID, sender: ParticipantRef
) -> None:
    """Поднять счётчик окна и отлупить сверх лимита (429 message_rate_limit).

    TTL ставится на первом инкременте — окно фиксированное от первого
    сообщения (INCR+EXPIRE, как у partner rate-limit).
    """
    key = _rate_limit_key(sender, thread_id)
    try:
        count = await cache.incr(key)
        if count == 1:
            await cache.expire(key, MESSAGE_RATE_WINDOW_SEC)
    except Exception:  # noqa: BLE001 — лежачий Redis не блокирует чат
        logger.warning("message_rate_limit_lookup_failed", exc_info=True)
        return
    if count > MESSAGE_RATE_LIMIT:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "message_rate_limit: слишком много сообщений — подождите минуту",
        )


# --------------------------------------------------------------------------
# Typing rate-limit (09 §1): 1 событие / 2с на (субъект, тред) — клиент
# дебаунсит отправку 1.5с, сервер страхует от залпа (тот же INCR+EXPIRE,
# порог 1 — второе событие в окне уже 429).
# --------------------------------------------------------------------------

TYPING_RATE_LIMIT = 1
TYPING_RATE_WINDOW_SEC = 2


def _typing_rate_key(sender: ParticipantRef, thread_id: UUID) -> str:
    """Ключ Redis: chat:rl:typing:{user_type}:{user_id}:{thread}."""
    return f"chat:rl:typing:{sender.user_type}:{sender.user_id}:{thread_id}"


async def _enforce_typing_rate_limit(
    cache: CachePort, thread_id: UUID, sender: ParticipantRef
) -> None:
    """Отлупить второе typing в окне 2с (429 typing_rate_limit).

    Лежачий Redis не блокирует отправку (fail-open, как у сообщений).
    """
    key = _typing_rate_key(sender, thread_id)
    try:
        count = await cache.incr(key)
        if count == 1:
            await cache.expire(key, TYPING_RATE_WINDOW_SEC)
    except Exception:  # noqa: BLE001 — лежачий Redis не блокирует typing
        logger.warning("typing_rate_limit_lookup_failed", exc_info=True)
        return
    if count > TYPING_RATE_LIMIT:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "typing_rate_limit: не чаще одного события в 2 секунды",
        )


def _check_subscribe_token(token: str | None, settings: Settings) -> None:
    """Авторизация proxy-запроса от centrifugo (X-Internal-Token).

    Принимаем internal-токен приложения ИЛИ centrifugo http_api_key:
    статический заголовок в configs/centrifugo.json проксирует именно
    значение api-ключа (env-подстановки в конфиге centrifugo нет).
    """
    expected = settings.internal_token.get_secret_value() or (
        settings.app_secret_key.get_secret_value()
    )
    api_key = settings.centrifugo_http_api_key.get_secret_value()
    provided = token or ""
    # bytes: не-ASCII заголовок не должен ронять compare_digest TypeError-500
    # (INFRA-04 аудита 2026-10-29; паттерн deps/internal._as_bytes)
    if not (
        hmac.compare_digest(provided.encode(), expected.encode())
        or hmac.compare_digest(provided.encode(), api_key.encode())
    ):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid internal token"
        )


@router.get("", response_model=list[ThreadOut])
async def list_my_threads(
    user: CurrentUserDep, use_case: ListMyThreadsDep
) -> list[ThreadOut]:
    """Мои треды: поддержка, продавцы, сделки — с unread и предметом (§5)."""
    _reject_guest(user.telegram_id)
    return [_thread_out(view) for view in await use_case.execute(user.telegram_id)]


@router.post("/support", response_model=ThreadCreatedOut)
async def create_support_thread(
    response: Response,
    user: CurrentUserDep,
    use_case: CreateSupportThreadDep,
) -> ThreadCreatedOut:
    """Создать/reuse singleton поддержки; 201 при создании, 200 при reuse."""
    _reject_guest(user.telegram_id)
    thread_id, created = await use_case.execute(user.telegram_id)
    response.status_code = (
        status.HTTP_201_CREATED if created else status.HTTP_200_OK
    )
    return ThreadCreatedOut(thread_id=thread_id)


@router.post(
    "/seller/{listing_id}", response_model=ThreadCreatedOut
)
async def create_seller_thread(
    response: Response,
    user: CurrentUserDep,
    use_case: CreateSellerThreadDep,
    listing_id: int = Path(ge=1),
) -> ThreadCreatedOut:
    """Чат с продавцом лота (reuse по UNIQUE); 201/200.

    Проживает в /api/chats (а не /api/listings), чтобы gateway-правило
    префиксом уводил его в chat-сервис, а не в catalog.
    """
    _reject_guest(user.telegram_id)
    try:
        thread_id, created = await use_case.execute(
            user.telegram_id, listing_id
        )
    except AppError as exc:
        _raise_app_error(exc)
    response.status_code = (
        status.HTTP_201_CREATED if created else status.HTTP_200_OK
    )
    return ThreadCreatedOut(thread_id=thread_id)


@router.post(
    "/group", response_model=ThreadCreatedOut, status_code=status.HTTP_201_CREATED
)
async def create_group_thread(
    body: GroupIn,
    user: CurrentUserDep,
    use_case: CreateGroupThreadDep,
) -> ThreadCreatedOut:
    """Переговорная до 5 человек по автомобилю (07 §2, 08 §1).

    `listing_id` обязателен (без него — 409 `group_needs_listing`; лот
    снят с продажи — 409 `listing_not_active`); пустой title — автогенер
    «Переговоры: Make Model Year». Создатель — участник с ролью owner
    (08 §2); партнёр-владелец лота НЕ добавляется автоматически
    (приглашение отдельным кодом). Гость — 403.
    """
    _reject_guest(user.telegram_id)
    try:
        thread_id = await use_case.execute(
            user.telegram_id, body.title, body.listing_id
        )
    except AppError as exc:
        _raise_app_error(exc)
    return ThreadCreatedOut(thread_id=thread_id)


@router.post("/join", response_model=JoinOut)
async def join_by_code(
    body: JoinIn,
    response: Response,
    user: CurrentUserDep,
    use_case: JoinByCodeDep,
) -> JoinOut:
    """Войти в переговорную по коду (07 §2).

    201 — вошли; 200 — уже участник (создатель/ранее вошедший), тот же
    тред; 404 — код истёк; 409 group_is_full — участников уже 5.
    """
    _reject_guest(user.telegram_id)
    try:
        thread_id, joined = await use_case.execute(
            body.code, _user_ref(user.telegram_id)
        )
    except AppError as exc:
        _raise_app_error(exc)
    response.status_code = (
        status.HTTP_201_CREATED if joined else status.HTTP_200_OK
    )
    return JoinOut(thread_id=thread_id)


@router.post("/{thread_id}/invite", response_model=InviteOut)
async def create_invite(
    user: CurrentUserDep,
    use_case: CreateInviteDep,
    thread_id: ThreadIdPath,
) -> InviteOut:
    """Код приглашения в переговорную (owner; 6 символов, TTL 7 дней).

    Многоразовый до лимита участников. Не-group тред — 409, чужой — 404,
    member — 403 `invite_owner_only` (08 §2).
    """
    _reject_guest(user.telegram_id)
    try:
        code = await use_case.execute(
            thread_id, _user_ref(user.telegram_id)
        )
    except AppError as exc:
        _raise_app_error(exc)
    return InviteOut(invite_code=code)


# =========================================================================
# Говернанс переговорных (08 §2, §4, §6): kick / leave / archive / mute /
# report. Все операции пишут аудит-события (chat_events, §5).
# =========================================================================


@router.delete("/{thread_id}/participants/{user_type}/{user_id}")
async def kick_participant(
    user: CurrentUserDep,
    use_case: KickParticipantDep,
    thread_id: ThreadIdPath,
    user_type: Literal["user", "partner", "operator"] = Path(),
    user_id: int = Path(),
) -> dict[str, bool]:
    """Owner исключает member любого типа (08 §2).

    Кик owner — 409 `cannot_kick_owner`; кик себя — 409 с подсказкой
    использовать leave; не-владелец — 403; цели нет — 404.
    """
    _reject_guest(user.telegram_id)
    try:
        await use_case.execute(
            thread_id, _user_ref(user.telegram_id), user_type, user_id
        )
    except AppError as exc:
        _raise_app_error(exc)
    return {"removed": True}


@router.post("/{thread_id}/leave")
async def leave_thread(
    user: CurrentUserDep, use_case: LeaveThreadDep, thread_id: ThreadIdPath
) -> dict[str, bool]:
    """Покинуть переговорную (08 §2).

    Member — свободно; owner — только последний участник (иначе 409
    `owner_must_archive`). Когда участников 0 — тред закрывается сам.
    """
    _reject_guest(user.telegram_id)
    try:
        await use_case.execute(thread_id, _user_ref(user.telegram_id))
    except AppError as exc:
        _raise_app_error(exc)
    return {"left": True}


@router.post("/{thread_id}/archive")
async def archive_thread(
    user: CurrentUserDep, use_case: ArchiveThreadDep, thread_id: ThreadIdPath
) -> dict[str, bool]:
    """Архивировать переговорную (owner, 08 §2): closed + system-строка.

    Идемпотентно: повторный archive закрытого треда — 200 без изменений.
    Сообщения в архив → 403 `thread_archived`; переоткрытия нет (MVP).
    """
    _reject_guest(user.telegram_id)
    try:
        archived = await use_case.execute(
            thread_id, _user_ref(user.telegram_id)
        )
    except AppError as exc:
        _raise_app_error(exc)
    return {"archived": archived}


@router.post("/{thread_id}/mute")
async def mute_thread(
    user: CurrentUserDep, use_case: ToggleMuteDep, thread_id: ThreadIdPath
) -> dict[str, bool]:
    """Выключить свои уведомления треда (08 §6): muted=true в своей строке."""
    _reject_guest(user.telegram_id)
    try:
        muted = await use_case.execute(
            thread_id, _user_ref(user.telegram_id), True
        )
    except AppError as exc:
        _raise_app_error(exc)
    return {"muted": muted}


@router.post("/{thread_id}/unmute")
async def unmute_thread(
    user: CurrentUserDep, use_case: ToggleMuteDep, thread_id: ThreadIdPath
) -> dict[str, bool]:
    """Включить свои уведомления треда обратно (08 §6)."""
    _reject_guest(user.telegram_id)
    try:
        muted = await use_case.execute(
            thread_id, _user_ref(user.telegram_id), False
        )
    except AppError as exc:
        _raise_app_error(exc)
    return {"muted": muted}


@router.post("/{thread_id}/report", status_code=status.HTTP_201_CREATED)
async def report_thread(
    body: ReportIn,
    user: CurrentUserDep,
    use_case: ReportThreadDep,
    response: Response,
    thread_id: ThreadIdPath,
) -> dict[str, bool]:
    """Пожаловаться на тред (участник, 08 §4): spam|fraud|offtop|abuse.

    Идемпотентно, пока жалоба «открыта»: повтор с той же причиной —
    200 `already_reported=true` без новой строки (partial unique 0029).
    """
    _reject_guest(user.telegram_id)
    try:
        created = await use_case.execute(
            thread_id,
            _user_ref(user.telegram_id),
            body.reason,
            body.comment,
        )
    except AppError as exc:
        _raise_app_error(exc)
    if not created:
        response.status_code = status.HTTP_200_OK
    return {"reported": created}


@router.get("/ws-token", response_model=WsTokenOut)
async def ws_token(
    user: CurrentUserDep, use_case: IssueWsTokenDep
) -> WsTokenOut:
    """Браузерный JWT centrifugo: sub=user:{telegram_id}, exp=+12ч (§4).

    Гость — 403 (06 §5): ws-токен открывает личный канал уведомлений,
    RAG-чаты гостям не выдаются.
    """
    _reject_guest(user.telegram_id)
    view = await use_case.execute(f"user:{user.telegram_id}")
    return WsTokenOut(token=view.token, url=view.url)


ONLINE_IDS_INVALID = (
    f"online_ids_invalid: ids — до {ONLINE_IDS_MAX} telegram_id через запятую"
)


def _parse_online_ids(raw: str) -> list[int]:
    """`ids=1,2,3` → список telegram_id (400 при мусоре/переполнении)."""
    try:
        ids = [int(chunk.strip()) for chunk in raw.split(",") if chunk.strip()]
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, ONLINE_IDS_INVALID)
    if not ids or len(ids) > ONLINE_IDS_MAX or any(i <= 0 for i in ids):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, ONLINE_IDS_INVALID)
    return ids


@router.get("/online")
async def chats_online(
    user: CurrentUserDep,
    use_case: GetOnlineUsersDep,
    ids: str = Query(min_length=1, max_length=600),
) -> dict[str, list[int]]:
    """Онлайн-статусы юзеров: presence их личных каналов (09 §1).

    `ids` — до 50 telegram_id через запятую; ответ `{online: [ids]}` —
    кто подключён к centrifugo сейчас (фронт поллит открытую комнату).
    Centrifugo не настроен — честный пустой список.
    """
    _reject_guest(user.telegram_id)
    return {"online": await use_case.execute(_parse_online_ids(ids))}


@router.post("/subscribe-proxy")
async def subscribe_proxy(
    body: SubscribeProxyIn,
    use_case: HandleSubscribeProxyDep,
    settings: FromDishka[Settings],
    x_internal_token: Annotated[str | None, Header(alias="X-Internal-Token")] = None,
) -> dict[str, Any]:
    """Валидация подписки: centrifugo → бэк (§4).

    Тело v6: `{client, channel, user}` — user это sub connection-JWT.
    Разрешено → `{}`; запрещено → `{"error": {"code": 403, ...}}` (200:
    формат centrifugo, не-2xx считается временной ошибкой и ретраится).
    """
    _check_subscribe_token(x_internal_token, settings)
    # v6 присылает user; data.sub оставлен как запасной вариант формата.
    sub = body.user or (
        body.data.get("sub") if isinstance(body.data, dict) else None
    )
    allowed = await use_case.execute(body.channel, sub)
    if not allowed:
        logger.info(
            "subscribe_denied channel=%s sub=%s", body.channel, sub
        )
        return {"error": {"code": 403, "message": "subscription denied"}}
    return {}


@router.get("/{thread_id}/messages", response_model=list[MessageOut])
async def list_messages(
    user: CurrentUserDep,
    use_case: ListMessagesDep,
    thread_id: ThreadIdPath,
    before_id: int | None = Query(default=None, ge=1),
    after_id: int | None = Query(default=None, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
) -> list[MessageOut]:
    """Сообщения по возрастанию id: before_id — вниз, after_id — поллинг."""
    _reject_guest(user.telegram_id)
    try:
        messages = await use_case.execute(
            thread_id,
            _user_ref(user.telegram_id),
            before_id=before_id,
            after_id=after_id,
            limit=limit,
        )
    except AppError as exc:
        _raise_app_error(exc)
    return [_message_out(m) for m in messages]


@router.post(
    "/{thread_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def send_message(
    body: MessageIn,
    user: CurrentUserDep,
    use_case: SendMessageDep,
    spawner: SupportBotSpawnerDep,
    list_messages: ListMessagesDep,
    cache: FromDishka[CachePort],
    response: Response,
    thread_id: ThreadIdPath,
    idempotency_key: IdempotencyKeyHeader = None,
) -> MessageOut:
    """Отправить сообщение (markdown <=4000) + публикация в канал (§4).

    В support-треде ответ RAG-бота готовится фоном (§6): REST не ждёт
    LLM, клиент получает ответ по сокету или поллингом `after_id`.
    Спавнер сам отсекает не-support треды (в своей сессии).

    Гость — 403 (06 §5): сообщения гостям недоступны, как и весь /api/chats.

    `Idempotency-Key` (необязательный, долг №7): повтор запроса с тем же
    ключом того же отправителя возвращает сохранённое сообщение (200)
    без новой записи, публикации и запуска бота.

    Антифрод (08 §4): 20 сообщений/мин на (юзер, тред) — сверх лимита
    429 `message_rate_limit` (redis INCR, окно 60с).
    """
    _reject_guest(user.telegram_id)
    sender = _user_ref(user.telegram_id)
    key = _norm_idempotency_key(idempotency_key)
    replayed = await _replayed_message(
        list_messages, cache, thread_id, sender, key
    )
    if replayed is not None:
        response.status_code = status.HTTP_200_OK
        return _message_out(replayed)
    await _enforce_message_rate_limit(cache, thread_id, sender)
    try:
        message = await use_case.execute(thread_id, sender, body.body)
    except AppError as exc:
        _raise_app_error(exc)
    await _remember_idempotent(cache, sender, key, message.id)
    spawner.spawn(thread_id, user.telegram_id, message.body)
    return _message_out(message)


@router.post("/{thread_id}/summon-operator", response_model=SummonOut)
async def summon_operator(
    user: CurrentUserDep,
    use_case: SummonOperatorDep,
    thread_id: ThreadIdPath,
) -> SummonOut:
    """«Позвать человека» (§6): бот на паузе + system-строка в канал.

    Идемпотентно: повторный зов при уже стоящей паузе — тот же 200 без
    второй system-строки. Не-support тред — 409, чужой тред — 404,
    гость — 403 (как весь /api/chats).
    """
    _reject_guest(user.telegram_id)
    try:
        thread, message = await use_case.execute(thread_id, user.telegram_id)
    except AppError as exc:
        _raise_app_error(exc)
    # `thread` из репозитория взят до UPDATE паузы — флаг отражает постусловие.
    return SummonOut(
        bot_paused=thread.bot_paused or message is not None,
        message=_message_out(message) if message is not None else None,
    )


@router.post("/{thread_id}/read")
async def mark_read(
    body: ReadIn,
    user: CurrentUserDep,
    use_case: MarkReadDep,
    thread_id: ThreadIdPath,
) -> dict[str, int]:
    """Поднять read-маркер юзера (без поля — до последнего сообщения)."""
    _reject_guest(user.telegram_id)
    try:
        marker = await use_case.execute(
            thread_id,
            _user_ref(user.telegram_id),
            body.last_read_message_id,
        )
    except AppError as exc:
        _raise_app_error(exc)
    return {"last_read_message_id": marker}


@router.post("/{thread_id}/typing")
async def send_typing(
    user: CurrentUserDep,
    use_case: SendTypingDep,
    cache: FromDishka[CachePort],
    thread_id: ThreadIdPath,
) -> dict[str, bool]:
    """«Печатает» (09 §1): эфемерное событие ДРУГИМ участникам треда.

    Себе не доставляется (свои echo не нужны); rate 1/2с на (юзер,
    тред) — 429 `typing_rate_limit` на второе событие в окне. Не
    участник — 404, гость — 403 (как весь /api/chats).
    """
    _reject_guest(user.telegram_id)
    sender = _user_ref(user.telegram_id)
    await _enforce_typing_rate_limit(cache, thread_id, sender)
    try:
        await use_case.execute(thread_id, sender)
    except AppError as exc:
        _raise_app_error(exc)
    return {"typing": True}


@router.get("/{thread_id}/link-preview")
async def link_preview(
    user: CurrentUserDep,
    use_case: GetLinkPreviewDep,
    thread_id: ThreadIdPath,
    url: str = Query(min_length=1, max_length=2048),
) -> dict[str, Any]:
    """Превью ссылки: /listing/N → карточка из БД, внешняя → OG-теги.

    SSRF: только http/https, приватные IP запрещены (400), тело <=512KB,
    редирект — один, кэш 24ч (§5). Авторизация юзера — как у остальных
    эндпоинтов треда (без отдельной проверки участия: превью не раскрывает
    содержимое чата). Гость — 403 (06 §5), как весь /api/chats.
    """
    _reject_guest(user.telegram_id)
    try:
        return await use_case.execute(url)
    except LinkBlockedError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, exc.public_message
        ) from exc
    except AppError as exc:
        _raise_app_error(exc)


def _user_ref(telegram_id: int) -> ParticipantRef:
    """ParticipantRef юзера (telegram_id)."""
    return ParticipantRef(user_type="user", user_id=telegram_id)


# ==========================================================================
# Операторский контур (§2/§6): /api/admin/chats — X-Internal-Token
# (InternalDishkaRoute, как у admin.py). Оператор видит все треды,
# ответ оператора ставит bot_paused (репозиторий, §2). Без сокета:
# админка поллит список (30с) и комнату (10с).
# ==========================================================================


@admin_router.get("", response_model=list[OperatorThreadOut])
async def admin_list_chats(
    use_case: ListOperatorThreadsDep,
    type: Literal["support", "seller", "deal"] = Query(default="support"),
    paused: bool | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[OperatorThreadOut]:
    """Список тредов для оператора: юзер, последнее юзер-сообщение, пауза.

    `paused=true` — только треды, где бот на паузе (юзер позвал человека
    или оператор уже вклинился, §6).
    """
    views = await use_case.execute(type, paused=paused, limit=limit)
    return [_operator_thread_out(v) for v in views]


@admin_router.get("/unread")
async def admin_chats_unread(
    use_case: CountOperatorUnreadDep,
    type: Literal["support", "seller", "deal"] = Query(default="support"),
) -> dict[str, int]:
    """Бейдж «ждут ответа»: треды с юзер-сообщением позже последнего
    ответа оператора (или ответов ещё не было) — для поллинга админки."""
    return {"threads": await use_case.execute(type)}


# ==========================================================================
# Модерация и аудит (08 §4-§5): жалобы, кик оператора, лента событий.
# ==========================================================================


@admin_router.get("/reports", response_model=list[AdminReportOut])
async def admin_list_reports(
    use_case: ListAdminReportsDep,
    status: Literal["new", "resolved", "dismissed"] = Query(default="new"),
    limit: int = Query(default=100, ge=1, le=200),
) -> list[AdminReportOut]:
    """Жалобы по статусу: репортёр, причина + сниппет последнего
    сообщения треда — модерация видит контекст без открытия комнаты."""
    views = await use_case.execute(status, limit=limit)
    return [AdminReportOut.model_validate(v, from_attributes=True) for v in views]


@admin_router.patch("/reports/{report_id}")
async def admin_handle_report(
    body: ReportStatusIn,
    use_case: HandleReportDep,
    report_id: int = Path(ge=1),
) -> dict[str, str]:
    """Обработать жалобу: resolved|dismissed (handled_at=now, 08 §4).

    После обработки репортёр может пожаловаться повторно (partial unique
    держит только «открытые» жалобы).
    """
    try:
        await use_case.execute(report_id, body.status)
    except AppError as exc:
        _raise_app_error(exc)
    return {"status": body.status}


@admin_router.get("/{thread_id}/events", response_model=list[ChatEventOut])
async def admin_list_events(
    use_case: ListThreadEventsDep,
    thread_id: ThreadIdPath,
    limit: int = Query(default=100, ge=1, le=500),
) -> list[ChatEventOut]:
    """Лента аудита треда (08 §5): created/joined/invited/kicked/...,
    новые сверху (id DESC)."""
    try:
        events = await use_case.execute(thread_id, limit=limit)
    except AppError as exc:
        _raise_app_error(exc)
    return [ChatEventOut.model_validate(e, from_attributes=True) for e in events]


@admin_router.delete(
    "/{thread_id}/participants/{user_type}/{user_id}"
)
async def admin_kick_participant(
    use_case: AdminKickDep,
    thread_id: ThreadIdPath,
    user_type: Literal["user", "partner", "operator"] = Path(),
    user_id: int = Path(),
) -> dict[str, bool]:
    """Оператор исключает любого участника, включая owner (08 §4).

    Событие 'kicked' с actor=operator. Треда/участника нет — 404.
    """
    try:
        await use_case.execute(thread_id, user_type, user_id)
    except AppError as exc:
        _raise_app_error(exc)
    return {"removed": True}


@admin_router.get("/{thread_id}/messages", response_model=list[MessageOut])
async def admin_list_messages(
    use_case: ListOperatorMessagesDep,
    thread_id: ThreadIdPath,
    before_id: int | None = Query(default=None, ge=1),
    after_id: int | None = Query(default=None, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
) -> list[MessageOut]:
    """Сообщения треда по возрастанию id — оператор видит всё (§2)."""
    try:
        messages = await use_case.execute(
            thread_id, before_id=before_id, after_id=after_id, limit=limit
        )
    except AppError as exc:
        _raise_app_error(exc)
    return [_message_out(m) for m in messages]


@admin_router.post(
    "/{thread_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def admin_send_message(
    body: MessageIn,
    use_case: SendOperatorMessageDep,
    thread_id: ThreadIdPath,
) -> MessageOut:
    """Ответ оператора: sender_type='operator' (repo ставит bot_paused=True,
    §2) + публикация в канал треда и личный канал юзера (§4)."""
    try:
        message = await use_case.execute(thread_id, body.body)
    except AppError as exc:
        _raise_app_error(exc)
    return _message_out(message)


class ThreadSummaryOut(BaseModel):
    """LLM-выжимка треда для оператора (12 §3)."""

    thread_id: UUID
    summary: str
    last_message_id: int
    generated_at: str


@admin_router.post("/{thread_id}/summary", response_model=ThreadSummaryOut)
async def admin_thread_summary(
    use_case: SummarizeThreadDep, thread_id: ThreadIdPath
) -> ThreadSummaryOut:
    """LLM-выжимка треда для оператора (12 §3, X-Internal-Token).

    Последние ≤50 сообщений → выжимка ≤600 знаков: что хочет клиент,
    обсуждаемые лоты, сомнения, договорённости, следующий шаг. Кэш 1 час
    по последнему сообщению; LLM не настроена — 503; треда нет — 404.
    """
    try:
        view = await use_case.execute(thread_id)
    except AiUnavailable as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, exc.public_message
        ) from exc
    except AppError as exc:
        _raise_app_error(exc)
    return ThreadSummaryOut(
        thread_id=view.thread_id,
        summary=view.summary,
        last_message_id=view.last_message_id,
        generated_at=view.generated_at,
    )
