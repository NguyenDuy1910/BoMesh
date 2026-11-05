"""Fixtures of the Artifacts slice tests."""

from __future__ import annotations

import pytest_asyncio

from artifacts_support import Scene, build_scene
from harness import ApiClient, World


@pytest_asyncio.fixture
async def scene(world: World, client: ApiClient) -> Scene:
    return await build_scene(world, client)
