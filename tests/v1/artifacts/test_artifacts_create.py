"""CreateArtifact (an operation), the generation behind it and its cancellation."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from sqlalchemy import select, update

from artifacts_support import Scene, artifact_id, create, finished, index, reason, script
from bomesh.db.models import Artifact, AuditLog, Item, ItemRevision, Tenant
from bomesh.runtime import AppRuntime
from harness import Sessions
from native_responses import ScriptedResponsesTransport, completed, created, failed, message

pytestmark = pytest.mark.asyncio


async def test_create_draft_runs_an_operation_and_writes_revision_one(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    model = script(runtime, "# Travel\n\nBook economy.")

    response = await scene.as_owner.post(
        scene.url,
        json={
            "kind": "DRAFT",
            "displayName": "Travel memo",
            "sourceItems": [scene.item(scene.policy)],
            "generationInstructions": "Summarize the travel rules.",
        },
    )

    assert response.status_code == 200, response.text
    operation = response.json()
    assert operation["metadata"]["@type"].endswith("ArtifactOperationMetadata")
    done = await finished(scene.as_owner, operation)
    assert "error" not in done, done
    artifact = done["response"]
    assert artifact["@type"].endswith("Artifact")
    assert artifact["state"] == "ACTIVE"
    assert artifact["kind"] == "DRAFT"
    assert artifact["displayName"] == "Travel memo"
    assert artifact["mimeType"] == "text/markdown"
    assert artifact["audience"] == "PRIVATE"
    assert artifact["owner"] == f"workspaces/{scene.workspace.id}/members/{scene.owner.id}"
    assert artifact["sourceItems"] == [scene.item(scene.policy)]
    assert artifact["hiddenSourceCount"] == 0
    assert artifact["revision"] == f"{artifact['name']}/revisions/1"
    assert "generationInstructions" not in artifact
    assert model.requests[0]["model"] == "test-model"
    assert "Summarize the travel rules." in json.dumps(model.requests[0]["input"])

    revision = (await scene.as_owner.get(f"/api/v1/{artifact['revision']}")).json()
    assert revision["author"] == "ASSISTANT"
    assert revision["snapshot"]["text"] == "# Travel\n\nBook economy."
    assert revision["snapshot"]["mimeType"] == "text/markdown"
    assert revision["snapshot"].get("pageAssets", []) == []
    assert "rendition" not in revision["snapshot"]
    async with sessions() as session:
        item = await session.get(Item, artifact_id(artifact["name"]))
        assert item is not None and item.status == "ready"
        parent = await session.get(Item, item.parent_item_id)
        assert parent is not None and parent.metadata_["system_kind"] == "conversation_artifacts"
        actions = list(
            await session.scalars(select(AuditLog.action).where(AuditLog.tenant_id == scene.workspace.id))
        )
    assert "CreateArtifact" in actions


async def test_the_artifact_exists_at_once_while_generating(scene: Scene, runtime: AppRuntime) -> None:
    gate = asyncio.Event()

    class Slow(ScriptedResponsesTransport):
        async def stream_response(self, **kwargs: Any) -> Any:
            await gate.wait()
            return await super().stream_response(**kwargs)

    runtime._agent_transport = Slow(  # type: ignore[assignment]
        [[*created(), *message(item_id="m", output_index=0, deltas=["Quiz"]), *completed()]]
    )
    response = await scene.as_owner.post(
        scene.url, json={"kind": "QUIZ", "generationInstructions": "Five questions."}
    )
    operation = response.json()
    name = operation["metadata"]["artifact"]

    generating = (await scene.as_owner.get(f"/api/v1/{name}")).json()
    assert generating["state"] == "GENERATING"
    assert "revision" not in generating
    assert generating["displayName"] == "Quiz"
    assert operation["done"] is False
    gate.set()
    assert (await finished(scene.as_owner, operation))["response"]["state"] == "ACTIVE"


async def test_a_model_failure_fails_the_operation_and_the_artifact(
    scene: Scene, runtime: AppRuntime
) -> None:
    runtime._agent_transport = ScriptedResponsesTransport(  # type: ignore[assignment]
        [[*created(), *failed("server_error", "boom")]]
    )
    done = await create(scene, {"kind": "DRAFT", "generationInstructions": "Write."})

    assert done["error"]["code"] == 14  # UNAVAILABLE
    artifact = (await scene.as_owner.get(f"/api/v1/{done['metadata']['artifact']}")).json()
    assert artifact["state"] == "FAILED"


async def test_cancel_stops_generation_and_fails_the_artifact(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    started = asyncio.Event()

    class Hanging(ScriptedResponsesTransport):
        async def stream_response(self, **kwargs: Any) -> Any:
            started.set()
            await asyncio.Event().wait()

    runtime._agent_transport = Hanging([])  # type: ignore[assignment]
    operation = (
        await scene.as_owner.post(scene.url, json={"kind": "DRAFT", "generationInstructions": "Go."})
    ).json()
    await started.wait()

    cancelled = await scene.as_owner.post(f"/api/v1/{operation['name']}:cancel", json={})

    assert cancelled.status_code == 200, cancelled.text
    done = await finished(scene.as_owner, operation)
    assert done["error"]["code"] == 1
    for _ in range(100):
        artifact = (await scene.as_owner.get(f"/api/v1/{operation['metadata']['artifact']}")).json()
        if artifact["state"] != "GENERATING":
            break
        await asyncio.sleep(0.01)
    assert artifact["state"] == "FAILED"
    async with sessions() as session:
        count = await session.scalar(
            select(ItemRevision.id).where(ItemRevision.item_id == artifact_id(artifact["name"]))
        )
    assert count is None


async def test_request_id_replays_the_same_operation(scene: Scene, runtime: AppRuntime) -> None:
    script(runtime, "Draft text")
    body = {"kind": "DRAFT", "generationInstructions": "Write."}
    url = f"{scene.url}?requestId=8d7a1a52-0a43-4d3e-9a7b-2f1a3f3b9c11"

    first = (await scene.as_owner.post(url, json=body)).json()
    second = (await scene.as_owner.post(url, json=body)).json()
    reused = await scene.as_owner.post(url, json={**body, "kind": "QUIZ"})

    assert first["name"] == second["name"]
    assert reused.status_code == 400
    assert reason(reused) == "REQUEST_ID_REUSED"
    await finished(scene.as_owner, first)


async def test_evidence_review_fills_cells_from_source_passages(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    await index(runtime, sessions, scene.policy, ["Economy class is required for flights."])
    model = script(
        runtime,
        '{"state": "SUPPORTED", "summary": "Economy only.", "citations": [1]}',
        "Plan A fits the policy.",
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
        },
    )

    artifact = done["response"]
    assert artifact["mimeType"] == "application/json"
    review = artifact["evidenceReview"]
    assert review["options"] == [{"key": "plan-a", "displayName": "Plan A"}]
    [cell] = review["cells"]
    assert cell["state"] == "SUPPORTED"
    assert cell["available"] is True
    assert cell["summary"] == "Economy only."
    assert cell["citations"][0]["item"] == scene.item(scene.policy)
    assert cell["citations"][0]["passage"] == f"{scene.item(scene.policy)}/passages/{scene.policy.id}:0"
    assert cell["citations"][0]["pageNumber"] == 1
    assert review["synthesis"] == "Plan A fits the policy."
    assert review["synthesisAvailable"] is True
    assert len(model.requests) == 2


async def test_cells_without_passages_are_not_found_without_a_model_call(
    scene: Scene, runtime: AppRuntime
) -> None:
    model = script(runtime)

    done = await create(
        scene,
        {
            "kind": "EVIDENCE_REVIEW",
            "sourceItems": [scene.item(scene.policy)],
            "evidenceReview": {"options": [{"key": "a"}, {"key": "b"}], "criteria": [{"key": "cost"}]},
        },
    )

    cells = done["response"]["evidenceReview"]["cells"]
    assert [(c["option"], c["criterion"], c["state"]) for c in cells] == [
        ("a", "cost", "NOT_FOUND"),
        ("b", "cost", "NOT_FOUND"),
    ]
    assert model.requests == []


# -- Validation and authorization --------------------------------------------------------------


async def test_non_file_kinds_need_the_work_module(scene: Scene, sessions: Sessions) -> None:
    async with sessions.begin() as session:
        await session.execute(
            update(Tenant)
            .where(Tenant.id == scene.workspace.id)
            .values(settings={"modules": {"work": False}})
        )

    refused = await scene.as_owner.post(scene.url, json={"kind": "DRAFT", "generationInstructions": "x"})

    assert refused.status_code == 400
    assert reason(refused) == "MODULE_DISABLED"
    allowed = await scene.as_owner.post(scene.url, json={"kind": "FILE", "generationInstructions": "x"})
    assert allowed.status_code == 200, allowed.text


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({}, "kind"),
        ({"kind": "DRAFT"}, "generationInstructions"),
        ({"kind": "EVIDENCE_REVIEW"}, "evidenceReview.options"),
        (
            {"kind": "EVIDENCE_REVIEW", "evidenceReview": {"options": [{"key": "a"}, {"key": "a"}], "criteria": [{"key": "c"}]}},
            "evidenceReview.options",
        ),
        ({"kind": "DRAFT", "generationInstructions": "x", "evidenceReview": {}}, "evidenceReview"),
        ({"kind": "DRAFT", "generationInstructions": "x", "audience": "SPACE"}, "space"),
        ({"kind": "DRAFT", "sourceItems": ["items/nope"]}, "sourceItems"),
    ],
)
async def test_invalid_bodies_are_invalid_argument(
    scene: Scene, body: dict[str, Any], field: str
) -> None:
    response = await scene.as_owner.post(scene.url, json=body)

    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert field in response.text


async def test_a_collection_source_is_invalid_argument(scene: Scene) -> None:
    response = await scene.as_owner.post(
        scene.url, json={"kind": "DRAFT", "sourceItems": [scene.item(scene.handbook)]}
    )

    assert response.status_code == 400
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"


async def test_unreadable_sources_and_spaces_are_permission_denied(
    scene: Scene, world: Any
) -> None:
    unreadable = await scene.as_reader.post(
        scene.url, json={"kind": "DRAFT", "sourceItems": [scene.item(scene.secret)]}
    )
    other_space = await world.make_space(scene.workspace, scene.admin)
    foreign_space = await scene.as_reader.post(
        scene.url,
        json={
            "kind": "DRAFT",
            "generationInstructions": "x",
            "space": f"workspaces/{scene.workspace.id}/spaces/{other_space.code}",
        },
    )

    assert unreadable.status_code == 403
    assert foreign_space.status_code == 403


async def test_space_audience_needs_every_member_to_read_every_source(scene: Scene, runtime: AppRuntime) -> None:
    refused = await scene.as_owner.post(
        scene.url,
        json={
            "kind": "DRAFT",
            "sourceItems": [scene.item(scene.secret)],
            "space": scene.space_name,
            "audience": "SPACE",
        },
    )
    assert refused.status_code == 400
    assert reason(refused) == "AUDIENCE_CANNOT_READ_SOURCES"

    script(runtime, "Shared")
    done = await create(
        scene,
        {
            "kind": "DRAFT",
            "sourceItems": [scene.item(scene.policy)],
            "space": scene.space_name,
            "audience": "SPACE",
        },
    )
    assert done["response"]["audience"] == "SPACE"
    assert done["response"]["space"] == scene.space_name


async def test_callers_outside_the_workspace_are_denied(scene: Scene) -> None:
    response = await scene.as_outsider.post(
        scene.url, json={"kind": "DRAFT", "generationInstructions": "x"}
    )

    assert response.status_code == 403


async def test_a_foreign_conversation_is_permission_denied(scene: Scene) -> None:
    response = await scene.as_owner.post(
        scene.url,
        json={
            "kind": "DRAFT",
            "generationInstructions": "x",
            "conversation": f"workspaces/{scene.workspace.id}/conversations/not-mine",
        },
    )

    assert response.status_code == 403


async def test_the_artifact_never_appears_in_the_items_api(scene: Scene, runtime: AppRuntime) -> None:
    script(runtime, "Text")
    done = await create(scene, {"kind": "DRAFT", "generationInstructions": "x"})
    item_url = f"/api/v1/workspaces/{scene.workspace.id}/items/{artifact_id(done['response']['name'])}"

    assert (await scene.as_owner.get(item_url)).status_code in (403, 404)
    listed = (await scene.as_owner.get(f"/api/v1/workspaces/{scene.workspace.id}/items")).json()
    assert all(
        artifact_id(done["response"]["name"]) != artifact_id(item["name"]) for item in listed.get("items", [])
    )


async def test_rows_follow_the_schema(scene: Scene, runtime: AppRuntime, sessions: Sessions) -> None:
    script(runtime, "Text")
    done = await create(scene, {"kind": "STUDY_GUIDE", "generationInstructions": "x"})

    async with sessions() as session:
        row = await session.get(Artifact, artifact_id(done["response"]["name"]))
    assert row is not None
    assert (row.kind, row.audience, row.owner_user_id) == ("study_guide", "private", scene.owner.id)
