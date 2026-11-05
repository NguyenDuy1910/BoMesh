"""UpdateArtifact, DeleteArtifact, UndeleteArtifact, CommitArtifact and ReviseArtifact."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from sqlalchemy import select

from artifacts_support import Scene, artifact_id, draft, finished, reason, review, script
from bomesh.db.models import EvidenceReviewCell, ItemRevision
from bomesh.runtime import AppRuntime
from harness import Sessions, World
from native_responses import ScriptedResponsesTransport, created, failed

pytestmark = pytest.mark.asyncio


def url(name: str, suffix: str = "") -> str:
    return f"/api/v1/{name}{suffix}"


# -- UpdateArtifact -------------------------------------------------------------------------


async def test_update_renames_and_shares_with_the_space(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await draft(scene, runtime, sourceItems=[scene.item(scene.policy)])

    response = await scene.as_owner.patch(
        url(artifact["name"]),
        params={"updateMask": "displayName,space,audience"},
        json={
            "displayName": "Renamed",
            "space": scene.space_name,
            "audience": "SPACE",
            "etag": artifact["etag"],
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["displayName"], body["space"], body["audience"]) == (
        "Renamed",
        scene.space_name,
        "SPACE",
    )
    assert body["etag"] != artifact["etag"]
    assert (await scene.as_reader.get(url(artifact["name"]))).status_code == 200


async def test_update_refuses_an_audience_that_cannot_read_the_sources(
    scene: Scene, runtime: AppRuntime
) -> None:
    artifact = await draft(scene, runtime, sourceItems=[scene.item(scene.secret)])

    response = await scene.as_owner.patch(
        url(artifact["name"]),
        params={"updateMask": "space,audience"},
        json={"space": scene.space_name, "audience": "SPACE"},
    )

    assert response.status_code == 400
    assert reason(response) == "AUDIENCE_CANNOT_READ_SOURCES"


async def test_update_errors(scene: Scene, runtime: AppRuntime, world: World) -> None:
    artifact = await draft(scene, runtime)
    other = await world.make_space(scene.workspace, scene.admin)

    stale = await scene.as_owner.patch(
        url(artifact["name"]), params={"updateMask": "displayName"}, json={"displayName": "x", "etag": "stale"}
    )
    output_only = await scene.as_owner.patch(
        url(artifact["name"]), params={"updateMask": "kind"}, json={"kind": "QUIZ"}
    )
    no_space = await scene.as_owner.patch(
        url(artifact["name"]), params={"updateMask": "audience"}, json={"audience": "SPACE"}
    )
    foreign = await scene.as_owner.patch(
        url(artifact["name"]),
        params={"updateMask": "space"},
        json={"space": f"workspaces/{scene.workspace.id}/spaces/{other.code}"},
    )
    matrix = await scene.as_owner.patch(
        url(artifact["name"]),
        params={"updateMask": "evidenceReview.options"},
        json={"evidenceReview": {"options": [{"key": "a"}]}},
    )

    assert stale.status_code == 409 and reason(stale) == "ETAG_MISMATCH"
    assert output_only.status_code == 400
    assert no_space.status_code == 400
    assert foreign.status_code == 403
    assert matrix.status_code == 400


async def test_only_the_owner_updates(scene: Scene, runtime: AppRuntime) -> None:
    shared = await draft(
        scene, runtime, sourceItems=[scene.item(scene.policy)], space=scene.space_name, audience="SPACE"
    )
    private = await draft(scene, runtime)
    body = {"displayName": "Mine now"}

    by_reader = await scene.as_reader.patch(url(shared["name"]), params={"updateMask": "displayName"}, json=body)
    hidden = await scene.as_reader.patch(url(private["name"]), params={"updateMask": "displayName"}, json=body)

    assert by_reader.status_code == 403
    assert hidden.status_code == 404


async def test_removing_an_option_deletes_its_cells(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await review(scene, runtime, sessions)

    response = await scene.as_owner.patch(
        url(artifact["name"]),
        params={"updateMask": "evidenceReview.options"},
        json={"evidenceReview": {"options": [{"key": "plan-b", "displayName": "Plan B"}]}},
    )

    assert response.status_code == 200, response.text
    assert response.json()["evidenceReview"]["options"] == [{"key": "plan-b", "displayName": "Plan B"}]
    assert response.json()["evidenceReview"]["cells"] == []
    async with sessions() as session:
        rows = list(
            await session.scalars(
                select(EvidenceReviewCell).where(
                    EvidenceReviewCell.artifact_item_id == artifact_id(artifact["name"])
                )
            )
        )
    assert rows == []


# -- Delete and undelete -------------------------------------------------------------------------


async def test_delete_and_undelete(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await draft(scene, runtime)

    stale = await scene.as_owner.delete(url(artifact["name"]), params={"etag": "stale"})
    deleted = await scene.as_owner.delete(url(artifact["name"]), params={"etag": artifact["etag"]})
    again = await scene.as_owner.delete(url(artifact["name"]))
    restored = await scene.as_owner.post(url(artifact["name"], ":undelete"), json={})
    twice = await scene.as_owner.post(url(artifact["name"], ":undelete"), json={})

    assert stale.status_code == 409
    assert deleted.status_code == 200, deleted.text
    body = deleted.json()
    assert body["state"] == "DELETED" and "deleteTime" in body and "purgeTime" in body
    assert again.status_code == 400
    assert restored.status_code == 200 and restored.json()["state"] == "ACTIVE"
    assert "deleteTime" not in restored.json()
    assert twice.status_code == 409 and twice.json()["error"]["status"] == "ALREADY_EXISTS"


async def test_space_readers_lose_a_deleted_artifact(scene: Scene, runtime: AppRuntime) -> None:
    shared = await draft(
        scene, runtime, sourceItems=[scene.item(scene.policy)], space=scene.space_name, audience="SPACE"
    )

    assert (await scene.as_reader.delete(url(shared["name"]))).status_code == 403
    await scene.as_owner.delete(url(shared["name"]))

    assert (await scene.as_reader.get(url(shared["name"]))).status_code == 404
    assert (await scene.as_reader.post(url(shared["name"], ":undelete"), json={})).status_code == 404


# -- CommitArtifact -----------------------------------------------------------------------------


async def test_commit_stores_a_user_revision(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await draft(scene, runtime)

    response = await scene.as_owner.post(
        url(artifact["name"], ":commit"),
        json={"text": "# Edited\n", "changeSummary": "Fixed the title", "etag": artifact["etag"]},
    )

    assert response.status_code == 200, response.text
    assert response.json()["revision"] == f"{artifact['name']}/revisions/2"
    revision = (await scene.as_owner.get(url(artifact["name"], "/revisions/2"))).json()
    assert revision["author"] == "USER"
    assert revision["creator"] == f"workspaces/{scene.workspace.id}/members/{scene.owner.id}"
    assert revision["changeSummary"] == "Fixed the title"
    assert revision["snapshot"]["text"] == "# Edited\n"
    media = await scene.as_owner.get(url(artifact["name"]), params={"alt": "media"})
    assert media.content == b"# Edited\n"
    async with sessions() as session:
        rows = list(
            await session.scalars(
                select(ItemRevision.author).where(ItemRevision.item_id == artifact_id(artifact["name"]))
            )
        )
    assert sorted(rows) == ["assistant", "user"]


async def test_commit_errors(scene: Scene, runtime: AppRuntime, sessions: Sessions) -> None:
    artifact = await draft(
        scene, runtime, sourceItems=[scene.item(scene.policy)], space=scene.space_name, audience="SPACE"
    )
    matrix = await review(scene, runtime, sessions)

    stale = await scene.as_owner.post(url(artifact["name"], ":commit"), json={"text": "x", "etag": "stale"})
    by_reader = await scene.as_reader.post(url(artifact["name"], ":commit"), json={"text": "x"})
    not_text = await scene.as_owner.post(url(matrix["name"], ":commit"), json={"text": "x"})
    no_text = await scene.as_owner.post(url(artifact["name"], ":commit"), json={})

    assert stale.status_code == 409
    assert by_reader.status_code == 403
    assert not_text.status_code == 400 and not_text.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert no_text.status_code == 400 and no_text.json()["error"]["status"] == "INVALID_ARGUMENT"


# -- ReviseArtifact ---------------------------------------------------------------------------------


async def test_revise_writes_a_new_assistant_revision(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await draft(scene, runtime, "# First\n")
    model = script(runtime, "# Second\n")

    response = await scene.as_owner.post(
        url(artifact["name"], ":revise"), json={"instructions": "Make it shorter.", "etag": artifact["etag"]}
    )

    assert response.status_code == 200, response.text
    done = await finished(scene.as_owner, response.json())
    assert done["metadata"]["artifact"] == artifact["name"]
    assert done["response"]["revision"] == f"{artifact['name']}/revisions/2"
    prompt = str(model.requests[0]["input"])
    assert "Make it shorter." in prompt and "# First" in prompt
    media = await scene.as_owner.get(url(artifact["name"]), params={"alt": "media"})
    assert media.content == b"# Second"


async def test_revise_regenerates_only_the_named_cells(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await review(scene, runtime, sessions)
    script(runtime, '{"state": "PARTIAL", "summary": "Mostly.", "citations": [1]}', "Revised synthesis.")

    response = await scene.as_owner.post(
        url(artifact["name"], ":revise"),
        json={"cells": [{"option": "plan-a", "criterion": "travel"}]},
    )

    done = await finished(scene.as_owner, response.json())
    review_body = done["response"]["evidenceReview"]
    assert review_body["cells"][0]["state"] == "PARTIAL"
    assert review_body["synthesis"] == "Revised synthesis."
    assert done["response"]["revision"].endswith("/revisions/2")


async def test_revise_errors(scene: Scene, runtime: AppRuntime, sessions: Sessions) -> None:
    artifact = await draft(scene, runtime)
    matrix = await review(scene, runtime, sessions)

    no_instructions = await scene.as_owner.post(url(artifact["name"], ":revise"), json={})
    cells_on_text = await scene.as_owner.post(
        url(artifact["name"], ":revise"),
        json={"instructions": "x", "cells": [{"option": "a", "criterion": "b"}]},
    )
    unknown_cell = await scene.as_owner.post(
        url(matrix["name"], ":revise"), json={"cells": [{"option": "zzz", "criterion": "travel"}]}
    )
    stale = await scene.as_owner.post(url(artifact["name"], ":revise"), json={"instructions": "x", "etag": "stale"})
    hidden = await scene.as_reader.post(url(artifact["name"], ":revise"), json={"instructions": "x"})

    assert no_instructions.status_code == 400
    assert cells_on_text.status_code == 400
    assert unknown_cell.status_code == 400
    assert stale.status_code == 409
    assert hidden.status_code == 404


async def test_revise_while_generating_is_failed_precondition(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await draft(scene, runtime)
    gate = asyncio.Event()

    class Held(ScriptedResponsesTransport):
        async def stream_response(self, **kwargs: Any) -> Any:
            await gate.wait()
            return await super().stream_response(**kwargs)

    runtime._agent_transport = Held([[*created(), *failed("server_error", "down")]])  # type: ignore[assignment]
    first = await scene.as_owner.post(url(artifact["name"], ":revise"), json={"instructions": "x"})
    assert first.status_code == 200

    second = await scene.as_owner.post(url(artifact["name"], ":revise"), json={"instructions": "y"})
    generating = (await scene.as_owner.get(url(artifact["name"]))).json()["state"]
    gate.set()

    assert second.status_code == 400 and second.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert generating == "GENERATING"
    done = await finished(scene.as_owner, first.json())
    assert "error" in done
    restored = (await scene.as_owner.get(url(artifact["name"]))).json()
    assert restored["state"] == "ACTIVE"
    assert restored["revision"].endswith("/revisions/1")
