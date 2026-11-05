"""Helpers of the Artifacts slice tests: a scene, the scripted model, operations and indexing.

Tests import them with ``from artifacts_support import ...``; the fixtures live
in ``conftest.py``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    CitationInfo,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, Space, Tenant, User
from bomesh.document_index import IndexingContext
from bomesh.runtime import AppRuntime
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from harness import ApiClient, Sessions, World
from native_responses import ScriptedResponsesTransport, completed, created, message

VIEWER = "roles/collectionViewer"
EDITOR = "roles/collectionEditor"
SPACE_MEMBER = "roles/spaceMember"


@dataclass(slots=True)
class Scene:
    """``owner`` and ``reader`` read ``handbook``; only ``owner`` reads ``board``.

    ``reader`` and ``owner`` are members of ``space``; ``stranger`` is a plain
    workspace member in no space; ``outsider`` belongs to no workspace.
    """

    workspace: Tenant
    admin: User
    owner: User
    reader: User
    stranger: User
    outsider: User
    handbook: Item
    board: Item
    policy: Item
    secret: Item
    space: Space
    as_owner: ApiClient
    as_reader: ApiClient
    as_stranger: ApiClient
    as_outsider: ApiClient

    @property
    def url(self) -> str:
        return f"/api/v1/workspaces/{self.workspace.id}/artifacts"

    def item(self, item: Item) -> str:
        return f"workspaces/{self.workspace.id}/items/{item.id}"

    @property
    def space_name(self) -> str:
        return f"workspaces/{self.workspace.id}/spaces/{self.space.code}"


async def build_scene(world: World, client: ApiClient) -> Scene:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    owner = await world.add_member(workspace)
    reader = await world.add_member(workspace)
    stranger = await world.add_member(workspace)
    outsider = await world.make_user()
    handbook = await world.make_collection(
        workspace, title="Handbook", grants={owner: EDITOR, reader: VIEWER, stranger: VIEWER}
    )
    board = await world.make_collection(workspace, title="Board", grants={owner: EDITOR})
    policy = await world.make_document(handbook, title="Travel policy")
    secret = await world.make_document(board, title="Board minutes")
    space = await world.make_space(workspace, owner)
    await world.grant(reader, SPACE_MEMBER, on=space)
    return Scene(
        workspace=workspace,
        admin=admin,
        owner=owner,
        reader=reader,
        stranger=stranger,
        outsider=outsider,
        handbook=handbook,
        board=board,
        policy=policy,
        secret=secret,
        space=space,
        as_owner=await client.as_(owner),
        as_reader=await client.as_(reader),
        as_stranger=await client.as_(stranger),
        as_outsider=await client.as_(outsider),
    )


def script(runtime: AppRuntime, *answers: str) -> ScriptedResponsesTransport:
    """The agent model answers ``answers`` in order, one per request."""
    transport = ScriptedResponsesTransport(
        [
            [*created(), *message(item_id=f"msg_{n}", output_index=0, deltas=[answer]), *completed()]
            for n, answer in enumerate(answers)
        ]
    )
    runtime._agent_transport = transport  # type: ignore[assignment]
    return transport


async def finished(api: ApiClient, operation: dict[str, Any]) -> dict[str, Any]:
    """Poll the operation until it is done; return it."""
    for _ in range(500):
        body = (await api.get(f"/api/v1/{operation['name']}")).json()
        if body.get("done"):
            return body
        await asyncio.sleep(0.01)
    raise AssertionError(f"operation {operation['name']} did not finish")


async def create(scene: Scene, body: dict[str, Any], api: ApiClient | None = None) -> dict[str, Any]:
    """CreateArtifact and wait for its operation; returns the finished operation."""
    response = await (api or scene.as_owner).post(scene.url, json=body)
    assert response.status_code == 200, response.text
    return await finished(api or scene.as_owner, response.json())



async def draft(
    scene: Scene, runtime: AppRuntime, text: str = "# Draft\n\nBody.", **fields: Any
) -> dict[str, Any]:
    """An ACTIVE DRAFT of the owner generated as ``text``; returns the Artifact message."""
    script(runtime, text)
    done = await create(scene, {"kind": "DRAFT", "generationInstructions": "Write.", **fields})
    assert "error" not in done, done
    return done["response"]


async def review(scene: Scene, runtime: AppRuntime, sessions: Sessions, **fields: Any) -> dict[str, Any]:
    """An EVIDENCE_REVIEW over ``policy`` with one SUPPORTED cell citing it."""
    await index(runtime, sessions, scene.policy, ["Economy class is required for flights."])
    script(
        runtime,
        '{"state": "SUPPORTED", "summary": "Economy only.", "citations": [1]}',
        "Plan A fits.",
    )
    done = await create(
        scene,
        {
            "kind": "EVIDENCE_REVIEW",
            "displayName": "Vendors",
            "sourceItems": [scene.item(scene.policy)],
            "evidenceReview": {
                "options": [{"key": "plan-a", "displayName": "Plan A"}],
                "criteria": [{"key": "travel", "displayName": "Travel class"}],
            },
            **fields,
        },
    )
    assert "error" not in done, done
    return done["response"]


def reason(response: Any) -> str | None:
    for detail in response.json()["error"].get("details", []):
        if "reason" in detail:
            return detail["reason"]
    return None


def artifact_id(name: str) -> UUID:
    return UUID(name.rsplit("/", 1)[1])


async def index(
    runtime: AppRuntime, sessions: Sessions, document: Item, texts: Sequence[str], *, page: int = 1
) -> None:
    """Index ``texts`` as passages ``{item}:{n}`` of a document of a root collection."""
    async with transaction_scope(sessions) as session:
        row = await session.get(Item, document.id)
        assert row is not None and row.parent_item_id is not None
    canonical = DocumentItem(
        id=str(row.id),
        title=row.title,
        document_kind=DocumentKind.NOTE,
        source=SourceIdentity(
            connector_id="upload", provider=SourceProvider.FILE, external_id=str(row.id)
        ),
        hierarchy=Hierarchy(parent_id=str(row.parent_item_id)),
        access=AccessPolicy(),
    )
    chunks = [
        Chunk(
            id=f"{row.id}:{position}",
            item_id=str(row.id),
            chunk_index=position,
            chunk_text=text,
            content_type="text",
            citation=CitationInfo(page_start=page, page_end=page),
        )
        for position, text in enumerate(texts)
    ]
    await ItemIngestionService(sessions, index=runtime.item_index()).process_item_content(
        row,
        canonical,
        chunks,
        context=IndexingContext(
            tenant_id=str(row.tenant_id),
            collection_item_id=str(row.parent_item_id),
            parent_item_id=str(row.parent_item_id),
            document_type=row.document_type or "plain_text",
            connector_key="file",
            published=row.publication_state == "published",
        ),
        processed_version=runtime.processing_version(),
        revision_number=None,
    )


__all__ = [
    "EDITOR",
    "SPACE_MEMBER",
    "VIEWER",
    "Scene",
    "artifact_id",
    "build_scene",
    "create",
    "draft",
    "finished",
    "index",
    "reason",
    "review",
    "script",
]
