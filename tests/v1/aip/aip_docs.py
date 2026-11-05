"""An in-memory SQLite table to run compiled filters, orders and pages against.

``session`` is exposed to the tests by ``conftest.py``.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column


class Base(DeclarativeBase):
    pass


class Doc(Base):
    __tablename__ = "docs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    display_name: Mapped[str] = mapped_column(String)
    state: Mapped[str] = mapped_column(String)
    size: Mapped[int] = mapped_column(Integer)
    pinned: Mapped[bool] = mapped_column(Boolean)
    create_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    owner_id: Mapped[str | None] = mapped_column(String, nullable=True)


class DocTag(Base):
    __tablename__ = "doc_tags"

    doc_id: Mapped[int] = mapped_column(ForeignKey("docs.id"), primary_key=True)
    tag: Mapped[str] = mapped_column(String, primary_key=True)


def _at(day: int) -> datetime:
    return datetime(2026, 11, day, 12, 0, tzinfo=UTC)


DOCS = [
    Doc(
        id=1,
        display_name="Alpha",
        state="ACTIVE",
        size=5,
        pinned=True,
        create_time=_at(1),
        owner_id="u1",
    ),
    Doc(
        id=2,
        display_name="Beta",
        state="ACTIVE",
        size=20,
        pinned=False,
        create_time=_at(2),
        owner_id="u2",
    ),
    Doc(
        id=3,
        display_name='Say "hi"',
        state="DRAFT",
        size=20,
        pinned=False,
        create_time=_at(3),
        owner_id=None,
    ),
    Doc(
        id=4,
        display_name="Delta",
        state="ARCHIVED",
        size=-3,
        pinned=True,
        create_time=_at(4),
        owner_id="u1",
    ),
    Doc(
        id=5,
        display_name="Echo",
        state="DRAFT",
        size=50,
        pinned=False,
        create_time=_at(5),
        owner_id="u2",
    ),
]
TAGS = [
    DocTag(doc_id=1, tag="faq"),
    DocTag(doc_id=1, tag="hr"),
    DocTag(doc_id=2, tag="hr"),
]


@pytest.fixture
def session() -> Iterator[Session]:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add_all(
            [Doc(**_columns(doc)) for doc in DOCS]
            + [DocTag(**_columns(tag)) for tag in TAGS]
        )
        db.commit()
        yield db
    engine.dispose()


def _columns(row: Base) -> dict[str, object]:
    return {column.key: getattr(row, column.key) for column in row.__table__.columns}
