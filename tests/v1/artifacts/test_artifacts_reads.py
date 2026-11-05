"""GetArtifact (incl. ``alt=media``) and ListArtifacts: access, per-reader filtering, lists."""

from __future__ import annotations

import pytest

from artifacts_support import Scene, draft, review
from bomesh.runtime import AppRuntime
from harness import Sessions, World

pytestmark = pytest.mark.asyncio


def url(name: str, suffix: str = "") -> str:
    return f"/api/v1/{name}{suffix}"


async def test_owner_reads_and_space_members_read_space_artifacts(
    scene: Scene, runtime: AppRuntime
) -> None:
    private = await draft(scene, runtime)
    shared = await draft(
        scene,
        runtime,
        sourceItems=[scene.item(scene.policy)],
        space=scene.space_name,
        audience="SPACE",
    )

    assert (await scene.as_owner.get(url(private["name"]))).status_code == 200
    assert (await scene.as_reader.get(url(shared["name"]))).json()["name"] == shared["name"]
    assert (await scene.as_reader.get(url(private["name"]))).status_code == 404
    assert (await scene.as_stranger.get(url(shared["name"]))).status_code == 404
    assert (await scene.as_outsider.get(url(shared["name"]))).status_code == 403
    missing = f"workspaces/{scene.workspace.id}/artifacts/0b6f2f0e-3c1a-4c8e-9a51-4e0f6b2f7a10"
    assert (await scene.as_owner.get(url(missing))).status_code == 404


async def test_sources_are_refiltered_for_every_read(
    scene: Scene, runtime: AppRuntime, world: World
) -> None:
    shared = await draft(
        scene,
        runtime,
        "Policy summary",
        sourceItems=[scene.item(scene.policy)],
        space=scene.space_name,
        audience="SPACE",
    )
    await world.revoke(scene.reader, on=scene.handbook)

    seen = (await scene.as_reader.get(url(shared["name"]))).json()
    owner_view = (await scene.as_owner.get(url(shared["name"]))).json()
    media = await scene.as_reader.get(url(shared["name"]), params={"alt": "media"})

    assert seen["sourceItems"] == []
    assert seen["hiddenSourceCount"] == 1
    assert owner_view["sourceItems"] == [scene.item(scene.policy)]
    assert owner_view["hiddenSourceCount"] == 0
    assert media.status_code == 403


async def test_alt_media_returns_the_stored_bytes(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await draft(scene, runtime, "# Hello\n")

    response = await scene.as_owner.get(url(artifact["name"]), params={"alt": "media"})

    assert response.status_code == 200
    assert response.content == b"# Hello"
    assert response.headers["content-type"].startswith("text/markdown")


async def test_evidence_cells_citing_unreadable_items_are_withheld(
    scene: Scene, runtime: AppRuntime, sessions: Sessions, world: World
) -> None:
    artifact = await review(scene, runtime, sessions, space=scene.space_name, audience="SPACE")
    await world.revoke(scene.reader, on=scene.handbook)

    seen = (await scene.as_reader.get(url(artifact["name"]))).json()["evidenceReview"]

    assert seen["cells"] == [{"option": "plan-a", "criterion": "travel", "available": False}]
    assert seen["synthesisAvailable"] is False
    assert "synthesis" not in seen
    assert (await scene.as_reader.get(url(artifact["name"]), params={"alt": "media"})).status_code == 403
    owner_view = (await scene.as_owner.get(url(artifact["name"]))).json()["evidenceReview"]
    assert owner_view["cells"][0]["available"] is True


async def test_list_shows_own_and_space_artifacts(scene: Scene, runtime: AppRuntime) -> None:
    own = await draft(scene, runtime)
    shared = await draft(
        scene, runtime, sourceItems=[scene.item(scene.policy)], space=scene.space_name, audience="SPACE"
    )

    def names(response: object) -> list[str]:
        assert response.status_code == 200, response.text  # type: ignore[attr-defined]
        return [a["name"] for a in response.json().get("artifacts", [])]  # type: ignore[attr-defined]

    assert set(names(await scene.as_owner.get(scene.url))) == {own["name"], shared["name"]}
    assert names(await scene.as_reader.get(scene.url)) == [shared["name"]]
    assert names(await scene.as_stranger.get(scene.url)) == []
    assert (await scene.as_outsider.get(scene.url)).status_code == 403


async def test_list_filters_orders_and_pages(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    first = await draft(scene, runtime)
    second = await draft(scene, runtime, space=scene.space_name)
    evidence = await review(scene, runtime, sessions)

    async def names(**params: str) -> list[str]:
        response = await scene.as_owner.get(scene.url, params=params)
        assert response.status_code == 200, response.text
        return [a["name"] for a in response.json().get("artifacts", [])]

    assert await names(filter='kind = "EVIDENCE_REVIEW"') == [evidence["name"]]
    assert await names(filter=f'space = "{scene.space_name}"') == [second["name"]]
    assert set(await names(filter=f'owner = "workspaces/{scene.workspace.id}/members/{scene.owner.id}"')) == {
        first["name"],
        second["name"],
        evidence["name"],
    }
    assert await names(filter="state = ACTIVE", orderBy="createTime") == [
        first["name"],
        second["name"],
        evidence["name"],
    ]
    assert await names(orderBy="createTime desc") == [evidence["name"], second["name"], first["name"]]

    page = (await scene.as_owner.get(scene.url, params={"pageSize": 2, "orderBy": "createTime"})).json()
    assert [a["name"] for a in page["artifacts"]] == [first["name"], second["name"]]
    assert page["totalSize"] == 3
    rest = (
        await scene.as_owner.get(
            scene.url, params={"pageSize": 2, "orderBy": "createTime", "pageToken": page["nextPageToken"]}
        )
    ).json()
    assert [a["name"] for a in rest["artifacts"]] == [evidence["name"]]
    assert "nextPageToken" not in rest

    bad = await scene.as_owner.get(scene.url, params={"filter": 'displayName = "x"'})
    assert bad.status_code == 400
    assert (await scene.as_owner.get(scene.url, params={"orderBy": "kind"})).status_code == 400


async def test_list_basic_view_omits_cells_and_full_view_has_them(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    await review(scene, runtime, sessions)

    basic = (await scene.as_owner.get(scene.url)).json()["artifacts"][0]["evidenceReview"]
    full = (await scene.as_owner.get(scene.url, params={"view": "FULL"})).json()["artifacts"][0][
        "evidenceReview"
    ]

    assert "cells" not in basic and basic["options"][0]["key"] == "plan-a"
    assert full["cells"][0]["state"] == "SUPPORTED"


async def test_deleted_artifacts_are_listed_only_with_show_deleted(
    scene: Scene, runtime: AppRuntime
) -> None:
    artifact = await draft(scene, runtime)
    deleted = await scene.as_owner.delete(url(artifact["name"]))
    assert deleted.status_code == 200, deleted.text

    assert (await scene.as_owner.get(scene.url)).json().get("artifacts", []) == []
    shown = (await scene.as_owner.get(scene.url, params={"showDeleted": "true"})).json()["artifacts"]
    assert [(a["name"], a["state"]) for a in shown] == [(artifact["name"], "DELETED")]
    assert (await scene.as_owner.get(scene.url, params={"filter": "state = NOPE"})).status_code == 400
