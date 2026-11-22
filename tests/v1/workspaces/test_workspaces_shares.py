"""Shares (``workspaces/{w}/shares``, ``shares:resolve``, ``shares:accept``).

``database_architecture.md`` "Resource shares": a SHARE of knowledge grants
nothing; an INVITE grants its role once per person, bounded by expiry, max
uses and revocation, and only while its creator could still grant it.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from bomesh.db.models import (
    Item,
    ResourceShare,
    RoleAssignment,
    Tenant,
    TenantMembership,
    User,
)
from bomesh.services.knowledge_items.item_store import personal_collection_id
from harness import ApiClient, Sessions, World
from sqlalchemy import select, update
from workspaces_support import audit_actions, reason, ws_path

pytestmark = pytest.mark.asyncio

RESOLVE = "/api/v1/shares:resolve"
ACCEPT = "/api/v1/shares:accept"


def _item(item: Item) -> str:
    return f"workspaces/{item.tenant_id}/items/{item.id}"


def _token(share: dict[str, Any]) -> str:
    return share["uri"].rsplit("/", 1)[-1]


async def _create(api: ApiClient, workspace: Tenant, **body: Any) -> dict[str, Any]:
    response = await api.post(f"{ws_path(workspace)}/shares", json=body)
    assert response.status_code == 200, response.text
    return response.json()


async def _row(sessions: Sessions, share: dict[str, Any]) -> ResourceShare:
    async with sessions() as session:
        row = await session.get(ResourceShare, share["name"].rsplit("/", 1)[-1])
        assert row is not None
        return row


async def _invite(world: World, client: ApiClient, **body: Any) -> tuple[Tenant, User, dict]:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin, name="Acme")
    share = await _create(
        await client.as_(admin),
        workspace,
        kind="INVITE",
        target=f"workspaces/{workspace.id}",
        role="roles/workspaceMember",
        **body,
    )
    return workspace, admin, share


# -- SHARE grants nothing -------------------------------------------------------------------


async def test_share_grants_nothing(client: ApiClient, world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    reader, outsider_member = await world.add_member(workspace), await world.add_member(workspace)
    restricted = await world.make_collection(workspace, item_name="Payroll", grants={reader: "roles/collectionViewer"})
    document = await world.make_document(restricted, item_name="Salaries 2026")
    share = await _create(await client.as_(admin), workspace, kind="SHARE", target=_item(document))
    assert share["uri"] == f"/s/{share['name'].rsplit('/', 1)[-1]}"
    assert share["audience"] == "WORKSPACE" and share["state"] == "ACTIVE"

    member = await client.as_(outsider_member)
    resolved = await member.post(RESOLVE, json={"token": _token(share)})
    assert resolved.status_code == 200, resolved.text
    body = resolved.json()
    assert (body["canOpen"], body["canAccept"], body["reason"]) == (False, False, "NO_ACCESS")
    assert "targetDisplayName" not in body
    # Opening the share changed nothing: the document is still unreadable.
    assert (await member.get(f"/api/v1/{_item(document)}")).status_code in (403, 404)

    opened = (await (await client.as_(reader)).post(RESOLVE, json={"token": _token(share)})).json()
    assert opened["canOpen"] is True and opened["targetDisplayName"] == "Salaries 2026"
    assert "reason" not in opened


async def test_people_share_resolves_only_for_recipients(client: ApiClient, world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    recipient, other = await world.add_member(workspace), await world.add_member(workspace)
    shelf = await world.make_collection(workspace, grants={"workspaceMembers": "roles/collectionViewer"})
    document = await world.make_document(shelf)
    share = await _create(
        await client.as_(admin),
        workspace,
        kind="SHARE",
        target=_item(document),
        audience="PEOPLE",
        recipients=[f"workspaces/{workspace.id}/members/{recipient.id}"],
    )
    for user, can_open, why in ((recipient, True, None), (other, False, "NOT_IN_AUDIENCE")):
        body = (await (await client.as_(user)).post(RESOLVE, json={"token": _token(share)})).json()
        assert (body["canOpen"], body.get("reason")) == (can_open, why)


async def test_share_of_an_unreadable_target_is_refused(client: ApiClient, world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    hidden = await world.make_document(await world.make_collection(workspace))
    response = await (await client.as_(member)).post(
        f"{ws_path(workspace)}/shares", json={"kind": "SHARE", "target": _item(hidden)}
    )
    assert response.status_code == 403, response.text


# -- INVITE ---------------------------------------------------------------------------------


async def test_invite_accept_creates_membership_and_role_once(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    workspace, admin, share = await _invite(world, client, maxUses=5)
    newcomer = await world.make_user()
    api = await client.as_(newcomer)

    resolved = (await api.post(RESOLVE, json={"token": _token(share)})).json()
    assert resolved["canAccept"] is True and resolved["canOpen"] is False
    assert resolved["targetDisplayName"] == "Acme" and resolved["role"] == "roles/workspaceMember"

    accepted = await api.post(ACCEPT, json={"token": _token(share)})
    assert accepted.status_code == 200, accepted.text
    body = accepted.json()
    assert body["canOpen"] is True and body["canAccept"] is False
    assert body["reason"] == "ALREADY_MEMBER"
    again = await api.post(ACCEPT, json={"token": _token(share)})
    assert again.status_code == 200, again.text

    async with sessions() as session:
        membership = await session.get(
            TenantMembership, {"user_id": newcomer.id, "tenant_id": workspace.id}
        )
        assert membership is not None and membership.status == "active"
        grants = list(
            await session.scalars(
                select(RoleAssignment).where(
                    RoleAssignment.user_id == newcomer.id,
                    RoleAssignment.tenant_id == workspace.id,
                    RoleAssignment.deleted_at.is_(None),
                )
            )
        )
        assert len(grants) == 1 and grants[0].created_by_user_id == admin.id
        assert await session.get(Item, personal_collection_id(workspace.id, newcomer.id))
    row = await _row(sessions, share)
    assert row.use_count == 1 and row.last_used_at is not None
    assert (await api.get(ws_path(workspace))).status_code == 200
    assert (await audit_actions(sessions, workspace)).count("AcceptShare") == 2


async def test_invite_max_uses_expiry_and_revocation(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    _, _, share = await _invite(world, client, maxUses=1)
    first, second = await world.make_user(), await world.make_user()
    assert (await (await client.as_(first)).post(ACCEPT, json={"token": _token(share)})).status_code == 200
    exhausted = await (await client.as_(second)).post(ACCEPT, json={"token": _token(share)})
    assert exhausted.status_code == 400 and reason(exhausted) == "EXHAUSTED"
    resolved = (await (await client.as_(second)).post(RESOLVE, json={"token": _token(share)})).json()
    assert (resolved["canAccept"], resolved["reason"]) == (False, "EXHAUSTED")

    _, _, expiring = await _invite(world, client)
    async with sessions.begin() as session:
        await session.execute(
            update(ResourceShare)
            .where(ResourceShare.id == expiring["name"].rsplit("/", 1)[-1])
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
    expired = await (await client.as_(second)).post(ACCEPT, json={"token": _token(expiring)})
    assert expired.status_code == 400 and reason(expired) == "EXPIRED"

    workspace3, admin3, revoked = await _invite(world, client)
    deleted = await (await client.as_(admin3)).delete(f"/api/v1/{revoked['name']}")
    assert deleted.status_code == 200 and deleted.json()["state"] == "REVOKED"
    refused = await (await client.as_(second)).post(ACCEPT, json={"token": _token(revoked)})
    assert refused.status_code == 400 and reason(refused) == "REVOKED"
    async with sessions() as session:
        assert await session.get(
            TenantMembership, {"user_id": second.id, "tenant_id": workspace3.id}
        ) is None


async def test_invite_creation_is_an_iam_change(client: ApiClient, world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    target = f"workspaces/{workspace.id}"
    plain = await (await client.as_(member)).post(
        f"{ws_path(workspace)}/shares",
        json={"kind": "INVITE", "target": target, "role": "roles/workspaceMember"},
    )
    assert plain.status_code == 403, plain.text

    iam = await world.make_role(
        workspace, "iam", ["workspaces.get", "workspaces.setIamPolicy", "shares.create"]
    )
    manager = await world.add_member(workspace, role=iam)
    escalation = await (await client.as_(manager)).post(
        f"{ws_path(workspace)}/shares",
        json={"kind": "INVITE", "target": target, "role": "roles/workspaceAdmin"},
    )
    assert escalation.status_code == 403 and reason(escalation) == "ROLE_ESCALATION"

    personal = await world.make_collection(workspace, personal_for=admin)
    refused = await (await client.as_(admin)).post(
        f"{ws_path(workspace)}/shares",
        json={"kind": "INVITE", "target": _item(personal), "role": "roles/collectionViewer"},
    )
    assert refused.status_code == 400 and reason(refused) == "PERSONAL_COLLECTION"


async def test_collection_invite_needs_workspace_membership(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    owner, member = await world.add_member(workspace), await world.add_member(workspace)
    collection = await world.make_collection(workspace, item_name="Handbook", grants={owner: "roles/collectionOwner"})
    share = await _create(
        await client.as_(owner),
        workspace,
        kind="INVITE",
        target=_item(collection),
        role="roles/collectionViewer",
    )
    outsider = await client.as_(await world.make_user())
    resolved = (await outsider.post(RESOLVE, json={"token": _token(share)})).json()
    assert (resolved["canAccept"], resolved["reason"]) == (False, "NOT_WORKSPACE_MEMBER")
    assert resolved["targetDisplayName"] == "Handbook"
    refused = await outsider.post(ACCEPT, json={"token": _token(share)})
    assert refused.status_code == 400 and reason(refused) == "NOT_WORKSPACE_MEMBER"

    api = await client.as_(member)
    assert (await api.get(f"/api/v1/{_item(collection)}")).status_code in (403, 404)
    accepted = (await api.post(ACCEPT, json={"token": _token(share)})).json()
    assert accepted["canOpen"] is True
    assert (await api.get(f"/api/v1/{_item(collection)}")).status_code == 200
    assert (await _row(sessions, share)).use_count == 1


async def test_invite_stops_when_its_creator_loses_the_right(
    client: ApiClient, world: World
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    owner, member = await world.add_member(workspace), await world.add_member(workspace)
    collection = await world.make_collection(workspace, grants={owner: "roles/collectionOwner"})
    share = await _create(
        await client.as_(owner), workspace, kind="INVITE", target=_item(collection), role="roles/collectionViewer"
    )
    await world.revoke(owner, on=collection)
    api = await client.as_(member)
    resolved = (await api.post(RESOLVE, json={"token": _token(share)})).json()
    assert (resolved["canAccept"], resolved["reason"]) == (False, "SHARE_CREATOR_NOT_ALLOWED")
    refused = await api.post(ACCEPT, json={"token": _token(share)})
    assert refused.status_code == 400 and reason(refused) == "SHARE_CREATOR_NOT_ALLOWED"


async def test_invite_token_is_never_stored_or_returned_again(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    workspace, admin, share = await _invite(world, client)
    token = _token(share)
    assert len(token) >= 43 and share["uri"] == f"/s/{token}"
    row = await _row(sessions, share)
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert token not in repr({column.key: getattr(row, column.key) for column in ResourceShare.__table__.c})
    api = await client.as_(admin)
    assert "uri" not in (await api.get(f"/api/v1/{share['name']}")).json()
    listed = (await api.get(f"{ws_path(workspace)}/shares")).json()["shares"]
    assert [entry["name"] for entry in listed] == [share["name"]] and "uri" not in listed[0]
    # The share ID does not open an invite; only the secret does.
    unknown = await api.post(RESOLVE, json={"token": share["name"].rsplit("/", 1)[-1]})
    assert unknown.status_code == 404


async def test_shares_are_visible_to_creator_and_target_managers(
    client: ApiClient, world: World
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    creator, other = await world.add_member(workspace), await world.add_member(workspace)
    shelf = await world.make_collection(workspace, grants={"workspaceMembers": "roles/collectionViewer"})
    share = await _create(await client.as_(creator), workspace, kind="SHARE", target=_item(shelf))
    other_api = await client.as_(other)
    assert (await other_api.get(f"/api/v1/{share['name']}")).status_code == 404
    assert (await other_api.get(f"{ws_path(workspace)}/shares")).json().get("shares", []) == []
    assert (await other_api.delete(f"/api/v1/{share['name']}")).status_code == 404
    admin_api = await client.as_(admin)
    listed = await admin_api.get(
        f"{ws_path(workspace)}/shares", params={"filter": f'target = "{_item(shelf)}" AND kind = SHARE'}
    )
    assert [entry["name"] for entry in listed.json()["shares"]] == [share["name"]]
    revoked = await admin_api.get(f"{ws_path(workspace)}/shares", params={"filter": "state = REVOKED"})
    assert revoked.json().get("shares", []) == []


async def test_role_lookup_rejects_a_role_of_another_scope(client: ApiClient, world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    response = await (await client.as_(admin)).post(
        f"{ws_path(workspace)}/shares",
        json={"kind": "INVITE", "target": f"workspaces/{workspace.id}", "role": "roles/collectionViewer"},
    )
    assert response.status_code == 400, response.text
