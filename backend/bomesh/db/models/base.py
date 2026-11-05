"""Declarative base, naming convention and shared column helpers."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, MetaData, String, func, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TEXT
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

JsonObject = dict[str, Any]

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class UUIDPrimaryKeyMixin:
    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )


class CreatedAtMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class TimestampMixin(CreatedAtMixin):
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


def uuid_fk(target: str, *, nullable: bool = True, **kwargs: Any) -> Any:
    """A uuid column referencing ``target`` (``table.column``)."""

    return mapped_column(
        PG_UUID(as_uuid=True), ForeignKey(target), nullable=nullable, **kwargs
    )


def uuid_column(*, nullable: bool = True) -> Any:
    """A uuid column without a foreign key (polymorphic references)."""

    return mapped_column(PG_UUID(as_uuid=True), nullable=nullable)


def timestamp(*, nullable: bool = True) -> Any:
    return mapped_column(DateTime(timezone=True), nullable=nullable)


def created_now() -> Any:
    """A not-null creation time defaulting to the transaction time."""

    return mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


def updated_now() -> Any:
    """A not-null modification time, refreshed by every ORM update."""

    return mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


def choice(default: str, length: int = 16) -> Any:
    """A not-null vocabulary column with a server default."""

    return mapped_column(
        String(length), nullable=False, default=default, server_default=default
    )


def flag(default: bool) -> Any:
    return mapped_column(
        Boolean,
        nullable=False,
        default=default,
        server_default=text("true" if default else "false"),
    )


def json_object(column_name: str | None = None) -> Any:
    args = (column_name,) if column_name else ()
    return mapped_column(
        *args,
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )


def json_array() -> Any:
    return mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )


def text_array() -> Any:
    return mapped_column(
        ARRAY(TEXT),
        nullable=False,
        default=list,
        server_default=text("'{}'::text[]"),
    )


def uuid_array() -> Any:
    return mapped_column(
        ARRAY(PG_UUID(as_uuid=True)),
        nullable=False,
        default=list,
        server_default=text("'{}'::uuid[]"),
    )


def one_of(column: str, values: tuple[str, ...], *, nullable: bool = False) -> str:
    """CHECK expression restricting ``column`` to a vocabulary."""

    allowed = ", ".join(f"'{value}'" for value in values)
    expression = f"{column} IN ({allowed})"
    return f"{column} IS NULL OR {expression}" if nullable else expression
