"""stale-check (PLAN.md, фаза 3): owner-лоты рынка никогда не сталеют (B-01).

`mark_stale` деактивирует только ВНЕШНИЕ лоты (encar/kcar/…): фильтр
`owner_type IS NULL` обязателен. Owner-лоты рынка (user/partner) не
пере-фетчатся — их `last_seen_at` навсегда остаётся датой создания, а жизнь
управляется placement/lifecycle (`market_placement_expiry` + `deactivate_lot`),
не источником. Без фильтра ночной stale-check через 3 дня убивал оплаченные
размещения и слоты (см. аудит 2026-10-29, B-01).
"""

from __future__ import annotations

from typing import Any

from app.infrastructure.db.repositories.listings_writer import (
    SqlAlchemyListingsWriter,
)


class _Result:
    """Результат execute() с цепочкой scalars().all() (select/update)."""

    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def scalars(self) -> "_Result":
        return self

    def all(self) -> list[Any]:
        return list(self._rows)


class StaleStmtSession:
    """Стаб сессии: сохраняет statement'ы mark_stale в порядке выполнения.

    Первый execute — выборка CB-источников (source_health), второй — сам
    UPDATE деактивации.
    """

    def __init__(
        self,
        cb_sources: list[str] | None = None,
        gone_ids: list[int] | None = None,
    ) -> None:
        self.statements: list[str] = []
        self._results = [_Result(cb_sources or []), _Result(gone_ids or [])]
        self.committed = False

    async def execute(self, stmt: Any, params: Any = None) -> _Result:
        self.statements.append(str(stmt))
        return self._results.pop(0)

    async def commit(self) -> None:
        self.committed = True


async def test_mark_stale_never_touches_owner_lots():
    """B-01: UPDATE фильтрует owner-лоты (`owner_type IS NULL`) — оплаченные
    размещения и слоты рынка не деактивируются ночным stale-check, сколько бы
    ни прожил их last_seen_at (дата создания)."""
    session = StaleStmtSession(cb_sources=[], gone_ids=[7])
    ids = await SqlAlchemyListingsWriter(session).mark_stale(max_age_days=3)

    assert ids == [7]  # внешние лоты сталеют как раньше
    update_sql = session.statements[1]
    assert "UPDATE listings" in update_sql
    assert "owner_type IS NULL" in update_sql  # владелец не матчится


async def test_mark_stale_external_lots_still_deactivate():
    """Внешние лоты (владельца нет) по-прежнему сталеют: is_active=false,
    disappeared_at=now(), порог по last_seen_at, CB-источники исключены."""
    session = StaleStmtSession(cb_sources=["encar"], gone_ids=[1, 2])
    ids = await SqlAlchemyListingsWriter(session).mark_stale(max_age_days=3)

    assert ids == [1, 2]
    assert session.committed is True
    assert "source_health" in session.statements[0]  # CB-источники учтены
    update_sql = session.statements[1]
    assert "is_active" in update_sql
    assert "disappeared_at" in update_sql
    assert "last_seen_at" in update_sql
    assert "NOT IN" in update_sql  # encar в circuit breaker — пропущен
