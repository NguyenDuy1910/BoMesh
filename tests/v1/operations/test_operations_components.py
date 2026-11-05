"""Components and incidents derived from the probe history, and the probe recorder."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select

from bomesh.db.models import PlatformHealthCheck
from bomesh.health import HISTORY_RETENTION, HealthRecorder, HealthService, HealthSettings
from harness import ApiClient, Sessions, World

pytestmark = pytest.mark.asyncio

NOW = datetime.now(UTC).replace(microsecond=0)


async def _operator(client: ApiClient, world: World) -> ApiClient:
    return await client.as_(await world.platform_operator(await world.make_user()))


async def test_components_list_the_catalog_with_their_latest_probe(
    client: ApiClient, world: World, ops: Any
) -> None:
    await ops.check("openai_chat", "healthy", NOW - timedelta(minutes=2))
    await ops.check("openai_chat", "unhealthy", NOW - timedelta(minutes=1), error_category="timeout")
    await ops.check("qdrant", "healthy", NOW)
    api = await _operator(client, world)

    body = (await api.get("/api/v1/components")).json()

    by_name = {c["name"]: c for c in body["components"]}
    assert [c["displayName"] for c in body["components"]] == sorted(
        c["displayName"] for c in body["components"]
    )
    chat = by_name["components/chat-model"]
    assert chat["kind"] == "AI_MODEL"
    assert chat["state"] == "DOWN"
    assert chat["model"] == "test-model"
    assert chat["setting"] == "OPENAI_MODEL"
    assert chat["checkTime"].startswith((NOW - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M"))
    # Not configured in the harness: the probe history does not matter.
    assert by_name["components/vector-index"]["state"] == "NOT_CONFIGURED"
    assert "state" not in by_name["components/api"]


async def test_components_filter_order_and_page(
    client: ApiClient, world: World, ops: Any
) -> None:
    await ops.check("openai_chat", "healthy", NOW - timedelta(minutes=5))
    await ops.check("openrouter_embeddings", "healthy", NOW)
    api = await _operator(client, world)

    models = (await api.get("/api/v1/components", params={"filter": 'kind = "AI_MODEL"'})).json()
    assert {c["name"] for c in models["components"]} == {
        "components/chat-model", "components/embedding-model"
    }
    healthy = (
        await api.get(
            "/api/v1/components",
            params={"filter": 'state = "HEALTHY"', "orderBy": "checkTime desc"},
        )
    ).json()
    assert [c["name"] for c in healthy["components"]] == [
        "components/embedding-model", "components/chat-model"
    ]
    first = (await api.get("/api/v1/components", params={"pageSize": 2})).json()
    assert len(first["components"]) == 2 and first["nextPageToken"]
    bad = await api.get("/api/v1/components", params={"filter": 'state = "BROKEN"'})
    assert bad.status_code == 400


async def test_get_component(client: ApiClient, world: World, ops: Any) -> None:
    await ops.check("openrouter_embeddings", "healthy", NOW)
    api = await _operator(client, world)

    body = (await api.get("/api/v1/components/embedding-model")).json()
    assert body["name"] == "components/embedding-model"
    assert body["state"] == "HEALTHY"
    assert body["model"] == "fake-embedding"
    assert (await api.get("/api/v1/components/nope")).status_code == 404


async def test_components_and_incidents_are_platform_only(
    client: ApiClient, world: World, ops: Any
) -> None:
    started = await ops.check("qdrant", "unhealthy", NOW)
    admin = await world.make_user()
    await world.make_workspace(admin)
    api = await client.as_(admin)

    for path in (
        "/api/v1/components",
        "/api/v1/components/api",
        "/api/v1/components/nope",
        "/api/v1/incidents",
        f"/api/v1/incidents/{started}",
        f"/api/v1/incidents/{uuid4()}",
    ):
        assert (await api.get(path)).status_code == 403, path
    assert (await client.get("/api/v1/components")).status_code == 401


async def test_incidents_are_runs_of_failing_probes(
    client: ApiClient, world: World, ops: Any
) -> None:
    await ops.check("qdrant", "healthy", NOW - timedelta(minutes=10))
    resolved = await ops.check("qdrant", "unhealthy", NOW - timedelta(minutes=9), error_category="timeout")
    await ops.check("qdrant", "degraded", NOW - timedelta(minutes=8), error_category="timeout")
    await ops.check("qdrant", "healthy", NOW - timedelta(minutes=7))
    ongoing = await ops.check("openai_chat", "unhealthy", NOW - timedelta(minutes=3),
                              error_category="rate_limited")
    await ops.check("openai_chat", "unhealthy", NOW - timedelta(minutes=2))
    api = await _operator(client, world)

    body = (await api.get("/api/v1/incidents")).json()

    assert [i["name"] for i in body["incidents"]] == [f"incidents/{ongoing}", f"incidents/{resolved}"]
    current, past = body["incidents"]
    assert current["component"] == "components/chat-model"
    assert current["state"] == "ONGOING"
    assert current["errorCategory"] == "rate_limited"
    assert "endTime" not in current
    assert past["component"] == "components/vector-index"
    assert past["state"] == "RESOLVED"
    assert past["endTime"].startswith((NOW - timedelta(minutes=7)).strftime("%Y-%m-%dT%H:%M"))

    got = (await api.get(f"/api/v1/incidents/{resolved}")).json()
    assert got == past
    assert (await api.get(f"/api/v1/incidents/{uuid4()}")).status_code == 404


async def test_incidents_filter_and_order(client: ApiClient, world: World, ops: Any) -> None:
    old = await ops.check("qdrant", "unhealthy", NOW - timedelta(hours=2), error_category="timeout")
    await ops.check("qdrant", "healthy", NOW - timedelta(hours=1))
    new = await ops.check("openai_chat", "unhealthy", NOW, error_category="upstream_error")
    api = await _operator(client, world)

    async def names(**params: str) -> list[str]:
        response = await api.get("/api/v1/incidents", params=params)
        assert response.status_code == 200, response.text
        return [i["name"] for i in response.json()["incidents"]]

    assert await names(filter='state = "ONGOING"') == [f"incidents/{new}"]
    assert await names(filter='component = "components/vector-index"') == [f"incidents/{old}"]
    assert await names(filter='errorCategory = "timeout"') == [f"incidents/{old}"]
    since = (NOW - timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
    assert await names(filter=f'startTime > "{since}"') == [f"incidents/{new}"]
    assert await names(orderBy="startTime") == [f"incidents/{old}", f"incidents/{new}"]
    bad = await api.get("/api/v1/incidents", params={"filter": 'component = "nope"'})
    assert bad.status_code == 400


async def test_the_recorder_stores_one_row_per_probe_and_prunes_old_history(
    sessions: Sessions, ops: Any
) -> None:
    stale = await ops.check("qdrant", "healthy", NOW - HISTORY_RETENTION - timedelta(days=1))
    settings = HealthSettings(
        qdrant_url=None, qdrant_api_key=None, qdrant_collection=None,
        openai_base_url="https://openai.test/v1", openai_api_key="key",
        openrouter_base_url="https://openrouter.test/api/v1", openrouter_api_key=None,
        chat_model="test-model", embedding_model=None,
        langfuse_base_url="https://langfuse.test", langfuse_public_key=None,
        langfuse_secret_key=None,
    )
    transport = httpx.MockTransport(lambda request: httpx.Response(503))
    recorder = HealthRecorder(HealthService(settings, transport=transport), sessions)

    report = await recorder.record()

    async with sessions() as session:
        rows = (await session.scalars(select(PlatformHealthCheck))).all()
    assert stale not in {row.id for row in rows}
    by_service = {row.service: row for row in rows}
    assert set(by_service) == {s.name for s in report.services}
    assert by_service["openai_chat"].status == "unhealthy"
    assert by_service["openai_chat"].error_category == "upstream_error"
    assert by_service["qdrant"].status == "not_configured"
