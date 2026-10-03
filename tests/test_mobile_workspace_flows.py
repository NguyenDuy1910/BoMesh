"""Consumer contracts exercised by the Flutter workspace client."""
from __future__ import annotations

from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from sqlalchemy import select

from api.routers import ApprovalRequest as ApprovalResponse
from api.routers import Group as GroupResponse, GroupCreate, GroupUpdate, Role as RoleResponse, RoleCreate
from bothesis.db.models import Item, Role, User
from bothesis.document_index import ItemIndex
from bothesis.services import AuthorizationError, DocumentNotFoundError
from bothesis.services.approval_request import ApprovalRequestService
from bothesis.services.identity_access.authorization import AuthorizationService
from bothesis.services.identity_access.identity_store import IdentityStoreService
from bothesis.services.identity_access.roles import RoleService
from bothesis.services.item import ItemService
from bothesis.services.item_catalog import ItemCatalogService
from bothesis.services.item_ingestion import ItemIngestionService
from bothesis.services.workspace_control_plane import WorkspaceControlPlaneService
from config import VectorIndexConfig
from test_db_services import (
    TEST_DATABASE_URL,
    _collection_upload_contexts,
    _UploadStorage,
    _uploads,
    join_tenant,
    session_factory,
)

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL required"),
]


async def test_collection_read_and_editor_updates_do_not_require_workspace_administration(session_factory):
    collection_id, editor, viewer, outsider = await _collection_upload_contexts(session_factory)
    async with session_factory.begin() as session:
        catalog = ItemCatalogService(session)
        visible = await catalog.get_collection(viewer, collection_id)
        assert "collection.read" in visible["permissions"]
        assert "collection.update" not in visible["permissions"]
        edited = await catalog.update_collection(editor, collection_id, title="Updated by editor")
        assert edited["title"] == "Updated by editor"
        assert "collection.update" in edited["permissions"]
        with pytest.raises(AuthorizationError):
            await catalog.update_collection(viewer, collection_id, title="Unauthorized")
        with pytest.raises((AuthorizationError, DocumentNotFoundError)):
            await catalog.get_collection(outsider, collection_id)
        listed = await catalog.list_collections(viewer)
        assert str(collection_id) in {item["id"] for item in listed["items"]}
        assert (await catalog.list_collections(outsider))["items"] == []


async def test_requester_can_read_and_cancel_own_request_without_review_capability(session_factory):
    collection_id, editor, viewer, outsider = await _collection_upload_contexts(session_factory)
    async with session_factory.begin() as session:
        approvals = ApprovalRequestService(session)
        created = await approvals.create_request(
            viewer, request_type="resource_access", target_id=str(collection_id),
            details={"role": "collection_editor"}, reason="Maintain team knowledge",
        )
        response = ApprovalResponse.model_validate(created)
        assert response.requester.id == viewer.user_id
        assert response.requested_role.code == "collection_editor"
        own = await approvals.list_requests(viewer)
        assert [item["id"] for item in own["items"]] == [created["id"]]
        assert (await approvals.list_requests(editor))["items"] == []
        assert (await approvals.list_requests(outsider))["items"] == []
        request_id = UUID(created["id"])
        with pytest.raises(AuthorizationError):
            await approvals.update_request(viewer, request_id, status="approved")
        result = await approvals.update_request(viewer, request_id, status="cancelled")
        assert ApprovalResponse.model_validate(result).status == "cancelled"


async def test_collection_editor_can_delete_another_uploaders_knowledge(session_factory):
    collection_id, editor, viewer, _ = await _collection_upload_contexts(session_factory)
    async with session_factory.begin() as session:
        owner_id = (await session.get(Item, collection_id)).created_by_user_id
        document, _ = await ItemService(session).create_or_get_collection_upload(
            owner_id, editor.tenant_id, collection_id,
            idempotency_key="knowledge-delete", file_name="policy.txt",
            mime_type="text/plain", size_bytes=10, document_type="plain_text",
            metadata={"purpose": "knowledge"},
        )
        document_id = document.id
    ingestion = ItemIngestionService(
        session_factory, index=AsyncMock(spec=ItemIndex),
    )
    documents = _uploads(session_factory, _UploadStorage(), ingestion=ingestion)
    with pytest.raises(AuthorizationError):
        await documents.delete_document(viewer, document_id)
    await documents.delete_document(editor, document_id)
    async with session_factory() as session:
        with pytest.raises(DocumentNotFoundError):
            await AuthorizationService(session).require_item(document_id, access=viewer)
        removed = await session.get(Item, document_id)
        assert removed.deleted_at is not None
        assert removed.status == "deleted"
    assert (await documents.list_documents(viewer, collection_id=collection_id))["total"] == 0


async def test_private_attachment_cannot_be_deleted_by_workspace_admin(session_factory):
    collection_id, owner, _, _ = await _collection_upload_contexts(session_factory)
    async with session_factory.begin() as session:
        admin_id = (await session.get(Item, collection_id)).created_by_user_id
        admin = await IdentityStoreService(session).get_context(
            admin_id, tenant_id=owner.tenant_id,
        )
        items = ItemService(session)
        personal_id = await items.ensure_personal_collection(
            owner.user_id, owner.tenant_id,
            collection_id=items.upload_collection_id(owner.tenant_id, owner.user_id),
            title="My attachments", system_kind="personal_uploads",
        )
        document, _ = await items.create_or_get_collection_upload(
            owner.user_id, owner.tenant_id, personal_id,
            idempotency_key="private-delete", file_name="draft.txt",
            mime_type="text/plain", size_bytes=10, document_type="plain_text",
            metadata={"purpose": "conversation_attachment"},
        )
        document_id = document.id
    ingestion = ItemIngestionService(
        session_factory, index=AsyncMock(spec=ItemIndex),
    )
    documents = _uploads(session_factory, _UploadStorage(), ingestion=ingestion)
    with pytest.raises((AuthorizationError, DocumentNotFoundError)):
        await documents.delete_document(admin, document_id)
    async with session_factory() as session:
        retained = await AuthorizationService(session).require_item(document_id, access=owner)
        assert retained.deleted_at is None
    await documents.delete_document(owner, document_id)
    async with session_factory() as session:
        with pytest.raises(DocumentNotFoundError):
            await AuthorizationService(session).require_item(document_id, access=owner)


async def test_nested_collection_creation_needs_parent_update_not_just_item_manage(session_factory):
    collection_id, editor, viewer, _ = await _collection_upload_contexts(session_factory)
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        for member in (editor, viewer):
            await join_tenant(
                session, await session.get(User, member.user_id), member.tenant_id,
                role_code="collection-creator", permission_codes=("item.manage",),
            )
        creator = await identity.get_context(viewer.user_id, tenant_id=viewer.tenant_id)
        writer = await identity.get_context(editor.user_id, tenant_id=editor.tenant_id)
        catalog = ItemCatalogService(session)
        with pytest.raises(AuthorizationError):
            await catalog.create_collection(creator, title="Forbidden child", parent_item_id=collection_id)
        child = await catalog.create_collection(writer, title="Allowed child", parent_item_id=collection_id)
    async with session_factory() as session:
        catalog = ItemCatalogService(session)
        children = await catalog.list_collections(creator)
        assert {item["title"] for item in children["items"]} == {"Upload destination", "Allowed child"}
        assert (await catalog.get_collection(writer, UUID(child["id"])))["parent_item_id"] == str(collection_id)


async def test_group_patch_distinguishes_omission_from_null_and_keeps_member_metadata(session_factory):
    collection_id, member, _, _ = await _collection_upload_contexts(session_factory)
    async with session_factory.begin() as session:
        admin_id = (await session.get(Item, collection_id)).created_by_user_id
        admin = await IdentityStoreService(session).get_context(admin_id, tenant_id=member.tenant_id)
    control = WorkspaceControlPlaneService(session_factory, vector_index=VectorIndexConfig())
    created = await control.create_group(
        admin, {"code": "editors", "display_name": "Editors", "description": "Knowledge editors"},
    )
    group_id = UUID(created["id"])
    populated = GroupResponse.model_validate(
        await control.replace_group_members(admin, group_id, [member.user_id]),
    )
    joined_at = populated.members[0].joined_at
    await control.update_group(
        admin, group_id, GroupUpdate(display_name="Team editors").model_dump(exclude_unset=True),
    )
    assert GroupResponse.model_validate(await control.get_group(admin, group_id)).description == "Knowledge editors"
    await control.update_group(
        admin, group_id, GroupUpdate(description=None).model_dump(exclude_unset=True),
    )
    async with session_factory.begin() as session:
        account = await session.get(User, member.user_id)
        account.display_name = "Current member name"
    loaded = GroupResponse.model_validate(await control.get_group(admin, group_id))
    assert loaded.description is None
    assert loaded.member_count == 1
    assert loaded.members[0].id == member.user_id
    assert loaded.members[0].email == "upload-editor@example.com"
    assert loaded.members[0].display_name == "Current member name"
    assert loaded.members[0].joined_at == joined_at
    assert joined_at is not None


async def test_roles_and_groups_are_created_by_name_alone(session_factory):
    collection_id, member, _, _ = await _collection_upload_contexts(session_factory)
    async with session_factory.begin() as session:
        admin_id = (await session.get(Item, collection_id)).created_by_user_id
        admin = await IdentityStoreService(session).get_context(admin_id, tenant_id=member.tenant_id)
    control = WorkspaceControlPlaneService(session_factory, vector_index=VectorIndexConfig())

    first = await control.create_role(
        admin, RoleCreate(display_name="Quản lý tài liệu", permission_codes=["knowledge.read"]).model_dump(),
    )
    second = await control.create_role(
        admin, RoleCreate(display_name="Quản lý tài liệu", permission_codes=["knowledge.read"]).model_dump(),
    )
    assert (first["code"], second["code"]) == ("quan-ly-tai-lieu", "quan-ly-tai-lieu-2")

    groups = [
        await control.create_group(admin, GroupCreate(display_name="Đội Kế toán").model_dump())
        for _ in range(2)
    ]
    assert [group["code"] for group in groups] == ["doi-ke-toan", "doi-ke-toan-2"]

    # A disabled custom role stays listed below, so it can be enabled again.
    renamed = await control.update_role(admin, UUID(second["id"]), {"display_name": "Biên tập"})
    disabled = await control.update_role(admin, UUID(second["id"]), {"status": "inactive"})
    assert (renamed["display_name"], disabled["status"]) == ("Biên tập", "inactive")

    async with session_factory.begin() as session:
        retired = await session.scalar(select(Role).where(Role.code == "tenant_member", Role.tenant_id.is_(None)))
        retired.status = "inactive"
    listed = await control.list_roles(admin, page_size=100)
    codes = {role["code"] for role in listed["items"]}
    assert "tenant_member" not in codes
    assert {"quan-ly-tai-lieu", "quan-ly-tai-lieu-2"} <= codes


async def test_role_response_counts_assignments_and_approval_grants_requested_access(session_factory):
    collection_id, _, requester, _ = await _collection_upload_contexts(session_factory)
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        admin_id = (await session.get(Item, collection_id)).created_by_user_id
        admin = await identity.get_context(admin_id, tenant_id=requester.tenant_id)
        roles = RoleService(session)
        created = RoleResponse.model_validate(await roles.create_role(
            admin, code="read-knowledge", display_name="Knowledge reader",
            permission_codes=["knowledge.read"],
        ))
        await join_tenant(
            session, await session.get(User, requester.user_id), requester.tenant_id,
            role_code=created.code,
        )
    async with session_factory.begin() as session:
        role = RoleResponse.model_validate(await RoleService(session).get_role(admin, created.id))
        assert role.member_count == 1
        assert role.scope_type == "tenant"
        assert role.is_system is False
        assert role.permission_codes == ["knowledge.read"]
        requester = await IdentityStoreService(session).get_context(
            requester.user_id, tenant_id=requester.tenant_id,
        )
        assert requester.has_permissions("knowledge.read")
        approvals = ApprovalRequestService(session)
        request = ApprovalResponse.model_validate(await approvals.create_request(
            requester, request_type="resource_access", target_id=str(collection_id),
            details={"role": "collection_editor"}, reason="Maintain team knowledge",
        ))
        with pytest.raises(AuthorizationError):
            await ItemCatalogService(session).update_collection(requester, collection_id, title="Too soon")
        decided = ApprovalResponse.model_validate(await approvals.update_request(
            admin, request.id, status="approved", decision_note="Granted for maintenance",
        ))
        assert decided.decided_by_user_id == admin.user_id
        assert decided.decided_at is not None
        assert decided.requested_role.code == "collection_editor"
        assert decided.requester.id == requester.user_id
    async with session_factory.begin() as session:
        approved = ApprovalResponse.model_validate(
            await ApprovalRequestService(session).get_request(requester, request.id),
        )
        assert approved.status == "approved"
        assert approved.decision_note == "Granted for maintenance"
        updated = await ItemCatalogService(session).update_collection(
            requester, collection_id, title="Approved maintenance",
        )
        assert updated["title"] == "Approved maintenance"
        revised = RoleResponse.model_validate(await RoleService(session).update_role(
            admin, created.id, display_name="Collection-only reader", permission_codes=[],
        ))
        assert revised.member_count == 1
        assert revised.permission_codes == []
    async with session_factory() as session:
        current = await IdentityStoreService(session).get_context(
            requester.user_id, tenant_id=requester.tenant_id,
        )
        assert not current.has_permissions("knowledge.read")
        assert "collection.update" in (
            await ItemCatalogService(session).get_collection(current, collection_id)
        )["permissions"]
