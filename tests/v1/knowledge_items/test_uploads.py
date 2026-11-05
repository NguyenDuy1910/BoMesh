"""CompleteItemUpload, CreateItemMedia and the upload format rules of the Knowledge interface."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID, uuid4

import pytest

from bomesh.db.models import Item
from bomesh.storage import ObjectStorageError
from knowledge_support import error_reason, item_name, item_url, upload, ws_url

pytestmark = pytest.mark.asyncio

EDITOR = "roles/collectionEditor"
VIEWER = "roles/collectionViewer"

PDF = b"%PDF-1.7 ten"  # 12 bytes
PNG = b"\x89PNG\r\n\x1a\nfake-image"
ZIP = b"PK\x03\x04fake-archive"


def item_id(body: dict[str, Any]) -> UUID:
    return UUID(body["name"].rsplit("/", 1)[1])


def status_of(response: Any) -> str:
    return response.json()["error"]["status"]


async def create_pending(
    api: Any, parent: Item, *, size: int = len(PDF), mime_type: str = "application/pdf"
) -> dict[str, Any]:
    response = await api.post(
        f"{ws_url(parent.tenant_id)}/items",
        json={
            "itemType": "DOCUMENT",
            "displayName": "Policy",
            "parentItem": item_name(parent),
            "document": {"mimeType": mime_type, "sizeBytes": str(size), "fileName": "policy.pdf"},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


async def complete(api: Any, document: Item | dict[str, Any], **body: Any) -> Any:
    url = (
        item_url(document)
        if isinstance(document, Item)
        else f"/api/v1/{document['name']}"
    )
    return await api.post(f"{url}:completeUpload", json=body)


async def media(api: Any, parent: Item, metadata: dict[str, Any], data: bytes, mime: str) -> Any:
    return await api.post(
        f"/upload/api/v1/workspaces/{parent.tenant_id}/items",
        data={"metadata": json.dumps(metadata)},
        files={"file": (metadata["document"].get("fileName", "file"), data, mime)},
    )


async def editor_world(world: Any) -> tuple[Any, Any, Item]:
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={editor: EDITOR})
    return ws, editor, root


# -- CompleteItemUpload ------------------------------------------------------------


async def test_complete_before_the_object_exists_is_upload_incomplete(client, world, knowledge):
    _, editor, root = await editor_world(world)
    api = await client.as_(editor)
    document = await create_pending(api, root)

    response = await complete(api, document)

    assert response.status_code == 400, response.text
    assert status_of(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "UPLOAD_INCOMPLETE"
    row = await knowledge.row(item_id(document))
    assert row.status == "pending"
    assert await knowledge.revisions(row) == []


async def test_complete_after_upload_makes_document_available_with_revision_one(
    client, world, knowledge, fakes
):
    _, editor, root = await editor_world(world)
    api = await client.as_(editor)
    document = await create_pending(api, root)
    row = await knowledge.row(item_id(document))
    fakes.storage.put_bytes(PDF, row.storage_key, content_type="application/pdf")

    response = await complete(api, document)

    assert response.status_code == 200, response.text
    facet = response.json()["document"]
    assert facet["contentState"] == "AVAILABLE"
    assert facet["publicationState"] == "PUBLISHED"
    assert facet["indexingState"] == "PENDING"
    assert facet["sizeBytes"] == str(len(PDF))
    assert facet["revision"] == f"{document['name']}/revisions/1"
    assert "uploadUri" not in facet
    revisions = await knowledge.revisions(row)
    assert [revision.revision_number for revision in revisions] == [1]
    assert revisions[0].storage_key == row.storage_key
    assert revisions[0].size_bytes == len(PDF)
    assert (await knowledge.row(row)).status == "ready"


async def test_complete_is_idempotent_for_an_available_document(client, world, knowledge, fakes):
    _, editor, root = await editor_world(world)
    api = await client.as_(editor)
    document = await create_pending(api, root)
    row = await knowledge.row(item_id(document))
    fakes.storage.put_bytes(PDF, row.storage_key, content_type="application/pdf")

    first = await complete(api, document)
    second = await complete(api, document)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["document"]["contentState"] == "AVAILABLE"
    assert second.json()["etag"] == first.json()["etag"]
    assert second.json()["updateTime"] == first.json()["updateTime"]
    assert len(await knowledge.revisions(row)) == 1


async def test_complete_by_someone_other_than_the_creator_is_denied(
    client, world, knowledge, fakes
):
    ws, editor, root = await editor_world(world)
    colleague = await world.add_member(ws)
    await world.grant(colleague, EDITOR, on=root)
    document = await create_pending(await client.as_(editor), root)
    row = await knowledge.row(item_id(document))
    fakes.storage.put_bytes(PDF, row.storage_key, content_type="application/pdf")

    response = await complete(await client.as_(colleague), document)

    assert response.status_code == 403, response.text
    assert status_of(response) == "PERMISSION_DENIED"
    assert (await knowledge.row(row)).status == "pending"


async def test_complete_on_a_collection_is_failed_precondition(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)

    response = await complete(await client.as_(admin), root)

    assert response.status_code == 400, response.text
    assert status_of(response) == "FAILED_PRECONDITION"


async def test_complete_with_size_mismatch_marks_content_failed(client, world, knowledge, fakes):
    _, editor, root = await editor_world(world)
    api = await client.as_(editor)
    document = await create_pending(api, root, size=len(PDF) + 5)
    row = await knowledge.row(item_id(document))
    fakes.storage.put_bytes(PDF, row.storage_key, content_type="application/pdf")

    response = await complete(api, document)

    assert response.status_code == 200, response.text
    assert response.json()["document"]["contentState"] == "FAILED"
    assert (await knowledge.row(row)).status == "failed"
    assert await knowledge.revisions(row) == []


async def test_complete_with_stale_etag_is_aborted(client, world, knowledge, fakes):
    _, editor, root = await editor_world(world)
    api = await client.as_(editor)
    document = await create_pending(api, root)
    row = await knowledge.row(item_id(document))
    renamed = await api.patch(
        item_url(row), params={"updateMask": "displayName"}, json={"displayName": "Renamed"}
    )
    assert renamed.status_code == 200, renamed.text
    fakes.storage.put_bytes(PDF, row.storage_key, content_type="application/pdf")

    response = await complete(api, document, etag=document["etag"])

    assert response.status_code == 409, response.text
    assert status_of(response) == "ABORTED"
    assert (await knowledge.row(row)).status == "pending"


async def test_complete_while_a_contribution_is_open_is_rejected(
    client, world, knowledge, fakes
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    personal = await world.make_collection(ws, personal_for=member)
    target = await world.make_collection(ws)
    api = await client.as_(member)
    document = await create_pending(api, personal)
    row = await knowledge.row(item_id(document))
    await world.make_contribution(row, contributor=member, target=target)
    fakes.storage.put_bytes(PDF, row.storage_key, content_type="application/pdf")

    response = await complete(api, document)

    assert response.status_code == 400, response.text
    assert status_of(response) == "FAILED_PRECONDITION"
    assert error_reason(response) == "CONTRIBUTION_OPEN"
    assert (await knowledge.row(row)).status == "pending"


# -- CreateItemMedia -----------------------------------------------------------------


async def test_media_upload_stores_bytes_and_records_revision_one(client, world, knowledge, fakes):
    _, editor, root = await editor_world(world)
    api = await client.as_(editor)

    response = await upload(api, root, data=b"hello knowledge", file_name="notes.txt")

    assert response.status_code == 200, response.text
    body = response.json()
    facet = body["document"]
    assert body["parentItem"] == item_name(root)
    assert facet["contentState"] == "AVAILABLE"
    assert facet["publicationState"] == "PUBLISHED"
    assert facet["indexingState"] == "PENDING"
    assert facet["documentType"] == "plain_text"
    assert facet["mimeType"] == "text/plain"
    assert facet["fileName"] == "notes.txt"
    assert facet["sizeBytes"] == str(len(b"hello knowledge"))
    assert facet["revision"] == f"{body['name']}/revisions/1"
    assert "uploadUri" not in facet
    row = await knowledge.row(item_id(body))
    assert fakes.storage.objects[row.storage_key].data == b"hello knowledge"
    revisions = await knowledge.revisions(row)
    assert [revision.revision_number for revision in revisions] == [1]


async def test_media_upload_derives_document_type_from_mime_type(client, world):
    _, editor, root = await editor_world(world)
    api = await client.as_(editor)

    pdf = await upload(api, root, data=PDF, file_name="policy.pdf", mime_type="application/pdf")
    markdown = await upload(api, root, data=b"# Title", file_name="readme.md", mime_type="text/markdown")

    assert pdf.status_code == 200, pdf.text
    assert pdf.json()["document"]["documentType"] == "pdf"
    assert markdown.status_code == 200, markdown.text
    assert markdown.json()["document"]["documentType"] == "markdown"


async def test_media_upload_size_mismatch_is_invalid(client, world, fakes):
    _, editor, root = await editor_world(world)
    metadata = {
        "itemType": "DOCUMENT",
        "displayName": "notes.txt",
        "parentItem": item_name(root),
        "document": {"mimeType": "text/plain", "fileName": "notes.txt", "sizeBytes": "999"},
    }

    response = await media(await client.as_(editor), root, metadata, b"short", "text/plain")

    assert response.status_code == 400, response.text
    assert status_of(response) == "INVALID_ARGUMENT"
    assert fakes.storage.objects == {}


async def test_media_upload_needs_items_create_on_parent(client, world, fakes):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    stranger = await world.add_member(ws)
    root = await world.make_collection(ws, grants={viewer: VIEWER})

    as_viewer = await upload(await client.as_(viewer), root)
    as_stranger = await upload(await client.as_(stranger), root)

    for response in (as_viewer, as_stranger):
        assert response.status_code == 403, response.text
        assert status_of(response) == "PERMISSION_DENIED"
    assert fakes.storage.objects == {}


async def test_media_upload_with_same_request_id_and_file_replays(client, world, fakes):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    api = await client.as_(admin)
    request_id = uuid4()

    first = await upload(api, root, request_id=request_id)
    second = await upload(api, root, request_id=request_id)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["name"] == first.json()["name"]
    children = await api.get(
        f"{ws_url(ws)}/items", params={"filter": f'parentItem="{item_name(root)}"'}
    )
    assert [item["name"] for item in children.json()["items"]] == [first.json()["name"]]
    assert len(fakes.storage.objects) == 1


async def test_media_upload_with_reused_request_id_and_other_file_is_rejected(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    api = await client.as_(admin)
    request_id = uuid4()

    first = await upload(api, root, data=b"first version", request_id=request_id)
    second = await upload(api, root, data=b"second version", request_id=request_id)

    assert first.status_code == 200, first.text
    assert second.status_code == 400, second.text
    assert error_reason(second) == "REQUEST_ID_REUSED"


# -- Formats -------------------------------------------------------------------------


async def test_image_as_knowledge_is_not_allowed(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    api = await client.as_(admin)

    via_media = await upload(api, root, data=PNG, file_name="photo.png", mime_type="image/png")
    via_create = await api.post(
        f"{ws_url(ws)}/items",
        json={
            "itemType": "DOCUMENT",
            "displayName": "photo.png",
            "parentItem": item_name(root),
            "document": {"mimeType": "image/png", "sizeBytes": "10", "fileName": "photo.png"},
        },
    )

    for response in (via_media, via_create):
        assert response.status_code == 400, response.text
        assert status_of(response) == "INVALID_ARGUMENT"
        assert error_reason(response) == "FORMAT_NOT_ALLOWED"


async def test_attachment_outside_own_personal_collection_is_not_allowed(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    root = await world.make_collection(ws)
    members_personal = await world.make_collection(ws, personal_for=member)
    api = await client.as_(admin)

    for parent in (root, members_personal):
        response = await upload(
            api,
            parent,
            data=PNG,
            file_name="photo.png",
            mime_type="image/png",
            purpose="CONVERSATION_ATTACHMENT",
        )
        assert response.status_code == 400, response.text
        assert error_reason(response) == "FORMAT_NOT_ALLOWED"


async def test_image_attachment_in_own_personal_collection_is_unsupported(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    personal = await world.make_collection(ws, personal_for=member)

    response = await upload(
        await client.as_(member),
        personal,
        data=PNG,
        file_name="photo.png",
        mime_type="image/png",
        purpose="CONVERSATION_ATTACHMENT",
    )

    assert response.status_code == 200, response.text
    facet = response.json()["document"]
    assert facet["purpose"] == "CONVERSATION_ATTACHMENT"
    assert facet["contentState"] == "AVAILABLE"
    assert facet["indexingState"] == "UNSUPPORTED"
    assert facet["documentType"] == "image"


async def test_archive_only_into_standard_collections(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    member = await world.add_member(ws)
    personal = await world.make_collection(ws, personal_for=member)
    root = await world.make_collection(ws, grants={member: EDITOR})
    api = await client.as_(member)

    into_personal = await upload(
        api, personal, data=ZIP, file_name="bundle.zip", mime_type="application/zip"
    )
    into_standard = await upload(
        api, root, data=ZIP, file_name="bundle.zip", mime_type="application/zip"
    )

    assert into_personal.status_code == 400, into_personal.text
    assert error_reason(into_personal) == "FORMAT_NOT_ALLOWED"
    assert into_standard.status_code == 200, into_standard.text
    facet = into_standard.json()["document"]
    assert facet["contentState"] == "AVAILABLE"
    assert facet["indexingState"] == "PENDING"


async def test_media_upload_storage_failure_marks_content_failed_and_retry_recovers(
    client, world, fakes, monkeypatch
):
    _, editor, root = await editor_world(world)
    api = await client.as_(editor)
    request_id = uuid4()
    store = fakes.storage.put_bytes

    def unavailable(*args: Any, **kwargs: Any) -> Any:
        raise ObjectStorageError("storage is down")

    monkeypatch.setattr(fakes.storage, "put_bytes", unavailable)
    failed = await upload(api, root, request_id=request_id)

    assert failed.status_code == 503, failed.text
    assert status_of(failed) == "UNAVAILABLE"
    children = await api.get(
        f"{ws_url(root.tenant_id)}/items", params={"filter": f'parentItem="{item_name(root)}"'}
    )
    [orphan] = children.json()["items"]
    assert orphan["document"]["contentState"] == "FAILED"

    monkeypatch.setattr(fakes.storage, "put_bytes", store)
    retried = await upload(api, root, request_id=request_id)

    assert retried.status_code == 200, retried.text
    assert retried.json()["name"] == orphan["name"]
    assert retried.json()["document"]["contentState"] == "AVAILABLE"
