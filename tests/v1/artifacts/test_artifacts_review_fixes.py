"""Write safety, agent-file sources, stopped generations, hook registration and purge.

Integration review findings #1, #5, #12, #21, #24 and #27.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select, update

import bomesh.services.artifacts.generation as generation
from artifacts_support import Scene, artifact_id, draft, finished, reason
from bomesh.services.artifacts.artifacts import load_result
from bomesh.services.kernel.operations import OPERATION_HANDLERS
from bomesh.services.operations.operations import reconcile_abandoned_operations
from bomesh.db.models import ArtifactSourceItem, Conversation, Item, ItemRevision
from bomesh.iam.authorizer import Principal, WorkspaceAccess
from bomesh.runtime import AppRuntime
from bomesh.services import ArtifactValidationError
from harness import Sessions, World
from native_responses import ScriptedResponsesTransport

pytestmark = pytest.mark.asyncio


def url(name: str, suffix: str = "") -> str:
    return f"/api/v1/{name}{suffix}"


class Hanging(ScriptedResponsesTransport):
    """A model that never answers; ``started`` is set once a request is waiting."""

    def __init__(self) -> None:
        super().__init__([])
        self.started = asyncio.Event()

    async def stream_response(self, **kwargs: Any) -> Any:
        self.started.set()
        await asyncio.Event().wait()


async def revisions(sessions: Sessions, artifact: UUID) -> list[ItemRevision]:
    async with sessions() as session:
        return list(
            await session.scalars(
                select(ItemRevision)
                .where(ItemRevision.item_id == artifact)
                .order_by(ItemRevision.revision_number)
            )
        )


async def item(sessions: Sessions, artifact: UUID) -> Item:
    async with sessions() as session:
        row = await session.get(Item, artifact)
        assert row is not None
        return row


async def conversation(scene: Scene, sessions: Sessions, code: str = "chat-1") -> UUID:
    created = await scene.as_owner.post(
        f"/api/v1/workspaces/{scene.workspace.id}/conversations",
        params={"conversationId": code},
        json={},
    )
    assert created.status_code == 200, created.text
    async with sessions() as session:
        value = await session.scalar(select(Conversation.id).where(Conversation.code == code))
    assert value is not None
    return value


def access(scene: Scene, runtime: AppRuntime) -> WorkspaceAccess:
    return WorkspaceAccess(Principal(scene.owner.id), scene.workspace.id, runtime.authorizer_factory())


# -- #5: one object per upload ---------------------------------------------------------------


async def test_concurrent_commits_each_keep_their_own_bytes(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await draft(scene, runtime, "one")

    first, second = await asyncio.gather(
        scene.as_owner.post(url(artifact["name"], ":commit"), json={"text": "two"}),
        scene.as_owner.post(url(artifact["name"], ":commit"), json={"text": "three"}),
    )

    assert (first.status_code, second.status_code) == (200, 200)
    rows = await revisions(sessions, artifact_id(artifact["name"]))
    assert len({row.storage_key for row in rows}) == 3
    texts = {
        (await scene.as_owner.get(url(artifact["name"], f"/revisions/{row.revision_number}"))).json()[
            "snapshot"
        ]["text"]
        for row in rows
    }
    assert texts == {"one", "two", "three"}


async def test_a_rollback_reuses_the_object_and_new_uploads_never_reuse_a_key(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await draft(scene, runtime, "one")
    await scene.as_owner.post(url(artifact["name"], ":commit"), json={"text": "two"})
    await scene.as_owner.delete(url(artifact["name"], "/revisions/2"))
    await scene.as_owner.post(url(artifact["name"], ":commit"), json={"text": "three"})
    await scene.as_owner.post(url(artifact["name"], "/revisions/1:rollback"), json={})

    rows = await revisions(sessions, artifact_id(artifact["name"]))

    assert [row.revision_number for row in rows] == [1, 2, 3, 4]
    assert len({rows[0].storage_key, rows[1].storage_key, rows[2].storage_key}) == 3
    assert rows[3].storage_key == rows[0].storage_key
    assert (await scene.as_owner.get(url(artifact["name"], "/revisions/2"))).status_code == 404


async def test_agent_files_are_refused_while_being_written(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    chat = await conversation(scene, sessions)
    engine = runtime.artifact_service()
    first = await engine.record_generated(
        access(scene, runtime), conversation_id=chat, file_name="a.csv", mime_type="text/csv", data=b"x\n", summary="v1"
    )
    async with sessions.begin() as session:
        await session.execute(update(Item).where(Item.id == first.artifact_id).values(status="pending"))

    with pytest.raises(ArtifactValidationError, match="being written"):
        await engine.record_generated(
            access(scene, runtime), conversation_id=chat, file_name="a.csv", mime_type="text/csv", data=b"y\n", summary="v2"
        )
    assert len(await revisions(sessions, first.artifact_id)) == 1


async def test_a_failed_upload_releases_the_reservation(
    scene: Scene, runtime: AppRuntime, sessions: Sessions, monkeypatch: pytest.MonkeyPatch
) -> None:
    chat = await conversation(scene, sessions)
    engine = runtime.artifact_service()
    kept = await engine.record_generated(
        access(scene, runtime), conversation_id=chat, file_name="a.csv", mime_type="text/csv", data=b"x\n", summary="v1"
    )

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise OSError("storage down")

    monkeypatch.setattr(runtime.object_storage(), "put_bytes", broken)
    for name in ("a.csv", "b.csv"):
        with pytest.raises(OSError):
            await engine.record_generated(
                access(scene, runtime), conversation_id=chat, file_name=name, mime_type="text/csv", data=b"y\n", summary="v"
            )

    assert (await item(sessions, kept.artifact_id)).status == "ready"
    async with sessions() as session:
        statuses = set(
            await session.scalars(
                select(Item.status).where(Item.metadata_["file_name"].astext == "b.csv")
            )
        )
    assert statuses == {"failed"}


# -- #12: agent files record the turn's documents ------------------------------------------------


async def test_agent_files_record_readable_sources_and_gate_the_space_audience(
    scene: Scene, runtime: AppRuntime, sessions: Sessions, world: World
) -> None:
    closed = await world.make_collection(scene.workspace, title="Closed", grants={scene.admin: "roles/collectionOwner"})
    hidden = await world.make_document(closed)
    chat = await conversation(scene, sessions)
    engine = runtime.artifact_service()

    first = await engine.record_generated(
        access(scene, runtime),
        conversation_id=chat,
        file_name="summary.md",
        mime_type="text/markdown",
        data=b"# Summary",
        summary="v1",
        source_ids=[scene.policy.id, hidden.id, scene.handbook.id],
    )
    await engine.record_generated(
        access(scene, runtime),
        conversation_id=chat,
        file_name="summary.md",
        mime_type="text/markdown",
        data=b"# Summary 2",
        summary="v2",
        source_ids=[scene.secret.id, scene.policy.id],
    )

    async with sessions() as session:
        sources = list(
            await session.scalars(
                select(ArtifactSourceItem.item_id)
                .where(ArtifactSourceItem.artifact_item_id == first.artifact_id)
                .order_by(ArtifactSourceItem.position)
            )
        )
    assert sources == [scene.policy.id, scene.secret.id]
    refused = await scene.as_owner.patch(
        url(first.name),
        params={"updateMask": "space,audience"},
        json={"space": scene.space_name, "audience": "SPACE"},
    )
    assert refused.status_code == 400
    assert reason(refused) == "AUDIENCE_CANNOT_READ_SOURCES"


# -- #1: stopped generations settle --------------------------------------------------------------


async def test_shutdown_fails_the_operation_and_the_new_artifact(
    scene: Scene, runtime: AppRuntime
) -> None:
    model = Hanging()
    runtime._agent_transport = model  # type: ignore[assignment]
    operation = (
        await scene.as_owner.post(scene.url, json={"kind": "DRAFT", "generationInstructions": "x"})
    ).json()
    await model.started.wait()

    await runtime.artifact_service().aclose()

    done = await finished(scene.as_owner, operation)
    assert done["error"]["code"] == 14  # UNAVAILABLE
    artifact = (await scene.as_owner.get(url(operation["metadata"]["artifact"]))).json()
    assert artifact["state"] == "FAILED"


async def test_a_revise_stopped_by_shutdown_leaves_the_artifact_active(
    scene: Scene, runtime: AppRuntime
) -> None:
    artifact = await draft(scene, runtime)
    model = Hanging()
    runtime._agent_transport = model  # type: ignore[assignment]
    operation = (
        await scene.as_owner.post(url(artifact["name"], ":revise"), json={"instructions": "x"})
    ).json()
    await model.started.wait()

    await runtime.artifact_service().aclose()

    assert "error" in await finished(scene.as_owner, operation)
    restored = (await scene.as_owner.get(url(artifact["name"]))).json()
    assert restored["state"] == "ACTIVE"
    assert restored["revision"].endswith("/revisions/1")


async def test_a_settle_failure_never_escapes_the_task(
    scene: Scene, runtime: AppRuntime, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def broken(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("database down")

    monkeypatch.setattr(generation, "restore_unfinished", broken)
    runtime._agent_transport = ScriptedResponsesTransport([])  # type: ignore[assignment]
    engine = runtime.artifact_service()
    started: list[asyncio.Task[None]] = []
    original = engine.start

    def tracked(operation_id: UUID, work: Any) -> None:
        original(operation_id, work)
        started.append(engine._jobs[operation_id])  # noqa: SLF001 - the task under test

    monkeypatch.setattr(engine, "start", tracked)
    response = await scene.as_owner.post(scene.url, json={"kind": "DRAFT", "generationInstructions": "x"})
    assert response.status_code == 200, response.text

    await asyncio.wait_for(started[0], timeout=5)
    assert started[0].exception() is None


async def test_crashed_generations_are_restored_by_the_abandon_hook(
    scene: Scene, runtime: AppRuntime, sessions: Sessions, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A crash: the work never runs, so nothing settles the operation or the artifact.
    monkeypatch.setattr(runtime.artifact_service(), "start", lambda operation_id, work: work.close())
    operation = (
        await scene.as_owner.post(scene.url, json={"kind": "DRAFT", "generationInstructions": "x"})
    ).json()
    name = operation["metadata"]["artifact"]
    assert (await scene.as_owner.get(url(name))).json()["state"] == "GENERATING"

    repaired = await reconcile_abandoned_operations(runtime, started_before=datetime.now(UTC) + timedelta(seconds=1))

    assert repaired >= 1
    done = (await scene.as_owner.get(url(operation["name"]))).json()
    assert done["done"] is True and done["error"]["code"] == 14
    assert (await scene.as_owner.get(url(name))).json()["state"] == "FAILED"


# -- #27: hooks belong to the artifacts service -----------------------------------------------------


def test_operation_hooks_are_registered_by_the_artifacts_service() -> None:
    for verb in ("createArtifact", "reviseArtifact"):
        assert OPERATION_HANDLERS.result_loader(verb) is load_result
        assert OPERATION_HANDLERS.cancel_hook(verb) is not None
        assert OPERATION_HANDLERS.abandon_hook(verb) is not None


# -- #21: purged artifacts are gone -------------------------------------------------------------


async def test_a_purged_artifact_is_not_found(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await draft(scene, runtime)
    await scene.as_owner.delete(url(artifact["name"]))
    async with sessions.begin() as session:
        await session.execute(
            update(Item)
            .where(Item.id == artifact_id(artifact["name"]))
            .values(deleted_at=datetime.now(UTC) - timedelta(days=31))
        )

    assert (await scene.as_owner.post(url(artifact["name"], ":undelete"), json={})).status_code == 404
    assert (await scene.as_owner.get(url(artifact["name"]))).status_code == 404
