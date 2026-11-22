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
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from bomesh.db.models import (
    AccessSession,
    Base,
    Contribution,
    Conversation,
    Group,
    Item,
    ItemIndexState,
    ItemShortcut,
    ItemRevision,
    ItemUpload,
    Request,
    Role,
    RoleAssignment,
    Space,
    Tenant,
    TenantMembership,
    User,
)
from bomesh.services.knowledge_items.file_types import file_class

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
    tenant = Tenant(code=f"t-{uuid4().hex[:12]}", tenant_name="Workspace")
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
        role_name=code,
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
    item_type: str = "standard",
    created_by: UUID | None = None,
) -> Item:
    return Item(
        id=uuid4(),
        tenant_id=tenant_id,
        item_kind="collection",
        item_type=item_type,
        parent_item_id=parent,
        item_name="Collection",
        inherit_access=parent is not None,
        discoverable=False,
        accepts_contributions=False,
        created_by_user_id=created_by,
    )


def _document(
    tenant_id: UUID,
    parent: UUID,
    *,
    is_published: bool | None = True,
    purpose: str | None = "knowledge",
) -> Item:
    return Item(
        id=uuid4(),
        tenant_id=tenant_id,
        item_kind="document",
        item_type="pdf",
        parent_item_id=parent,
        item_name="Document",
        is_published=is_published,
        purpose=purpose,
    )


def _revision(item_id: UUID, number: int = 1, **values: Any) -> ItemRevision:
    return ItemRevision(
        id=uuid4(),
        item_id=item_id,
        revision_number=number,
        content_id=uuid4(),
        mime_type=values.pop("mime_type", "application/pdf"),
        size_bytes=1,
        file_name=values.pop("file_name", "a.pdf"),
        **values,
    )


async def _move(factory: Factory, item_id: UUID, parent_id: UUID | None) -> None:
    async with factory.begin() as session:
        await session.execute(update(Item).where(Item.id == item_id).values(parent_item_id=parent_id))


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


async def test_tenant_kind_and_type_are_immutable(factory: Factory) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    root = _collection(tenant_id)
    await _add(factory, root)

    for values in (
        {"tenant_id": other_tenant_id},
        {"item_kind": "document", "item_type": "pdf"},
        {"item_type": "personal"},
    ):
        with pytest.raises(DBAPIError, match="immutable"):
            async with factory.begin() as session:
                await session.execute(update(Item).where(Item.id == root.id).values(**values))


async def test_a_document_is_never_a_root(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    document = _document(tenant_id, root.id)
    await _add(factory, root, document)

    rootless_document = _document(tenant_id, root.id)
    rootless_document.parent_item_id = None
    await _rejected(factory, rootless_document, match="never a root")
    with pytest.raises(DBAPIError, match="never a root"):
        await _move(factory, document.id, None)


async def test_only_documents_nest_under_documents(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    document = _document(tenant_id, root.id)
    await _add(factory, root, document)

    await _rejected(
        factory,
        _collection(tenant_id, parent=document.id),
        match="parent is a Collection",
    )
    await _add(factory, _document(tenant_id, document.id))


async def test_kind_columns_are_set_exactly_for_their_kind(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    await _add(factory, root)

    await _rejected(
        factory,
        _document(tenant_id, root.id, is_published=None),
        match="document_attributes_match_kind",
    )
    await _rejected(
        factory,
        _document(tenant_id, root.id, purpose=None),
        match="document_attributes_match_kind",
    )
    published_collection = _collection(tenant_id, parent=root.id)
    published_collection.is_published = True
    await _rejected(factory, published_collection, match="document_attributes_match_kind")
    non_inheriting_document = _document(tenant_id, root.id)
    non_inheriting_document.inherit_access = False
    await _rejected(
        factory, non_inheriting_document, match="collection_attributes_match_kind"
    )
    collection_without_flags = _collection(tenant_id, parent=root.id)
    collection_without_flags.discoverable = None
    await _rejected(
        factory, collection_without_flags, match="collection_attributes_match_kind"
    )
    owned_collection = _collection(tenant_id, parent=root.id)
    owned_collection.owner_user_id = await _member(factory, tenant_id)
    await _rejected(factory, owned_collection, match="document_only_attributes")


async def test_item_types_are_scoped_by_kind(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    await _add(factory, root)

    await _rejected(
        factory, _collection(tenant_id, item_type="pdf"), match="collection_type_is_valid"
    )
    malformed = _document(tenant_id, root.id)
    malformed.item_type = "Not-A-Type"
    await _rejected(factory, malformed, match="item_type_is_valid")
    open_personal = _collection(tenant_id, item_type="personal")
    open_personal.discoverable = True
    await _rejected(factory, open_personal, match="system_collection_is_closed")
    await _add(factory, _collection(tenant_id, item_type="personal"))


async def test_revisions_belong_to_documents_of_their_file_class(factory: Factory) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    document = _document(tenant_id, root.id)
    await _add(factory, root, document)

    await _rejected(factory, _revision(root.id), match="only Document Items")
    await _rejected(
        factory,
        _revision(document.id, mime_type="text/markdown", file_name="a.md"),
        match="must map to its Document item_type",
    )
    async with factory.begin() as session:
        revision = _revision(document.id, mime_type="application/octet-stream", file_name="b.PDF")
        session.add(revision)
        await session.flush()
        await session.execute(
            update(Item).where(Item.id == document.id).values(current_revision_id=revision.id)
        )


async def test_uploads_promise_content_of_the_documents_file_class(factory: Factory) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    owner = await _member(factory, tenant_id)
    root, foreign_root = _collection(tenant_id), _collection(other_tenant_id)
    document, archive = _document(tenant_id, root.id), _document(tenant_id, root.id)
    foreign_archive = _document(other_tenant_id, foreign_root.id)
    await _add(factory, root, foreign_root, document, archive, foreign_archive)

    def upload(**values: Any) -> ItemUpload:
        return ItemUpload(
            item_id=document.id,
            tenant_id=tenant_id,
            owner_user_id=owner,
            content_id=uuid4(),
            mime_type=values.pop("mime_type", "application/pdf"),
            file_name=values.pop("file_name", "a.pdf"),
            **values,
        )

    await _rejected(
        factory, upload(mime_type="image/png", file_name="a.png"), match="must map to its Document"
    )
    await _rejected(
        factory, upload(archive_item_id=archive.id), match="item_upload_archive_member_is_complete"
    )
    await _rejected(
        factory,
        upload(archive_item_id=foreign_archive.id, archive_path="x/a.pdf"),
        match="archive member comes from a Document of its tenant",
    )
    await _add(factory, upload(archive_item_id=archive.id, archive_path="x/a.pdf"))


async def test_a_document_shows_its_newest_live_revision(factory: Factory) -> None:
    """Checked at commit: the revision and the pointer change in one transaction."""
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    document = _document(tenant_id, root.id)
    await _add(factory, root, document)
    match = "current revision must be its newest live revision"

    async def write(
        *rows: ItemRevision, point: UUID | None = None, tombstone: UUID | None = None
    ) -> None:
        async with factory.begin() as session:
            for row in rows:
                session.add(row)
                await session.flush()
            if tombstone is not None:
                await session.execute(
                    update(ItemRevision)
                    .where(ItemRevision.id == tombstone)
                    .values(deleted_at=datetime.now(UTC))
                )
            if point is not None:
                await session.execute(
                    update(Item).where(Item.id == document.id).values(current_revision_id=point)
                )

    with pytest.raises(DBAPIError, match=match):
        await write(_revision(document.id))  # a live revision exists, nothing points at it
    first = _revision(document.id)
    await write(first, point=first.id)
    with pytest.raises(DBAPIError, match=match):
        await write(_revision(document.id, 2))  # the pointer must move to the newest
    second = _revision(document.id, 2)
    await write(second, point=second.id)
    with pytest.raises(DBAPIError, match=match):
        await write(point=first.id)  # an older revision is not current
    with pytest.raises(DBAPIError, match=match):
        await write(tombstone=second.id)  # the pointer must leave a tombstoned revision
    await write(point=first.id, tombstone=second.id)


async def test_the_database_file_class_is_the_python_rule(factory: Factory) -> None:
    """``bomesh_file_class`` (the triggers' rule) is generated from the Python one."""
    mime_types = (
        None,
        "application/pdf",
        "text/x-rst",
        "image/heic",
        "Text/HTML; charset=utf-8",
        "application/octet-stream",
        "audio/x-new",
        "text/unknown",
    )
    file_names = (
        "report.PDF",
        "dir\\Slides.pptx",
        " notes.md ",
        ".env",
        "Dockerfile",
        "a.tar.gz",
        "noext",
        "trailing.",
        "data.jsonl",
        "x/y/photo.webp",
    )
    async with factory.begin() as session:
        for mime_type in mime_types:
            for file_name in file_names:
                stored = await session.scalar(select(func.bomesh_file_class(mime_type, file_name)))
                assert stored == file_class(mime_type, file_name), (mime_type, file_name)


async def test_every_document_and_only_documents_have_one_index_state(
    factory: Factory,
) -> None:
    tenant_id = await _tenant(factory)
    root = _collection(tenant_id)
    document = _document(tenant_id, root.id)
    await _add(factory, root, document)

    async with factory.begin() as session:
        states = list(await session.scalars(select(ItemIndexState)))
    assert [(state.item_id, state.index_status) for state in states] == [
        (document.id, "pending")
    ]

    await _rejected(
        factory, ItemIndexState(item_id=root.id), match="only Document Items have an index state"
    )
    await _rejected(
        factory, ItemIndexState(item_id=document.id), match="pk_item_index_states"
    )
    with pytest.raises(DBAPIError, match="index_status_is_valid"):
        async with factory.begin() as session:
            await session.execute(
                update(ItemIndexState)
                .where(ItemIndexState.item_id == document.id)
                .values(index_status="indexed")
            )


# ── Item shortcuts and contributions ───────────────────────────────────────────


async def test_item_shortcuts_join_a_collection_to_a_document_elsewhere(
    factory: Factory,
) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    root = _collection(tenant_id)
    shelf = _collection(tenant_id, parent=root.id)
    artifacts = _collection(tenant_id, item_type="conversation_artifacts")
    document = _document(tenant_id, root.id)
    attachment = _document(
        tenant_id, root.id, purpose="conversation_attachment"
    )
    foreign_root = _collection(other_tenant_id)
    foreign_document = _document(other_tenant_id, foreign_root.id)
    await _add(
        factory, root, shelf, artifacts, document, attachment, foreign_root, foreign_document
    )

    def link(container: UUID, target: UUID) -> ItemShortcut:
        return ItemShortcut(tenant_id=tenant_id, collection_item_id=container, target_item_id=target)

    await _rejected(factory, link(shelf.id, foreign_document.id), match="shortcut tenant")
    await _rejected(factory, link(document.id, document.id), match="container must be a live Collection")
    await _rejected(factory, link(artifacts.id, document.id), match="conversation_artifacts")
    await _rejected(factory, link(shelf.id, root.id), match="target must be a Document")
    await _rejected(factory, link(shelf.id, attachment.id), match="conversation attachment")
    await _rejected(factory, link(root.id, document.id), match="already lives in the container")

    await _add(factory, link(shelf.id, document.id))
    await _rejected(factory, link(shelf.id, document.id), match="uq_item_shortcuts_live")


async def test_contribution_references_stay_in_the_tenant(factory: Factory) -> None:
    tenant_id, other_tenant_id = await _tenant(factory), await _tenant(factory)
    contributor = await _member(factory, tenant_id)
    root = _collection(tenant_id)
    candidate = _document(tenant_id, root.id, is_published=False)
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
    space = Space(tenant_id=tenant_id, code="s1", space_name="Space", space_type="team")
    deleted_space = Space(
        tenant_id=tenant_id,
        code="s2",
        space_name="Gone",
        space_type="team",
        deleted_at=datetime.now(UTC),
    )
    group = Group(tenant_id=tenant_id, code="g1", group_name="Group")
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
    personal = _collection(tenant_id, item_type="personal", created_by=owner)
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
    space = Space(tenant_id=other_tenant_id, code="s1", space_name="S", space_type="team")
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
