"""Tombstoned resources are never physically deleted (AGENTS.md, "Lifecycle and deletion").

A table with a ``deleted_at`` column is a business resource with a tombstone
lifecycle. Every ORM session refuses to delete its rows, whether through
``session.delete(row)`` or a ``delete(Model)`` statement, so a hard delete
fails loudly in tests instead of silently losing history. Tables without a
tombstone (references, ledgers, probe history) are deleted normally.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Table, event
from sqlalchemy.orm import ORMExecuteState, Session, UOWTransaction
from sqlalchemy.sql import Delete


class TombstoneViolation(RuntimeError):
    """A hard delete of a table whose rows are tombstoned with ``deleted_at``."""


def is_tombstoned(table: Table) -> bool:
    return "deleted_at" in table.c


def _refuse(table: Table) -> None:
    raise TombstoneViolation(
        f"Rows of {table.name} are tombstoned with deleted_at; never delete them."
    )


def _refuse_bulk_delete(state: ORMExecuteState) -> None:
    statement = state.statement
    if isinstance(statement, Delete) and isinstance(statement.table, Table):
        if is_tombstoned(statement.table):
            _refuse(statement.table)


def _refuse_row_delete(session: Session, _flush: UOWTransaction, _instances: Any) -> None:
    for row in session.deleted:
        table = row.__table__
        if is_tombstoned(table):
            _refuse(table)


def install() -> None:
    """Make every ORM session refuse hard deletes of tombstoned tables (idempotent)."""
    for name, listener in (
        ("do_orm_execute", _refuse_bulk_delete),
        ("before_flush", _refuse_row_delete),
    ):
        if not event.contains(Session, name, listener):
            event.listen(Session, name, listener)


__all__ = ["TombstoneViolation", "install", "is_tombstoned"]
