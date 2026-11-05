"""Revisions, rollback, reader content and passages of documents (``item_model.md`` §4.8–§4.10)."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.services.knowledge_items.item_store import ItemService
from knowledge_support import chunk_id, error_reason, item_name, item_url, upload

pytestmark = pytest.mark.asyncio


# -- Helpers -------------------------------------------------------------------------


async def _setup(world: Any, client: Any) -> tuple[Any, Any, Any, Any]:
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    collection = await world.make_collection(ws)
    return admin, ws, collection, await client.as_(admin)


async def _uploaded(api: Any, knowledge: Any, parent: Item, **kwargs: Any) -> Item:
    response = await upload(api, parent, **kwargs)
    assert response.status_code == 200, response.text
    return await knowledge.row(UUID(response.json()["name"].split("/")[-1]))


async def _viewer(world: Any, client: Any, ws: Any, collection: Item) -> Any:
    user = await world.add_member(ws)
    await world.grant(user, "roles/collectionViewer", on=collection)
    return await client.as_(user)


async def _append(
    sessions: Any,
    fakes: Any,
    document: Item,
    *,
    data: bytes,
    file_name: str,
    mime_type: str = "application/pdf",
) -> int:
    """Store a new original and append it as the document's newest revision."""
    async with transaction_scope(sessions) as session:
        row = await session.get(Item, document.id)
        assert row is not None
        number = len(await _numbers(session, document)) + 1
        key = f"tenants/{row.tenant_id}/items/{row.id}/revisions/{number}/original"
        fakes.storage.put_bytes(data, key, content_type=mime_type)
        revision = await ItemService(session).append_revision(
            row, storage_key=key, mime_type=mime_type, size_bytes=len(data), file_name=file_name
        )
        return revision.revision_number


async def _numbers(session: Any, document: Item) -> list[int]:
    return list(
        await session.scalars(
            select(ItemRevision.revision_number).where(ItemRevision.item_id == document.id)
        )
    )


async def _set_metadata(sessions: Any, item: Item, **values: Any) -> None:
    async with transaction_scope(sessions) as session:
        row = await session.get(Item, item.id)
        assert row is not None
        row.metadata_ = {**row.metadata_, **values}


async def _write_preview(sessions: Any, document: Item, number: int, manifest: dict[str, Any]) -> None:
    async with transaction_scope(sessions) as session:
        revision = await session.scalar(
            select(ItemRevision).where(
                ItemRevision.item_id == document.id, ItemRevision.revision_number == number
            )
        )
        assert revision is not None
        revision.exports = {**revision.exports, "preview": manifest}


def _prefix(document: Item) -> str:
    return f"tenants/{document.tenant_id}/items/{document.id}/previews/"


def _manifest(document: Item, *, rendition: bool = True) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "source_version": "source-v1",
        "representation": "pages",
        "assets": [
            {
                "key": f"{_prefix(document)}pages/1.webp",
                "content_type": "image/webp",
                "size_bytes": 120,
                "width": 800,
                "height": 1100,
                "page": 1,
            }
        ],
        "page_count": 1,
    }
    if rendition:
        manifest["rendition"] = {
            "key": f"{_prefix(document)}document-v1/source-v1/document.json.gz",
            "size_bytes": 512,
            "version": "document-v1",
            "block_count": 4,
        }
    return manifest


def _revision(document: Item, number: int) -> str:
    return f"{item_name(document)}/revisions/{number}"


# -- ListItemRevisions / GetItemRevision ----------------------------------------------


async def test_list_revisions_newest_first_with_paging(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"second version", file_name="v2.pdf")
    await _append(sessions, fakes, document, data=b"third version!", file_name="v3.pdf")

    first = await api.get(item_url(document, "/revisions"), params={"pageSize": 2})
    assert first.status_code == 200, first.text
    body = first.json()
    assert [r["name"] for r in body["revisions"]] == [_revision(document, 3), _revision(document, 2)]
    assert body["revisions"][0]["mimeType"] == "application/pdf"
    assert int(body["revisions"][0]["sizeBytes"]) == len(b"third version!")
    assert body.get("nextPageToken")

    second = await api.get(
        item_url(document, "/revisions"), params={"pageSize": 2, "pageToken": body["nextPageToken"]}
    )
    assert second.status_code == 200, second.text
    assert [r["name"] for r in second.json()["revisions"]] == [_revision(document, 1)]
    assert not second.json().get("nextPageToken")


async def test_list_revisions_of_collection_is_invalid(client, world):
    _, _, collection, api = await _setup(world, client)
    response = await api.get(item_url(collection, "/revisions"))
    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"


async def test_list_revisions_needs_read_access(client, world, knowledge):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    outsider = await client.as_(await world.add_member(ws))
    response = await outsider.get(item_url(document, "/revisions"))
    assert response.status_code == 403, response.text

    viewer = await _viewer(world, client, ws, collection)
    response = await viewer.get(item_url(document, "/revisions"))
    assert response.status_code == 200, response.text
    assert [r["name"] for r in response.json()["revisions"]] == [_revision(document, 1)]


async def test_get_revision_and_missing_revision(client, world, knowledge, sessions, fakes):
    admin, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"second version", file_name="v2.pdf")

    response = await api.get(item_url(document, "/revisions/2"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == _revision(document, 2)
    assert body["mimeType"] == "application/pdf"
    assert int(body["sizeBytes"]) == len(b"second version")
    assert body.get("restoredFrom") is None

    first = await api.get(item_url(document, "/revisions/1"))
    assert first.status_code == 200, first.text
    assert first.json()["mimeType"] == "text/plain"
    assert first.json()["creator"] == f"workspaces/{document.tenant_id}/members/{admin.id}"

    missing = await api.get(item_url(document, "/revisions/9"))
    assert missing.status_code == 404, missing.text


# -- RollbackItem ---------------------------------------------------------------------


async def test_rollback_reuses_the_older_object(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    data = b"original text content"
    document = await _uploaded(api, knowledge, collection, data=data, file_name="notes.txt")
    await _append(sessions, fakes, document, data=b"%PDF newer", file_name="newer.pdf")
    await knowledge.index(document, ["newer content"])
    objects = dict(fakes.storage.objects)

    response = await api.post(item_url(document, "/revisions/1:rollback"), json={})
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["document"]["revision"] == _revision(document, 3)
    assert item["document"]["mimeType"] == "text/plain"
    assert int(item["document"]["sizeBytes"]) == len(data)
    assert item["document"]["fileName"] == "notes.txt"
    assert item["document"]["indexingState"] == "PENDING"

    revisions = await knowledge.revisions(document)
    assert [r.revision_number for r in revisions] == [1, 2, 3]
    assert revisions[2].storage_key == revisions[0].storage_key
    assert revisions[2].restored_from == 1
    assert fakes.storage.objects.keys() == objects.keys()
    assert (await knowledge.row(document)).storage_key == revisions[0].storage_key

    restored = await api.get(item_url(document, "/revisions/3"))
    assert restored.status_code == 200, restored.text
    assert restored.json()["restoredFrom"] == _revision(document, 1)
    assert restored.json()["mimeType"] == "text/plain"


async def test_rollback_to_current_revision_fails(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"%PDF newer", file_name="newer.pdf")

    response = await api.post(item_url(document, "/revisions/2:rollback"), json={})
    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert [r.revision_number for r in await knowledge.revisions(document)] == [1, 2]


async def test_rollback_missing_revision_is_not_found(client, world, knowledge):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    response = await api.post(item_url(document, "/revisions/7:rollback"), json={})
    assert response.status_code == 404, response.text


async def test_rollback_with_stale_etag_is_aborted(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    stale = (await api.get(item_url(document))).json()["etag"]
    await _append(sessions, fakes, document, data=b"%PDF newer", file_name="newer.pdf")

    response = await api.post(item_url(document, "/revisions/1:rollback"), json={"etag": stale})
    assert response.status_code == 409, response.text
    assert [r.revision_number for r in await knowledge.revisions(document)] == [1, 2]


async def test_rollback_of_source_managed_document(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"%PDF newer", file_name="newer.pdf")
    await _set_metadata(sessions, document, source={"external_id": "drive-file-1"})

    response = await api.post(item_url(document, "/revisions/1:rollback"), json={})
    assert response.status_code == 400, response.text
    assert error_reason(response) == "SOURCE_MANAGED"
    assert [r.revision_number for r in await knowledge.revisions(document)] == [1, 2]


async def test_rollback_while_contribution_open(client, world, knowledge, sessions, fakes):
    admin, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"%PDF newer", file_name="newer.pdf")
    await world.make_contribution(document, contributor=admin, target=collection)

    response = await api.post(item_url(document, "/revisions/1:rollback"), json={})
    assert response.status_code == 400, response.text
    assert error_reason(response) == "CONTRIBUTION_OPEN"


async def test_rollback_needs_publish_permission(client, world, knowledge, sessions, fakes):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"%PDF newer", file_name="newer.pdf")
    viewer = await _viewer(world, client, ws, collection)

    response = await viewer.post(item_url(document, "/revisions/1:rollback"), json={})
    assert response.status_code == 403, response.text
    assert [r.revision_number for r in await knowledge.revisions(document)] == [1, 2]

    editor = await world.add_member(ws)
    await world.grant(editor, "roles/collectionEditor", on=collection)
    response = await (await client.as_(editor)).post(
        item_url(document, "/revisions/1:rollback"), json={}
    )
    assert response.status_code == 200, response.text


# -- GetItemContent -------------------------------------------------------------------


async def test_content_without_preview_is_failed_precondition(client, world, knowledge):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)

    response = await api.get(item_url(document, "/content"))
    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"

    response = await api.get(item_url(document, "/content"), params={"revision": "1"})
    assert response.status_code == 400, response.text
    assert error_reason(response) == "REVISION_NOT_RENDERED"


async def test_content_resolves_page_assets_and_rendition(client, world, knowledge, sessions):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    manifest = _manifest(document)
    await _write_preview(sessions, document, 1, manifest)

    viewer = await _viewer(world, client, ws, collection)
    response = await viewer.get(item_url(document, "/content"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == f"{item_name(document)}/content"
    assert body["revision"] == _revision(document, 1)
    assert len(body["pageAssets"]) == 1
    asset = body["pageAssets"][0]
    assert asset["pageNumber"] == 1
    assert asset["widthPixels"] == 800 and asset["heightPixels"] == 1100
    assert asset["imageUri"].startswith(
        f"https://storage.test/test-bucket/{manifest['assets'][0]['key']}?expires="
    )
    rendition = body["rendition"]
    assert rendition["version"] == 1
    assert rendition["uri"].startswith(
        f"https://storage.test/test-bucket/{manifest['rendition']['key']}?expires="
    )
    assert rendition["blockCount"] == 4
    assert not body.get("elements")

    by_name = await api.get(
        item_url(document, "/content"), params={"revision": _revision(document, 1)}
    )
    assert by_name.status_code == 200, by_name.text
    assert by_name.json()["revision"] == _revision(document, 1)


async def test_content_without_rendition(client, world, knowledge, sessions):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _write_preview(sessions, document, 1, _manifest(document, rendition=False))

    response = await api.get(item_url(document, "/content"))
    assert response.status_code == 200, response.text
    assert response.json().get("rendition") is None
    assert len(response.json()["pageAssets"]) == 1


async def test_content_elements_of_indexed_revision(client, world, knowledge, sessions):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _write_preview(sessions, document, 1, _manifest(document))
    await knowledge.index(document, ["first paragraph", "second paragraph"], page=1)

    response = await api.get(item_url(document, "/content"))
    assert response.status_code == 200, response.text
    elements = response.json()["elements"]
    assert [e["text"] for e in elements] == ["first paragraph", "second paragraph"]
    assert [e["passage"] for e in elements] == [
        f"{item_name(document)}/passages/{chunk_id(document, 0)}",
        f"{item_name(document)}/passages/{chunk_id(document, 1)}",
    ]
    assert [e["elementId"] for e in elements] == ["element-0", "element-1"]
    assert all(e["pageNumber"] == 1 for e in elements)


async def test_content_of_older_revision(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _write_preview(sessions, document, 1, _manifest(document))
    await knowledge.index(document, ["first version text"])
    await _append(sessions, fakes, document, data=b"%PDF newer", file_name="newer.pdf")

    current = await api.get(item_url(document, "/content"))
    assert current.status_code == 400, current.text
    assert current.json()["error"]["status"] == "FAILED_PRECONDITION"

    older = await api.get(item_url(document, "/content"), params={"revision": "1"})
    assert older.status_code == 200, older.text
    assert older.json()["revision"] == _revision(document, 1)
    assert len(older.json()["pageAssets"]) == 1
    # Revision 1 is still the indexed revision: its elements are served.
    assert [e["text"] for e in older.json()["elements"]] == ["first version text"]

    missing = await api.get(item_url(document, "/content"), params={"revision": "5"})
    assert missing.status_code == 404, missing.text


async def test_content_of_collection_is_invalid(client, world):
    _, _, collection, api = await _setup(world, client)
    response = await api.get(item_url(collection, "/content"))
    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"


async def test_content_of_deleted_document(client, world, knowledge, sessions):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _write_preview(sessions, document, 1, _manifest(document))
    viewer = await _viewer(world, client, ws, collection)
    await world.delete(document)

    response = await api.get(item_url(document, "/content"))
    assert response.status_code == 404, response.text
    response = await viewer.get(item_url(document, "/content"))
    assert response.status_code == 403, response.text


async def test_content_of_unreadable_document(client, world, knowledge, sessions):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _write_preview(sessions, document, 1, _manifest(document))
    outsider = await client.as_(await world.add_member(ws))
    response = await outsider.get(item_url(document, "/content"))
    assert response.status_code == 403, response.text


# -- ListPassages / GetPassage --------------------------------------------------------


async def test_list_passages_in_document_order(client, world, knowledge):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await knowledge.index(document, ["alpha text", "beta text", "gamma text"], page=2)
    indexed = (await knowledge.row(document)).indexed_revision_number
    assert indexed is not None
    viewer = await _viewer(world, client, ws, collection)

    response = await viewer.get(item_url(document, "/passages"))
    assert response.status_code == 200, response.text
    passages = response.json()["passages"]
    assert [p["name"] for p in passages] == [
        f"{item_name(document)}/passages/{chunk_id(document, n)}" for n in range(3)
    ]
    assert [p["text"] for p in passages] == ["alpha text", "beta text", "gamma text"]
    for position, passage in enumerate(passages):
        assert passage["pageNumber"] == 2
        assert passage["elementIds"] == [f"element-{position}"]
        assert passage["revision"] == _revision(document, indexed)
        assert passage["boundingBoxes"] == [
            {"pageNumber": 2, "left": 0.1, "top": 0.2, "width": 0.5, "height": 0.1}
        ]


async def test_list_passages_paging(client, world, knowledge):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await knowledge.index(document, ["one", "two", "three"])

    first = await api.get(item_url(document, "/passages"), params={"pageSize": 2})
    assert first.status_code == 200, first.text
    assert [p["text"] for p in first.json()["passages"]] == ["one", "two"]
    token = first.json()["nextPageToken"]
    second = await api.get(item_url(document, "/passages"), params={"pageSize": 2, "pageToken": token})
    assert second.status_code == 200, second.text
    assert [p["text"] for p in second.json()["passages"]] == ["three"]
    assert not second.json().get("nextPageToken")


async def test_list_passages_page_asset_uri(client, world, knowledge, sessions):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    manifest = _manifest(document)
    await _write_preview(sessions, document, 1, manifest)
    await knowledge.index(document, ["on page one"], page=1)

    response = await api.get(item_url(document, "/passages"))
    assert response.status_code == 200, response.text
    assert response.json()["passages"][0]["pageAssetUri"].startswith(
        f"https://storage.test/test-bucket/{manifest['assets'][0]['key']}?expires="
    )


async def test_get_passage_and_unknown_passage(client, world, knowledge):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await knowledge.index(document, ["alpha text", "beta text"], page=2)
    viewer = await _viewer(world, client, ws, collection)

    response = await viewer.get(item_url(document, f"/passages/{chunk_id(document, 1)}"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == f"{item_name(document)}/passages/{chunk_id(document, 1)}"
    assert body["text"] == "beta text"
    assert body["pageNumber"] == 2
    assert body["elementIds"] == ["element-1"]

    missing = await viewer.get(item_url(document, f"/passages/{chunk_id(document, 9)}"))
    assert missing.status_code == 404, missing.text


async def test_passages_of_unpublished_document_hidden_from_viewer(client, world, knowledge):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await knowledge.index(document, ["draft text"])
    assert (await api.post(item_url(document, ":unpublish"), json={})).status_code == 200
    viewer = await _viewer(world, client, ws, collection)

    response = await viewer.get(item_url(document, "/passages"))
    assert response.status_code == 403, response.text
    response = await viewer.get(item_url(document, f"/passages/{chunk_id(document, 0)}"))
    assert response.status_code == 403, response.text

    editor = await world.add_member(ws)
    await world.grant(editor, "roles/collectionEditor", on=collection)
    response = await (await client.as_(editor)).get(item_url(document, "/passages"))
    assert response.status_code == 200, response.text
    assert [p["text"] for p in response.json()["passages"]] == ["draft text"]


async def test_passages_of_deleted_document_not_served(client, world, knowledge):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await knowledge.index(document, ["gone text"])
    viewer = await _viewer(world, client, ws, collection)
    await world.delete(document)

    assert (await api.get(item_url(document, "/passages"))).status_code == 404
    assert (
        await api.get(item_url(document, f"/passages/{chunk_id(document, 0)}"))
    ).status_code == 404
    assert (await viewer.get(item_url(document, "/passages"))).status_code == 403


async def test_passages_of_collection_is_invalid(client, world):
    _, _, collection, api = await _setup(world, client)
    response = await api.get(item_url(collection, "/passages"))
    assert response.status_code == 400, response.text
