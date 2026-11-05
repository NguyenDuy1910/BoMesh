"""The SQL builders other slices report on ingestion with (Workspaces overview and usage)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from bomesh.services.ingestion.queries import (
    expired_connection_codes,
    failing_source_codes,
    processed_document_rows,
)
from bomesh.db.models import IngestionRun, IngestionRunItem, IngestionSource, IngestionSync, Item
from harness import Sessions, World
from runs_support import document
from sources_support import make_connection

pytestmark = pytest.mark.asyncio


async def _source(
    sessions: Sessions, connection_id: UUID, target: Item, code: str, *syncs: str, paused: bool = False
) -> None:
    """A source whose syncs ended with ``syncs``, oldest first."""
    start = datetime.now(UTC) - timedelta(hours=1)
    async with sessions.begin() as session:
        source = IngestionSource(
            tenant_id=target.tenant_id,
            code=code,
            integration_connection_id=connection_id,
            target_item_id=target.id,
            resource_type="space",
            external_resource_id=code,
            paused_at=start if paused else None,
        )
        session.add(source)
        await session.flush()
        for offset, status in enumerate(syncs):
            session.add(
                IngestionSync(
                    ingestion_source_id=source.id,
                    trigger_type="manual",
                    status=status,
                    started_at=start + timedelta(minutes=offset),
                    finished_at=start + timedelta(minutes=offset, seconds=30),
                )
            )


async def test_attention_queries_name_failing_sources_and_expired_connections(
    world: World, sessions: Sessions
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    target = await world.make_collection(workspace)
    healthy = await make_connection(sessions, workspace, "healthy")
    expired = await make_connection(
        sessions, workspace, "expired", status="reauthorization_required"
    )
    await make_connection(
        sessions, workspace, "mine", owner=admin, status="reauthorization_required"
    )
    await _source(sessions, healthy.id, target, "broken", "succeeded", "failed")
    await _source(sessions, healthy.id, target, "recovered", "failed", "succeeded")
    await _source(sessions, healthy.id, target, "paused", "failed", paused=True)
    await _source(sessions, expired.id, target, "stale", "failed")

    async with sessions() as session:
        failing = set(await session.scalars(failing_source_codes(workspace.id)))
        connections = set(await session.scalars(expired_connection_codes(workspace.id)))

    # A paused source and one behind a connection to reauthorize are not FAILED.
    assert failing == {"broken"}
    # Personal connections are their owners' business.
    assert connections == {"expired"}


async def test_processed_document_rows_are_succeeded_tasks(
    world: World, sessions: Sessions
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    target = await world.make_collection(workspace)
    done, failed = await document(sessions, target), await document(sessions, target)
    finished = datetime.now(UTC)
    async with sessions.begin() as session:
        run = IngestionRun(id=uuid4(), tenant_id=workspace.id, trigger_type="manual", status="succeeded")
        session.add(run)
        await session.flush()
        session.add_all(
            [
                IngestionRunItem(run_id=run.id, item_id=done.id, status="succeeded", finished_at=finished),
                IngestionRunItem(run_id=run.id, item_id=failed.id, status="failed", finished_at=finished),
            ]
        )

    async with sessions() as session:
        rows = (await session.execute(processed_document_rows())).all()

    assert [(row.tenant_id, row.item_id) for row in rows] == [(workspace.id, done.id)]
    assert rows[0].processed_at == finished
