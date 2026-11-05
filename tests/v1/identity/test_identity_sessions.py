"""Identity sessions: CreateSession, GetSession, ListSessions, DeleteSession (``auth_contract.md``)."""

from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import uuid4

import pytest

from harness import ApiClient, World

if TYPE_CHECKING:
    from conftest import Accounts, AuditReader, FakeGoogle, Reason

pytestmark = pytest.mark.asyncio

SESSIONS = "/api/v1/sessions"
CURRENT = f"{SESSIONS}/current"


# -- CreateSession ------------------------------------------------------------------------


async def test_password_sign_in_returns_the_session_with_its_token_once(
    client: ApiClient, accounts: Accounts
) -> None:
    user = await accounts.sign_up("ada@example.com")

    response = await accounts.sign_in(email="ADA@example.com")

    assert response.status_code == 200
    session = response.json()
    assert session["name"].startswith("sessions/")
    assert session["user"] == user["name"]
    assert session["authenticationMethod"] == "PASSWORD"
    assert session["state"] == "ACTIVE"
    assert {"expireTime", "createTime", "lastSeenTime", "accessToken"} <= session.keys()
    assert "credential" not in session
    current = await client.with_token(session["accessToken"]).get(CURRENT)
    assert current.status_code == 200
    assert current.json()["name"] == session["name"]
    assert "accessToken" not in current.json()


async def test_password_sign_in_accepts_the_username(accounts: Accounts) -> None:
    await accounts.sign_up(username="analyst")

    response = await accounts.sign_in(username="Analyst")

    assert response.status_code == 200


async def test_wrong_credentials_answer_the_same_whether_or_not_the_account_exists(
    accounts: Accounts, reason: Reason
) -> None:
    await accounts.sign_up("grace@example.com")

    wrong_password = await accounts.sign_in("not the password", email="grace@example.com")
    unknown_account = await accounts.sign_in(email="nobody@example.com")
    unknown_username = await accounts.sign_in(username="nobody")

    for response in (wrong_password, unknown_account, unknown_username):
        assert response.status_code == 401
        assert reason(response) == "INVALID_CREDENTIALS"
    assert wrong_password.json() == unknown_account.json()


async def test_a_suspended_account_cannot_sign_in(
    accounts: Accounts, world: World, reason: Reason
) -> None:
    user = await accounts.sign_up("suspended@example.com")
    admin = await world.platform_admin(await world.make_user())
    admin_client = await accounts.client.as_(admin)
    assert (await admin_client.post(f"/api/v1/{user['name']}:suspend", json={})).status_code == 200

    response = await accounts.sign_in(email="suspended@example.com")

    assert response.status_code == 400
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert reason(response) == "USER_SUSPENDED"


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"credential": {}},
        {"credential": {"password": {"password": "x" * 10}}},
        {"credential": {"password": {"email": "a@b.c", "username": "ab", "password": "x" * 10}}},
        {"credential": {"password": {"email": "a@b.c", "password": "x"}, "google": {"idToken": "t"}}},
        {"credential": {"saml": {"assertion": "x"}}},
    ],
)
async def test_a_malformed_credential_is_invalid_argument(
    client: ApiClient, body: dict[str, object]
) -> None:
    response = await client.post(SESSIONS, json=body)

    assert response.status_code == 400
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"


async def test_sign_in_ignores_any_bearer_token(client: ApiClient, accounts: Accounts) -> None:
    await accounts.sign_up("token@example.com")

    response = await client.with_token("garbage").post(
        SESSIONS,
        json={"credential": {"password": {"email": "token@example.com", "password": accounts.password}}},
    )

    assert response.status_code == 200


async def test_sign_in_audits_the_platform_and_every_active_membership(
    accounts: Accounts, world: World, audit: AuditReader
) -> None:
    member = await accounts.user_row(await accounts.sign_up("member@example.com"))
    first = await world.make_workspace(await world.make_user())
    second = await world.make_workspace(await world.make_user())
    left = await world.make_workspace(await world.make_user())
    await world.make_workspace(await world.make_user())  # not a member here
    for workspace in (first, second, left):
        await world.add_member(workspace, member)
    await world.suspend_member(left, member)

    session = (await accounts.sign_in(email="member@example.com")).json()

    events = [e for e in await audit("CreateSession") if e.target_name == session["name"]]
    assert sorted(map(str, (e.tenant_id for e in events))) == sorted(
        map(str, (None, first.id, second.id))
    )
    assert {e.category for e in events} == {"sign_in"}
    assert {e.actor_user_id for e in events} == {member.id}


async def test_google_sign_in_creates_the_account_once_and_reuses_it(
    client: ApiClient, google: FakeGoogle
) -> None:
    token = google.token_for("new@gmail.com", subject="google-subject", name="New Person")

    first = await client.post(SESSIONS, json={"credential": {"google": {"idToken": token}}})
    again = await client.post(
        SESSIONS,
        json={"credential": {"google": {"idToken": google.token_for("new@gmail.com", subject="google-subject")}}},
    )

    assert first.status_code == 200
    assert first.json()["authenticationMethod"] == "GOOGLE"
    assert again.json()["user"] == first.json()["user"]
    me = await client.with_token(first.json()["accessToken"]).get("/api/v1/users/me")
    assert me.json()["email"] == "new@gmail.com"
    assert me.json()["displayName"] == "New Person"


async def test_google_sign_in_links_an_existing_account_by_verified_email(
    client: ApiClient, accounts: Accounts, google: FakeGoogle
) -> None:
    user = await accounts.sign_up("linked@example.com")

    response = await client.post(
        SESSIONS, json={"credential": {"google": {"idToken": google.token_for("linked@example.com")}}}
    )

    assert response.status_code == 200
    assert response.json()["user"] == user["name"]


async def test_google_sign_in_of_a_suspended_account_links_nothing(
    client: ApiClient, accounts: Accounts, world: World, google: FakeGoogle, reason: Reason
) -> None:
    user = await accounts.sign_up("paused@example.com")
    await world.suspend_user(await accounts.user_row(user))
    token = google.token_for("paused@example.com", subject="paused-subject")

    refused = await client.post(SESSIONS, json={"credential": {"google": {"idToken": token}}})
    admin = await client.as_(await world.platform_admin(await world.make_user()))
    await admin.post(f"/api/v1/{user['name']}:activate", json={})
    after = await client.post(SESSIONS, json={"credential": {"google": {"idToken": token}}})

    assert refused.status_code == 400
    assert reason(refused) == "USER_SUSPENDED"
    assert after.status_code == 200
    assert after.json()["user"] == user["name"]


async def test_an_unverifiable_google_token_is_invalid_credentials(
    client: ApiClient, google: FakeGoogle, reason: Reason
) -> None:
    response = await client.post(SESSIONS, json={"credential": {"google": {"idToken": "forged"}}})

    assert response.status_code == 401
    assert reason(response) == "INVALID_CREDENTIALS"


# -- GetSession ----------------------------------------------------------------------------


async def test_current_names_the_presented_session_canonically(
    client: ApiClient, world: World
) -> None:
    alice = await client.as_(await world.make_user())

    response = await alice.get(CURRENT)

    assert response.status_code == 200
    assert response.json()["name"] == f"sessions/{alice.session_id}"
    assert response.json()["user"] == f"users/{alice.user_id}"


async def test_get_session_reads_own_sessions_and_denies_others(
    client: ApiClient, world: World
) -> None:
    user = await world.make_user()
    laptop, phone = await client.as_(user), await client.as_(user)
    mallory = await client.as_(await world.make_user())

    own = await laptop.get(f"{SESSIONS}/{phone.session_id}")
    foreign = await mallory.get(f"{SESSIONS}/{phone.session_id}")
    missing = await laptop.get(f"{SESSIONS}/{uuid4()}")
    malformed = await laptop.get(f"{SESSIONS}/not-a-uuid")

    assert own.status_code == 200
    assert own.json()["name"] == f"sessions/{phone.session_id}"
    assert foreign.status_code == 403
    assert missing.status_code == 404
    assert malformed.status_code == 400


async def test_session_methods_need_a_bearer_token(client: ApiClient) -> None:
    assert (await client.get(CURRENT)).status_code == 401
    assert (await client.get(SESSIONS)).status_code == 401
    assert (await client.delete(CURRENT)).status_code == 401


# -- ListSessions ---------------------------------------------------------------------------


async def test_list_sessions_returns_only_own_sessions_without_tokens(
    client: ApiClient, world: World
) -> None:
    user = await world.make_user()
    first, second = await client.as_(user), await client.as_(user)
    await client.as_(await world.make_user())

    response = await first.get(SESSIONS)

    assert response.status_code == 200
    sessions = response.json()["sessions"]
    assert {s["name"] for s in sessions} == {
        f"sessions/{first.session_id}",
        f"sessions/{second.session_id}",
    }
    assert all("accessToken" not in s for s in sessions)


async def test_list_sessions_filters_orders_and_pages(
    client: ApiClient, accounts: Accounts, google: FakeGoogle
) -> None:
    await accounts.sign_up("lister@example.com")
    clients = [await accounts.signed_in(email="lister@example.com") for _ in range(3)]
    await client.post(
        SESSIONS,
        json={"credential": {"google": {"idToken": google.token_for("lister@example.com")}}},
    )
    reader = clients[0]
    await clients[1].delete(CURRENT)

    ended = await reader.get(SESSIONS, params={"filter": 'state = "ENDED"'})
    google_only = await reader.get(SESSIONS, params={"filter": "authenticationMethod = GOOGLE"})
    oldest_first = await reader.get(SESSIONS, params={"orderBy": "createTime"})
    first_page = await reader.get(SESSIONS, params={"pageSize": 3})
    second_page = await reader.get(
        SESSIONS, params={"pageSize": 3, "pageToken": first_page.json()["nextPageToken"]}
    )

    assert [s["name"] for s in ended.json()["sessions"]] == [f"sessions/{clients[1].session_id}"]
    assert [s["authenticationMethod"] for s in google_only.json()["sessions"]] == ["GOOGLE"]
    assert oldest_first.json()["sessions"][0]["name"] == f"sessions/{clients[0].session_id}"
    assert len(first_page.json()["sessions"]) == 3
    assert len(second_page.json()["sessions"]) == 1
    assert "nextPageToken" not in second_page.json()


@pytest.mark.parametrize(
    "params", [{"filter": "user = x"}, {"filter": "state = GONE"}, {"orderBy": "expireTime"}]
)
async def test_list_sessions_rejects_unknown_filters_and_orders(
    client: ApiClient, world: World, params: dict[str, str]
) -> None:
    alice = await client.as_(await world.make_user())

    assert (await alice.get(SESSIONS, params=params)).status_code == 400


# -- DeleteSession --------------------------------------------------------------------------


async def test_signing_out_ends_the_session_and_revokes_its_token(
    client: ApiClient, world: World, audit: AuditReader
) -> None:
    user = await world.make_user()
    laptop, phone = await client.as_(user), await client.as_(user)

    response = await laptop.delete(CURRENT)

    assert response.status_code == 200
    assert response.json()["state"] == "ENDED"
    assert response.json()["name"] == f"sessions/{laptop.session_id}"
    assert (await laptop.get(CURRENT)).status_code == 401
    still_readable = await phone.get(f"{SESSIONS}/{laptop.session_id}")
    assert still_readable.json()["state"] == "ENDED"
    assert [e.target_name for e in await audit("DeleteSession")] == [
        f"sessions/{laptop.session_id}"
    ]


async def test_ending_another_own_session_and_ending_twice(
    client: ApiClient, world: World
) -> None:
    user = await world.make_user()
    laptop, phone = await client.as_(user), await client.as_(user)

    ended = await laptop.delete(f"{SESSIONS}/{phone.session_id}")
    twice = await laptop.delete(f"{SESSIONS}/{phone.session_id}")

    assert ended.status_code == 200
    assert (await phone.get(CURRENT)).status_code == 401
    assert twice.status_code == 400
    assert twice.json()["error"]["status"] == "FAILED_PRECONDITION"


async def test_another_users_session_cannot_be_ended(client: ApiClient, world: World) -> None:
    victim = await client.as_(await world.make_user())
    mallory = await client.as_(await world.make_user())

    response = await mallory.delete(f"{SESSIONS}/{victim.session_id}")

    assert response.status_code == 403
    assert (await victim.get(CURRENT)).status_code == 200
