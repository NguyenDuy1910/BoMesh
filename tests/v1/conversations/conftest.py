"""Fixtures of the Conversations slice tests."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest_asyncio

from bomesh.db.models import Item, Tenant, User
from bomesh.runtime import AppRuntime
from conversations_support import conversations_url, index
from harness import ApiClient, Fakes, Sessions, World


@dataclass
class Chat:
    """A workspace where ``member`` reads the ``handbook`` collection and its ``policy``."""

    runtime: AppRuntime
    sessions: Sessions
    fakes: Fakes
    world: World
    client: ApiClient
    admin: User
    member: User
    workspace: Tenant
    handbook: Item
    policy: Item

    async def api(self, user: User | None = None) -> ApiClient:
        return await self.client.as_(user or self.member)

    async def conversation(self, user: User | None = None, **body: Any) -> dict[str, Any]:
        """Create a conversation as ``user`` (default ``member``); returns its JSON."""
        response = await (await self.api(user)).post(
            conversations_url(self.workspace), json=body or {}
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def index(self, document: Item, *texts: str, page: int | None = None) -> list[str]:
        return await index(self.runtime, self.sessions, document, texts, page=page)


@pytest_asyncio.fixture
async def chat(
    runtime: AppRuntime, sessions: Sessions, fakes: Fakes, world: World, client: ApiClient
) -> Chat:
    admin = await world.make_user(display_name="Admin")
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    handbook = await world.make_collection(
        workspace, title="Handbook", grants={member: "roles/collectionViewer"}
    )
    policy = await world.make_document(handbook, title="Leave policy")
    return Chat(runtime, sessions, fakes, world, client, admin, member, workspace, handbook, policy)
