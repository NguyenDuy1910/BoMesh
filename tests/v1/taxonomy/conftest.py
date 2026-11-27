"""Fixture ``tx``: a :class:`~taxonomy_scene.TaxonomyScene`."""

from __future__ import annotations

import pytest_asyncio

from bomesh.runtime import AppRuntime
from harness import ApiClient, Sessions, World
from taxonomy_scene import TaxonomyScene


@pytest_asyncio.fixture
async def tx(client: ApiClient, world: World, sessions: Sessions, runtime: AppRuntime) -> TaxonomyScene:
    return await TaxonomyScene(client, world, sessions, runtime).setup()
