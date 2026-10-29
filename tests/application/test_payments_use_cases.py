"""Гонки двойного вебхука successful_payment (аудит 2026-10-29, B-02).

`ConfirmPayment` при `mark_paid == False` (платёж уже оплатил параллельный
вебхук) вызывает `PaymentRepository.rollback()`. До фикса метода не было ни
в порте, ни в адаптере — AttributeError и 500 на внутреннем эндпоинте
`/api/payments/success`, хотя деньги уже зачислены первой транзакцией.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from app.application.billing.dto import PaymentRecord, SubscriptionState
from app.application.payments.use_cases import ConfirmPayment
from app.infrastructure.db.repositories.payments import SqlAlchemyPaymentRepository


class _RacePaymentRepository:
    """Двойник порта: `mark_paid` всегда False — гонку выиграл параллельный вебхук."""

    def __init__(
        self, record: PaymentRecord, deadlines: Any | None = None
    ) -> None:
        self._record = record
        self._deadlines = deadlines
        self.state = SubscriptionState(
            subscription_tier="free", subscription_until=None
        )
        self.rolled_back = False
        self.saved_subscription: tuple | None = None
        self.saved_placement: tuple | None = None
        self.committed = False

    async def get_payment(self, payment_id: int) -> PaymentRecord | None:
        return self._record if payment_id == self._record.id else None

    async def get_subscription(self, user_id: int) -> SubscriptionState:
        return self.state

    async def get_placement_deadlines(self, listing_id: int) -> Any:
        return self._deadlines

    async def mark_paid(
        self, payment_id: int, *, provider_payment_id: str, paid_at: datetime
    ) -> bool:
        return False  # UPDATE … WHERE status != 'paid' → rowcount 0

    async def save_subscription(
        self, user_id: int, *, tier: str, until: datetime
    ) -> None:
        self.saved_subscription = (user_id, tier, until)

    async def save_placement_paid_until(
        self, listing_id: int, *, user_id: int, until: datetime
    ) -> bool:
        self.saved_placement = (listing_id, user_id, until)
        return True

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        self.rolled_back = True


def _subscription_payment() -> PaymentRecord:
    """Pending-платёж подписки pro/30d пользователя 42."""
    return PaymentRecord(
        id=1,
        user_id=42,
        status="pending",
        tier="pro",
        period_days=30,
        amount=Decimal("500"),
    )


async def test_double_webhook_race_rolls_back_and_confirms():
    """B-02: проигравший гонку вебхук не падает — rollback у порта существует,
    эффект (подписка) не применяется второй раз."""
    repo = _RacePaymentRepository(_subscription_payment())
    confirmation = await ConfirmPayment(repo).execute(
        payment_id=1, user_id=42, provider_payment_id="chg_race"
    )
    assert confirmation.activated is True
    assert confirmation.tier == "pro"
    assert confirmation.subscription_until is not None
    assert confirmation.subscription_until > datetime.now(UTC)
    assert repo.rolled_back is True  # открытая транзакция отброшена
    assert repo.saved_subscription is None  # продление уже сделал победитель
    assert repo.committed is False


async def test_double_webhook_race_placement_kind():
    """B-02: та же гонка для kind='placement' — подтверждение без повторного
    продления размещения (дедлайн читан заново, как у победителя)."""
    paid_until = datetime.now(UTC) + timedelta(days=7)
    record = PaymentRecord(
        id=2,
        user_id=42,
        status="pending",
        tier=None,
        period_days=7,
        amount=Decimal("300"),
        kind="placement",
        listing_id=5,
    )
    repo = _RacePaymentRepository(record, deadlines=(None, paid_until))
    confirmation = await ConfirmPayment(repo).execute(
        payment_id=2, user_id=42, provider_payment_id="chg_race2"
    )
    assert confirmation.kind == "placement"
    assert confirmation.activated is True
    assert confirmation.placement_paid_until == paid_until
    assert repo.saved_placement is None
    assert repo.committed is False


def test_payment_repository_has_rollback():
    """B-02: у адаптера есть rollback (раньше hasattr == False — AttributeError)."""
    assert hasattr(SqlAlchemyPaymentRepository, "rollback")


async def test_repository_rollback_delegates_to_session():
    """Адаптер делегирует rollback сессии (транзакция закрывается корректно)."""

    class _Session:
        def __init__(self) -> None:
            self.rolled_back = False

        async def rollback(self) -> None:
            self.rolled_back = True

    session = _Session()
    await SqlAlchemyPaymentRepository(session).rollback()
    assert session.rolled_back is True
