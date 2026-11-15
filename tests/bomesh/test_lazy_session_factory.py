"""The lazy session factory must stand in for a real ``async_sessionmaker``."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from bomesh.db import engine as engine_module
from bomesh.db.engine import LazySessionFactory, transaction_scope

# Every attribute the application reaches for on its session factory. A proxy
# that forwards only ``__call__`` breaks ``session_factory.begin()`` at runtime
# while every stubbed test still passes.
FORWARDED_ATTRIBUTES = ("begin", "kw")


@pytest.fixture(autouse=True)
def engines(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, int]]:
    """Stub the engine: record the pool sizing each factory asks for."""
    requested: list[dict[str, int]] = []

    def get_engine(**pool: int) -> object:
        requested.append(pool)
        return object()

    monkeypatch.setattr(engine_module, "get_engine", get_engine)
    return requested


def test_engine_is_not_built_until_a_session_is_requested(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    calls: list[int] = []

    def fail(**_: int) -> None:
        calls.append(1)
        raise RuntimeError("DATABASE_URL is required")

    monkeypatch.setattr(engine_module, "get_engine", fail)
    factory = LazySessionFactory()

    assert calls == []

    with pytest.raises(RuntimeError, match="DATABASE_URL is required"):
        factory()

    assert calls == [1]


@pytest.mark.parametrize("attribute", FORWARDED_ATTRIBUTES)
def test_session_maker_attributes_are_forwarded(
    monkeypatch: pytest.MonkeyPatch, attribute: str
) -> None:
    sentinel = object()
    real = type("Sessionmaker", (), {attribute: sentinel})()
    monkeypatch.setattr(engine_module, "get_session_factory", lambda _engine: real)

    assert getattr(LazySessionFactory(), attribute) is sentinel


def test_calling_the_factory_opens_a_session_from_the_real_factory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = object()
    monkeypatch.setattr(
        engine_module, "get_session_factory", lambda _engine: lambda **_: session
    )
    factory = LazySessionFactory()

    assert factory() is session
    assert factory() is session


def test_the_real_factory_is_built_once(monkeypatch: pytest.MonkeyPatch) -> None:
    built: list[int] = []

    def build(_engine: object) -> object:
        built.append(1)
        return lambda **_: object()

    monkeypatch.setattr(engine_module, "get_session_factory", build)
    factory = LazySessionFactory()
    factory()
    factory()

    assert built == [1]


def test_private_attributes_do_not_resolve_the_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A missing dunder must not recurse into building the engine."""

    monkeypatch.setattr(
        engine_module,
        "get_session_factory",
        lambda _engine: pytest.fail("engine built for a private attribute"),
    )

    with pytest.raises(AttributeError):
        LazySessionFactory()._not_a_real_attribute


def test_runtime_hands_services_a_usable_session_factory(
    monkeypatch: pytest.MonkeyPatch, engines: list[dict[str, int]]
) -> None:
    """The runtime's factory must satisfy the surface services call on it."""

    real = type("Sessionmaker", (), {attr: object() for attr in FORWARDED_ATTRIBUTES})()
    monkeypatch.setattr(engine_module, "get_session_factory", lambda _engine: real)

    from bomesh.runtime import AppRuntime
    from config import AppConfig, DatabaseConfig

    sessions = AppRuntime(AppConfig(database=DatabaseConfig(pool_size=7, max_overflow=3))).sessions()

    for attribute in FORWARDED_ATTRIBUTES:
        assert getattr(sessions, attribute) is getattr(real, attribute)
    assert engines == [{"pool_size": 7, "max_overflow": 3}]


@pytest.mark.asyncio
async def test_transaction_scope_uses_factory_begin_and_releases_scope() -> None:
    events: list[str] = []

    class BeginScope:
        async def __aenter__(self):
            events.append("begin")
            return "session"

        async def __aexit__(self, exc_type, exc, traceback):
            events.append("rollback" if exc_type else "commit")

    class Factory:
        def begin(self):
            return BeginScope()

    async with transaction_scope(Factory()) as session:
        assert session == "session"
        events.append("work")

    assert events == ["begin", "work", "commit"]

    events.clear()
    with pytest.raises(RuntimeError):
        async with transaction_scope(Factory()):
            events.append("work")
            raise RuntimeError("boom")
    assert events == ["begin", "work", "rollback"]
