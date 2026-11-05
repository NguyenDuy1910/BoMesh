from __future__ import annotations

import base64
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from bomesh.connector.protocol import BoundingBox, Chunk, CitationInfo, CitationSpan
from bomesh.db.models import (
    AccessSession,
    Base,
    Citation,
    Conversation,
    IntegrationConnection,
    IntegrationCredential,
    Item,
    ItemUpload,
    Message,
    MessageItem,
    SandboxSession,
    User,
)
from bomesh.iam import Authorizer, ItemRef, Principal, WorkspaceAccess, WorkspaceRef
from bomesh.iam.policy import PolicyStore
from bomesh.iam.sync import sync_catalog
from bomesh.services import (
    DocumentNotFoundError,
    SandboxManifestResource,
    SandboxMaterializedFile,
)
from bomesh.services.identity.identity_store import IdentityStoreService
from bomesh.services.knowledge_items.citations import CitationService
from bomesh.services.ingestion.credentials import IntegrationCredentialService
from bomesh.services.knowledge_items.item_store import Cohort, ItemService, revision_object_key
from bomesh.services.conversations.sandbox_session import SandboxSessionService
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="TEST_DATABASE_URL is required for PostgreSQL service integration tests",
)

COLLECTION_OWNER = "roles/collectionOwner"


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert TEST_DATABASE_URL is not None
    schema = f"test_services_{uuid4().hex}"
    admin_engine = create_async_engine(TEST_DATABASE_URL)
    async with admin_engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))

    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"server_settings": {"search_path": schema}},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory.begin() as session:
        await sync_catalog(session)

    try:
        yield factory
    finally:
        await engine.dispose()
        async with admin_engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin_engine.dispose()


async def join_tenant(
    session_factory: async_sessionmaker[AsyncSession],
    session: AsyncSession,
    user: User,
    tenant_id: UUID,
    *,
    role: str = "roles/workspaceMember",
) -> WorkspaceAccess:
    """Admit ``user`` with one workspace role and open a session for them.

    The returned access resolves permissions lazily in its own transactions,
    so it is first used after ``session`` commits.
    """

    await IdentityStoreService(session).assign_membership(user.id, tenant_id)
    authorizer = Authorizer(session_factory)
    await PolicyStore(session, authorizer).add_binding(
        WorkspaceRef(tenant_id), role, f"user:{user.id}"
    )
    access_session = AccessSession(
        user_id=user.id,
        authentication_method="password",
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    session.add(access_session)
    await session.flush()
    return WorkspaceAccess(Principal(user.id, access_session.id), tenant_id, authorizer)


def fresh(
    access: WorkspaceAccess, session_factory: async_sessionmaker[AsyncSession]
) -> WorkspaceAccess:
    """The same caller in a new request: nothing memoized from earlier lookups."""

    return WorkspaceAccess(access.principal, access.workspace_id, Authorizer(session_factory))


async def _document(
    items: ItemService, parent: Item, title: str, document_type: str, owner: User
) -> Item:
    return await items.create_document(
        workspace_id=parent.tenant_id,
        parent=parent,
        title=title,
        document_type=document_type,
        mime_type="application/octet-stream",
        size_bytes=None,
        file_name=title,
        created_by_user_id=owner.id,
    )


async def grant_collection_role(
    session_factory: async_sessionmaker[AsyncSession],
    session: AsyncSession,
    item_id: UUID,
    tenant_id: UUID,
    *,
    user: User,
    role: str,
) -> None:
    """Give a user one Collection role directly through the policy store."""

    await PolicyStore(session, Authorizer(session_factory)).add_binding(
        ItemRef(tenant_id, item_id), role, f"user:{user.id}", created_by=user.id
    )


@pytest.mark.asyncio
async def test_personal_upload_and_message_relation_store_metadata_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("acme", "Acme")
        owner = await auth.create_user("owner@example.com")
        context = await join_tenant(session_factory, session, owner, tenant.id)

        items = ItemService(session)
        personal_id = await items.ensure_personal_collection(tenant.id, owner.id)
        personal = await session.get(Item, personal_id)
        assert personal is not None and personal.inherit_access is False
        item = await items.create_document(
            workspace_id=tenant.id,
            parent=personal,
            title="report.pdf",
            document_type="pdf",
            mime_type="application/pdf",
            size_bytes=100,
            file_name="report.pdf",
            created_by_user_id=owner.id,
            uploader_user_id=owner.id,
        )
        assert item.storage_key == revision_object_key(tenant.id, item.id, 1)
        upload = await session.get(ItemUpload, item.id)
        assert upload is not None and upload.status == "pending"
        assert item.publication_state == "published"

        conversation = Conversation(
            tenant_id=tenant.id,
            code="review",
            owner_user_id=owner.id,
            created_by_session_id=context.session_id,
            title="Review",
        )
        session.add(conversation)
        await session.flush()
        message = Message(
            conversation_id=conversation.id,
            role="user",
            content="Review the attachment",
            sequence_number=1,
        )
        session.add(message)
        await session.flush()

    async with session_factory.begin() as session:
        items = ItemService(session)
        link = await items.link_message(
            message.id,
            item.id,
            "attachment",
            access=context,
        )
        assert link.item_id == item.id
        assert link.relation_type == "attachment"

        stored = await session.get(Item, item.id)
        assert stored is not None
        await items.delete_cohort(Cohort((stored,)))
        deleted = await session.get(Item, item.id)
        assert deleted is not None
        assert deleted.status == "pending"
        assert deleted.deleted_at is not None
        assert await session.scalar(
            select(ItemUpload).where(ItemUpload.item_id == item.id)
        )
        assert await session.scalar(
            select(MessageItem).where(MessageItem.item_id == item.id)
        )



@pytest.mark.asyncio
async def test_sandbox_recovery_state_is_private_to_its_conversation_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        first_tenant = await identity.create_tenant("sandbox-one", "Sandbox one")
        second_tenant = await identity.create_tenant("sandbox-two", "Sandbox two")
        owner = await identity.create_user("owner@sandbox.test")
        other = await identity.create_user("other@sandbox.test")
        owner_access = await join_tenant(session_factory, session, owner, first_tenant.id)
        other_access = await join_tenant(session_factory, session, other, second_tenant.id)
        conversation = Conversation(
            tenant_id=first_tenant.id,
            code="sandbox-work",
            owner_user_id=owner.id,
            created_by_session_id=owner_access.session_id,
            title="Sandbox work",
        )
        session.add(conversation)
        await session.flush()
        conversation_id = conversation.id

    sandboxes = SandboxSessionService(session_factory)
    created = await sandboxes.ensure(
        owner_access, conversation_id=conversation_id, provider="docker"
    )
    bound = await sandboxes.bind_container(
        owner_access, session_id=created.id, container_id="container_1", replaces=None
    )
    recorded = await sandboxes.record_materialization(
        owner_access,
        session_id=created.id,
        container_id="container_1",
        resource=SandboxManifestResource(
            resource_id=str(UUID(int=19)),
            name="revenue.csv",
            mime_type="text/csv",
            size_bytes=12,
        ),
        files=(
            SandboxMaterializedFile(path="revenue.csv", resource_id=str(UUID(int=19))),
        ),
    )
    # A concurrent binder that still believes the session is unbound loses.
    raced = await sandboxes.bind_container(
        owner_access, session_id=created.id, container_id="container_2", replaces=None
    )

    assert bound.container_id == "container_1"
    assert recorded.manifest[0].resource_id == str(UUID(int=19))
    assert raced.container_id == "container_1"
    assert raced.materialized_files == recorded.materialized_files
    async with session_factory() as session:
        row = await session.get(SandboxSession, created.id)
        assert row is not None
        assert row.provider_state == {
            "container_id": "container_1",
            "materialized_files": [
                {"path": "revenue.csv", "resource_id": str(UUID(int=19))}
            ],
        }
    with pytest.raises(DocumentNotFoundError):
        await sandboxes.active(
            other_access, conversation_id=conversation_id, provider="docker"
        )

    assert await sandboxes.active_container_ids(provider="docker") >= {"container_1"}
    expired = await sandboxes.expire_idle(
        provider="docker", idle_before=datetime.now(UTC) + timedelta(seconds=1)
    )
    assert "container_1" in expired
    assert await sandboxes.active(
        owner_access, conversation_id=conversation_id, provider="docker"
    ) is None
    recoverable = await sandboxes.recoverable(
        owner_access, conversation_id=conversation_id, provider="docker"
    )
    assert recoverable is not None
    assert recoverable.manifest == recorded.manifest


@pytest.mark.asyncio
async def test_citations_replace_geometry_by_stable_chunk_identity(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("citations", "Citations")
        owner = await auth.create_user("citations@example.com")
        collection = await ItemService(session).create_collection(
            workspace_id=tenant.id,
            title="Policies",
            created_by_user_id=owner.id,
        )
        document = await _document(ItemService(session), collection, "Policy", "pdf", owner)
        chunks = (
            Chunk(
                id=f"{document.id}:0",
                item_id=str(document.id),
                chunk_index=0,
                chunk_text="First policy paragraph",
                content_type="text",
                section_path=["Policy", "Eligibility"],
                citation=CitationInfo(
                    anchor="eligibility",
                    spans=(
                        CitationSpan(
                            page=2,
                            element_id="p002_para_001",
                            start_offset=0,
                            end_offset=22,
                            bounding_box=BoundingBox(
                                x=0.1,
                                y=0.2,
                                width=0.3,
                                height=0.1,
                            ),
                        ),
                    ),
                ),
            ),
            Chunk(
                id=f"{document.id}:1",
                item_id=str(document.id),
                chunk_index=1,
                chunk_text="Second policy paragraph",
                content_type="text",
                citation=CitationInfo(spans=(CitationSpan(page=4),)),
            ),
        )

        citations = CitationService(session)
        await citations.replace_for_item(document.id, chunks)
        first = await citations.get(document.id, chunks[0].id)
        assert first is not None
        assert first.section_path == ("Policy", "Eligibility")
        assert first.section == "Eligibility"
        assert first.page_start == 2
        assert first.page_end == 2
        assert first.spans[0].bounding_box == BoundingBox(
            x=0.1,
            y=0.2,
            width=0.3,
            height=0.1,
        )

        await citations.replace_for_item(document.id, chunks[:1])
        assert await citations.get(document.id, chunks[1].id) is None
        stale = await session.scalar(
            select(Citation).where(
                Citation.item_id == document.id,
                Citation.chunk_id == chunks[1].id,
            )
        )
        assert stale is not None and stale.deleted_at is not None


@pytest.mark.asyncio
async def test_integration_credentials_are_encrypted_and_owner_models_are_explicit(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("acme", "Acme")
        owner = await auth.create_user("owner@example.com")
        await join_tenant(session_factory, session, owner, tenant.id)

        personal = IntegrationConnection(
            tenant_id=tenant.id,
            code="owner-confluence",
            owner_user_id=owner.id,
            connector_key="confluence",
            display_name="Owner Confluence",
            created_by_user_id=owner.id,
        )
        tenant_owned = IntegrationConnection(
            tenant_id=tenant.id,
            code="company-drive",
            connector_key="google_drive",
            display_name="Company Drive",
            created_by_user_id=owner.id,
        )
        session.add_all([personal, tenant_owned])
        await session.flush()

        encryption_key = base64.urlsafe_b64encode(bytes(range(32))).decode("ascii")
        credentials = IntegrationCredentialService(session, encryption_key)
        record = await credentials.store(
            personal.id,
            credential_type="oauth_grant",
            payload={"access_token": "top-secret", "refresh_token": "refresh-secret"},
            key_version="local-v1",
        )

        assert personal.owner_user_id == owner.id
        assert tenant_owned.owner_user_id is None
        assert "top-secret" not in record.encrypted_payload
        assert "refresh-secret" not in record.encrypted_payload
        assert await credentials.resolve(personal.id) == {
            "access_token": "top-secret",
            "refresh_token": "refresh-secret",
        }
        assert (
            await session.scalar(
                select(IntegrationCredential).where(
                    IntegrationCredential.integration_connection_id == personal.id
                )
            )
            is record
        )


def test_integration_encryption_key_accepts_unpadded_urlsafe_base64() -> None:
    expected = bytes(range(32))
    encryption_key = base64.urlsafe_b64encode(expected).decode("ascii").rstrip("=")

    assert IntegrationCredentialService._decode_key(encryption_key) == expected


def test_postgresql_models_have_no_raw_byte_or_chunk_columns() -> None:
    forbidden_tables = {"documents", "document_blobs", "document_chunks"}
    assert forbidden_tables.isdisjoint(Base.metadata.tables)
    # Only a request digest and a sealed secret are binary; no content bytes.
    assert {
        (table.name, column.name)
        for table in Base.metadata.tables.values()
        for column in table.columns
        if column.type.__class__.__name__.casefold() in {"largebinary", "bytea"}
    } == {
        ("platform_connector_settings", "oauth_client_secret_encrypted"),
        ("request_idempotency", "request_hash"),
    }


