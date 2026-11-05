"""The schema itself refuses invalid state, whatever service wrote it.

Each test builds the smallest valid world, then asks PostgreSQL to accept one
row that breaks a rule of ``design.dbml``. The rules are enforced by CHECK
constraints and triggers (``bomesh.db.models.triggers``), so they must hold
for raw ORM writes with no service in between.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from bomesh.db.models import (
    AccessSession,
    Base,
    Contribution,
    Conversation,
    Group,
    Item,
    ItemLink,
    ItemRevision,
    Request,
    Role,
    RoleAssignment,
    Space,
    Tenant,
    TenantMembership,
    User,
)

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        not TEST_DATABASE_URL,
        reason="TEST_DATABASE_URL is required for PostgreSQL schema tests",
    ),
]

Factory = async_sessionmaker[AsyncSession]


@pytest_asyncio.fixture
async def factory() -> AsyncIterator[Factory]:
    assert TEST_DATABASE_URL is not None
    schema = f"test_schema_{uuid4().hex}"
    admin_engine = create_async_engine(TEST_DATABASE_URL)
    async with admin_engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"server_settings": {"search_path": schema}},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()
        async with admin_engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin_engine.dispose()


async def _add(factory: Factory, *rows: Any) -> None:
    async with factory.begin() as session:
        for row in rows:
            session.add(row)
            await session.flush()


async def _rejected(factory: Factory, *rows: Any, match: str) -> None:
    with pytest.raises(DBAPIError, match=match):
        await _add(factory, *rows)


async def _tenant(factory: Factory) -> UUID:
    tenant = Tenant(code=f"t-{uuid4().hex[:12]}", name="Workspace")
    await _add(factory, tenant)
    return tenant.id


async def _member(factory: Factory, tenant_id: UUID, *, status: str = "active") -> UUID:
    user = User(email=f"{uuid4().hex}@example.test")
    await _add(factory, user)
    await _add(
        factory, TenantMembership(user_id=user.id, tenant_id=tenant_id, status=status)
    )
    return user.id


async def _role(
    factory: Factory, code: str, scope_type: str, *, tenant_id: UUID | None = None
) -> UUID:
    role = Role(
        code=code,
        display_name=code,
        scope_type=scope_type,
        tenant_id=tenant_id,
        is_system=tenant_id is None,
    )
    await _add(factory, role)
    return role.id


def _collection(
    tenant_id: UUID,
    *,
    parent: UUID | None = None,
    metadata: dict[str, Any] | None = None,
    created_by: UUID | None = None,
) -> Item:
    return Item(
        id=uuid4(),
        tenant_id=tenant_id,
        item_type="collection",
        parent_item_id=parent,
        parent_relation="contains" if parent else None,
        title="Collection",
        status="ready",
        inherit_access=parent is not None,
        metadata_=metadata or {},
        created_by_user_id=created_by,
    )


def _document(
    tenant_id: UUID,
    parent: UUID,
    *,
    relation: str = "contains",
    publication_state: str | None = "published",
    metadata: dict[str, Any] | None = None,
) -> Item:
    return Item(
        id=uuid4(),
        tenant_id=tenant_id,
        item_type="document",
        parent_item_id=parent,
        parent_relation=relation,
        document_type="pdf",
        title="Document",
        publication_state=publication_state,
        index_status="pending",
        metadata_=metadata or {},
    )


async def _move(factory: Factory, item_id: UUID, parent_id: UUID) -> None:
    async with factory.begin() as session:
        await session.execute(
            update(Item)
            .where(Item.id == item_id)
            .values(parent_item_id=parent_id, parent_relation="contains", inherit_access=True)
        )


# ── Item tree ──────────────────────────────────────────────────────────────


async def test_a_move_cannot_create_a_cycle(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    child = _collection(tenant_id, parent=root.id)
    grandchild = _collection(tenant_id, parent=child.id)
    await _add(factory, root, child, grandchild)

    with pytest.raises(DBAPIError, match="cycle"):
        await _move(factory, root.id, grandchild.id)
    with pytest.raises(DBAPIError, match="cycle"):
        await _move(factory, child.id, child.id)

    # A legal move under a sibling subtree still works.
    other_root = _collection(tenant_id)
    await _add(factory, other_root)
    await _move(factory, grandchild.id, other_root.id)


async def test_parents_stay_in_the_tenant_and_alive(factory: Factory) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    foreign_root = _collection(other_tenant_id)
    deleted_root = _collection(tenant_id)
    deleted_root.deleted_at = datetime.now(UTC)
    await _add(factory, foreign_root, deleted_root)

    await _rejected(
        factory, _collection(tenant_id, parent=foreign_root.id), match="same tenant"
    )
    await _rejected(
        factory, _document(tenant_id, deleted_root.id), match="live Item of the same tenant"
    )


async def test_tenant_and_type_are_immutable(factory: Factory) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    root = _collection(tenant_id)
    await _add(factory, root)

    with pytest.raises(DBAPIError, match="immutable"):
        async with factory.begin() as session:
            await session.execute(
                update(Item).where(Item.id == root.id).values(tenant_id=other_tenant_id)
            )


async def test_only_collections_are_roots_and_roots_are_access_boundaries(
    factory: Factory,
) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    await _add(factory, root)

    rootless_document = _document(tenant_id, root.id)
    rootless_document.parent_item_id = None
    rootless_document.parent_relation = None
    await _rejected(factory, rootless_document, match="document_requires_parent")

    inheriting_root = _collection(tenant_id)
    inheriting_root.inherit_access = True
    await _rejected(factory, inheriting_root, match="root_is_access_boundary")

    non_inheriting_document = _document(tenant_id, root.id)
    non_inheriting_document.inherit_access = False
    await _rejected(
        factory, non_inheriting_document, match="only_collections_end_inheritance"
    )


async def test_parent_relation_follows_the_parent_type(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    document = _document(tenant_id, root.id)
    await _add(factory, root, document)

    await _rejected(
        factory, _document(tenant_id, root.id, relation="child"), match="contains"
    )
    await _rejected(
        factory,
        _document(tenant_id, document.id, relation="contains"),
        match="child or attachment",
    )
    await _rejected(
        factory,
        _document(tenant_id, document.id, relation="embedded"),
        match="child or attachment",
    )
    collection_under_document = _collection(tenant_id, parent=document.id)
    collection_under_document.parent_relation = "child"
    await _rejected(
        factory, collection_under_document, match="cannot be parented by a Document"
    )

    await _add(factory, _document(tenant_id, document.id, relation="attachment"))


async def test_publication_state_is_set_exactly_for_documents(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    await _add(factory, root)

    await _rejected(
        factory,
        _document(tenant_id, root.id, publication_state=None),
        match="item_publication_matches_type",
    )
    published_collection = _collection(tenant_id, parent=root.id)
    published_collection.publication_state = "published"
    await _rejected(
        factory, published_collection, match="item_publication_matches_type"
    )
    deleted_status = _document(tenant_id, root.id)
    deleted_status.status = "deleted"
    await _rejected(factory, deleted_status, match="item_status_is_valid")


async def test_revisions_belong_to_documents_only(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    document = _document(tenant_id, root.id)
    await _add(factory, root, document)

    def revision(item_id: UUID) -> ItemRevision:
        return ItemRevision(
            item_id=item_id,
            revision_number=1,
            storage_key="objects/a",
            mime_type="application/pdf",
            size_bytes=1,
        )

    await _rejected(factory, revision(root.id), match="only Document Items")
    await _add(factory, revision(document.id))


# ── Item links and contributions ───────────────────────────────────────────


async def test_item_links_join_a_collection_to_a_document_elsewhere(
    factory: Factory,
) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    root = _collection(tenant_id)
    shelf = _collection(tenant_id, parent=root.id)
    artifacts = _collection(tenant_id, metadata={"system_kind": "conversation_artifacts"})
    document = _document(tenant_id, root.id)
    attachment = _document(
        tenant_id, root.id, metadata={"purpose": "conversation_attachment"}
    )
    foreign_root = _collection(other_tenant_id)
    foreign_document = _document(other_tenant_id, foreign_root.id)
    await _add(
        factory, root, shelf, artifacts, document, attachment, foreign_root, foreign_document
    )

    def link(container: UUID, target: UUID) -> ItemLink:
        return ItemLink(tenant_id=tenant_id, collection_item_id=container, target_item_id=target)

    await _rejected(factory, link(shelf.id, foreign_document.id), match="link tenant")
    await _rejected(factory, link(document.id, document.id), match="container must be a live Collection")
    await _rejected(factory, link(artifacts.id, document.id), match="conversation_artifacts")
    await _rejected(factory, link(shelf.id, root.id), match="target must be a Document")
    await _rejected(factory, link(shelf.id, attachment.id), match="conversation attachment")
    await _rejected(factory, link(root.id, document.id), match="already lives in the container")

    await _add(factory, link(shelf.id, document.id))
    await _rejected(factory, link(shelf.id, document.id), match="uq_item_links_live")


async def test_contribution_references_stay_in_the_tenant(factory: Factory) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    contributor = await _member(factory, tenant_id)
    root = _collection(tenant_id)
    candidate = _document(tenant_id, root.id, publication_state="unpublished")
    foreign_root = _collection(other_tenant_id)
    await _add(factory, root, candidate, foreign_root)

    def contribution(**values: Any) -> Contribution:
        return Contribution(
            tenant_id=tenant_id,
            kind="new_document",
            origin="member",
            contributor_user_id=contributor,
            **values,
        )

    await _rejected(
        factory,
        contribution(item_id=candidate.id, target_item_id=foreign_root.id),
        match="target must be a Collection of its tenant",
    )
    await _rejected(
        factory, contribution(item_id=root.id), match="candidate must be a Document"
    )
    await _add(factory, contribution(item_id=candidate.id, target_item_id=root.id))
    await _rejected(
        factory, contribution(item_id=candidate.id), match="uq_contributions_open_item_id"
    )


# ── Role assignments ───────────────────────────────────────────────────────


async def test_space_grants_go_to_members_with_space_roles(factory: Factory) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    member = await _member(factory, tenant_id)
    outsider = await _member(factory, other_tenant_id)
    suspended = await _member(factory, tenant_id, status="suspended")
    space_member = await _role(factory, "spaceMember", "space")
    collection_viewer = await _role(factory, "collectionViewer", "collection")
    custom = await _role(factory, "coach", "tenant", tenant_id=tenant_id)
    foreign_custom = await _role(factory, "coach", "tenant", tenant_id=other_tenant_id)
    space = Space(tenant_id=tenant_id, code="s1", display_name="Space", space_type="team")
    deleted_space = Space(
        tenant_id=tenant_id,
        code="s2",
        display_name="Gone",
        space_type="team",
        deleted_at=datetime.now(UTC),
    )
    group = Group(tenant_id=tenant_id, code="g1", display_name="Group")
    await _add(factory, space, deleted_space, group)

    def grant(**values: Any) -> RoleAssignment:
        return RoleAssignment(space_id=space.id, **values)

    await _rejected(
        factory,
        grant(group_id=group.id, role_id=space_member),
        match="space_grant_has_user_principal",
    )
    await _rejected(factory, grant(user_id=outsider, role_id=space_member), match="active member")
    await _rejected(factory, grant(user_id=suspended, role_id=space_member), match="active member")
    await _rejected(
        factory, grant(user_id=member, role_id=collection_viewer), match="Role scope"
    )
    await _rejected(
        factory, grant(user_id=member, role_id=foreign_custom), match="own tenant"
    )
    await _rejected(
        factory,
        RoleAssignment(space_id=deleted_space.id, user_id=member, role_id=space_member),
        match="live space",
    )

    await _add(factory, grant(user_id=member, role_id=space_member))
    await _add(factory, grant(user_id=member, role_id=custom))
    await _rejected(
        factory,
        grant(user_id=member, role_id=space_member),
        match="uq_role_assignments_principal_scope_role",
    )


async def test_a_personal_collection_carries_only_its_owner_grant(
    factory: Factory,
) -> None:
    tenant_id = await _tenant(factory)
    owner = await _member(factory, tenant_id)
    colleague = await _member(factory, tenant_id)
    collection_owner = await _role(factory, "collectionOwner", "collection")
    collection_viewer = await _role(factory, "collectionViewer", "collection")
    personal = _collection(
        tenant_id, metadata={"system_kind": "personal_uploads"}, created_by=owner
    )
    await _add(factory, personal)

    await _rejected(
        factory,
        RoleAssignment(item_id=personal.id, user_id=colleague, role_id=collection_viewer),
        match="owner grant",
    )
    await _rejected(
        factory,
        RoleAssignment(item_id=personal.id, all_members=True, role_id=collection_viewer),
        match="owner grant",
    )
    await _add(
        factory,
        RoleAssignment(item_id=personal.id, user_id=owner, role_id=collection_owner),
    )


async def test_general_access_is_collection_viewer_on_a_collection(
    factory: Factory,
) -> None:
    tenant_id = await _tenant(factory)
    collection_viewer = await _role(factory, "collectionViewer", "collection")
    collection_editor = await _role(factory, "collectionEditor", "collection")
    root = _collection(tenant_id)
    await _add(factory, root)

    await _rejected(
        factory,
        RoleAssignment(item_id=root.id, all_members=True, role_id=collection_editor),
        match="collectionViewer",
    )
    await _rejected(
        factory,
        RoleAssignment(tenant_id=tenant_id, all_members=True, role_id=collection_viewer),
        match="Role scope",
    )
    await _rejected(
        factory,
        RoleAssignment(
            item_id=root.id,
            all_members=True,
            user_id=await _member(factory, tenant_id),
            role_id=collection_viewer,
        ),
        match="role_assignment_has_one_principal",
    )
    await _add(
        factory,
        RoleAssignment(item_id=root.id, all_members=True, role_id=collection_viewer),
    )


# ── Sessions and conversations ─────────────────────────────────────────────


def _session(user_id: UUID, *, parent: AccessSession | None = None, method: str = "password") -> AccessSession:
    return AccessSession(
        id=uuid4(),
        user_id=user_id,
        authentication_method=method,
        parent_session_id=parent.id if parent else None,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )


async def test_a_rotated_session_keeps_its_subject_and_method(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    user_id = await _member(factory, tenant_id)
    other_user_id = await _member(factory, tenant_id)
    parent = _session(user_id)
    await _add(factory, parent)

    await _rejected(factory, _session(other_user_id, parent=parent), match="keeps the User")
    await _rejected(
        factory, _session(user_id, parent=parent, method="internal"), match="keeps the User"
    )
    await _add(factory, _session(user_id, parent=parent))


async def test_conversations_belong_to_members_and_their_tenant(factory: Factory) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    owner = await _member(factory, tenant_id)
    other_user = await _member(factory, tenant_id)
    former = await _member(factory, tenant_id)
    async with factory.begin() as session:
        await session.execute(
            update(TenantMembership)
            .where(TenantMembership.user_id == former)
            .values(deleted_at=datetime.now(UTC))
        )
    owner_session, other_session, former_session = (
        _session(owner),
        _session(other_user),
        _session(former),
    )
    root = _collection(tenant_id)
    foreign_root = _collection(other_tenant_id)
    space = Space(tenant_id=other_tenant_id, code="s1", display_name="S", space_type="team")
    await _add(factory, owner_session, other_session, former_session, root, foreign_root, space)

    def conversation(user_id: UUID, session_id: UUID, **values: Any) -> Conversation:
        return Conversation(
            tenant_id=tenant_id,
            code=f"r{uuid4().hex}",
            owner_user_id=user_id,
            created_by_session_id=session_id,
            **values,
        )

    await _rejected(
        factory, conversation(owner, other_session.id), match="belong to its owner"
    )
    await _rejected(
        factory, conversation(former, former_session.id), match="active member"
    )
    await _rejected(
        factory,
        conversation(owner, owner_session.id, scope_collection_ids=[foreign_root.id]),
        match="scope collections",
    )
    await _rejected(
        factory,
        conversation(owner, owner_session.id, scope_space_ids=[space.id]),
        match="scope spaces",
    )
    await _add(
        factory, conversation(owner, owner_session.id, scope_collection_ids=[root.id])
    )


# ── Requests ───────────────────────────────────────────────────────────────


async def test_requests_name_exactly_their_decision_resource(factory: Factory) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    requester = await _member(factory, tenant_id)
    outsider = await _member(factory, other_tenant_id)
    collection_viewer = await _role(factory, "collectionViewer", "collection")
    root = _collection(tenant_id)
    foreign_root = _collection(other_tenant_id)
    await _add(factory, root, foreign_root)

    def access_request(**values: Any) -> Request:
        return Request(
            tenant_id=tenant_id,
            kind="collection_access",
            requested_role_id=collection_viewer,
            **values,
        )

    await _rejected(
        factory,
        access_request(requester_user_id=requester),
        match="request_references_match_kind",
    )
    await _rejected(
        factory,
        access_request(requester_user_id=requester, collection_item_id=foreign_root.id),
        match="Collection of its tenant",
    )
    await _rejected(
        factory,
        access_request(requester_user_id=outsider, collection_item_id=root.id),
        match="requester must be an active member",
    )
    await _add(factory, access_request(requester_user_id=requester, collection_item_id=root.id))
    await _rejected(
        factory,
        access_request(requester_user_id=requester, collection_item_id=root.id),
        match="uq_requests_open_ask",
    )
