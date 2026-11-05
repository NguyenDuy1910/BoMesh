"""IAM policies on workspaces, collections and spaces (``api_design.md`` §1).

``PolicyStore`` runs inside the caller's transaction; the ``Authorizer`` it
consults reads committed state, so every precondition is built through the
``World`` factories first.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import select

from bomesh.db.models import Group, Role, RoleAssignment, User
from bomesh.errors import (
    Aborted,
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
)
from bomesh.iam.authorizer import ItemRef, SpaceRef, WorkspaceRef
from bomesh.iam.policy import (
    Binding,
    Policy,
    PolicyResource,
    PolicyStore,
    platform_role,
    platform_role_column,
    role_name,
    space_leads,
    workspace_admins,
)
from harness import WORKSPACE_MEMBERS, World, member_name, principal

pytestmark = pytest.mark.asyncio

ADMIN = "roles/workspaceAdmin"
MEMBER = "roles/workspaceMember"
OWNER = "roles/collectionOwner"
EDITOR = "roles/collectionEditor"
VIEWER = "roles/collectionViewer"
LEAD = "roles/spaceLead"
SPACE_MEMBER = "roles/spaceMember"


@asynccontextmanager
async def _store(world: World) -> AsyncIterator[PolicyStore]:
    async with world.sessions.begin() as session:
        yield PolicyStore(session, world.authorizer())


async def _get(world: World, resource: PolicyResource) -> Policy:
    async with _store(world) as store:
        return await store.get_policy(resource)


async def _set(
    world: World,
    actor: User,
    resource: PolicyResource,
    bindings: Sequence[Binding],
    *,
    etag: str | None = None,
) -> Policy:
    async with _store(world) as store:
        return await store.set_policy(principal(actor), resource, bindings, etag=etag)


def _with(policy: Policy, role: str, member: str) -> list[Binding]:
    members = {binding.role: set(binding.members) for binding in policy.bindings}
    members.setdefault(role, set()).add(member)
    return [Binding(name, tuple(sorted(held))) for name, held in members.items()]


def _without(policy: Policy, role: str, member: str) -> list[Binding]:
    bindings = []
    for binding in policy.bindings:
        members = tuple(
            held for held in binding.members if (binding.role, held) != (role, member)
        )
        if members:
            bindings.append(Binding(binding.role, members))
    return bindings


async def test_a_collection_policy_round_trips_with_its_etag(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    editor, viewer = await world.add_member(workspace), await world.add_member(workspace)
    team = await world.make_group(workspace, [viewer])
    collection = await world.make_collection(workspace)
    ref = ItemRef(workspace.id, collection.id)
    empty = await _get(world, ref)
    assert empty.bindings == ()

    written = await _set(
        world,
        admin,
        ref,
        [
            Binding(EDITOR, (member_name(editor),)),
            Binding(VIEWER, (WORKSPACE_MEMBERS, member_name(team))),
        ],
        etag=empty.etag,
    )

    assert written.bindings == (
        Binding(EDITOR, (member_name(editor),)),
        Binding(VIEWER, tuple(sorted((WORKSPACE_MEMBERS, member_name(team))))),
    )
    assert written.etag != empty.etag
    read = await _get(world, ref)
    assert read == written
    # Writing the same bindings again changes nothing, etag included.
    assert await _set(world, admin, ref, list(read.bindings), etag=read.etag) == read


async def test_a_stale_etag_is_aborted(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    first, second = await world.add_member(workspace), await world.add_member(workspace)
    collection = await world.make_collection(workspace)
    ref = ItemRef(workspace.id, collection.id)
    stale = await _get(world, ref)
    await world.grant(first, VIEWER, on=collection)

    with pytest.raises(Aborted) as aborted:
        await _set(world, admin, ref, [Binding(VIEWER, (member_name(second),))], etag=stale.etag)
    assert aborted.value.reason == "ETAG_MISMATCH"
    assert (await _get(world, ref)).bindings == (Binding(VIEWER, (member_name(first),)),)


async def test_a_policy_shows_only_bindings_set_on_the_resource(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    viewer = await world.add_member(workspace)
    parent = await world.make_collection(workspace, grants={viewer: VIEWER})
    child = await world.make_collection(workspace, parent)

    assert (await _get(world, ItemRef(workspace.id, child.id))).bindings == ()
    assert (await _get(world, WorkspaceRef(workspace.id))).bindings == (
        Binding(ADMIN, (member_name(admin),)),
        Binding(MEMBER, (member_name(viewer),)),
    )


async def test_a_collection_editor_cannot_grant_ownership(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    editor, colleague = await world.add_member(workspace), await world.add_member(workspace)
    collection = await world.make_collection(workspace, grants={editor: EDITOR})
    ref = ItemRef(workspace.id, collection.id)
    current = await _get(world, ref)

    with pytest.raises(PermissionDenied) as escalation:
        await _set(world, editor, ref, _with(current, OWNER, member_name(colleague)))
    assert escalation.value.reason == "ROLE_ESCALATION"
    async with _store(world) as store:
        with pytest.raises(PermissionDenied, match="do not hold"):
            await store.require_grantable(principal(editor), ref, OWNER)
        await store.require_grantable(principal(editor), ref, VIEWER)
    # Roles within the editor's own permissions are grantable.
    granted = await _set(world, editor, ref, _with(current, VIEWER, member_name(colleague)))
    assert Binding(VIEWER, (member_name(colleague),)) in granted.bindings


async def test_a_member_cannot_grant_workspace_admin(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member, colleague = await world.add_member(workspace), await world.add_member(workspace)
    ref = WorkspaceRef(workspace.id)
    current = await _get(world, ref)

    with pytest.raises(PermissionDenied) as escalation:
        await _set(world, member, ref, _with(current, ADMIN, member_name(colleague)))
    assert escalation.value.reason == "ROLE_ESCALATION"
    # An admin may.
    promoted = await _set(world, admin, ref, _with(current, ADMIN, member_name(colleague)))
    assert member_name(colleague) in dict(
        (binding.role, binding.members) for binding in promoted.bindings
    )[ADMIN]


async def test_nobody_changes_their_own_workspace_roles(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    await world.add_member(workspace, role=ADMIN)
    ref = WorkspaceRef(workspace.id)
    current = await _get(world, ref)

    for bindings in (
        _without(current, ADMIN, member_name(admin)),
        _with(current, MEMBER, member_name(admin)),
    ):
        with pytest.raises(FailedPrecondition) as refused:
            await _set(world, admin, ref, bindings)
        assert refused.value.reason == "SELF_MODIFICATION"


async def test_the_last_workspace_admin_cannot_be_removed(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    ref = WorkspaceRef(workspace.id)

    with pytest.raises(FailedPrecondition) as refused:
        await _set(world, member, ref, _without(await _get(world, ref), ADMIN, member_name(admin)))
    assert refused.value.reason == "LAST_ADMIN"


async def test_an_admin_group_counts_only_through_its_active_members(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    curator = await world.add_member(workspace, role=None)
    admins = await world.make_group(workspace, [curator])
    await world.grant(admins, ADMIN, on=workspace)
    ref = WorkspaceRef(workspace.id)
    async with world.sessions() as session:
        assert await workspace_admins(session, workspace.id) == {admin.id, curator.id}

    await world.suspend_member(workspace, curator)
    async with world.sessions() as session:
        assert await workspace_admins(session, workspace.id) == {admin.id}
    with pytest.raises(FailedPrecondition) as refused:
        await _set(world, member, ref, _without(await _get(world, ref), ADMIN, member_name(admin)))
    assert refused.value.reason == "LAST_ADMIN"

    # With an active member the group keeps the workspace administered.
    await world.activate_member(workspace, curator)
    remaining = await _set(
        world, member, ref, _without(await _get(world, ref), ADMIN, member_name(admin))
    )
    assert Binding(ADMIN, (member_name(admins),)) in remaining.bindings


async def test_the_last_space_lead_cannot_be_removed(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    lead, successor = await world.add_member(workspace), await world.add_member(workspace)
    space = await world.make_space(workspace, lead)
    ref = SpaceRef(workspace.id, space.id)

    with pytest.raises(FailedPrecondition) as refused:
        await _set(world, admin, ref, [Binding(SPACE_MEMBER, (member_name(lead),))])
    assert refused.value.reason == "LAST_SPACE_LEAD"

    handed_over = await _set(
        world,
        admin,
        ref,
        [
            Binding(LEAD, (member_name(successor),)),
            Binding(SPACE_MEMBER, (member_name(lead),)),
        ],
    )
    assert Binding(LEAD, (member_name(successor),)) in handed_over.bindings
    async with world.sessions() as session:
        assert await space_leads(session, space.id) == {successor.id}


async def test_a_document_has_no_policy(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    document = await world.make_document(await world.make_collection(workspace))
    ref = ItemRef(workspace.id, document.id)

    for attempt in (
        lambda store: store.get_policy(ref),
        lambda store: store.set_policy(principal(admin), ref, []),
    ):
        async with _store(world) as store:
            with pytest.raises(FailedPrecondition) as refused:
                await attempt(store)
        assert refused.value.reason == "POLICY_ON_DOCUMENT"


async def test_a_policy_of_a_missing_resource_is_not_found(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    deleted = await world.make_collection(workspace)
    await world.delete(deleted)

    for ref in (
        WorkspaceRef(uuid4()),
        ItemRef(workspace.id, uuid4()),
        ItemRef(workspace.id, deleted.id),
        SpaceRef(workspace.id, uuid4()),
    ):
        with pytest.raises(NotFound):
            await _get(world, ref)


@pytest.mark.parametrize(
    ("scope", "role", "member"),
    [
        ("workspace", MEMBER, WORKSPACE_MEMBERS),
        ("collection", EDITOR, WORKSPACE_MEMBERS),
        ("collection", VIEWER, "user:not-a-uuid"),
        ("collection", VIEWER, "alice@example.com"),
        ("collection", VIEWER, "serviceAccount:robot"),
        ("space", SPACE_MEMBER, "group"),
        ("space", SPACE_MEMBER, WORKSPACE_MEMBERS),
        ("workspace", VIEWER, "user"),
        ("collection", ADMIN, "user"),
        ("collection", "roles/doesNotExist", "user"),
        ("collection", "workspaces/other/roles/curator", "user"),
    ],
)
async def test_invalid_principals_and_roles_are_invalid_arguments(
    world: World, scope: str, role: str, member: str
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    user = await world.add_member(workspace)
    group = await world.make_group(workspace, [user])
    resources: dict[str, PolicyResource] = {
        "workspace": WorkspaceRef(workspace.id),
        "collection": ItemRef(workspace.id, (await world.make_collection(workspace)).id),
        "space": SpaceRef(workspace.id, (await world.make_space(workspace, admin)).id),
    }
    ref = resources[scope]
    members = {"user": member_name(user), "group": member_name(group)}
    current = await _get(world, ref)

    with pytest.raises(InvalidArgument) as invalid:
        await _set(world, admin, ref, _with(current, role, members.get(member, member)))
    assert [violation.field for violation in invalid.value.field_violations] == [
        "policy.bindings"
    ]


async def test_a_custom_role_of_another_workspace_cannot_be_granted(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    other = await world.make_workspace(admin)
    foreign_role = await world.make_role(other, "curator", ["items.get"])
    user = await world.add_member(workspace)
    collection = await world.make_collection(workspace)

    with pytest.raises(InvalidArgument):
        await _set(
            world,
            admin,
            ItemRef(workspace.id, collection.id),
            [Binding(role_name(foreign_role), (member_name(user),))],
        )


async def test_only_active_members_and_live_groups_receive_grants(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    outsider = await world.make_user()
    other = await world.make_workspace(admin)
    foreign_group = await world.make_group(other, [admin])
    ref = ItemRef(workspace.id, (await world.make_collection(workspace)).id)

    with pytest.raises(FailedPrecondition) as refused:
        await _set(world, admin, ref, [Binding(VIEWER, (member_name(outsider),))])
    assert refused.value.reason == "NOT_WORKSPACE_MEMBER"
    with pytest.raises(InvalidArgument):
        await _set(world, admin, ref, [Binding(VIEWER, (member_name(foreign_group),))])


async def test_group_principals_use_the_group_id_of_a_live_group_of_the_workspace(
    world: World,
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    other = await world.make_workspace(admin)
    team = await world.make_group(workspace, [admin], code="team")
    retired = await world.make_group(workspace, [admin], code="retired")
    await world.make_group(other, [admin], code="elsewhere")
    async with world.sessions.begin() as session:
        (await session.get(Group, retired.id)).deleted_at = datetime.now(UTC)
    ref = ItemRef(workspace.id, (await world.make_collection(workspace)).id)

    written = await _set(world, admin, ref, [Binding(VIEWER, ("group:team",))])
    assert written.bindings == (Binding(VIEWER, ("group:team",)),)
    for member in (f"group:{team.id}", "group:retired", "group:elsewhere", "group:Team"):
        with pytest.raises(InvalidArgument) as invalid:
            await _set(world, admin, ref, [Binding(VIEWER, (member,))])
        assert [violation.field for violation in invalid.value.field_violations] == [
            "policy.bindings"
        ]


async def test_a_custom_role_on_a_collection_confers_only_collection_permissions(
    world: World,
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    curator_role = await world.make_role(
        workspace, "curator", ["items.get", "items.update", "members.list", "topics.create"]
    )
    curator = await world.add_member(workspace, role=None)
    collection = await world.make_collection(workspace)
    document = await world.make_document(collection, published=False)
    ref = ItemRef(workspace.id, collection.id)

    written = await _set(
        world, admin, ref, [Binding(role_name(curator_role), (member_name(curator),))]
    )
    assert written.bindings == (
        Binding(f"workspaces/{workspace.id}/roles/curator", (member_name(curator),)),
    )

    authorizer = world.authorizer()
    held = await authorizer.collection_permissions(principal(curator), document.id)
    assert {"items.get", "items.update"} <= held
    assert not {"members.list", "topics.create"} & held
    assert await authorizer.workspace_permissions(principal(curator), workspace.id) == frozenset()
    # The same role on the workspace confers its workspace permissions too.
    await world.grant(curator, curator_role, on=workspace)
    assert {"members.list", "topics.create"} <= await world.authorizer().workspace_permissions(
        principal(curator), workspace.id
    )


async def test_granting_a_custom_role_needs_every_permission_it_confers_there(
    world: World,
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    publisher_role = await world.make_role(workspace, "publisher", ["items.get", "items.publish"])
    viewer, colleague = await world.add_member(workspace), await world.add_member(workspace)
    owner = await world.add_member(workspace)
    collection = await world.make_collection(workspace, grants={viewer: VIEWER, owner: OWNER})
    ref = ItemRef(workspace.id, collection.id)
    bindings = _with(await _get(world, ref), role_name(publisher_role), member_name(colleague))

    with pytest.raises(PermissionDenied) as escalation:
        await _set(world, viewer, ref, bindings)
    assert escalation.value.reason == "ROLE_ESCALATION"
    granted = await _set(world, owner, ref, bindings)
    assert Binding(role_name(publisher_role), (member_name(colleague),)) in granted.bindings


async def test_platform_role_column_lists_platform_roles_without_per_row_queries(
    world: World,
) -> None:
    both = await world.make_user()
    operator = await world.make_user()
    nobody = await world.make_user()
    await world.platform_operator(both)
    await world.platform_operator(operator)
    async with world.sessions.begin() as session:
        admin_role = await session.scalar(
            select(Role.id).where(Role.tenant_id.is_(None), Role.code == "platformAdmin")
        )
        session.add(RoleAssignment(user_id=both.id, role_id=admin_role))

    async with world.sessions() as session:
        rows = await session.execute(
            select(User.id, platform_role_column(User.id)).where(
                User.id.in_([both.id, operator.id, nobody.id])
            )
        )
        roles = dict(rows.tuples().all())
        filtered = set(
            await session.scalars(
                select(User.id).where(
                    platform_role_column(User.id) == "roles/platformOperator"
                )
            )
        )
        assert await platform_role(session, both.id) == "roles/platformAdmin"
        assert await platform_role(session, nobody.id) is None

    assert roles == {
        both.id: "roles/platformAdmin",
        operator.id: "roles/platformOperator",
        nobody.id: None,
    }
    assert filtered == {operator.id}
