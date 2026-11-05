"""Who may do what: effective permissions and the AIP-211 check (``item_model.md`` §6.2).

Every test asks a product question — "can this person do this to that?" —
against PostgreSQL through the request-scoped ``Authorizer``. A fresh
Authorizer stands for the next request, so revocations are checked with one.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError

from bomesh.db.models import RolePermission
from bomesh.errors import InvalidArgument, NotFound, PermissionDenied
from bomesh.iam.authorizer import ItemRef, PlatformRef, SpaceRef, WorkspaceRef
from harness import WORKSPACE_MEMBERS, World, principal

pytestmark = pytest.mark.asyncio

READ = "items.get"
EDIT = "items.update"
DELETE = "items.delete"
SHARE = "items.setIamPolicy"
RESTORE = "items.undelete"


def _denied_message(permission: str, name: str) -> str:
    return f"Permission '{permission}' denied on resource '{name}' (or it might not exist)"


async def test_a_grant_reaches_nested_collections_and_their_documents(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    editor = await world.add_member(workspace)
    handbook = await world.make_collection(workspace, grants={editor: "roles/collectionEditor"})
    policies = await world.make_collection(workspace, handbook)
    leave = await world.make_document(policies)
    attachment = await world.make_document(leave)

    authorizer = world.authorizer()
    you = principal(editor)
    for item in (handbook, policies, leave, attachment):
        held = await authorizer.collection_permissions(you, item.id)
        assert {READ, EDIT} <= held
        assert DELETE not in held
    assert await authorizer.governing_collection(leave.id) == policies.id
    assert await authorizer.governing_collection(attachment.id) == policies.id
    assert await authorizer.allowed_collections(you, workspace.id, READ) == {
        handbook.id,
        policies.id,
    }
    await authorizer.require(you, EDIT, ItemRef(workspace.id, attachment.id))


async def test_collection_roles_separate_reading_editing_and_owning(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    viewer, editor, owner = [await world.add_member(workspace) for _ in range(3)]
    collection = await world.make_collection(
        workspace,
        grants={
            viewer: "roles/collectionViewer",
            editor: "roles/collectionEditor",
            owner: "roles/collectionOwner",
        },
    )
    ref = ItemRef(workspace.id, collection.id)
    every = (READ, EDIT, DELETE, SHARE)
    authorizer = world.authorizer()

    assert await authorizer.test_permissions(principal(viewer), ref, every) == {READ}
    assert await authorizer.test_permissions(principal(editor), ref, every) == {READ, EDIT}
    assert await authorizer.test_permissions(principal(owner), ref, every) == set(every)
    # Visible but not permitted: still the AIP-211 answer, never a confirmation.
    with pytest.raises(PermissionDenied) as denied:
        await authorizer.require(principal(viewer), EDIT, ref)
    assert denied.value.message == _denied_message(EDIT, ref.name)
    assert denied.value.metadata == {"permission": EDIT, "resource": ref.name}


async def test_a_collection_that_stops_inheriting_is_its_own_boundary(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    reader, legal = await world.add_member(workspace), await world.add_member(workspace)
    handbook = await world.make_collection(workspace, grants={reader: "roles/collectionOwner"})
    sealed = await world.make_collection(
        workspace, handbook, inherit_access=False, grants={legal: "roles/collectionViewer"}
    )
    settlement = await world.make_document(sealed)
    inside = await world.make_collection(workspace, sealed)

    authorizer = world.authorizer()
    # Owning the parent does not reach past a collection that ended inheritance.
    for hidden in (sealed, settlement, inside):
        assert READ not in await authorizer.collection_permissions(principal(reader), hidden.id)
    assert await authorizer.allowed_collections(principal(reader), workspace.id, READ) == {
        handbook.id
    }
    # The grant on the boundary itself governs everything inside it.
    assert READ in await authorizer.collection_permissions(principal(legal), settlement.id)
    assert await authorizer.allowed_collections(principal(legal), workspace.id, READ) == {
        sealed.id,
        inside.id,
    }


async def test_a_workspace_members_grant_reaches_every_active_member(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    suspended = await world.add_member(workspace)
    outsider = await world.make_user()
    announcements = await world.make_collection(
        workspace, grants={WORKSPACE_MEMBERS: "roles/collectionViewer"}
    )
    news = await world.make_document(announcements)
    await world.suspend_member(workspace, suspended)

    authorizer = world.authorizer()
    held = await authorizer.collection_permissions(principal(member), news.id)
    assert READ in held and EDIT not in held
    assert await authorizer.allowed_collections(principal(member), workspace.id, READ) == {
        announcements.id
    }
    for nobody in (suspended, outsider):
        assert await authorizer.collection_permissions(principal(nobody), news.id) == frozenset()
        assert await authorizer.allowed_collections(
            principal(nobody), workspace.id, READ
        ) == frozenset()


async def test_a_workspace_admin_reaches_every_collection_of_the_workspace(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    private = await world.make_collection(workspace, grants={member: "roles/collectionOwner"})
    sealed = await world.make_collection(workspace, private, inherit_access=False)
    personal = await world.make_collection(workspace, personal_for=member)
    draft = await world.make_document(sealed, published=False)

    authorizer = world.authorizer()
    assert await authorizer.allowed_collections(principal(admin), workspace.id, SHARE) == {
        private.id,
        sealed.id,
        personal.id,
    }
    assert {READ, EDIT, DELETE, SHARE, RESTORE} <= await authorizer.collection_permissions(
        principal(admin), draft.id
    )


async def test_a_group_grant_reaches_its_members_and_stops_when_they_leave(
    world: World,
) -> None:
    """A group is a principal, not a second kind of permission."""
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    analyst, outsider = await world.add_member(workspace), await world.add_member(workspace)
    analysts = await world.make_group(workspace, [analyst])
    revenue = await world.make_collection(workspace, grants={analysts: "roles/collectionEditor"})
    ref = ItemRef(workspace.id, revenue.id)

    authorizer = world.authorizer()
    assert await authorizer.group_ids(principal(analyst), workspace.id) == {analysts.id}
    await authorizer.require(principal(analyst), EDIT, ref)
    with pytest.raises(PermissionDenied):
        await authorizer.require(principal(outsider), READ, ref)

    await world.leave_group(analysts, analyst)
    next_request = world.authorizer()
    assert await next_request.group_ids(principal(analyst), workspace.id) == frozenset()
    with pytest.raises(PermissionDenied):
        await next_request.require(principal(analyst), READ, ref)


async def test_a_group_workspace_role_reaches_its_members(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    curator = await world.add_member(workspace, role=None)
    curators = await world.make_group(workspace, [curator])
    await world.grant(curators, "roles/workspaceAdmin", on=workspace)
    collection = await world.make_collection(workspace)

    authorizer = world.authorizer()
    assert "members.suspend" in await authorizer.workspace_permissions(
        principal(curator), workspace.id
    )
    assert SHARE in await authorizer.collection_permissions(principal(curator), collection.id)


async def test_revoking_a_grant_removes_access_at_the_next_request(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    reader = await world.add_member(workspace)
    handbook = await world.make_collection(workspace, grants={reader: "roles/collectionViewer"})
    ref = ItemRef(workspace.id, handbook.id)
    await world.authorizer().require(principal(reader), READ, ref)

    assert await world.revoke(reader, on=handbook) == 1

    next_request = world.authorizer()
    with pytest.raises(PermissionDenied):
        await next_request.require(principal(reader), READ, ref)
    assert await next_request.allowed_collections(
        principal(reader), workspace.id, READ
    ) == frozenset()


async def test_revoking_a_permission_from_a_role_removes_it_from_its_holders(
    world: World,
) -> None:
    """A tombstoned role permission must stop granting, not linger in a join."""
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    curator_role = await world.make_role(workspace, "curator", ["members.list", "topics.create"])
    curator = await world.add_member(workspace, role=curator_role)
    you = principal(curator)
    assert {"members.list", "topics.create"} <= await world.authorizer().workspace_permissions(
        you, workspace.id
    )

    await world.set_role_permissions(curator_role, ["members.list"])

    held = await world.authorizer().workspace_permissions(you, workspace.id)
    assert "members.list" in held and "topics.create" not in held
    async with world.sessions() as session:
        revoked = await session.scalar(
            select(RolePermission).where(
                RolePermission.role_id == curator_role.id,
                RolePermission.permission_code == "topics.create",
            )
        )
    assert revoked is not None and revoked.deleted_at is not None


async def test_a_workspace_role_grants_in_that_workspace_and_no_other(world: World) -> None:
    acme_admin, labs_admin = await world.make_user(), await world.make_user()
    acme = await world.make_workspace(acme_admin)
    labs = await world.make_workspace(labs_admin)
    acme_handbook = await world.make_collection(acme)
    labs_handbook = await world.make_collection(
        labs, grants={WORKSPACE_MEMBERS: "roles/collectionViewer"}
    )
    labs_doc = await world.make_document(labs_handbook)

    authorizer = world.authorizer()
    you = principal(acme_admin)
    assert await authorizer.allowed_collections(you, acme.id, READ) == {acme_handbook.id}
    assert await authorizer.allowed_collections(you, labs.id, READ) == frozenset()
    assert await authorizer.workspace_permissions(you, labs.id) == frozenset()
    assert await authorizer.collection_permissions(you, labs_doc.id) == frozenset()
    with pytest.raises(PermissionDenied):
        await authorizer.require(you, READ, ItemRef(labs.id, labs_doc.id))
    # Naming a foreign item under one's own workspace finds nothing there.
    assert await authorizer.permissions(you, ItemRef(acme.id, labs_doc.id)) == frozenset()
    with pytest.raises(NotFound):
        await authorizer.require(you, READ, ItemRef(acme.id, labs_doc.id))


async def test_an_item_named_under_another_workspace_is_denied(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    other = await world.make_workspace(await world.make_user())
    collection = await world.make_collection(workspace)
    wrong = ItemRef(other.id, collection.id)

    with pytest.raises(PermissionDenied) as denied:
        await world.authorizer().require(principal(admin), READ, wrong)
    assert denied.value.message == _denied_message(READ, wrong.name)


async def test_grants_and_groups_never_reach_across_workspaces(world: World) -> None:
    """Tenant isolation of grants is enforced by PostgreSQL, not only by the Authorizer."""
    acme = await world.make_workspace(await world.make_user())
    labs = await world.make_workspace(await world.make_user())
    labs_member = await world.add_member(labs)
    acme_handbook = await world.make_collection(acme)
    labs_role = await world.make_role(labs, "labsOnly", ["items.get"])

    with pytest.raises(DBAPIError, match="active member of the scope tenant"):
        await world.grant(labs_member, "roles/collectionOwner", on=acme_handbook)
    with pytest.raises(DBAPIError, match="must belong to the group tenant"):
        await world.make_group(acme, [labs_member])
    with pytest.raises(InvalidArgument):
        await world.grant(labs_member, labs_role, on=acme)
    assert await world.authorizer().collection_permissions(
        principal(labs_member), acme_handbook.id
    ) == frozenset()


async def test_aip_211_denied_and_absent_answer_alike_below_the_parent_permission(
    world: World,
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    hidden = await world.make_collection(workspace)
    missing = ItemRef(workspace.id, uuid4())
    existing = ItemRef(workspace.id, hidden.id)
    authorizer = world.authorizer()

    # workspaceMember does not hold items.get at workspace scope: 403 either way.
    for ref in (missing, existing):
        with pytest.raises(PermissionDenied) as denied:
            await authorizer.require(principal(member), READ, ref)
        assert denied.value.message == _denied_message(READ, ref.name)
        assert denied.value.reason is None

    # The admin holds items.get on the workspace: a missing item is NOT_FOUND.
    with pytest.raises(NotFound) as absent:
        await authorizer.require(principal(admin), READ, missing)
    assert absent.value.message == f"Resource '{missing.name}' was not found."
    await authorizer.require(principal(admin), READ, existing)


async def test_non_members_and_suspended_members_are_denied_never_told(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    suspended_admin = await world.add_member(workspace, role="roles/workspaceAdmin")
    outsider = await world.make_user()
    collection = await world.make_collection(workspace)
    await world.suspend_member(workspace, suspended_admin)
    authorizer = world.authorizer()

    for user in (outsider, suspended_admin):
        assert await authorizer.is_active_member(principal(user), workspace.id) is False
        assert await authorizer.workspace_permissions(principal(user), workspace.id) == frozenset()
        for ref in (ItemRef(workspace.id, uuid4()), ItemRef(workspace.id, collection.id)):
            with pytest.raises(PermissionDenied):
                await authorizer.require(principal(user), READ, ref)
        with pytest.raises(PermissionDenied):
            await authorizer.require(principal(user), "workspaces.get", WorkspaceRef(workspace.id))


async def test_platform_roles_reach_platform_resources_and_workspaces_never_content(
    world: World,
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    collection = await world.make_collection(
        workspace, grants={WORKSPACE_MEMBERS: "roles/collectionViewer"}
    )
    document = await world.make_document(collection)
    platform_admin = await world.platform_admin(await world.make_user())
    operator = await world.platform_operator(await world.make_user())
    # Also a plain member: membership, not the platform role, is what reads.
    member_admin = await world.platform_admin(await world.add_member(workspace))
    authorizer = world.authorizer()

    assert {"users.list", "users.suspend"} <= await authorizer.permissions(
        principal(platform_admin), PlatformRef("users")
    )
    operator_held = await authorizer.permissions(principal(operator), PlatformRef("users"))
    assert "users.list" in operator_held and "users.suspend" not in operator_held

    workspace_ref = WorkspaceRef(workspace.id)
    await authorizer.require(principal(platform_admin), "workspaces.get", workspace_ref)
    await authorizer.require(principal(operator), "workspaces.pauseIngestion", workspace_ref)
    with pytest.raises(PermissionDenied):
        await authorizer.require(principal(operator), "workspaces.suspend", workspace_ref)
    # Held at the platform (the parent of a workspace): a missing one is NOT_FOUND.
    with pytest.raises(NotFound):
        await authorizer.require(principal(platform_admin), "workspaces.get", WorkspaceRef(uuid4()))

    for user in (platform_admin, operator):
        assert await authorizer.permissions(
            principal(user), ItemRef(workspace.id, document.id)
        ) == frozenset()
        with pytest.raises(PermissionDenied):
            await authorizer.require(principal(user), READ, ItemRef(workspace.id, document.id))
        assert await authorizer.allowed_collections(
            principal(user), workspace.id, READ
        ) == frozenset()
    # The member reads through the workspaceMembers grant; the platform role adds nothing.
    member_held = await authorizer.collection_permissions(principal(member_admin), document.id)
    assert READ in member_held and "requests.approve" not in member_held


async def test_space_permissions_come_from_the_workspace_and_the_space(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    lead, member = await world.add_member(workspace), await world.add_member(workspace)
    space = await world.make_space(workspace, lead)
    other = await world.make_workspace(await world.make_user())
    ref = SpaceRef(workspace.id, space.id)
    authorizer = world.authorizer()

    assert {"spaces.get", "spaces.update"} <= await authorizer.permissions(principal(lead), ref)
    member_held = await authorizer.permissions(principal(member), ref)
    assert "spaces.get" in member_held and "spaces.update" not in member_held
    assert await authorizer.permissions(principal(lead), SpaceRef(other.id, space.id)) == (
        frozenset()
    )
    with pytest.raises(PermissionDenied):
        await authorizer.require(principal(member), "spaces.update", ref)
    with pytest.raises(NotFound):
        await authorizer.require(principal(admin), "spaces.update", SpaceRef(workspace.id, uuid4()))


async def test_test_permissions_answers_the_held_subset(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    viewer = await world.add_member(workspace)
    collection = await world.make_collection(workspace, grants={viewer: "roles/collectionViewer"})
    document = await world.make_document(collection)

    held = await world.authorizer().test_permissions(
        principal(viewer),
        ItemRef(workspace.id, document.id),
        [READ, EDIT, "items.list", "members.list"],
    )
    assert held == {READ, "items.list"}


async def test_an_unknown_permission_is_a_programming_error(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    with pytest.raises(ValueError, match="unknown permission"):
        await world.authorizer().require(principal(admin), "items.read", WorkspaceRef(workspace.id))



async def test_member_workspaces_lists_only_active_memberships(world: World) -> None:
    user = await world.make_user()
    own = await world.make_workspace(user)
    joined = await world.make_workspace(await world.make_user())
    await world.add_member(joined, user, role=None)
    suspended = await world.make_workspace(user)
    await world.suspend_member(suspended, user)

    workspaces = await world.authorizer().member_workspaces(principal(user))

    assert workspaces == frozenset({own.id, joined.id})
