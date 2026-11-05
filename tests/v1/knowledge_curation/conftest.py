"""Fixtures of the KnowledgeCuration slice tests."""

from __future__ import annotations

import pytest_asyncio

from curation_support import Scene, make_scene
from harness import ApiClient, Sessions, World


@pytest_asyncio.fixture
async def scene(world: World, sessions: Sessions, client: ApiClient) -> Scene:
    return await make_scene(world, sessions, client)
