"""Порты биллинга: хранилище платежей и субъект подписки."""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

from app.application.billing.dto import PaymentRecord, SubscriptionState


class PaymentRepository(Protocol):
    """Хранилище платежей и подписки пользователя."""

    async def create_pending(
        self,
        *,
        user_id: int,
        amount: int,
        tier: str,
        period_days: int,
    ) -> int:
        """Создать pending-платёж и вернуть его id (фиксирует строку)."""

    async def create_pending_placement(
        self,
        *,
        user_id: int,
        amount: int,
        listing_id: int,
        weeks: int,
    ) -> int:
        """Pending-платёж продления размещения (kind='placement').

        `period_days = 7*weeks` — ConfirmPayment добавляет дни к дедлайну.
        """

    async def get_payment(self, payment_id: int) -> PaymentRecord | None:
        """Снимок платежа или `None`, если платежа нет."""

    async def get_placement_deadlines(
        self, listing_id: int
    ) -> tuple[datetime | None, datetime | None] | None:
        """`(placement_free_until, placement_paid_until)` лота или `None`."""

    async def save_placement_paid_until(
        self, listing_id: int, *, user_id: int, until: datetime
    ) -> bool:
        """Записать `placement_paid_until` и активировать свой лот.

        Возвращает `False`, если лот не найден или чужой (в текущей
        транзакции, commit — в сценарии).
        """

    async def get_subscription(self, user_id: int) -> SubscriptionState | None:
        """Подписка пользователя или `None`, если пользователя нет."""

    async def mark_paid(
        self,
        payment_id: int,
        *,
        provider_payment_id: str,
        paid_at: datetime,
    ) -> None:
        """Пометить платёж оплаченным (в текущей транзакции)."""

    async def save_subscription(
        self, user_id: int, *, tier: str, until: datetime
    ) -> None:
        """Записать тариф и срок подписки (в текущей транзакции)."""

    async def commit(self) -> None:
        """Зафиксировать платёж и подписку одной транзакцией."""

    async def rollback(self) -> None:
        """Откатить текущую транзакцию (гонка вебхуков: эффект уже применён).

        Вызывается сценарием, когда `mark_paid` вернул `False`: платёж
        оплатил параллельный вебхук, осталось отбросить открытый этой
        веткой no-op UPDATE и вернуть подтверждение без второго эффекта.
        """


class SubscriptionSubject(Protocol):
    """Минимальный контракт субъекта подписки (ORM удовлетворяет)."""

    subscription_tier: str | None
    subscription_until: datetime | None
