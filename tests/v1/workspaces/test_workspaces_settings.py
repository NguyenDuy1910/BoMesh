"""WorkspaceSettings and WorkspaceAssistant singletons, their cross-slice reads, and the map background."""

from __future__ import annotations

import io
from uuid import UUID

import pytest
from PIL import Image

from bomesh.services.workspaces.settings import assistant_settings, workspace_settings
from bomesh.db.models import Tenant
from bomesh.storage.keys import ASSETS, IMMUTABLE_CACHE_CONTROL, LOGO, MAP_BACKGROUND, asset_key
from harness import ApiClient, Fakes, World
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
        json={"workflows": [{"key": "QUIZ", "enabled": True}, {"key": "QUIZ", "enabled": False}]},
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


# -- Map background ----------------------------------------------------------------

def _image(fmt: str = "JPEG", size: tuple[int, int] = (1920, 1080)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, (120, 160, 200)).save(buffer, format=fmt)
    return buffer.getvalue()


async def _upload(api: ApiClient, workspace: Tenant, data: bytes, name: str, mime: str):
    return await api.post(
        f"{ws_path(workspace)}/settings:uploadMapBackground", files={"file": (name, data, mime)}
    )


def _map_objects(fakes: Fakes, workspace: Tenant) -> list[str]:
    prefix = f"{ASSETS}/{workspace.id}/{MAP_BACKGROUND}/"
    return [key for key in fakes.storage.objects if key.startswith(prefix)]


async def test_upload_map_background_replaces_and_deletes_the_old_image(
    client: ApiClient, world: World, sessions, fakes: Fakes
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    first = await _upload(api, workspace, _image(size=(1600, 900)), "campus.jpg", "image/jpeg")

    assert first.status_code == 200, first.text
    background = first.json()["branding"]["mapBackground"]
    assert background["fileName"] == "campus.jpg"
    assert (background["widthPixels"], background["heightPixels"]) == (1600, 900)
    assert background["strength"] == 25
    assert background["updater"] == f"workspaces/{workspace.id}/members/{owner.id}"
    assert background["updateTime"]
    [first_key] = _map_objects(fakes, workspace)
    assert background["imageUri"].startswith(f"https://storage.test/test-bucket/{first_key}")
    assert fakes.storage.objects[first_key].content_type == "image/jpeg"
    assert "UploadMapBackground" in await audit_actions(sessions, workspace)

    # Every member reads it, with a signed image URI.
    read = (await (await client.as_(member)).get(f"{ws_path(workspace)}/settings")).json()
    assert read["branding"]["mapBackground"]["imageUri"].startswith("https://storage.test/")

    strength = await api.patch(
        f"{ws_path(workspace)}/settings",
        params={"updateMask": "branding.mapBackground.strength"},
        json={"branding": {"mapBackground": {"strength": 60}}},
    )
    assert strength.status_code == 200, strength.text
    assert strength.json()["branding"]["mapBackground"]["strength"] == 60

    second = await _upload(api, workspace, _image("PNG", (800, 450)), "map.png", "image/png")

    assert second.status_code == 200, second.text
    replaced = second.json()["branding"]["mapBackground"]
    assert replaced["fileName"] == "map.png"
    assert replaced["widthPixels"] == 800
    assert replaced["strength"] == 60  # the strength is kept
    [second_key] = _map_objects(fakes, workspace)
    assert second_key != first_key
    async with sessions.begin() as session:
        stored = (await session.get(Tenant, workspace.id)).settings["branding"]["map_background"]
    assert asset_key(workspace.id, MAP_BACKGROUND, UUID(stored["image_id"])) == second_key
    assert fakes.storage.objects[second_key].cache_control == IMMUTABLE_CACHE_CONTROL
    assert stored["size_bytes"] == len(fakes.storage.objects[second_key].data)


async def test_remove_map_background_deletes_its_image(
    client: ApiClient, world: World, sessions, fakes: Fakes
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    api = await client.as_(owner)
    await _upload(api, workspace, _image("WEBP"), "bg.webp", "image/webp")
    assert len(_map_objects(fakes, workspace)) == 1

    removed = await api.patch(
        f"{ws_path(workspace)}/settings", params={"updateMask": "branding.mapBackground"}, json={}
    )

    assert removed.status_code == 200, removed.text
    assert "mapBackground" not in (removed.json().get("branding") or {})
    assert _map_objects(fakes, workspace) == []
    async with sessions.begin() as session:
        assert "branding" not in (await session.get(Tenant, workspace.id)).settings
    no_background = await api.patch(
        f"{ws_path(workspace)}/settings",
        params={"updateMask": "branding.mapBackground.strength"},
        json={"branding": {"mapBackground": {"strength": 40}}},
    )
    assert no_background.status_code == 400


async def test_upload_map_background_validation_and_permission(
    client: ApiClient, world: World, fakes: Fakes
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
    wrong_type = await _upload(api, workspace, svg, "map.svg", "image/svg+xml")
    assert wrong_type.status_code == 400
    assert wrong_type.json()["error"]["status"] == "INVALID_ARGUMENT"
    gif = io.BytesIO()
    Image.new("RGB", (10, 10)).save(gif, format="GIF")
    assert (await _upload(api, workspace, gif.getvalue(), "a.gif", "image/jpeg")).status_code == 400
    too_big = _image() + b"\0" * (10 * 1024 * 1024)
    assert (await _upload(api, workspace, too_big, "big.jpg", "image/jpeg")).status_code == 400
    bad_strength = await api.patch(
        f"{ws_path(workspace)}/settings",
        params={"updateMask": "branding.mapBackground.strength"},
        json={"branding": {"mapBackground": {"strength": 101}}},
    )
    assert bad_strength.status_code == 400

    denied = await _upload(await client.as_(member), workspace, _image(), "a.jpg", "image/jpeg")
    assert denied.status_code == 403
    assert _map_objects(fakes, workspace) == []


# -- Logo -------------------------------------------------------------------------


async def _upload_logo(api: ApiClient, workspace: Tenant, data: bytes, name: str, mime: str):
    return await api.post(
        f"{ws_path(workspace)}/settings:uploadLogo", files={"file": (name, data, mime)}
    )


def _logo_objects(fakes: Fakes, workspace: Tenant) -> list[str]:
    prefix = f"{ASSETS}/{workspace.id}/{LOGO}/"
    return [key for key in fakes.storage.objects if key.startswith(prefix)]


async def test_upload_logo_replaces_and_shows_on_the_workspace(
    client: ApiClient, world: World, sessions, fakes: Fakes
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    api = await client.as_(owner)

    first = await _upload_logo(api, workspace, _image("PNG", (256, 256)), "mark.png", "image/png")

    assert first.status_code == 200, first.text
    logo = first.json()["branding"]["logo"]
    assert logo["fileName"] == "mark.png"
    assert logo["updateTime"]
    [first_key] = _logo_objects(fakes, workspace)
    assert logo["uri"].startswith(f"https://storage.test/test-bucket/{first_key}")
    assert fakes.storage.objects[first_key].content_type == "image/png"
    assert fakes.storage.objects[first_key].cache_control == IMMUTABLE_CACHE_CONTROL
    assert "UploadWorkspaceLogo" in await audit_actions(sessions, workspace)

    # The Workspace carries it too (chooser, join page), for every reader of the workspace.
    got = (await api.get(ws_path(workspace))).json()
    assert got["logoUri"].startswith(f"https://storage.test/test-bucket/{first_key}")
    listed = (await api.get("/api/v1/workspaces")).json()["workspaces"]
    assert [w["logoUri"].startswith("https://storage.test/") for w in listed] == [True]

    second = await _upload_logo(api, workspace, _image("WEBP", (64, 64)), "m.webp", "image/webp")
    assert second.status_code == 200, second.text
    [second_key] = _logo_objects(fakes, workspace)
    assert second_key != first_key
    async with sessions.begin() as session:
        stored = (await session.get(Tenant, workspace.id)).settings["branding"]["logo"]
    assert asset_key(workspace.id, LOGO, UUID(stored["image_id"])) == second_key


async def test_remove_logo_deletes_its_image(
    client: ApiClient, world: World, sessions, fakes: Fakes
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    api = await client.as_(owner)
    await _upload_logo(api, workspace, _image("JPEG", (100, 100)), "l.jpg", "image/jpeg")
    assert len(_logo_objects(fakes, workspace)) == 1

    removed = await api.patch(
        f"{ws_path(workspace)}/settings", params={"updateMask": "branding.logo"}, json={}
    )

    assert removed.status_code == 200, removed.text
    assert "logo" not in (removed.json().get("branding") or {})
    assert _logo_objects(fakes, workspace) == []
    async with sessions.begin() as session:
        assert "branding" not in (await session.get(Tenant, workspace.id)).settings
    assert "logoUri" not in (await api.get(ws_path(workspace))).json()


async def test_upload_logo_validation_and_permission(
    client: ApiClient, world: World, fakes: Fakes
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
    wrong_type = await _upload_logo(api, workspace, svg, "l.svg", "image/svg+xml")
    assert wrong_type.status_code == 400
    assert wrong_type.json()["error"]["status"] == "INVALID_ARGUMENT"
    gif = io.BytesIO()
    Image.new("RGB", (10, 10)).save(gif, format="GIF")
    assert (await _upload_logo(api, workspace, gif.getvalue(), "a.gif", "image/png")).status_code == 400
    too_big = _image("PNG", (64, 64)) + b"\0" * (1024 * 1024)
    assert (await _upload_logo(api, workspace, too_big, "big.png", "image/png")).status_code == 400

    denied = await _upload_logo(await client.as_(member), workspace, _image(), "a.jpg", "image/jpeg")
    assert denied.status_code == 403
    member_remove = await (await client.as_(member)).patch(
        f"{ws_path(workspace)}/settings", params={"updateMask": "branding.logo"}, json={}
    )
    assert member_remove.status_code == 403
    assert _logo_objects(fakes, workspace) == []
