"""Авторизация: initData Mini App, веб-регистрация, вход через Telegram-бота.

Тонкий контроллер: только разбор запроса, вызов сценария и маппинг результата
в схему. Ни SQL, ни сессии БД, ни Redis, ни импортов инфраструктуры — всё это
в `app.application.auth.use_cases` и адаптерах
(`infrastructure/db/repositories/users_auth.py`,
`infrastructure/security/login_codes.py`).

Эндпоинты:

- POST /telegram — вход по initData из Mini App (HMAC-проверка).
- POST /register, /login, /guest — веб-аутентификация (PBKDF2-SHA256).
- POST /refresh — обмен refresh-токена (без ротации — отдельный TECHDEBT).
- POST /telegram/link — создание одноразового кода + state-cookie.
- GET  /telegram/link/{code} — статус / JWT (с проверкой state-cookie).
- GET  /telegram/link/{code}/context — internal: контекст инициатора.
- DELETE /telegram/link/{code} — internal: отмена кода.
- POST /telegram/link/confirm — internal: подтверждение кода ботом.
- POST /magic-link — заглушка 501 (ТЗ п. 14.3).

Session fixation в flow «вход через Telegram-бота»: `state_hash` привязывает
код к браузеру инициатора, а `initiator_ip`/`initiator_ua`/`created_at`
отдаются боту, чтобы он показал «Вход в браузере: <IP>, <браузер>, <N сек
назад>» и вызвал `confirm` **только** после явного «✅ Это я». Полная модель
атаки — в docstring `app.application.auth.use_cases`.
"""


from __future__ import annotations
from app.transport.http.deps.dishka import DishkaRoute, InternalDishkaRoute

import logging

from fastapi import (
    APIRouter,
    HTTPException,
    Path,
    Request,
    Response,
    status,
)
from pydantic import BaseModel, Field

from app.application.auth.use_cases import (
    BotNotConfigured,
    EmailConflict,
    InvalidCredentials,
    InvalidEmail,
    InvalidInitData,
    InvalidToken,
    LoginLinkExpired,
    LoginStateMismatch,
    UserDeactivated,
    UserIdAllocationFailed,
    UserNotFound,
)
from app.application.identity.dto import (
    ConfirmLoginCommand,
    LoginCommand,
    RegisterCommand,
)
from app.application.identity.dto import AuthResult
from app.application.errors import AppError
from app.config import get_settings
from dishka.integrations.fastapi import FromDishka
from redis.asyncio import Redis

from app.infrastructure.security.ip_limit import client_ip, guest_ip_allowed
from app.transport.http.deps.auth_use_cases import (
    AuthenticateTelegramDep,
    CancelTelegramLoginDep,
    ConfirmTelegramLoginDep,
    CreateGuestSessionDep,
    CreateTelegramLoginLinkDep,
    GetLoginContextDep,
    LoginWebUserDep,
    PollTelegramLoginDep,
    RefreshSessionDep,
    RegisterWebUserDep,
)
from app.transport.http.schemas.user import (
    AuthResponse,
    MagicLinkRequest,
    RefreshRequest,
    TelegramAuthRequest,
    TokenPair,
    UserOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(route_class=DishkaRoute, prefix="/api/auth", tags=["auth"])

# Внутренние эндпоинты (бот): X-Internal-Token проверяет route-класс
# InternalDishkaRoute — router-level `Depends` больше не используется.
internal_router = APIRouter(route_class=InternalDishkaRoute)

_STATE_COOKIE_NAME = "tglogin_state"
_STATE_COOKIE_PATH = "/api/auth/telegram/link"  # покрывает GET /{code}
_CODE_PATH_PATTERN = r"^[A-Za-z0-9_-]+$"

# Прикладная ошибка → HTTP-статус. DuplicateUserId сюда не входит: это
# внутренний сигнал retry, наружу он не выходит.
_HTTP_STATUS: dict[type[AppError], int] = {
    InvalidCredentials: status.HTTP_401_UNAUTHORIZED,
    InvalidToken: status.HTTP_401_UNAUTHORIZED,
    UserNotFound: status.HTTP_401_UNAUTHORIZED,
    InvalidInitData: status.HTTP_401_UNAUTHORIZED,
    LoginStateMismatch: status.HTTP_401_UNAUTHORIZED,
    UserDeactivated: status.HTTP_403_FORBIDDEN,
    LoginLinkExpired: status.HTTP_404_NOT_FOUND,
    EmailConflict: status.HTTP_409_CONFLICT,
    InvalidEmail: status.HTTP_422_UNPROCESSABLE_CONTENT,
    BotNotConfigured: status.HTTP_503_SERVICE_UNAVAILABLE,
    UserIdAllocationFailed: status.HTTP_500_INTERNAL_SERVER_ERROR,
}


def _http_error(exc: AppError) -> HTTPException:
    """Прикладная ошибка → HTTP-ответ с безопасным текстом."""
    status_code = next(
        (
            code
            for error_type, code in _HTTP_STATUS.items()
            if isinstance(exc, error_type)
        ),
        status.HTTP_500_INTERNAL_SERVER_ERROR,
    )
    return HTTPException(status_code=status_code, detail=exc.public_message)


def _auth_response(result: AuthResult) -> AuthResponse:
    """DTO сценария → Pydantic-схема ответа."""
    return AuthResponse(
        access_token=result.tokens.access_token,
        refresh_token=result.tokens.refresh_token,
        user=UserOut.model_validate(result.user),
    )


def _cookie_samesite(settings) -> str:
    """SameSite для state-cookie с учётом конфигурации и prod/dev.

    Для cross-site фронтенда (`app.com` ↔ `api.com`) нужен `none` + `secure`.
    Для same-site (`app.example.com` ↔ `api.example.com`) — `lax`.

    Args:
        settings: Настройки приложения.

    Returns:
        `"lax"` или `"none"` (в dev `none` откатывается на `lax`: без Secure
        браузер cookie не примет).
    """
    samesite = getattr(settings, "auth_cookie_samesite", "lax")
    if samesite == "none" and not settings.is_prod:
        logger.warning(
            "auth_cookie_samesite=none requires Secure (prod); using lax in dev"
        )
        return "lax"
    return samesite


# ---------------------------------------------------------------------------
# Mini App / magic-link
# ---------------------------------------------------------------------------


@router.post("/telegram", response_model=AuthResponse)
async def auth_telegram(
    body: TelegramAuthRequest, use_case: AuthenticateTelegramDep
) -> AuthResponse:
    """Вход по initData из Mini App → JWT (access + refresh) + профиль.

    Raises:
        HTTPException: 503 без `BOT_TOKEN`, 401 при невалидном initData,
            403 если пользователь деактивирован.
    """
    try:
        result = await use_case.execute(body.init_data)
    except AppError as exc:
        raise _http_error(exc) from exc
    return _auth_response(result)


@router.post("/magic-link", status_code=status.HTTP_501_NOT_IMPLEMENTED)
async def auth_magic_link(body: MagicLinkRequest) -> dict[str, str]:
    """Вход по ссылке из бота. Реализуется на этапах 3–4 (ТЗ п. 14.3)."""
    return {"detail": "magic-link auth will be implemented at stage 3-4"}


# ---------------------------------------------------------------------------
# Вход через Telegram (веб-режим): код → /start в боте → JWT
# ---------------------------------------------------------------------------


class TelegramLoginLinkResponse(BaseModel):
    """Ответ на создание ссылки входа через Telegram-бота."""

    code: str
    url: str
    expires_in: int


class TelegramLoginConfirmRequest(BaseModel):
    """Данные подтверждения кода входа, присылаемые ботом.

    `user_acknowledged_at` — unix-время, когда пользователь нажал «✅ Это я».
    API не может проверить факт показа контекста, но поле нужно для аудита:
    сравнение с `created_at` из `/context` ловится в логах как suspicious.
    """

    code: str = Field(min_length=8, max_length=128, pattern=_CODE_PATH_PATTERN)
    telegram_id: int
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    language_code: str | None = None
    user_acknowledged_at: int | None = None


@router.post("/telegram/link", response_model=TelegramLoginLinkResponse)
async def create_telegram_login_link(
    request: Request,
    response: Response,
    use_case: CreateTelegramLoginLinkDep,
) -> TelegramLoginLinkResponse:
    """Одноразовый код входа + ссылка на бота.

    Привязывает код к текущему браузеру (HttpOnly state-cookie) **и** фиксирует
    контекст инициатора (IP, User-Agent, время) для UX-фикса session fixation.

    Args:
        request: FastAPI Request — источник IP и User-Agent.
        response: FastAPI Response — для установки state-cookie.
        use_case: Сценарий создания кода.

    Raises:
        HTTPException: 503 если `BOT_USERNAME` не сконфигурирован.
    """
    settings = get_settings()
    bot = (settings.bot_username or "").strip()  # config-валидатор уже снял "@"
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bot username is not configured",
        )

    link = await use_case.execute(
        initiator_ip=request.client.host if request.client else None,
        initiator_ua=request.headers.get("user-agent") or "",
    )
    response.set_cookie(
        key=_STATE_COOKIE_NAME,
        value=link.state,
        max_age=link.expires_in,
        httponly=True,
        secure=settings.is_prod,
        samesite=_cookie_samesite(settings),
        path=_STATE_COOKIE_PATH,
    )
    return TelegramLoginLinkResponse(
        code=link.code,
        url=f"https://t.me/{bot.lstrip('@')}?start=login_{link.code}",
        expires_in=link.expires_in,
    )


@router.get("/telegram/link/{code}", response_model=None)
async def telegram_login_status(
    request: Request,
    use_case: PollTelegramLoginDep,
    code: str = Path(min_length=8, max_length=128, pattern=_CODE_PATH_PATTERN),
) -> dict:
    """Статус входа: pending / expired / JWT-пара с профилем (одноразово).

    Требует HttpOnly-cookie `tglogin_state` из `POST /telegram/link`: без него
    код бесполезен для чужого браузера.

    Args:
        request: FastAPI Request — для чтения cookie.
        use_case: Сценарий поллинга.
        code: Одноразовый код из ответа `POST /telegram/link`.

    Returns:
        `{"status": "pending"}` / `{"status": "expired"}` либо `AuthResponse`.

    Raises:
        HTTPException: 401 если cookie отсутствует или не совпадает;
            403 если пользователь деактивирован.
    """
    try:
        poll = await use_case.execute(code, request.cookies.get(_STATE_COOKIE_NAME))
    except AppError as exc:
        raise _http_error(exc) from exc
    if poll.auth is None:
        return {"status": poll.status}
    return _auth_response(poll.auth).model_dump()


@internal_router.get(
    "/telegram/link/{code}/context",
)
async def telegram_login_context(
    use_case: GetLoginContextDep,
    code: str = Path(min_length=8, max_length=128, pattern=_CODE_PATH_PATTERN),
) -> dict:
    """Internal: контекст инициатора для бота (UX-фикс session fixation).

    Бот показывает пользователю IP/UA/время и только после явного
    подтверждения вызывает `POST /telegram/link/confirm`. Ответ — PII (IP),
    поэтому доступен только с `X-Internal-Token`.

    Raises:
        HTTPException: 404 если код истёк или не найден.
    """
    try:
        context = await use_case.execute(code)
    except AppError as exc:
        raise _http_error(exc) from exc
    return {
        "code": context.code,
        "status": context.status,
        "initiator_ip": context.initiator_ip,
        "initiator_ua": context.initiator_ua,
        "created_at": context.created_at,
    }


@internal_router.delete(
    "/telegram/link/{code}",
)
async def cancel_telegram_login(
    use_case: CancelTelegramLoginDep,
    code: str = Path(min_length=8, max_length=128, pattern=_CODE_PATH_PATTERN),
) -> dict:
    """Internal: инвалидировать код входа (жертва нажала «Отмена»).

    После удаления `GET /telegram/link/{code}` вернёт `{"status": "expired"}`,
    и атакующий не получит JWT.

    Raises:
        HTTPException: 404 если код истёк или не найден.
    """
    try:
        await use_case.execute(code)
    except AppError as exc:
        raise _http_error(exc) from exc
    return {"status": "cancelled"}


@internal_router.post(
    "/telegram/link/confirm",
)
async def confirm_telegram_login(
    body: TelegramLoginConfirmRequest, use_case: ConfirmTelegramLoginDep
) -> dict:
    """Internal: бот подтвердил `/start login_{code}`.

    Сохраняет `state_hash` (проверка привязки к браузеру) и контекст
    инициатора (аудит). Бот ОБЯЗАН вызывать endpoint только после явного
    подтверждения пользователем.

    Raises:
        HTTPException: 404 если код истёк или повреждён.
    """
    try:
        await use_case.execute(
            ConfirmLoginCommand(
                code=body.code,
                telegram_id=body.telegram_id,
                username=body.username,
                first_name=body.first_name,
                last_name=body.last_name,
                language_code=body.language_code,
                acknowledged_at=body.user_acknowledged_at,
            )
        )
    except AppError as exc:
        raise _http_error(exc) from exc
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Refresh
# ---------------------------------------------------------------------------


@router.post("/refresh", response_model=TokenPair)
async def auth_refresh(
    body: RefreshRequest, use_case: RefreshSessionDep
) -> TokenPair:
    """Обмен refresh-токена на новую пару access+refresh (веб-сессии, 0003).

    Ротация refresh (инвалидация старого) — отдельный TECHDEBT: требуется
    `users.refresh_token_version` и проверка в `decode_token`.

    Raises:
        HTTPException: 401 если токен не refresh/невалиден или пользователя нет.
    """
    try:
        tokens = await use_case.execute(body.refresh_token)
    except AppError as exc:
        raise _http_error(exc) from exc
    return TokenPair(
        access_token=tokens.access_token, refresh_token=tokens.refresh_token
    )


# ---------------------------------------------------------------------------
# Веб-регистрация (сайт): поиск доступен только зарегистрированным
# ---------------------------------------------------------------------------


class WebRegisterRequest(BaseModel):
    """Запрос на регистрацию с сайта."""

    email: str
    password: str = Field(min_length=8, max_length=128)
    first_name: str | None = Field(default=None, max_length=64)


class WebLoginRequest(BaseModel):
    """Запрос на вход с сайта."""

    email: str
    password: str = Field(min_length=1, max_length=128)


@router.post(
    "/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED
)
async def auth_register(
    body: WebRegisterRequest, use_case: RegisterWebUserDep
) -> AuthResponse:
    """Регистрация на сайте: email + пароль → JWT + профиль.

    Raises:
        HTTPException: 422 при неверном email, 409 если email уже занят.
    """
    try:
        result = await use_case.execute(
            RegisterCommand(
                email=body.email,
                password=body.password,
                first_name=body.first_name,
            )
        )
    except AppError as exc:
        raise _http_error(exc) from exc
    return _auth_response(result)


@router.post(
    "/guest", response_model=AuthResponse, status_code=status.HTTP_201_CREATED
)
async def auth_guest(
    use_case: CreateGuestSessionDep,
    request: Request,
    redis: FromDishka[Redis],
) -> AuthResponse:
    """Гостевой режим: сайт открыт без регистрации (демо функционала).

    Создаёт временного пользователя («Гость», синтетический telegram_id < 0,
    без email/пароля) и сразу выдаёт JWT. Гостю доступно демо: лента, фильтры,
    карточка, калькулятор, избранное. AI-анализ цены, Telegram-уведомления и
    покупка Pro — только после входа/регистрации. Апгрейд до аккаунта:
    «Войти/Зарегистрироваться» на экране профиля.

    Защита (TECHDEBT 1.4): фиксированное окно в Redis — не более
    `GUEST_IP_RATE_LIMIT` (по умолчанию 5) созданий сессий в минуту
    с одного IP (AUTH-01: `X-Real-IP` или правый хоп `X-Forwarded-For`
    — их ставит доверенный прокси, левую часть XFF клиент подделывает;
    иначе client host); превышение — 429.
    """
    settings = get_settings()
    ip = client_ip(
        request.headers.get("x-forwarded-for"),
        request.client.host if request.client else None,
        request.headers.get("x-real-ip"),
    )
    if not await guest_ip_allowed(
        redis, ip, limit=settings.guest_ip_rate_limit
    ):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many guest sessions from this IP, try again later",
        )
    try:
        result = await use_case.execute()
    except AppError as exc:
        raise _http_error(exc) from exc
    return _auth_response(result)


@router.post("/login", response_model=AuthResponse)
async def auth_login(
    body: WebLoginRequest, use_case: LoginWebUserDep
) -> AuthResponse:
    """Вход на сайте: email + пароль → JWT + профиль.

    Тайминг выровнен для всех 401-путей: PBKDF2 (~100ms) выполняется всегда
    (dummy-хеш для отсутствующего пользователя / пустого password_hash),
    поэтому нельзя отличить «email нет» от «email есть, пароль неверный».

    Raises:
        HTTPException: 422 при неверном email, 401 при неверной паре,
            403 если пользователь деактивирован.
    """
    try:
        result = await use_case.execute(
            LoginCommand(email=body.email, password=body.password)
        )
    except AppError as exc:
        raise _http_error(exc) from exc
    return _auth_response(result)


# Внутренние маршруты включаются в основной роутер (префикс /api/auth
# применяется при include).
router.include_router(internal_router)
