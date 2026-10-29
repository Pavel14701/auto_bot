"""Сценарии AI-поиска Mini App: rate-limit, сообщение, финализация.

Отличие от бота — только источник пользователя (JWT вместо internal-токена)
и защита бюджета: сообщения бесплатны по квоте, но не по LLM-вызовам,
поэтому на `/message` стоит per-user лимит из Redis.

Квота AI-поиска (`quota_used`) читается через `application/quota`; лимит
по тарифу считает `application/dialog.ai_daily_limit`, а списание делает
агент в момент выдачи результата (`preview`/`finalize`), а не за сообщение.
"""

from __future__ import annotations

import logging

from app.application.dialog.dto import (
    AI_MESSAGE_RATE_LIMIT,
    AI_MESSAGE_RATE_PREFIX,
    AI_MESSAGE_RATE_WINDOW_SEC,
    AiMessageCommand,
    DialogMessageCommand,
    DialogReply,
)
from app.application.dialog.ports import QuotaStore
from app.application.dialog.use_cases import SendDialogMessage
from app.application.errors import AppError
from app.application.quota.use_cases import quota_used
from app.application.catalog.dto import GUEST_FORBIDDEN_MESSAGE
from app.application.catalog.ports import UserLookupPort
from app.application.errors import Forbidden, NotFound
from app.application.shared.ports import CachePort

logger = logging.getLogger(__name__)


class RateLimited(AppError):
    """Слишком много сообщений за окно."""

    code = "rate_limited"
    default_message = "Слишком много сообщений. Подождите минуту."


class MessageRateLimiter:
    """Per-user лимит сообщений в минуту (Redis INCR + TTL)."""

    def __init__(
        self,
        cache: CachePort,
        *,
        limit: int = AI_MESSAGE_RATE_LIMIT,
        window_sec: int = AI_MESSAGE_RATE_WINDOW_SEC,
    ) -> None:
        self._cache = cache
        self._limit = limit
        self._window = window_sec

    async def check(self, user_id: int) -> None:
        """Посчитать сообщение и бросить 429-ошибку при превышении.

        Raises:
            RateLimited: Лимит окна исчерпан.
        """
        key = f"{AI_MESSAGE_RATE_PREFIX}:{user_id}"
        count = await self._cache.incr(key)
        if count == 1:
            await self._cache.expire(key, self._window)
        if count > self._limit:
            logger.warning(
                "ai_message_rate_limited user_id=%s count=%d", user_id, count
            )
            raise RateLimited()


class AiDailyQuota:
    """Наблюдение за суточной квотой AI-поиска (лимит + расход)."""

    def __init__(self, store: QuotaStore) -> None:
        self._store = store

    async def used(self, user_id: int) -> int:
        """Сколько AI-поисков списано за сегодня (ключ `application/quota`)."""
        return await quota_used(self._store, user_id)


class SendAiMessage:
    """Сообщение в Mini App: rate-limit → общий сценарий диалога."""

    def __init__(
        self,
        limiter: MessageRateLimiter,
        send_message: SendDialogMessage,
        quota: AiDailyQuota,
        users: UserLookupPort,
    ) -> None:
        self._limiter = limiter
        self._send_message = send_message
        self._quota = quota
        self._users = users

    async def execute(self, command: AiMessageCommand) -> DialogReply:
        """Ответить на сообщение.

        Raises:
            RateLimited: Превышен лимит сообщений.
            AiUnavailable: LLM недоступна.
            NotFound: Пользователя нет.
            Forbidden: Пользователь деактивирован.
        """
        # Гость → 403 (AI-01 аудита 2026-10-29): мультигостевые аккаунты не
        # должны получать свежие суточные LLM-квоты; поиск — после входа.
        profile = await self._users.get(command.user_id)
        if profile is None:
            raise NotFound("User not found")
        if not profile.is_active:
            raise Forbidden("User is deactivated")
        if profile.is_guest:
            logger.info("ai_guest_forbidden user_id=%s", command.user_id)
            raise Forbidden(GUEST_FORBIDDEN_MESSAGE)
        await self._limiter.check(command.user_id)
        try:
            quota_used_today = await self._quota.used(command.user_id)
        except Exception:  # noqa: BLE001 — наблюдение не должно ронять ответ
            logger.warning(
                "ai_quota_observe_failed user_id=%s", command.user_id, exc_info=True
            )
            quota_used_today = -1
        logger.info(
            "ai_message_quota user_id=%s used=%s",
            command.user_id,
            quota_used_today,
        )
        return await self._send_message.execute(
            DialogMessageCommand(user_id=command.user_id, text=command.text)
        )


__all__ = [
    "AiDailyQuota",
    "MessageRateLimiter",
    "RateLimited",
    "SendAiMessage",
]
