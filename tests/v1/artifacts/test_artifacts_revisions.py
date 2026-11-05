"""Artifact revisions: List, Get (with the viewer preview), Delete and Rollback."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import update

from artifacts_support import Scene, artifact_id, draft, finished, review, script
from bomesh.db.models import ItemRevision
from bomesh.iam.authorizer import Principal, WorkspaceAccess
from bomesh.runtime import AppRuntime
from harness import Sessions

pytestmark = pytest.mark.asyncio


def url(name: str, suffix: str = "") -> str:
    return f"/api/v1/{name}{suffix}"


async def edited(scene: Scene, runtime: AppRuntime, *texts: str) -> dict[str, Any]:
    """A draft (revision 1) followed by one user revision per text."""
    artifact = await draft(scene, runtime, "one")
    for text in texts:
        response = await scene.as_owner.post(url(artifact["name"], ":commit"), json={"text": text})
        assert response.status_code == 200, response.text
    return artifact


async def test_list_is_newest_first_and_pages(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await edited(scene, runtime, "two", "three")

    page = (await scene.as_owner.get(url(artifact["name"], "/revisions"), params={"pageSize": 2})).json()
    rest = (
        await scene.as_owner.get(
            url(artifact["name"], "/revisions"), params={"pageSize": 2, "pageToken": page["nextPageToken"]}
        )
    ).json()

    assert [r["name"].rsplit("/", 1)[1] for r in page["revisions"]] == ["3", "2"]
    assert [r["snapshot"]["text"] for r in page["revisions"]] == ["three", "two"]
    assert page["totalSize"] == 3
    assert [r["author"] for r in rest["revisions"]] == ["ASSISTANT"]


async def test_revisions_are_owner_only(scene: Scene, runtime: AppRuntime) -> None:
    shared = await draft(
        scene, runtime, sourceItems=[scene.item(scene.policy)], space=scene.space_name, audience="SPACE"
    )

    assert (await scene.as_reader.get(url(shared["name"], "/revisions"))).status_code == 403
    assert (await scene.as_reader.get(url(shared["name"], "/revisions/1"))).status_code == 403
    assert (await scene.as_stranger.get(url(shared["name"], "/revisions/1"))).status_code == 404
    assert (await scene.as_owner.get(url(shared["name"], "/revisions/9"))).status_code == 404
    assert (await scene.as_owner.get(url(shared["name"], "/revisions/abc"))).status_code == 400


async def test_delete_only_the_newest_user_revision_within_ten_minutes(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await edited(scene, runtime, "two", "three")

    older = await scene.as_owner.delete(url(artifact["name"], "/revisions/2"))
    assistant = await scene.as_owner.delete(url(artifact["name"], "/revisions/1"))
    newest = await scene.as_owner.delete(url(artifact["name"], "/revisions/3"))

    assert older.status_code == 400 and older.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert assistant.status_code == 400
    assert newest.status_code == 200 and newest.json() == {}
    current = (await scene.as_owner.get(url(artifact["name"]))).json()
    assert current["revision"].endswith("/revisions/2")
    assert (await scene.as_owner.get(url(artifact["name"]), params={"alt": "media"})).content == b"two"
    assert (await scene.as_owner.get(url(artifact["name"], "/revisions/3"))).status_code == 404

    async with sessions.begin() as session:
        await session.execute(
            update(ItemRevision)
            .where(ItemRevision.item_id == artifact_id(artifact["name"]), ItemRevision.revision_number == 2)
            .values(created_at=datetime.now(UTC) - timedelta(minutes=11))
        )
    late = await scene.as_owner.delete(url(artifact["name"], "/revisions/2"))
    assert late.status_code == 400


async def test_a_new_revision_never_reuses_a_deleted_number(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await edited(scene, runtime, "two")
    await scene.as_owner.delete(url(artifact["name"], "/revisions/2"))

    again = await scene.as_owner.post(url(artifact["name"], ":commit"), json={"text": "again"})

    assert again.json()["revision"].endswith("/revisions/3")


async def test_rollback_copies_a_revision_into_a_new_one(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await edited(scene, runtime, "two")
    current = (await scene.as_owner.get(url(artifact["name"]))).json()

    stale = await scene.as_owner.post(url(artifact["name"], "/revisions/1:rollback"), json={"etag": "stale"})
    missing = await scene.as_owner.post(url(artifact["name"], "/revisions/7:rollback"), json={})
    response = await scene.as_owner.post(
        url(artifact["name"], "/revisions/1:rollback"), json={"etag": current["etag"]}
    )

    assert stale.status_code == 409
    assert missing.status_code == 404
    assert response.status_code == 200, response.text
    assert response.json()["revision"].endswith("/revisions/3")
    revision = (await scene.as_owner.get(url(artifact["name"], "/revisions/3"))).json()
    assert revision["snapshot"]["text"] == "one"
    assert revision["author"] == "USER"
    assert revision["changeSummary"] == "Restored revision 1."


async def test_rollback_of_an_evidence_review_restores_its_matrix(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await review(scene, runtime, sessions)
    script(runtime, '{"state": "PARTIAL", "summary": "Mostly.", "citations": [1]}', "Second synthesis.")
    revised = await scene.as_owner.post(url(artifact["name"], ":revise"), json={})
    await finished(scene.as_owner, revised.json())

    rolled = await scene.as_owner.post(url(artifact["name"], "/revisions/1:rollback"), json={})

    body = rolled.json()["evidenceReview"]
    assert body["cells"][0]["state"] == "SUPPORTED"
    assert body["synthesis"] == "Plan A fits."
    frozen = (await scene.as_owner.get(url(artifact["name"], "/revisions/2"))).json()["snapshot"]
    assert frozen["evidenceReview"]["cells"][0]["state"] == "PARTIAL"


async def test_a_non_markdown_revision_gets_a_preview_once_and_markdown_none(
    scene: Scene, runtime: AppRuntime, monkeypatch: pytest.MonkeyPatch
) -> None:
    access = WorkspaceAccess(Principal(scene.owner.id), scene.workspace.id, runtime.authorizer_factory())
    generated = await runtime.artifact_service().record_generated(
        access,
        conversation_id=None,
        file_name="totals.csv",
        mime_type="text/csv",
        data=b"month,total\nJan,10\nFeb,12\n",
        summary="Totals",
    )
    preview = runtime.knowledge_preview()
    calls: list[Any] = []
    original = preview.generate

    async def counted(*args: Any, **kwargs: Any) -> Any:
        calls.append(args)
        return await original(*args, **kwargs)

    monkeypatch.setattr(preview, "generate", counted)

    first = (await scene.as_owner.get(url(generated.name, "/revisions/1"))).json()["snapshot"]
    second = (await scene.as_owner.get(url(generated.name, "/revisions/1"))).json()["snapshot"]
    listed = (await scene.as_owner.get(url(generated.name, "/revisions"))).json()["revisions"][0]

    assert first["rendition"]["uri"]
    assert first["rendition"]["version"] == 1
    assert second["rendition"]["blockCount"] == first["rendition"]["blockCount"]
    assert listed["snapshot"]["rendition"]["version"] == 1
    assert len(calls) == 1
    assert first["text"].startswith("month,total")

    markdown = await draft(scene, runtime, "# Notes")
    snapshot = (await scene.as_owner.get(url(markdown["name"], "/revisions/1"))).json()["snapshot"]
    assert "rendition" not in snapshot and snapshot.get("pageAssets", []) == []
    assert len(calls) == 1
