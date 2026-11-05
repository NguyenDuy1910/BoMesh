"""Fixtures of the API harness (documented in ``harness.py``).

One PostgreSQL schema serves the whole run: it is created on first use from
the models plus the IAM catalog, emptied before every test that asks for
``sessions`` (the catalog survives), and dropped at the end. Everything is
skipped when ``TEST_DATABASE_URL`` is unset.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import TypeVar
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from api.app import create_app
from bomesh.db.models import Base
from bomesh.iam.sync import sync_catalog
from bomesh.runtime import AppRuntime
from fakes import FakeAtlassian
from harness import TEST_DATABASE_URL, ApiClient, Fakes, Sessions, World, build_runtime

T = TypeVar("T")

#: Rows kept across tests: the permission catalog and the predefined roles.
_CATALOG_COPIES = {"roles": "_catalog_roles", "role_permissions": "_catalog_role_permissions"}
_KEPT = "permissions"


@dataclass(frozen=True, slots=True)
class Database:
    url: str
    schema: str

    def engine(self) -> AsyncEngine:
        return create_async_engine(
            self.url, connect_args={"server_settings": {"search_path": self.schema}}
        )


def _run(factory: Callable[[], Awaitable[T]]) -> T:
    """Run a coroutine to completion on a private loop in a worker thread.

    Keeps the session-scoped schema setup independent of pytest-asyncio's
    per-test event loops.
    """

    async def main() -> T:
        return await factory()

    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, main()).result()


async def _create(database: Database) -> None:
    admin = create_async_engine(database.url)
    try:
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{database.schema}"'))
    finally:
        await admin.dispose()
    engine = database.engine()
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine).begin() as session:
            await sync_catalog(session)
        async with engine.begin() as connection:
            for table, copy in _CATALOG_COPIES.items():
                await connection.execute(text(f"CREATE TABLE {copy} AS TABLE {table}"))
    finally:
        await engine.dispose()


async def _drop(database: Database) -> None:
    admin = create_async_engine(database.url)
    try:
        async with admin.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{database.schema}" CASCADE'))
    finally:
        await admin.dispose()


async def _reset(engine: AsyncEngine) -> None:
    """Empty every table, then restore the predefined roles and their permissions.

    ``TRUNCATE ... CASCADE`` reaches ``roles`` through ``roles.tenant_id``, so
    the catalog roles are copied back from the snapshot taken at creation.
    """
    tables = ", ".join(
        f'"{table.name}"' for table in Base.metadata.sorted_tables if table.name != _KEPT
    )
    async with engine.begin() as connection:
        await connection.execute(text(f"TRUNCATE {tables} CASCADE"))
        for table, copy in _CATALOG_COPIES.items():
            await connection.execute(text(f"INSERT INTO {table} SELECT * FROM {copy}"))


@pytest.fixture(scope="session")
def database() -> Iterator[Database]:
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is required for PostgreSQL API tests")
    database = Database(TEST_DATABASE_URL, f"test_v1_{uuid4().hex[:12]}")
    _run(lambda: _create(database))
    try:
        yield database
    finally:
        _run(lambda: _drop(database))


@pytest_asyncio.fixture
async def sessions(database: Database) -> AsyncIterator[Sessions]:
    engine = database.engine()
    try:
        await _reset(engine)
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
def fakes() -> Fakes:
    return Fakes()


@pytest_asyncio.fixture
async def runtime(sessions: Sessions, fakes: Fakes) -> AsyncIterator[AppRuntime]:
    runtime = build_runtime(sessions, fakes)
    try:
        yield runtime
    finally:
        await runtime.aclose()


@pytest.fixture
def app(runtime: AppRuntime) -> FastAPI:
    return create_app(runtime)


@pytest_asyncio.fixture
async def client(app: FastAPI, runtime: AppRuntime) -> AsyncIterator[ApiClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield ApiClient(http, runtime)


@pytest.fixture
def world(sessions: Sessions) -> World:
    return World(sessions)


@pytest.fixture
def atlassian(monkeypatch: pytest.MonkeyPatch) -> FakeAtlassian:
    """Atlassian's HTTP endpoints behind the runtime's Atlassian provider."""
    return FakeAtlassian().install(monkeypatch)
