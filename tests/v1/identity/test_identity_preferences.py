"""Identity preferences: GetUserPreferences, UpdateUserPreferences (self only)."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from harness import ApiClient, World

if TYPE_CHECKING:
    from conftest import AuditReader

pytestmark = pytest.mark.asyncio

MINE = "/api/v1/users/me/preferences"


async def test_new_accounts_have_empty_preferences(client: ApiClient, world: World) -> None:
    user = await world.make_user()
    me = await client.as_(user)

    response = await me.get(MINE)

    assert response.status_code == 200
    assert response.json() == {"name": f"users/{user.id}/preferences"}


async def test_preferences_update_by_mask_and_persist(
    client: ApiClient, world: World, audit: AuditReader
) -> None:
    user = await world.make_user()
    workspace = await world.make_workspace(user)
    me = await client.as_(user)

    response = await me.patch(
        MINE,
        params={
            "updateMask": "languageCode,appearance.mode,appearance.accentColor,"
            "emailNotifications.weeklySummary,lastWorkspace,showWorkSteps"
        },
        json={
            "languageCode": "vi",
            "showWorkSteps": False,
            "appearance": {"mode": "DARK", "accentColor": "#12AB34", "font": "ignored"},
            "emailNotifications": {"weeklySummary": True},
            "lastWorkspace": f"workspaces/{workspace.id}",
        },
    )

    expected = {
        "name": f"users/{user.id}/preferences",
        "languageCode": "vi",
        "showWorkSteps": False,
        "appearance": {"mode": "DARK", "accentColor": "#12AB34"},
        "emailNotifications": {"weeklySummary": True},
        "lastWorkspace": f"workspaces/{workspace.id}",
    }
    assert response.status_code == 200
    assert response.json() == expected
    assert (await me.get(f"/api/v1/users/{user.id}/preferences")).json() == expected
    assert [e.target_name for e in await audit("UpdateUserPreferences")] == [expected["name"]]


async def test_a_masked_field_left_out_is_cleared_and_others_are_kept(
    client: ApiClient, world: World
) -> None:
    me = await client.as_(await world.make_user())
    await me.patch(MINE, json={"languageCode": "en", "appearance": {"theme": "ocean", "font": "serif"}})

    response = await me.patch(MINE, params={"updateMask": "appearance.theme"}, json={})

    assert response.json()["languageCode"] == "en"
    assert response.json()["appearance"] == {"font": "serif"}


async def test_last_workspace_must_be_an_active_membership(
    client: ApiClient, world: World
) -> None:
    user = await world.make_user()
    foreign = await world.make_workspace(await world.make_user())
    left = await world.make_workspace(await world.make_user())
    await world.add_member(left, user)
    await world.suspend_member(left, user)
    me = await client.as_(user)

    for value in (f"workspaces/{foreign.id}", f"workspaces/{left.id}", "items/x"):
        response = await me.patch(MINE, json={"lastWorkspace": value})
        assert response.status_code == 400
        assert response.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert "lastWorkspace" not in (await me.get(MINE)).json()


@pytest.mark.parametrize(
    "body",
    [
        {"languageCode": "not a tag"},
        {"appearance": {"mode": "NEON"}},
        {"appearance": {"cornerRadius": "ROUND"}},
        {"appearance": {"accentColor": "red"}},
        {"emailNotifications": {"weeklySummary": "often"}},
        {"name": "users/x/preferences", "unknown": True},
    ],
)
async def test_invalid_preferences_are_invalid_argument(
    client: ApiClient, world: World, body: dict[str, object]
) -> None:
    me = await client.as_(await world.make_user())

    response = await me.patch(MINE, json=body)

    assert response.status_code == 400


async def test_unknown_mask_paths_are_invalid_argument(client: ApiClient, world: World) -> None:
    me = await client.as_(await world.make_user())

    response = await me.patch(MINE, params={"updateMask": "name"}, json={})

    assert response.status_code == 400


async def test_preferences_are_readable_and_writable_only_by_their_user(
    client: ApiClient, world: World
) -> None:
    other = await world.make_user()
    admin = await client.as_(await world.platform_admin(await world.make_user()))

    read = await admin.get(f"/api/v1/users/{other.id}/preferences")
    write = await admin.patch(f"/api/v1/users/{other.id}/preferences", json={"languageCode": "en"})

    assert read.status_code == 403
    assert write.status_code == 403
    assert (await client.get(MINE)).status_code == 401
