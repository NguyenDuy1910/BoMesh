"""WorkspaceSettings and WorkspaceAssistant singletons, and their cross-slice reads."""

from __future__ import annotations

import pytest

from bomesh.services.workspaces.settings import assistant_settings, workspace_settings
from bomesh.db.models import Tenant
from harness import ApiClient, World
from workspaces_support import audit_actions, reason, set_status, ws_path

pytestmark = pytest.mark.asyncio


async def test_settings_defaults_and_member_read(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)

    response = await (await client.as_(member)).get(f"{ws_path(workspace)}/settings")

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == f"workspaces/{workspace.id}/settings"
    assert body["modules"] == {"spaces": True, "work": True, "requests": True}
    assert body["defaultPublishingPolicy"] == "AUTO_PUBLISH"
    assert body["etag"]
    outsider = await client.as_(await world.make_user())
    assert (await outsider.get(f"{ws_path(workspace)}/settings")).status_code == 403


async def test_update_settings_masks_etag_and_storage(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)
    etag = (await api.get(f"{ws_path(workspace)}/settings")).json()["etag"]

    response = await api.patch(
        f"{ws_path(workspace)}/settings",
        json={
            "modules": {"spaces": False},
            "branding": {"accentColor": "TEAL"},
            "workflows": [{"key": "QUIZ", "enabled": False}],
            "spaceTypes": [{"key": "team", "displayName": "Team", "enabled": True}],
            "documentTypes": [{"key": "policy", "displayName": "Policy"}],
            "defaultPublishingPolicy": "REVIEW_FIRST",
            "reverificationDuration": "86400s",
            "etag": etag,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["modules"] == {"spaces": False, "work": True, "requests": True}
    assert body["branding"] == {"accentColor": "TEAL"}
    assert body["workflows"] == [{"key": "QUIZ", "enabled": False}]
    assert body["defaultPublishingPolicy"] == "REVIEW_FIRST"
    assert body["reverificationDuration"] == "86400s"
    assert body["etag"] != etag
    async with sessions.begin() as session:
        stored = (await session.get(Tenant, workspace.id)).settings
        assert stored["modules"] == {"spaces": False}
        assert stored["reverification_duration"] == 86400
        assert stored["default_publishing_policy"] == "review_first"
        assert stored["workflows"] == [{"key": "quiz", "enabled": False}]
    assert "UpdateWorkspaceSettings" in await audit_actions(sessions, workspace)

    stale = await api.patch(
        f"{ws_path(workspace)}/settings", json={"modules": {"work": False}, "etag": etag}
    )
    assert stale.status_code == 409
    assert reason(stale) == "ETAG_MISMATCH"

    cleared = await api.patch(
        f"{ws_path(workspace)}/settings",
        params={"updateMask": "modules.spaces,reverificationDuration"},
        json={},
    )
    assert cleared.json()["modules"]["spaces"] is True
    assert "reverificationDuration" not in cleared.json()

    denied = await (await client.as_(member)).patch(
        f"{ws_path(workspace)}/settings", json={"modules": {"work": False}}
    )
    assert denied.status_code == 403


async def test_update_settings_validation(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    api = await client.as_(owner)
    duplicate = await api.patch(
        f"{ws_path(workspace)}/settings",
        json={"documentTypes": [{"key": "a", "displayName": "A"}, {"key": "a", "displayName": "B"}]},
    )
    assert duplicate.status_code == 400
    bad_duration = await api.patch(
        f"{ws_path(workspace)}/settings", json={"reverificationDuration": "1 day"}
    )
    assert bad_duration.status_code == 400
    bad_mask = await api.patch(
        f"{ws_path(workspace)}/settings", params={"updateMask": "name"}, json={}
    )
    assert bad_mask.status_code == 400


async def test_module_flag_cross_slice_read(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await (await client.as_(owner)).patch(
        f"{ws_path(workspace)}/settings", json={"modules": {"requests": False}}
    )
    async with sessions.begin() as session:
        settings = await workspace_settings(session, workspace.id)
    assert settings.module_enabled("requests") is False
    assert settings.module_enabled("spaces") is True


async def test_assistant_defaults_update_and_validation(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    default = (await (await client.as_(member)).get(f"{ws_path(workspace)}/assistant")).json()
    assert default["answerLength"] == "BALANCED"
    assert default["capabilities"] == {"webSearch": False, "fileWork": True, "charts": True}
    assert default["starterPrompts"] == []

    response = await api.patch(
        f"{ws_path(workspace)}/assistant",
        json={
            "instructions": "Be brief.",
            "answerLength": "CONCISE",
            "capabilities": {"webSearch": True},
            "welcomeMessage": "Hi!",
            "starterPrompts": [
                {"title": "Policies", "prompt": "What is our leave policy?", "roles": ["roles/workspaceMember"]}
            ],
            "etag": default["etag"],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["instructions"] == "Be brief."
    assert body["capabilities"] == {"webSearch": True, "fileWork": True, "charts": True}
    assert body["starterPrompts"][0]["roles"] == ["roles/workspaceMember"]
    assert "UpdateWorkspaceAssistant" in await audit_actions(sessions, workspace)

    async with sessions.begin() as session:
        shared = await assistant_settings(session, workspace.id)
    assert shared.answer_length == "concise"
    assert shared.web_search is True

    stale = await api.patch(
        f"{ws_path(workspace)}/assistant", json={"instructions": "x", "etag": default["etag"]}
    )
    assert stale.status_code == 409

    too_long = await api.patch(f"{ws_path(workspace)}/assistant", json={"instructions": "x" * 2001})
    assert too_long.status_code == 400
    prompt = {"title": "t", "prompt": "p", "roles": []}
    too_many = await api.patch(
        f"{ws_path(workspace)}/assistant", json={"starterPrompts": [prompt] * 4}
    )
    assert too_many.status_code == 400
    unknown_role = await api.patch(
        f"{ws_path(workspace)}/assistant",
        json={"starterPrompts": [{"title": "t", "prompt": "p", "roles": ["roles/nope"]}]},
    )
    assert unknown_role.status_code == 400

    denied = await (await client.as_(member)).patch(
        f"{ws_path(workspace)}/assistant", json={"instructions": "x"}
    )
    assert denied.status_code == 403


async def test_settings_write_in_archived_workspace(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await set_status(sessions, workspace, "archived")
    api = await client.as_(owner)
    assert (await api.get(f"{ws_path(workspace)}/assistant")).status_code == 200
    blocked = await api.patch(f"{ws_path(workspace)}/assistant", json={"instructions": "x"})
    assert blocked.status_code == 400
    assert reason(blocked) == "WORKSPACE_ARCHIVED"
