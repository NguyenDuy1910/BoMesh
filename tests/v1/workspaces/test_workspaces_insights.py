"""Knowledge gaps, the workspace overview and platform usage (summarize and export)."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from bomesh.services.workspaces.knowledge_gaps import resolve_knowledge_gap
from bomesh.db.models import KnowledgeGapDecision, Operation, TenantMembership
from harness import ApiClient, Fakes, World
from workspaces_support import Conversations, reason, set_next_review, ws_path

pytestmark = pytest.mark.asyncio


def _gap_id(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


# -- Knowledge gaps -------------------------------------------------------------


async def test_gaps_cluster_by_normalized_question(
    client: ApiClient, world: World, conversations: Conversations
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    asker = await world.add_member(workspace)
    root = await world.make_collection(workspace)
    document = await world.make_document(root)
    now = datetime.now(UTC)
    await conversations.ask(workspace, asker, "What is the leave policy?", asked_at=now - timedelta(hours=2), scope=[root.id])
    await conversations.ask(workspace, asker, "what is the LEAVE policy", rating="unhelpful", scope=[root.id])
    await conversations.ask(
        workspace,
        asker,
        "How do I file expenses?",
        citations=[{"item_id": str(document.id)}],
        asked_at=now - timedelta(days=3),
    )
    await conversations.ask(workspace, asker, "Who is the CEO?", citations=[{"item_id": str(document.id)}])
    api = await client.as_(owner)

    gaps = (await api.get(f"{ws_path(workspace)}/knowledgeGaps")).json()["knowledgeGaps"]

    leave_id = _gap_id("what is the leave policy")
    assert [g["name"] for g in gaps] == [f"workspaces/{workspace.id}/knowledgeGaps/{leave_id}"]
    leave = gaps[0]
    assert leave["question"] == "what is the LEAVE policy"
    assert leave["askCount"] == 2
    assert leave["reason"] == "RATED_UNHELPFUL"
    assert leave["state"] == "OPEN"
    assert leave["suggestedCollection"] == f"workspaces/{workspace.id}/items/{root.id}"

    await set_next_review(world.sessions, document, now - timedelta(days=1))
    outdated = (await api.get(f"{ws_path(workspace)}/knowledgeGaps", params={"filter": "reason = OUTDATED"})).json()
    assert {g["question"] for g in outdated["knowledgeGaps"]} == {
        "How do I file expenses?",
        "Who is the CEO?",
    }
    recent = await api.get(
        f"{ws_path(workspace)}/knowledgeGaps",
        params={"filter": f'lastAskTime > "{(now - timedelta(days=1)).isoformat()}"', "orderBy": "askCount desc"},
    )
    assert [g["question"] for g in recent.json()["knowledgeGaps"]][0] == "what is the LEAVE policy"
    paged = (await api.get(f"{ws_path(workspace)}/knowledgeGaps", params={"pageSize": 1})).json()
    assert len(paged["knowledgeGaps"]) == 1 and paged["nextPageToken"]

    got = await api.get(f"{ws_path(workspace)}/knowledgeGaps/{leave_id}")
    assert got.json()["askCount"] == 2
    assert (await api.get(f"{ws_path(workspace)}/knowledgeGaps/{'0' * 32}")).status_code == 404
    member = await client.as_(asker)
    assert (await member.get(f"{ws_path(workspace)}/knowledgeGaps")).status_code == 403


async def test_dismiss_and_reopen(
    client: ApiClient, world: World, sessions, conversations: Conversations
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await conversations.ask(workspace, owner, "Where is the VPN guide?")
    gap_id = _gap_id("where is the vpn guide")
    api = await client.as_(owner)
    base = f"{ws_path(workspace)}/knowledgeGaps/{gap_id}"

    dismissed = await api.post(f"{base}:dismiss", json={})
    assert dismissed.status_code == 200, dismissed.text
    assert dismissed.json()["state"] == "DISMISSED"
    async with sessions.begin() as session:
        decision = await session.scalar(select(KnowledgeGapDecision))
        assert decision.gap_key == gap_id and decision.state == "dismissed"
    assert (await api.post(f"{base}:dismiss", json={})).status_code == 400
    listed = await api.get(f"{ws_path(workspace)}/knowledgeGaps", params={"filter": "state = OPEN"})
    assert listed.json().get("knowledgeGaps", []) == []

    reopened = await api.post(f"{base}:reopen", json={})
    assert reopened.json()["state"] == "OPEN"
    again = await api.post(f"{base}:reopen", json={})
    assert again.status_code == 400
    assert reason(again) == "KNOWLEDGE_GAP_ALREADY_OPEN"
    async with sessions.begin() as session:
        assert (await session.scalars(select(KnowledgeGapDecision))).all() == []

    async with sessions.begin() as session:
        session.add(
            KnowledgeGapDecision(
                tenant_id=workspace.id,
                gap_key=gap_id,
                state="resolved",
                decided_by_user_id=owner.id,
                decided_at=datetime.now(UTC),
            )
        )
    assert (await api.get(base)).json()["state"] == "RESOLVED"
    await conversations.ask(workspace, owner, "where is the vpn guide")
    assert (await api.get(base)).json()["state"] == "OPEN"

    member = await client.as_(await world.add_member(workspace))
    assert (await member.post(f"{base}:dismiss", json={})).status_code == 403


async def test_resolve_knowledge_gap_cross_slice(
    client: ApiClient, world: World, sessions, conversations: Conversations
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await conversations.ask(workspace, owner, "How do I reset my VPN token?")
    answer = await world.make_document(await world.make_collection(workspace))

    async with sessions.begin() as session:
        key = await resolve_knowledge_gap(
            session,
            workspace.id,
            "how do I reset my vpn token",
            decided_by=owner.id,
            resolved_by_item_id=answer.id,
        )
        empty = await resolve_knowledge_gap(session, workspace.id, " ?! ", decided_by=owner.id)

    assert key == _gap_id("how do i reset my vpn token")
    assert empty is None
    gap = (await (await client.as_(owner)).get(f"{ws_path(workspace)}/knowledgeGaps/{key}")).json()
    assert gap["state"] == "RESOLVED"
    async with sessions.begin() as session:
        decision = await session.get(
            KnowledgeGapDecision, {"tenant_id": workspace.id, "gap_key": key}
        )
        assert decision.resolved_by_item_id == answer.id


# -- Overview -------------------------------------------------------------------


async def test_overview(
    client: ApiClient, world: World, sessions, conversations: Conversations
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    root = await world.make_collection(workspace)
    published = await world.make_document(root)
    await world.make_document(root, published=False)
    await world.make_document(root, published=False)
    await set_next_review(sessions, published, datetime.now(UTC) - timedelta(days=1))
    await world.make_contribution(await world.make_document(root, published=False), contributor=member, target=root)
    await conversations.ask(workspace, member, "First question")
    await conversations.ask(workspace, member, "Second question")
    async with sessions.begin() as session:
        membership = await session.get(TenantMembership, {"user_id": member.id, "tenant_id": workspace.id})
        membership.last_active_at = datetime.now(UTC)
    api = await client.as_(owner)

    response = await api.get(f"{ws_path(workspace)}/overview", params={"window": "P7D", "timeZone": "UTC"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == f"workspaces/{workspace.id}/overview"
    assert body["window"] == "P7D" and body["timeZone"] == "UTC"
    attention = {a["kind"]: a for a in body["attentionItems"]}
    assert attention["DOCUMENTS_WAITING_TO_PUBLISH"]["itemCount"] == 3
    assert attention["DOCUMENTS_WAITING_TO_PUBLISH"]["target"] == f"workspaces/{workspace.id}/items"
    assert attention["REVERIFICATION_DUE"] == {
        "kind": "REVERIFICATION_DUE",
        "itemCount": 1,
        "target": f"workspaces/{workspace.id}/items/{published.id}",
    }
    assert attention["CONTRIBUTIONS_WAITING"]["itemCount"] == 1
    assert "SOURCE_FAILING" not in attention
    kpis = {k["key"]: k for k in body["kpis"]}
    assert kpis["questions"]["value"] == 2
    assert kpis["activeMembers"]["value"] == 1
    assert kpis["rootCollections"]["value"] == 1
    assert kpis["publishedDocuments"]["value"] == 1
    assert len(body["dailyUsage"]) == 7
    today = body["dailyUsage"][-1]
    assert today["date"] == datetime.now(UTC).date().isoformat()
    assert today == {"date": today["date"], "questionCount": "2", "activeMemberCount": "1"}

    assert (await api.get(f"{ws_path(workspace)}/overview", params={"window": "P3D"})).status_code == 400
    assert (await (await client.as_(member)).get(f"{ws_path(workspace)}/overview")).status_code == 403


# -- Usage ----------------------------------------------------------------------


async def test_summarize_and_export_usage(
    client: ApiClient, world: World, sessions, fakes: Fakes, conversations: Conversations
) -> None:
    owner = await world.make_user()
    busy = await world.make_workspace(owner, code="busy-" + owner.id.hex[:6])
    quiet = await world.make_workspace(owner, code="quiet-" + owner.id.hex[:6])
    await conversations.ask(busy, owner, "One?")
    await conversations.ask(busy, owner, "Two?", asked_at=datetime.now(UTC) - timedelta(days=10))
    async with sessions.begin() as session:
        membership = await session.get(TenantMembership, {"user_id": owner.id, "tenant_id": busy.id})
        membership.last_active_at = datetime.now(UTC)
    operator = await client.as_(await world.platform_operator(await world.make_user()))

    week = (await operator.get("/api/v1/workspaces:summarizeUsage")).json()
    assert week["window"] == "P7D"
    usage = {u["workspace"]: u for u in week["workspaceUsages"]}
    assert usage[f"workspaces/{busy.id}"] == {
        "workspace": f"workspaces/{busy.id}",
        "questionCount": "1",
        "activeMemberCount": "1",
        "processedDocumentCount": "0",
    }
    assert usage[f"workspaces/{quiet.id}"]["questionCount"] == "0"
    month = (await operator.get("/api/v1/workspaces:summarizeUsage", params={"window": "P30D"})).json()
    assert {u["workspace"]: u for u in month["workspaceUsages"]}[f"workspaces/{busy.id}"]["questionCount"] == "2"

    exported = await operator.post("/api/v1/workspaces:exportUsage", json={"window": "P30D"})
    assert exported.status_code == 200, exported.text
    assert exported.json()["done"] is True
    assert exported.json()["response"]["downloadUri"]
    key = f"exports/usage/{exported.json()['name'].removeprefix('operations/')}.csv"
    rows = (await fakes.storage.read(key, max_bytes=1 << 20)).decode().strip().splitlines()
    assert rows[0] == "workspace,window,questionCount,activeMemberCount,processedDocumentCount"
    assert f"workspaces/{busy.id},P30D,2,1,0" in rows

    admin = await client.as_(owner)
    assert (await admin.get("/api/v1/workspaces:summarizeUsage")).status_code == 403
    assert (await admin.post("/api/v1/workspaces:exportUsage", json={})).status_code == 403
    assert (await operator.get("/api/v1/workspaces:summarizeUsage", params={"window": "P2D"})).status_code == 400


async def test_export_usage_replays_request_id(client: ApiClient, world: World, sessions) -> None:
    operator = await client.as_(await world.platform_operator(await world.make_user()))
    url = f"/api/v1/workspaces:exportUsage?requestId={uuid4()}"
    first = await operator.post(url, json={"window": "P7D"})
    again = await operator.post(url, json={"window": "P7D"})
    assert first.status_code == again.status_code == 200
    assert first.json()["name"] == again.json()["name"]
    reused = await operator.post(url, json={"window": "P30D"})
    assert reused.status_code == 400
    assert reason(reused) == "REQUEST_ID_REUSED"
    async with sessions.begin() as session:
        assert len((await session.scalars(select(Operation))).all()) == 1
