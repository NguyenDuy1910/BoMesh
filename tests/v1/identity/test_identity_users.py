"""Identity accounts: CreateUser, GetUser, ListUsers, UpdateUser, SuspendUser, ActivateUser, LookupUser."""

from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import uuid4

import pytest

from harness import ApiClient, World

if TYPE_CHECKING:
    from conftest import Accounts, AuditReader, Reason

pytestmark = pytest.mark.asyncio

USERS = "/api/v1/users"


# -- CreateUser -------------------------------------------------------------------------------


async def test_sign_up_creates_an_active_account_that_can_sign_in(
    client: ApiClient, accounts: Accounts, audit: AuditReader
) -> None:
    response = await client.post(
        USERS,
        json={
            "email": " Ada@Example.com ",
            "password": accounts.password,
            "username": "Ada",
            "displayName": "Ada Lovelace",
        },
    )

    assert response.status_code == 200
    user = response.json()
    assert user["name"].startswith("users/")
    assert user["email"] == "ada@example.com"
    assert user["username"] == "ada"
    assert user["displayName"] == "Ada Lovelace"
    assert user["state"] == "ACTIVE"
    assert user["platformRole"] == "NONE"
    assert "password" not in user
    assert (await accounts.sign_in(email="ada@example.com")).status_code == 200
    assert [e.target_name for e in await audit("CreateUser")] == [user["name"]]


async def test_sign_up_rejects_a_used_email_or_username(
    client: ApiClient, accounts: Accounts, reason: Reason
) -> None:
    await accounts.sign_up("taken@example.com", username="taken")

    email = await client.post(
        USERS, json={"email": "TAKEN@example.com", "password": accounts.password}
    )
    username = await client.post(
        USERS,
        json={"email": "other@example.com", "password": accounts.password, "username": "Taken"},
    )

    assert email.status_code == 409
    assert reason(email) == "EMAIL_ALREADY_USED"
    assert username.status_code == 409
    assert reason(username) == "USERNAME_ALREADY_USED"


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"email": "not-an-email", "password": "long enough"}, "email"),
        ({"email": "a@example.com", "password": "short"}, "password"),
        ({"email": "a@example.com"}, "password"),
        ({"password": "long enough"}, "email"),
        ({"email": "a@example.com", "password": "long enough", "username": "a b"}, "username"),
        ({"email": "a@example.com", "password": "long enough", "platformRole": "ADMIN"}, "platformRole"),
    ],
)
async def test_sign_up_rejects_invalid_input(
    client: ApiClient, body: dict[str, str], field: str
) -> None:
    response = await client.post(USERS, json=body)

    assert response.status_code == 400
    violations = response.json()["error"]["details"][1]["fieldViolations"]
    assert [v["field"] for v in violations] == [field]


async def test_validate_only_checks_identifiers_and_creates_nothing(
    client: ApiClient, accounts: Accounts, reason: Reason
) -> None:
    await accounts.sign_up("used@example.com")

    fresh = await client.post(
        USERS, params={"validateOnly": "true"}, json={"email": "fresh@example.com"}
    )
    used = await client.post(
        USERS, params={"validateOnly": "true"}, json={"email": "used@example.com"}
    )

    assert fresh.status_code == 200
    assert fresh.json()["email"] == "fresh@example.com"
    assert "name" not in fresh.json()
    assert reason(used) == "EMAIL_ALREADY_USED"
    assert (await accounts.sign_in(email="fresh@example.com")).status_code == 401
    assert (
        await client.post(USERS, json={"email": "fresh@example.com", "password": accounts.password})
    ).status_code == 200


async def test_a_retried_request_id_returns_the_first_account(
    client: ApiClient, accounts: Accounts, reason: Reason
) -> None:
    request_id = str(uuid4())
    body = {"email": "retry@example.com", "password": accounts.password}

    first = await client.post(USERS, params={"requestId": request_id}, json=body)
    retry = await client.post(USERS, params={"requestId": request_id}, json=body)
    reused = await client.post(
        USERS,
        params={"requestId": request_id},
        json={"email": "other@example.com", "password": accounts.password},
    )

    assert first.status_code == retry.status_code == 200
    assert retry.json()["name"] == first.json()["name"]
    assert reused.status_code == 400
    assert reason(reused) == "REQUEST_ID_REUSED"


# -- GetUser ------------------------------------------------------------------------------------


async def test_users_me_names_the_caller_canonically(client: ApiClient, world: World) -> None:
    user = await world.make_user(display_name="Me Myself")
    me = await client.as_(user)

    response = await me.get(f"{USERS}/me")

    assert response.status_code == 200
    assert response.json()["name"] == f"users/{user.id}"
    assert response.json()["displayName"] == "Me Myself"
    assert (await me.get(f"{USERS}/{user.id}")).json() == response.json()


async def test_get_user_of_another_account_needs_users_get(
    client: ApiClient, world: World
) -> None:
    other = await world.make_user()
    plain = await client.as_(await world.make_user())
    operator = await client.as_(await world.platform_operator(await world.make_user()))

    assert (await plain.get(f"{USERS}/{other.id}")).status_code == 403
    assert (await plain.get(f"{USERS}/{uuid4()}")).status_code == 403
    assert (await operator.get(f"{USERS}/{other.id}")).status_code == 200
    assert (await operator.get(f"{USERS}/{uuid4()}")).status_code == 404
    assert (await operator.get(f"{USERS}/not-a-uuid")).status_code == 400


async def test_platform_role_is_read_from_platform_grants(
    client: ApiClient, world: World
) -> None:
    admin = await world.platform_admin(await world.make_user())
    operator = await world.platform_operator(await world.make_user())
    reader = await client.as_(admin)

    assert (await reader.get(f"{USERS}/me")).json()["platformRole"] == "ADMIN"
    assert (await reader.get(f"{USERS}/{operator.id}")).json()["platformRole"] == "OPERATOR"


# -- ListUsers ----------------------------------------------------------------------------------


async def test_list_users_needs_users_list(client: ApiClient, world: World) -> None:
    plain = await client.as_(await world.make_user())

    response = await plain.get(USERS)

    assert response.status_code == 403


async def test_list_users_filters_orders_pages_and_counts(
    client: ApiClient, world: World
) -> None:
    operator = await world.platform_operator(await world.make_user(display_name="Bob"))
    admin = await world.platform_admin(await world.make_user(display_name="Alice"))
    suspended = await world.make_user(email="suspended@example.com", display_name="Carol")
    await world.suspend_user(suspended)
    reader = await client.as_(operator)

    everyone = await reader.get(USERS, params={"orderBy": "displayName"})
    admins = await reader.get(USERS, params={"filter": "platformRole = ADMIN"})
    nobodies = await reader.get(USERS, params={"filter": "platformRole = NONE"})
    inactive = await reader.get(USERS, params={"filter": "state = SUSPENDED"})
    by_email = await reader.get(USERS, params={"filter": 'email = "suspended@example.com"'})
    first_page = await reader.get(USERS, params={"pageSize": 2, "orderBy": "createTime desc"})
    second_page = await reader.get(
        USERS,
        params={
            "pageSize": 2,
            "orderBy": "createTime desc",
            "pageToken": first_page.json()["nextPageToken"],
        },
    )

    assert everyone.status_code == 200
    assert [u["displayName"] for u in everyone.json()["users"]] == ["Alice", "Bob", "Carol"]
    assert everyone.json()["totalSize"] == 3
    assert [u["name"] for u in admins.json()["users"]] == [f"users/{admin.id}"]
    assert admins.json()["users"][0]["platformRole"] == "ADMIN"
    assert [u["name"] for u in nobodies.json()["users"]] == [f"users/{suspended.id}"]
    assert [u["state"] for u in inactive.json()["users"]] == ["SUSPENDED"]
    assert [u["name"] for u in by_email.json()["users"]] == [f"users/{suspended.id}"]
    assert [u["displayName"] for u in first_page.json()["users"]] == ["Carol", "Alice"]
    assert [u["displayName"] for u in second_page.json()["users"]] == ["Bob"]
    assert first_page.json()["totalSize"] == 3


@pytest.mark.parametrize(
    "params", [{"filter": "username = x"}, {"filter": "state = GONE"}, {"orderBy": "email"}]
)
async def test_list_users_rejects_unknown_filters_and_orders(
    client: ApiClient, world: World, params: dict[str, str]
) -> None:
    operator = await client.as_(await world.platform_operator(await world.make_user()))

    assert (await operator.get(USERS, params=params)).status_code == 400


# -- UpdateUser ---------------------------------------------------------------------------------


async def test_a_user_updates_their_own_display_name_and_username(
    client: ApiClient, accounts: Accounts, audit: AuditReader
) -> None:
    user = await accounts.sign_up("self@example.com", display_name="Old")
    me = await accounts.signed_in(email="self@example.com")

    response = await me.patch(
        f"{USERS}/me",
        params={"updateMask": "displayName,username"},
        json={"displayName": "New Name", "username": "New.Handle"},
    )

    assert response.status_code == 200
    assert response.json()["displayName"] == "New Name"
    assert response.json()["username"] == "new.handle"
    assert response.json()["updateTime"] >= user["updateTime"]
    assert (await accounts.sign_in(username="new.handle")).status_code == 200
    assert [e.details["updateMask"] for e in await audit("UpdateUser")] == [
        ["displayName", "username"]
    ]


async def test_update_without_a_mask_changes_only_populated_fields(
    client: ApiClient, world: World
) -> None:
    me = await client.as_(await world.make_user(display_name="Keep"))

    response = await me.patch(f"{USERS}/me", json={"username": "fresh"})

    assert response.json()["displayName"] == "Keep"
    assert response.json()["username"] == "fresh"


async def test_update_rejects_taken_usernames_and_output_only_fields(
    client: ApiClient, accounts: Accounts, world: World, reason: Reason
) -> None:
    await accounts.sign_up(username="occupied")
    me = await client.as_(await world.make_user())

    taken = await me.patch(f"{USERS}/me", json={"username": "Occupied"})
    email = await me.patch(
        f"{USERS}/me", params={"updateMask": "email"}, json={"email": "new@example.com"}
    )
    state = await me.patch(f"{USERS}/me", params={"updateMask": "state"}, json={})

    assert taken.status_code == 409
    assert reason(taken) == "USERNAME_ALREADY_USED"
    assert email.status_code == 400
    assert state.status_code == 400


async def test_nobody_changes_their_own_platform_role(
    client: ApiClient, world: World, reason: Reason
) -> None:
    admin = await client.as_(await world.platform_admin(await world.make_user()))
    plain = await client.as_(await world.make_user())

    by_admin = await admin.patch(
        f"{USERS}/me", params={"updateMask": "platformRole"}, json={"platformRole": "NONE"}
    )
    by_plain = await plain.patch(
        f"{USERS}/me", params={"updateMask": "platformRole"}, json={"platformRole": "ADMIN"}
    )

    assert by_admin.status_code == 400
    assert reason(by_admin) == "SELF_MODIFICATION"
    assert by_plain.status_code == 403
    assert (await admin.get(f"{USERS}/me")).json()["platformRole"] == "ADMIN"


async def test_a_platform_admin_grants_and_clears_platform_roles(
    client: ApiClient, world: World, audit: AuditReader
) -> None:
    admin = await client.as_(await world.platform_admin(await world.make_user()))
    target = await world.make_user()

    granted = await admin.patch(
        f"{USERS}/{target.id}",
        params={"updateMask": "platformRole"},
        json={"platformRole": "OPERATOR"},
    )
    target_client = await client.as_(target)
    can_list = (await target_client.get(USERS)).status_code
    cleared = await admin.patch(
        f"{USERS}/{target.id}", params={"updateMask": "platformRole"}, json={}
    )

    assert granted.status_code == 200
    assert granted.json()["platformRole"] == "OPERATOR"
    assert can_list == 200
    assert cleared.json()["platformRole"] == "NONE"
    assert (await target_client.get(USERS)).status_code == 403
    assert [e.details.get("platformRole") for e in await audit("UpdateUser")] == [
        "OPERATOR",
        "NONE",
    ]


async def test_other_accounts_profile_fields_are_self_only(
    client: ApiClient, world: World
) -> None:
    target = await world.make_user(display_name="Theirs")
    admin = await client.as_(await world.platform_admin(await world.make_user()))
    plain = await client.as_(await world.make_user())

    by_admin = await admin.patch(f"{USERS}/{target.id}", json={"displayName": "Mine"})
    by_plain = await plain.patch(f"{USERS}/{target.id}", json={"displayName": "Mine"})
    missing = await admin.patch(
        f"{USERS}/{uuid4()}", params={"updateMask": "platformRole"}, json={"platformRole": "ADMIN"}
    )

    assert by_admin.status_code == 403
    assert by_plain.status_code == 403
    assert missing.status_code == 404
    assert (await admin.get(f"{USERS}/{target.id}")).json()["displayName"] == "Theirs"


# -- SuspendUser / ActivateUser -----------------------------------------------------------------


async def test_suspension_ends_every_session_and_activation_restores_sign_in(
    client: ApiClient, accounts: Accounts, world: World, reason: Reason, audit: AuditReader
) -> None:
    user = await accounts.sign_up("cycle@example.com")
    device = await accounts.signed_in(email="cycle@example.com")
    admin = await client.as_(await world.platform_admin(await world.make_user()))

    suspended = await admin.post(f"/api/v1/{user['name']}:suspend", json={})
    again = await admin.post(f"/api/v1/{user['name']}:suspend", json={})

    assert suspended.status_code == 200
    assert suspended.json()["state"] == "SUSPENDED"
    assert (await device.get("/api/v1/sessions/current")).status_code == 401
    assert reason(await accounts.sign_in(email="cycle@example.com")) == "USER_SUSPENDED"
    assert again.status_code == 400
    assert again.json()["error"]["status"] == "FAILED_PRECONDITION"

    activated = await admin.post(f"/api/v1/{user['name']}:activate", json={})
    active_again = await admin.post(f"/api/v1/{user['name']}:activate", json={})

    assert activated.json()["state"] == "ACTIVE"
    assert (await accounts.sign_in(email="cycle@example.com")).status_code == 200
    assert active_again.status_code == 400
    assert [e.target_name for e in await audit("SuspendUser")] == [user["name"]]
    assert [e.target_name for e in await audit("ActivateUser")] == [user["name"]]


async def test_state_transitions_need_their_permission_and_never_apply_to_self(
    client: ApiClient, world: World, reason: Reason
) -> None:
    target = await world.make_user()
    operator = await client.as_(await world.platform_operator(await world.make_user()))
    admin = await client.as_(await world.platform_admin(await world.make_user()))

    by_operator = await operator.post(f"{USERS}/{target.id}:suspend", json={})
    on_self = await admin.post(f"{USERS}/me:suspend", json={})
    missing = await admin.post(f"{USERS}/{uuid4()}:activate", json={})
    unknown_field = await admin.post(f"{USERS}/{target.id}:suspend", json={"reason": "x"})

    assert by_operator.status_code == 403
    assert on_self.status_code == 400
    assert reason(on_self) == "SELF_MODIFICATION"
    assert missing.status_code == 404
    assert unknown_field.status_code == 400
    assert (await admin.get(f"{USERS}/{target.id}")).json()["state"] == "ACTIVE"


# -- LookupUser ---------------------------------------------------------------------------------


async def test_a_member_adder_looks_up_an_account_by_exact_email(
    client: ApiClient, world: World
) -> None:
    admin = await world.make_user()
    await world.make_workspace(admin)
    target = await world.make_user(email="found@example.com", display_name="Found")
    await world.platform_admin(target)
    reader = await client.as_(admin)

    response = await reader.get(f"{USERS}:lookup", params={"email": "FOUND@example.com"})
    partial = await reader.get(f"{USERS}:lookup", params={"email": "found@example"})
    missing = await reader.get(f"{USERS}:lookup", params={"email": "absent@example.com"})

    assert response.status_code == 200
    assert response.json() == {
        "name": f"users/{target.id}",
        "email": "found@example.com",
        "displayName": "Found",
        "state": "ACTIVE",
    }
    assert partial.status_code == 404
    assert missing.status_code == 404


async def test_lookup_needs_members_create_in_some_workspace(
    client: ApiClient, world: World
) -> None:
    workspace = await world.make_workspace(await world.make_user())
    member = await client.as_(await world.add_member(workspace))
    loner = await client.as_(await world.make_user())
    platform = await client.as_(await world.platform_admin(await world.make_user()))
    await world.make_user(email="someone@example.com")

    for caller in (member, loner, platform):
        response = await caller.get(f"{USERS}:lookup", params={"email": "someone@example.com"})
        assert response.status_code == 403


async def test_lookup_requires_a_well_formed_email(client: ApiClient, world: World) -> None:
    admin = await world.make_user()
    await world.make_workspace(admin)
    reader = await client.as_(admin)

    assert (await reader.get(f"{USERS}:lookup")).status_code == 400
    assert (await reader.get(f"{USERS}:lookup", params={"email": "nope"})).status_code == 400
