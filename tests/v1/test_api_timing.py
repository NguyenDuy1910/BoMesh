"""Browser-measurable API timing: ``Timing-Allow-Origin`` and ``Server-Timing``."""

from __future__ import annotations

import re
from dataclasses import replace

import httpx
import pytest

from api.app import create_app
from config.env_config import ServerConfig
from harness import ApiClient, Fakes, Sessions, World, build_runtime, harness_config

pytestmark = pytest.mark.asyncio

WEB = "https://app.example.com"
SERVER_TIMING = re.compile(r"^app;dur=\d+\.\d, db;dur=(\d+\.\d)$")


async def _client(sessions: Sessions, fakes: Fakes, origins: tuple[str, ...]):
    config = replace(harness_config(), server=ServerConfig(web_origins=origins))
    runtime = build_runtime(sessions, fakes, config)
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(runtime)), base_url="http://test")
    return runtime, http


async def test_configured_origin_can_read_timing(sessions: Sessions, fakes: Fakes, world: World) -> None:
    user = await world.make_user()
    workspace = await world.make_workspace(user)
    runtime, http = await _client(sessions, fakes, (WEB,))
    try:
        api = await ApiClient(http, runtime).as_(user)
        response = await api.get(f"/api/v1/workspaces/{workspace.id}/items", headers={"Origin": WEB})
        assert response.status_code == 200
        assert response.headers["timing-allow-origin"] == WEB
        assert "Origin" in response.headers["vary"]
        timing = SERVER_TIMING.match(response.headers["server-timing"])
        assert timing is not None, response.headers["server-timing"]
        # The request ran SQL, so its statement time reached the request's clock.
        assert float(timing.group(1)) > 0

        other = await api.get(
            f"/api/v1/workspaces/{workspace.id}/items", headers={"Origin": "https://evil.example"}
        )
        assert "timing-allow-origin" not in other.headers
        assert "access-control-allow-origin" not in other.headers
        assert SERVER_TIMING.match(other.headers["server-timing"])
    finally:
        await http.aclose()
        await runtime.aclose()


async def test_unconfigured_origins_mirror_cors_wildcard(sessions: Sessions, fakes: Fakes) -> None:
    runtime, http = await _client(sessions, fakes, ())
    try:
        response = await http.get("/health", headers={"Origin": "http://127.0.0.1:3000"})
        assert response.headers["timing-allow-origin"] == "http://127.0.0.1:3000"
        assert response.headers["access-control-allow-origin"] in ("*", "http://127.0.0.1:3000")
        # Same-origin or non-browser callers send no Origin: nothing to allow.
        assert "timing-allow-origin" not in (await http.get("/health")).headers
    finally:
        await http.aclose()
        await runtime.aclose()


async def test_search_reports_its_stages(sessions: Sessions, fakes: Fakes, world: World) -> None:
    user = await world.make_user()
    workspace = await world.make_workspace(user)
    await world.make_collection(workspace)
    runtime, http = await _client(sessions, fakes, ())
    try:
        api = await ApiClient(http, runtime).as_(user)
        response = await api.post(
            f"/api/v1/workspaces/{workspace.id}/items:search",
            json={"query": "annual leave", "facetSpecs": [{"field": "itemType"}]},
        )
        assert response.status_code == 200, response.text
        metrics = response.headers["server-timing"].split(", ")
        assert [metric.split(";")[0] for metric in metrics] == [
            "app", "db", "visibility", "embedding", "index", "page", "projection", "facets",
        ]
        assert all(re.fullmatch(r"[a-z]+;dur=\d+\.\d", metric) for metric in metrics)
        # Other methods report only the two coarse durations.
        listed = await api.get(f"/api/v1/workspaces/{workspace.id}/items")
        assert SERVER_TIMING.match(listed.headers["server-timing"])
    finally:
        await http.aclose()
        await runtime.aclose()
