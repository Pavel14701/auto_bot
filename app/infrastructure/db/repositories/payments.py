"""SQLAlchemy-репозиторий платежей и подписки пользователя.

Реализует `app.application.payments.use_cases.PaymentRepository`: сценарии
не знают про ORM, а деньги (сумма, срок) приходят уже посчитанными.

Инварианты:
- `create_pending` фиксирует строку сразу: инвойс ссылается на `payment.id`;
- `mark_paid` + `save_subscription` живут в одной транзакции, `commit`
  вызывается сценарием один раз (без «полуоплаченных» подписок);
- повторный `mark_paid` того же платежа не создаёт вторую строку.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.application.billing.dto import (
    STARS_CURRENCY,
    STARS_PROVIDER,
    PaymentRecord,
    SubscriptionState,
)
from app.application.market.dto import LISTING_STATUS_ACCEPTED, LISTING_STATUS_ARCHIVED
from app.infrastructure.db.models import Listing, Payment, User


class SqlAlchemyPaymentRepository:
    """`PaymentRepository` на `AsyncSession`."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def create_pending(
        self,
        *,
        user_id: int,
        amount: int,
        tier: str,
        period_days: int,
    ) -> int:
        """Создать pending-платёж Stars и вернуть его id."""
        payment = Payment(
            user_id=user_id,
            amount=amount,
            currency=STARS_CURRENCY,
            provider=STARS_PROVIDER,
            status="pending",
            tier=tier,
            period_days=period_days,
        )
        self._session.add(payment)
        await self._session.commit()
        await self._session.refresh(payment)
        return payment.id

    async def create_pending_placement(
        self,
        *,
        user_id: int,
        amount: int,
        listing_id: int,
        weeks: int,
    ) -> int:
        """Pending-платёж продления размещения (kind='placement').

        `period_days = 7*weeks` — столько дней вебхук добавит к дедлайну.
        """
        payment = Payment(
            user_id=user_id,
            amount=amount,
            currency=STARS_CURRENCY,
            provider=STARS_PROVIDER,
            status="pending",
            kind="placement",
            listing_id=listing_id,
            period_days=7 * weeks,
        )
        self._session.add(payment)
        await self._session.commit()
        await self._session.refresh(payment)
        return payment.id

    async def get_payment(self, payment_id: int) -> PaymentRecord | None:
        """Снимок платежа или `None`, если платежа нет."""
        payment = await self._session.get(Payment, payment_id)
        if payment is None:
            return None
        return PaymentRecord(
            id=payment.id,
            user_id=payment.user_id,
            status=payment.status,
            tier=payment.tier,
            period_days=payment.period_days,
            amount=payment.amount,
            kind=payment.kind,
            listing_id=payment.listing_id,
        )

    async def get_placement_deadlines(
        self, listing_id: int
    ) -> tuple[datetime | None, datetime | None] | None:
        """`(free_until, paid_until)` owner-лота или `None`, если лота нет."""
        row = (
            await self._session.execute(
                select(
                    Listing.placement_free_until,
                    Listing.placement_paid_until,
                ).where(Listing.id == listing_id)
            )
        ).one_or_none()
        if row is None:
            return None
        return row[0], row[1]

    async def save_placement_paid_until(
        self, listing_id: int, *, user_id: int, until: datetime
    ) -> bool:
        """Записать дедлайн и опубликовать свой owner-лот (в транзакции).

        `is_active=True` оживляет needs_payment-лоты первой оплатой;
        WHERE по владельцу защищает от чужого listing_id в платеже.
        Статус — 'accepted' (10 §1): продление истёкшего (expired) лота
        возвращает его в ленту; черновики и очередь модерации до
        оплаты не доходят (ExtendLot отсекает их 409).

        B-07/B-08 (аудит 2026-10-29): дедлайн — GREATEST(текущего, нового):
        параллельные вебхуки двух инвойсов не должны затирать друг друга
        (раньше меньший until перезаписывал больший — потеря оплаченной
        недели). Archived-лот оплатой старого инвойса не оживляем.
        """
        result = await self._session.execute(
            update(Listing)
            .where(
                Listing.id == listing_id,
                Listing.owner_type == "user",
                Listing.owner_user_id == user_id,
                Listing.status != LISTING_STATUS_ARCHIVED,
            )
            .values(
                placement_paid_until=func.greatest(
                    func.coalesce(Listing.placement_paid_until, until), until
                ),
                is_active=True,
                status=LISTING_STATUS_ACCEPTED,
            )
        )
        return bool(result.rowcount)

    async def get_subscription(self, user_id: int) -> SubscriptionState | None:
        """Подписка пользователя или `None`, если пользователя нет."""
        user = await self._session.get(User, user_id)
        if user is None:
            return None
        return SubscriptionState(
            subscription_tier=user.subscription_tier,
            subscription_until=user.subscription_until,
        )

    async def mark_paid(
        self,
        payment_id: int,
        *,
        provider_payment_id: str,
        paid_at: datetime,
    ) -> bool:
        """Пометить платёж оплаченным; `False` = уже был paid (двойной вебхук).

        Условная установка закрывает окно между чтением статуса в сценарии
        и коммитом: параллельная транзакция уже отметила платёж — эффект
        (продление/подписка) применён не будет.
        """
        from sqlalchemy import update

        # execute(..., execution_options={"synchronize_session": False})
        # чтобы Result имел rowcount и не трогал identity map дважды.
        result = await self._session.execute(
            update(Payment)
            .where(Payment.id == payment_id, Payment.status != "paid")
            .values(status="paid", paid_at=paid_at,
                    provider_payment_id=provider_payment_id)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount == 0:
            payment = await self._session.get(Payment, payment_id)
            if payment is None:
                raise LookupError(f"payment {payment_id} not found")
            return False
        # Синхронизируем ORM-объект (в реальной сессии UPDATE уже сделал
        # это; фейк-сессии тестов mutation-only).
        synced = await self._session.get(Payment, payment_id)
        if synced is not None and synced.status != "paid":
            synced.status = "paid"
            synced.paid_at = paid_at
            synced.provider_payment_id = provider_payment_id
        return True

    async def save_subscription(
        self, user_id: int, *, tier: str, until: datetime
    ) -> None:
        """Записать тариф и срок подписки в текущей транзакции."""
        user = await self._session.get(User, user_id)
        if user is None:  # сценарий читал этого пользователя в той же сессии
            raise LookupError(f"user {user_id} not found")
        user.subscription_tier = tier
        user.subscription_until = until

    async def commit(self) -> None:
        """Зафиксировать платёж и подписку одной транзакцией."""
        await self._session.commit()

    async def rollback(self) -> None:
        """Откатить текущую транзакцию (B-02: гонка двойного вебхука).

        `mark_paid` вернул `False` — платёж уже оплатил параллельный вебхук;
        открытый этой веткой no-op UPDATE (rowcount=0) транзакцию не грязнит,
        но и оставлять её висеть нельзя: отбрасываем и возвращаем
        подтверждение без повторного эффекта.
        """
        await self._session.rollback()
