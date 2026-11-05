"""Factories of the ingestion run and task tests: processable documents, attachments, run rows."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select, update

from bomesh.db.models import (
    Conversation,
    IngestionRun,
    IngestionRunItem,
    Item,
    ItemRevision,
    Message,
    MessageItem,
    Tenant,
    User,
)
from bomesh.services import ARTIFACT_COLLECTION_KIND
from harness import ApiClient, Sessions, World


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
        title="Handbook",
        grants={editor: "roles/collectionEditor", viewer: "roles/collectionViewer"},
    )
    policies = await world.make_collection(workspace, handbook, title="Policies")
    board = await world.make_collection(
        workspace, title="Board", grants={editor: "roles/collectionViewer"}
    )
    personal = await world.make_collection(workspace, personal_for=editor)
    artifacts = await world.make_collection(
        workspace, title="My documents", grants={editor: "roles/collectionOwner"}
    )
    async with sessions.begin() as session:
        await session.execute(
            update(Item)
            .where(Item.id == artifacts.id)
            .values(metadata_={"system_kind": ARTIFACT_COLLECTION_KIND})
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
    status: str = "ready",
    stored: bool = True,
    size_bytes: int = 1024,
    title: str | None = None,
) -> Item:
    """A DOCUMENT whose original is stored (``contentState`` AVAILABLE) with revision 1."""
    item_id = uuid4()
    storage_key = f"workspaces/{parent.tenant_id}/items/{item_id}/1" if stored else None
    async with sessions.begin() as session:
        item = Item(
            id=item_id,
            tenant_id=parent.tenant_id,
            item_type="document",
            parent_item_id=parent.id,
            parent_relation="contains" if parent.item_type == "collection" else "child",
            document_type="plain_text",
            title=title or f"doc-{item_id.hex[:6]}.txt",
            mime_type="text/plain",
            size_bytes=size_bytes,
            storage_key=storage_key,
            metadata_={"file_name": title or "file.txt"},
            status=status,
            publication_state="published" if published else "unpublished",
            index_status=index_status,
            processed_version=processed_version,
        )
        session.add(item)
        await session.flush()
        if storage_key is not None:
            session.add(
                ItemRevision(
                    item_id=item_id,
                    revision_number=1,
                    storage_key=storage_key,
                    mime_type="text/plain",
                    size_bytes=size_bytes,
                )
            )
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
