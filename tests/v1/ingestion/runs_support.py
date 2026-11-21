"""Factories of the ingestion run and task tests: processable documents, attachments, run rows."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine
from sqlalchemy.pool import NullPool

from bomesh.db.models import (
    Conversation,
    IngestionRun,
    IngestionRunItem,
    Item,
    ItemIndexState,
    ItemRevision,
    Message,
    MessageItem,
    Tenant,
    User,
)
from bomesh.services import ARTIFACT_COLLECTION_TYPE
from bomesh.services.knowledge_items.file_types import file_class
from harness import (
    TEST_DATABASE_URL,
    ApiClient,
    Sessions,
    World,
    member_name,
    register_synced,
    resource,
)


@dataclass(slots=True)
class Scene:
    """One workspace with the people and collections the run and task tests need.

    ``handbook`` (with ``policies`` nested): editor edits, viewer reads.
    ``board``: the editor may only read it. ``personal``: the editor's own.
    ``artifacts``: the assistant's artifacts collection. ``operator`` is a
    platform operator outside the workspace; ``outsider`` a plain member.
    """

    workspace: Tenant
    admin: User
    editor: User
    viewer: User
    outsider: User
    operator: User
    handbook: Item
    policies: Item
    board: Item
    personal: Item
    artifacts: Item
    as_admin: ApiClient
    as_editor: ApiClient
    as_viewer: ApiClient
    as_outsider: ApiClient
    as_operator: ApiClient


async def build_scene(client: ApiClient, world: World, sessions: Sessions) -> Scene:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    editor = await world.add_member(workspace)
    viewer = await world.add_member(workspace)
    outsider = await world.add_member(workspace)
    operator = await world.platform_operator(await world.make_user())
    handbook = await world.make_collection(
        workspace,
        item_name="Handbook",
        grants={editor: "roles/collectionEditor", viewer: "roles/collectionViewer"},
    )
    policies = await world.make_collection(workspace, handbook, item_name="Policies")
    board = await world.make_collection(
        workspace, item_name="Board", grants={editor: "roles/collectionViewer"}
    )
    personal = await world.make_collection(workspace, personal_for=editor)
    # item_type is immutable: the artifacts collection is born conversation_artifacts.
    async with sessions.begin() as session:
        artifacts = Item(
            tenant_id=workspace.id,
            item_kind="collection",
            item_type=ARTIFACT_COLLECTION_TYPE,
            item_name="My documents",
            inherit_access=False,
            discoverable=False,
            accepts_contributions=False,
            created_by_user_id=editor.id,
        )
        session.add(artifacts)
        await session.flush()
        await world._policies(session).add_binding(
            resource(artifacts), "roles/collectionOwner", member_name(editor)
        )
    return Scene(
        workspace=workspace,
        admin=admin,
        editor=editor,
        viewer=viewer,
        outsider=outsider,
        operator=operator,
        handbook=handbook,
        policies=policies,
        board=board,
        personal=personal,
        artifacts=artifacts,
        as_admin=await client.as_(admin),
        as_editor=await client.as_(editor),
        as_viewer=await client.as_(viewer),
        as_outsider=await client.as_(outsider),
        as_operator=await client.as_(operator),
    )


def reason(response: Any) -> str | None:
    return next(
        (d["reason"] for d in response.json()["error"]["details"] if d.get("reason")), None
    )


def runs_url(workspace: Tenant | str, *rest: str) -> str:
    """``/api/v1/workspaces/{workspace}/ingestionRuns[/...]``; ``"-"`` for the wildcard."""
    workspace_id = workspace if isinstance(workspace, str) else str(workspace.id)
    return "/".join(["/api/v1/workspaces", workspace_id, "ingestionRuns", *rest])


def item_ref(item: Item) -> str:
    return f"workspaces/{item.tenant_id}/items/{item.id}"


async def document(
    sessions: Sessions,
    parent: Item,
    *,
    published: bool = True,
    index_status: str = "pending",
    processed_version: str | None = None,
    stored: bool = True,
    size_bytes: int = 1024,
    item_name: str | None = None,
    mime_type: str | None = None,
    source_code: str | None = None,
) -> Item:
    """A DOCUMENT whose original is stored (``contentState`` AVAILABLE) with revision 1.

    ``stored=False`` is a Document without content yet (``contentState`` PENDING).
    ``source_code`` makes it a document that Source registered (``document.origin.source``).
    ``item_type`` is the file class of ``mime_type`` (default ``text/plain`` when stored)
    and the name.
    """
    item_id = uuid4()
    name = item_name or f"doc-{item_id.hex[:6]}.txt"
    if mime_type is None and stored:
        mime_type = "text/plain"
    async with sessions.begin() as session:
        item = Item(
            id=item_id,
            tenant_id=parent.tenant_id,
            item_kind="document",
            item_type=file_class(mime_type, name),
            parent_item_id=parent.id,
            item_name=name,
            purpose="knowledge",
            is_published=published,
        )
        session.add(item)
        await session.flush()
        if source_code is not None:
            await register_synced(session, item, source_code=source_code)
        if (index_status, processed_version) != ("pending", None):
            await session.execute(
                update(ItemIndexState)
                .where(ItemIndexState.item_id == item_id)
                .values(index_status=index_status, processed_version=processed_version)
            )
        if stored:
            revision = ItemRevision(
                item_id=item_id,
                revision_number=1,
                content_id=uuid4(),
                mime_type=mime_type,
                size_bytes=size_bytes,
                file_name=name,
            )
            session.add(revision)
            await session.flush()
            item.current_revision_id = revision.id
            await session.flush()
        await session.refresh(item)
    return item


async def attach_to_conversation(
    sessions: Sessions, item: Item, *, owner: User, session_id: UUID
) -> None:
    """Make ``item`` a file attached to one of ``owner``'s messages."""
    async with sessions.begin() as session:
        conversation = Conversation(
            tenant_id=item.tenant_id,
            code=f"c{uuid4().hex[:12]}",
            owner_user_id=owner.id,
            created_by_session_id=session_id,
        )
        session.add(conversation)
        await session.flush()
        message = Message(
            conversation_id=conversation.id,
            role="user",
            content="See the attached file.",
            sequence_number=1,
        )
        session.add(message)
        await session.flush()
        session.add(MessageItem(message_id=message.id, item_id=item.id, relation_type="attachment"))


async def task_items(sessions: Sessions, run_id: UUID | str) -> dict[UUID, IngestionRunItem]:
    async with sessions.begin() as session:
        return {
            row.item_id: row
            for row in await session.scalars(
                select(IngestionRunItem).where(IngestionRunItem.run_id == UUID(str(run_id)))
            )
        }


async def set_run(sessions: Sessions, run_id: UUID | str, **values: Any) -> None:
    async with sessions.begin() as session:
        await session.execute(
            update(IngestionRun).where(IngestionRun.id == UUID(str(run_id))).values(**values)
        )


async def set_task(
    sessions: Sessions, run_id: UUID | str, item_id: UUID, **values: Any
) -> None:
    async with sessions.begin() as session:
        await session.execute(
            update(IngestionRunItem)
            .where(
                IngestionRunItem.run_id == UUID(str(run_id)), IngestionRunItem.item_id == item_id
            )
            .values(**values)
        )


async def pause_ingestion(sessions: Sessions, workspace: Tenant) -> None:
    async with sessions.begin() as session:
        await session.execute(
            update(Tenant)
            .where(Tenant.id == workspace.id)
            .values(ingestion_paused_at=datetime.now(UTC))
        )


def run_id_of(body: dict[str, Any]) -> UUID:
    return UUID(body["name"].rsplit("/", 1)[-1])


@asynccontextmanager
async def held_lock(*keys: int) -> AsyncIterator[AsyncConnection]:
    """Session-level advisory locks on a connection of its own: another worker.

    Leaving the block closes the connection, as a worker that dies does.
    """
    assert TEST_DATABASE_URL is not None
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    connection = await engine.connect()
    try:
        for key in keys:
            assert await connection.scalar(select(func.pg_try_advisory_lock(key)))
        yield connection
    finally:
        await connection.close()
        await engine.dispose()
