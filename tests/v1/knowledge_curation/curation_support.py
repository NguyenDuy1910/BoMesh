"""Helpers of the KnowledgeCuration slice tests: one workspace with a contributor,
a reviewer and a knowledge base that accepts contributions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select, update

from bomesh.db.models import Item, ItemRevision, Tenant, Topic, User
from harness import ApiClient, Sessions, World

OWNER = "roles/collectionOwner"
VIEWER = "roles/collectionViewer"


def error_reason(response: Any) -> str | None:
    for detail in response.json()["error"]["details"]:
        if "reason" in detail:
            return detail["reason"]
    return None


def item_name(item: Item) -> str:
    return f"workspaces/{item.tenant_id}/items/{item.id}"


@dataclass
class Scene:
    """``admin`` created the workspace; ``member`` contributes; ``reviewer`` owns ``kb``."""

    world: World
    sessions: Sessions
    client: ApiClient
    ws: Tenant
    admin: User
    member: User
    reviewer: User
    outsider: User
    kb: Item
    personal: Item

    @property
    def base(self) -> str:
        return f"/api/v1/workspaces/{self.ws.id}"

    def url(self, path: str) -> str:
        return f"{self.base}/{path}"

    async def as_(self, user: User) -> ApiClient:
        return await self.client.as_(user)

    async def candidate(
        self,
        *,
        owner: User | None = None,
        personal: Item | None = None,
        title: str | None = None,
        file_name: str = "report.pdf",
        size: int = 100,
    ) -> Item:
        """A READY document with stored content in a PERSONAL collection."""
        document = await self.world.make_document(
            personal or self.personal,
            title=title or f"Draft {uuid4().hex[:6]}",
            creator=owner or self.member,
        )
        await self.set_content(document, file_name=file_name, size=size)
        return document

    async def set_content(self, document: Item, *, file_name: str = "report.pdf", size: int = 100) -> None:
        async with self.sessions.begin() as session:
            row = await session.get(Item, document.id)
            assert row is not None
            row.storage_key = f"objects/{row.id}"
            row.size_bytes = size
            row.metadata_ = {**row.metadata_, "file_name": file_name}
            session.add(
                ItemRevision(
                    item_id=row.id,
                    revision_number=1,
                    storage_key=row.storage_key,
                    mime_type=row.mime_type or "application/pdf",
                    size_bytes=size,
                )
            )
        document.storage_key = f"objects/{document.id}"

    async def topic(self, code: str, name: str, *, kind: str = "topic", state: str = "active") -> Topic:
        async with self.sessions.begin() as session:
            topic = Topic(tenant_id=self.ws.id, code=code, kind=kind, display_name=name, state=state)
            session.add(topic)
        return topic

    async def submit(self, candidate: Item, **body: Any) -> dict[str, Any]:
        api = await self.as_(self.member)
        response = await api.post(
            self.url("contributions"),
            json={"item": item_name(candidate), "targetCollection": item_name(self.kb), **body},
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def item(self, item_id: UUID) -> Item:
        async with self.sessions() as session:
            row = await session.scalar(select(Item).where(Item.id == item_id))
            assert row is not None
            return row

    async def set_metadata(self, item: Item, **values: Any) -> None:
        async with self.sessions.begin() as session:
            row = await session.get(Item, item.id)
            assert row is not None
            row.metadata_ = {**row.metadata_, **values}

    async def set_item(self, item: Item, **values: Any) -> None:
        async with self.sessions.begin() as session:
            await session.execute(update(Item).where(Item.id == item.id).values(**values))


async def make_scene(world: World, sessions: Sessions, client: ApiClient) -> Scene:
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    reviewer = await world.add_member(ws)
    outsider = await world.add_member(ws)
    kb = await world.make_collection(
        ws, title="Handbook", grants={reviewer: OWNER, member: VIEWER, outsider: VIEWER}
    )
    async with sessions.begin() as session:
        row = await session.get(Item, kb.id)
        assert row is not None
        row.metadata_ = {**row.metadata_, "accepts_contributions": True}
    personal = await world.make_collection(ws, personal_for=member)
    return Scene(world, sessions, client, ws, admin, member, reviewer, outsider, kb, personal)
