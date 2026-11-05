"""The Item visibility rule (``item_model.md`` §6.3) for Get and for lists alike.

A Get (``require_visible_item``) and a list (``ItemVisibility.clause()``) must
agree on what one caller can read; where a test checks both, it asks the
same question of each.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError

from bomesh.db.models import Item, User
from bomesh.errors import FailedPrecondition, NotFound, PermissionDenied
from bomesh.iam.authorizer import ItemRef
from bomesh.iam.policy import Binding, PolicyStore
from bomesh.iam.visibility import (
    is_contribution_reviewer,
    is_visible,
    item_visibility,
    require_visible_item,
)
from harness import WORKSPACE_MEMBERS, World, principal

pytestmark = pytest.mark.asyncio

READ = "items.get"
EDIT = "items.update"
RESTORE = "items.undelete"


def _ref(item: Item) -> ItemRef:
    return ItemRef(item.tenant_id, item.id)


async def _get(world: World, user: User, item: Item, **options: Any) -> Item:
    """GetItem's authorization: the row, or the AIP-211 error."""
    async with world.sessions() as session:
        return await require_visible_item(
            session, world.authorizer(), principal(user), _ref(item), **options
        )


async def _readable(world: World, user: User, item: Item, **options: Any) -> bool:
    try:
        await _get(world, user, item, **options)
    except (PermissionDenied, NotFound):
        return False
    return True


async def _listed(
    world: World, user: User, workspace_id: UUID, *, show_deleted: bool = False
) -> set[UUID]:
    """Ids a list over ``items`` returns for ``user`` with the visibility clause."""
    visibility = await item_visibility(
        world.authorizer(), principal(user), workspace_id, show_deleted=show_deleted
    )
    async with world.sessions() as session:
        return set(await session.scalars(select(Item.id).where(visibility.clause())))


async def _assert_get_and_list_agree(
    world: World, users: Iterable[User], items: list[Item]
) -> None:
    workspace_id = items[0].tenant_id
    for user in users:
        listed = await _listed(world, user, workspace_id)
        for item in items:
            assert await _readable(world, user, item) == (item.id in listed), (
                user.email,
                item.title,
            )
            assert await is_visible(world.authorizer(), principal(user), _ref(item)) == (
                item.id in listed
            )


async def test_unpublished_documents_are_visible_to_editors_not_viewers(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    editor, viewer = await world.add_member(workspace), await world.add_member(workspace)
    handbook = await world.make_collection(
        workspace, grants={editor: "roles/collectionEditor", viewer: "roles/collectionViewer"}
    )
    published = await world.make_document(handbook)
    attachment = await world.make_document(published)
    draft = await world.make_document(handbook, published=False)
    hidden_attachment = await world.make_document(published, published=False)

    assert await _listed(world, editor, workspace.id) == {
        handbook.id,
        published.id,
        attachment.id,
        draft.id,
        hidden_attachment.id,
    }
    assert await _listed(world, viewer, workspace.id) == {
        handbook.id,
        published.id,
        attachment.id,
    }
    assert (await _get(world, editor, draft)).id == draft.id
    for hidden in (draft, hidden_attachment):
        with pytest.raises(PermissionDenied):
            await _get(world, viewer, hidden)
    await _assert_get_and_list_agree(
        world,
        [admin, editor, viewer],
        [handbook, published, attachment, draft, hidden_attachment],
    )


async def test_visible_without_the_permission_is_denied(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    viewer = await world.add_member(workspace)
    handbook = await world.make_collection(workspace, grants={viewer: "roles/collectionViewer"})
    document = await world.make_document(handbook)

    with pytest.raises(PermissionDenied, match="'items.update' denied"):
        await _get(world, viewer, document, permission=EDIT)


async def test_a_deleted_ancestor_hides_its_subtree(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    owner, viewer = await world.add_member(workspace), await world.add_member(workspace)
    handbook = await world.make_collection(
        workspace, grants={owner: "roles/collectionOwner", viewer: "roles/collectionViewer"}
    )
    kept = await world.make_document(handbook)
    archive = await world.make_collection(workspace, handbook)
    old = await world.make_document(archive)
    await world.delete(archive)
    authorizer = world.authorizer()

    assert await _listed(world, owner, workspace.id) == {handbook.id, kept.id}
    assert READ not in await authorizer.collection_permissions(principal(owner), old.id)
    assert await is_visible(authorizer, principal(owner), _ref(old)) is False
    # Deleted answers like absent: denied below the workspace permission, else NOT_FOUND.
    with pytest.raises(PermissionDenied):
        await _get(world, owner, old)
    with pytest.raises(NotFound):
        await _get(world, admin, old)
    with pytest.raises(NotFound):
        await _get(world, admin, archive)


async def test_items_undelete_holders_resolve_through_the_deleted_cohort(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    owner, viewer = await world.add_member(workspace), await world.add_member(workspace)
    handbook = await world.make_collection(
        workspace, grants={owner: "roles/collectionOwner", viewer: "roles/collectionViewer"}
    )
    kept = await world.make_document(handbook)
    archive = await world.make_collection(workspace, handbook)
    old = await world.make_document(archive)
    old_draft = await world.make_document(archive, published=False)
    await world.delete(archive)
    authorizer = world.authorizer()

    assert RESTORE in await authorizer.collection_permissions(
        principal(owner), old.id, include_deleted=True
    )
    await authorizer.require(principal(owner), RESTORE, _ref(old), include_deleted=True)
    restored = await _get(world, owner, old, permission=RESTORE, include_deleted=True)
    assert restored.id == old.id and restored.deleted_at is not None
    assert await _listed(world, owner, workspace.id, show_deleted=True) == {
        handbook.id,
        kept.id,
        archive.id,
        old.id,
        old_draft.id,
    }

    # A viewer reads the live tree but restores nothing.
    with pytest.raises(PermissionDenied):
        await _get(world, viewer, old, include_deleted=True)
    assert await _listed(world, viewer, workspace.id, show_deleted=True) == {
        handbook.id,
        kept.id,
    }


async def test_a_personal_collection_is_seen_by_its_owner_and_workspace_admins(
    world: World,
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    owner, colleague = await world.add_member(workspace), await world.add_member(workspace)
    uploads = await world.make_collection(workspace, personal_for=owner)
    upload = await world.make_document(uploads, published=False)

    for reader in (owner, admin):
        assert {uploads.id, upload.id} <= await _listed(world, reader, workspace.id)
        assert (await _get(world, reader, upload)).id == upload.id
    assert await _listed(world, colleague, workspace.id) == set()
    with pytest.raises(PermissionDenied):
        await _get(world, colleague, uploads)
    await _assert_get_and_list_agree(world, [owner, admin, colleague], [uploads, upload])

    # Not shareable: neither through a policy nor by a direct grant.
    async with world.sessions.begin() as session:
        with pytest.raises(FailedPrecondition) as refused:
            await PolicyStore(session, world.authorizer()).set_policy(
                principal(owner),
                _ref(uploads),
                [
                    Binding("roles/collectionOwner", (f"user:{owner.id}",)),
                    Binding("roles/collectionViewer", (f"user:{colleague.id}",)),
                ],
            )
    assert refused.value.reason == "PERSONAL_COLLECTION"
    with pytest.raises(DBAPIError, match="carries only its owner grant"):
        await world.grant(colleague, "roles/collectionViewer", on=uploads)


async def test_a_workspace_admin_sees_every_item_of_the_workspace_only(world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    member = await world.add_member(workspace)
    private = await world.make_collection(workspace, grants={member: "roles/collectionOwner"})
    sealed = await world.make_collection(workspace, private, inherit_access=False)
    draft = await world.make_document(sealed, published=False)
    uploads = await world.make_collection(workspace, personal_for=member)
    other = await world.make_workspace(await world.make_user())
    foreign = await world.make_collection(other, grants={WORKSPACE_MEMBERS: "roles/collectionViewer"})

    assert await _listed(world, admin, workspace.id) == {
        private.id,
        sealed.id,
        draft.id,
        uploads.id,
    }
    assert await _listed(world, admin, other.id) == set()
    await _assert_get_and_list_agree(world, [admin, member], [private, sealed, draft, uploads])
    # An item named under the wrong workspace is never found there.
    async with world.sessions() as session:
        with pytest.raises(PermissionDenied):
            await require_visible_item(
                session, world.authorizer(), principal(admin), ItemRef(other.id, private.id)
            )
        with pytest.raises(NotFound):
            await require_visible_item(
                session, world.authorizer(), principal(admin), ItemRef(workspace.id, foreign.id)
            )


async def test_a_reviewer_reads_an_open_candidate_only_through_the_exception(
    world: World,
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    contributor = await world.add_member(workspace)
    reviewer, viewer = await world.add_member(workspace), await world.add_member(workspace)
    target = await world.make_collection(
        workspace, grants={reviewer: "roles/collectionOwner", viewer: "roles/collectionViewer"}
    )
    uploads = await world.make_collection(workspace, personal_for=contributor)
    candidate = await world.make_document(uploads, published=False)
    suggested = await world.make_document(uploads, published=False)
    withdrawn = await world.make_document(uploads, published=False)
    await world.make_contribution(candidate, contributor=contributor, target=target)
    await world.make_contribution(
        suggested,
        contributor=contributor,
        state="analyzing",
        suggestions={"collection_id": str(target.id)},
    )
    await world.make_contribution(
        withdrawn, contributor=contributor, target=target, state="withdrawn"
    )

    for open_candidate in (candidate, suggested):
        async with world.sessions() as session:
            assert await is_contribution_reviewer(
                session, world.authorizer(), principal(reviewer), _ref(open_candidate)
            )
        got = await _get(world, reviewer, open_candidate, reviewer_exception=True)
        assert got.id == open_candidate.id
        # Only GetItem-style reads use the exception, and only for items.get.
        with pytest.raises(PermissionDenied):
            await _get(world, reviewer, open_candidate)
        with pytest.raises(PermissionDenied):
            await _get(world, reviewer, open_candidate, permission=EDIT, reviewer_exception=True)
        with pytest.raises(PermissionDenied):
            await _get(world, viewer, open_candidate, reviewer_exception=True)
    with pytest.raises(PermissionDenied):
        await _get(world, reviewer, withdrawn, reviewer_exception=True)
    # Lists never include a candidate the reviewer cannot otherwise read.
    assert await _listed(world, reviewer, workspace.id) == {target.id}
    assert (await _get(world, contributor, candidate)).id == candidate.id
