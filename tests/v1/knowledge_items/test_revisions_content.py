"""Revisions, rollback, the document preview and passages (``item_model.md`` §4.8–§4.10,
``document_viewer.md``)."""

from __future__ import annotations

import asyncio
import gzip
import json
import zipfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from io import BytesIO
from typing import Any
from uuid import UUID

import asyncpg
import docx
import pytest
from PIL import Image
from sqlalchemy import select, update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.runtime import AppRuntime
from bomesh.services.knowledge_items.item_store import ItemService, item_content_key
from bomesh.services.previews.engine import PREVIEW_CHANNEL, PreviewEngine
from bomesh.services.previews.results import ConverterUnavailable
from bomesh.storage import ObjectStorageError
from bomesh.storage.keys import REPRESENTATION, content_key, derived_key, new_content_id
from harness import TEST_DATABASE_URL
from knowledge_support import chunk_id, error_reason, item_name, item_url, upload, ws_url

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
    mime_type: str = "text/plain",
) -> int:
    """Store a new original and append it as the document's newest revision."""
    async with transaction_scope(sessions) as session:
        row = await session.get(Item, document.id)
        assert row is not None
        content = new_content_id()
        fakes.storage.put_bytes(data, content_key(row.tenant_id, content), content_type=mime_type)
        revision = await ItemService(session).append_revision(
            row, content_id=content, mime_type=mime_type, size_bytes=len(data), file_name=file_name
        )
        return revision.revision_number


def _docx(*paragraphs: str) -> bytes:
    """A real Word document: a heading and ``paragraphs``."""
    document = docx.Document()
    document.add_heading("Leave policy", level=1)
    for text in paragraphs:
        document.add_paragraph(text)
    output = BytesIO()
    document.save(output)
    return output.getvalue()


def _engine(runtime: AppRuntime) -> PreviewEngine:
    return runtime.preview_engine()


@asynccontextmanager
async def _preview_requests() -> AsyncIterator[asyncio.Queue[str]]:
    """The payloads notified on ``bomesh_preview`` while the block runs."""
    assert TEST_DATABASE_URL is not None
    listener = await asyncpg.connect(TEST_DATABASE_URL.replace("+asyncpg", ""))
    received: asyncio.Queue[str] = asyncio.Queue()
    await listener.add_listener(PREVIEW_CHANNEL, lambda *args: received.put_nowait(args[-1]))
    try:
        yield received
    finally:
        await listener.close()


async def _preview(api: Any, document: Item, **params: Any) -> dict[str, Any]:
    response = await api.get(item_url(document, "/preview"), params=params or None)
    assert response.status_code == 200, response.text
    return response.json()


def _signed(key: str) -> str:
    return f"https://storage.test/test-bucket/{key}?expires="


def _rep_key(document: Item, revision: ItemRevision) -> str:
    return derived_key(document.tenant_id, revision.content_id, REPRESENTATION, 1)


async def _revision_row(sessions: Any, document: Item, number: int = 1) -> ItemRevision:
    async with transaction_scope(sessions) as session:
        row = await ItemService(session).revision(document.id, number)
        assert row is not None
        return row


DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
IMMUTABLE = "private, max-age=31536000, immutable"


def _revision(document: Item, number: int) -> str:
    return f"{item_name(document)}/revisions/{number}"


# -- ListItemRevisions / GetItemRevision ----------------------------------------------


async def test_list_revisions_newest_first_with_paging(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"second version", file_name="v2.txt")
    await _append(sessions, fakes, document, data=b"third version!", file_name="v3.txt")

    first = await api.get(item_url(document, "/revisions"), params={"pageSize": 2})
    assert first.status_code == 200, first.text
    body = first.json()
    assert [r["name"] for r in body["revisions"]] == [_revision(document, 3), _revision(document, 2)]
    assert body["revisions"][0]["mimeType"] == "text/plain"
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
    await _append(sessions, fakes, document, data=b"second version", file_name="v2.txt")

    response = await api.get(item_url(document, "/revisions/2"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == _revision(document, 2)
    assert body["mimeType"] == "text/plain"
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
    await _append(sessions, fakes, document, data=b"newer text", file_name="newer.txt")
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
    assert revisions[2].content_id == revisions[0].content_id
    assert revisions[2].restored_from == 1
    assert fakes.storage.objects.keys() == objects.keys()
    current = (await knowledge.row(document)).current_revision
    assert current is not None and current.content_id == revisions[0].content_id

    restored = await api.get(item_url(document, "/revisions/3"))
    assert restored.status_code == 200, restored.text
    assert restored.json()["restoredFrom"] == _revision(document, 1)
    assert restored.json()["mimeType"] == "text/plain"


async def test_rollback_to_current_revision_fails(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"newer text", file_name="newer.txt")

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
    await _append(sessions, fakes, document, data=b"newer text", file_name="newer.txt")

    response = await api.post(item_url(document, "/revisions/1:rollback"), json={"etag": stale})
    assert response.status_code == 409, response.text
    assert [r.revision_number for r in await knowledge.revisions(document)] == [1, 2]


async def test_rollback_of_source_managed_document(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"newer text", file_name="newer.txt")
    await world.make_synced(document, external_id="drive-file-1")

    response = await api.post(item_url(document, "/revisions/1:rollback"), json={})
    assert response.status_code == 400, response.text
    assert error_reason(response) == "SOURCE_MANAGED"
    assert [r.revision_number for r in await knowledge.revisions(document)] == [1, 2]


async def test_rollback_while_contribution_open(client, world, knowledge, sessions, fakes):
    admin, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"newer text", file_name="newer.txt")
    await world.make_contribution(document, contributor=admin, target=collection)

    response = await api.post(item_url(document, "/revisions/1:rollback"), json={})
    assert response.status_code == 400, response.text
    assert error_reason(response) == "CONTRIBUTION_OPEN"


async def test_rollback_needs_publish_permission(client, world, knowledge, sessions, fakes):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    await _append(sessions, fakes, document, data=b"newer text", file_name="newer.txt")
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


# -- GetItemPreview -------------------------------------------------------------------


async def test_preview_of_an_unprocessed_pdf_is_ready_at_once(
    client, world, knowledge, fakes, monkeypatch
):
    _, ws, collection, api = await _setup(world, client)
    data = b"%PDF-1.4 unprocessed"
    document = await _uploaded(
        api, knowledge, collection, data=data, file_name="policy.pdf", mime_type="application/pdf"
    )
    assert document.current_revision is not None

    async def unavailable(*args, **kwargs):
        raise AssertionError("GetItemPreview must not read the search index")

    monkeypatch.setattr(fakes.index_backend, "get_item_points", unavailable)
    monkeypatch.setattr(fakes.index_backend, "search_item_points", unavailable)
    viewer = await _viewer(world, client, ws, collection)

    async with _preview_requests() as requests:
        body = await _preview(viewer, document)
        await asyncio.sleep(0.2)
        assert requests.empty()  # as is: nothing to ask the worker

    assert body["name"] == f"{item_name(document)}/preview"
    assert body["revision"] == _revision(document, 1)
    assert body["state"] == "READY" and "unavailableReason" not in body
    representation, original = body["representation"], body["original"]
    assert representation["kind"] == "PDF"
    assert representation["uri"].startswith(_signed(item_content_key(document)))
    assert representation["mimeType"] == "application/pdf"
    assert representation["sizeBytes"] == str(len(data))
    assert representation["expireTime"]
    assert "truncated" not in representation and "textFormat" not in representation
    assert original["uri"] == representation["uri"]
    assert (original["mimeType"], original["sizeBytes"]) == ("application/pdf", str(len(data)))
    got = (await api.get(item_url(document))).json()
    assert got["document"]["indexingState"] == "PENDING"


async def test_preview_follows_each_revisions_file(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    notes = await _uploaded(
        api, knowledge, collection, data=b"# Notes", file_name="notes.md", mime_type="text/markdown"
    )
    await _append(sessions, fakes, notes, data=b"# Notes 2", file_name="notes.md", mime_type="text/markdown")

    async def appended(file_name: str, mime_type: str, data: bytes) -> Item:
        # Revision 1 of a harness document names no stored object; revision 2 is the file.
        document = await world.make_document(collection, mime_type=mime_type, item_name=file_name)
        await _append(sessions, fakes, document, data=data, file_name=file_name, mime_type=mime_type)
        return document

    photo = await appended("photo.png", "image/png", b"\x89PNG")
    clip = await appended("clip.mp4", "video/mp4", b"\x00\x00\x00\x18ftyp")
    binary = await appended("data.bin", "application/octet-stream", b"\x00\x01")

    current = await _preview(api, binary)
    text = await _preview(api, notes, revision=_revision(notes, 1))
    image = await _preview(api, photo)
    video = await _preview(api, clip, revision="2")
    missing = await api.get(item_url(notes, "/preview"), params={"revision": "9"})

    assert current["revision"] == _revision(binary, 2)
    assert (current["state"], current["unavailableReason"]) == ("UNAVAILABLE", "FORMAT_NOT_SUPPORTED")
    assert "representation" not in current
    assert current["original"]["mimeType"] == "application/octet-stream"
    assert (text["state"], text["revision"]) == ("PREPARING", _revision(notes, 1))
    assert "representation" not in text and text["original"]["mimeType"] == "text/markdown"
    image_key = content_key(photo.tenant_id, (await _revision_row(sessions, photo, 2)).content_id)
    assert (image["state"], image["representation"]["kind"]) == ("READY", "IMAGE")
    assert image["representation"]["uri"].startswith(_signed(image_key))
    assert (video["representation"]["kind"], video["representation"]["mediaType"]) == ("MEDIA", "VIDEO")
    assert missing.status_code == 404, missing.text


async def test_a_missing_representation_asks_the_worker_on_every_view(client, world, knowledge):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(
        api, knowledge, collection, data=_docx("Twelve days."), file_name="leave.docx", mime_type=DOCX
    )

    async with _preview_requests() as requests:
        first = await _preview(api, document)
        assert await asyncio.wait_for(requests.get(), 5) == f"{document.id}:1"
        await _preview(api, document)
        assert await asyncio.wait_for(requests.get(), 5) == f"{document.id}:1"

    assert first["state"] == "PREPARING"
    assert "representation" not in first and "unavailableReason" not in first
    assert first["original"]["mimeType"] == DOCX


async def test_an_office_file_becomes_a_pdf_once_without_processing_or_an_edit(
    client, world, knowledge, runtime, sessions, fakes
):
    _, _, collection, api = await _setup(world, client)
    data = _docx("Employees take twelve days.", "Requests go to the manager.")
    document = await _uploaded(
        api, knowledge, collection, data=data, file_name="leave.docx", mime_type=DOCX
    )
    before = (await api.get(item_url(document))).json()
    engine = _engine(runtime)

    assert await engine.produce(document.id, 1)

    assert [(route, name) for route, name, _ in fakes.gotenberg.conversions] == [
        ("/forms/libreoffice/convert", "document.docx")
    ]
    assert fakes.gotenberg.conversions[0][2] == data
    key = _rep_key(document, document.current_revision)
    stored = fakes.storage.objects[key]
    assert stored.data.startswith(b"%PDF") and stored.content_type == "application/pdf"
    assert stored.cache_control == IMMUTABLE and stored.content_encoding is None
    body = await _preview(api, document)
    assert body["state"] == "READY"
    representation = body["representation"]
    assert representation["kind"] == "PDF" and representation["mimeType"] == "application/pdf"
    assert representation["uri"].startswith(_signed(key))
    assert body["original"]["uri"].startswith(_signed(item_content_key(document)))
    revision = await _revision_row(sessions, document)
    assert revision.exports["representation"] == {
        "version": 1,
        "kind": "PDF",
        "stored": True,
        "mime_type": "application/pdf",
        "size_bytes": len(stored.data),
        "truncated": False,
    }
    assert revision.exports["cover"]["kind"] == "page"
    after = (await api.get(item_url(document))).json()
    assert after["document"]["indexingState"] == "PENDING"
    assert (after["etag"], after["updateTime"]) == (before["etag"], before["updateTime"])
    assert not await engine.produce(document.id, 1)
    assert not await engine.produce(document.id)
    assert len(fakes.gotenberg.conversions) == 1


def _zip(entries: dict[str, bytes]) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def _tiff() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (64, 48), "teal").save(buffer, "TIFF")
    return buffer.getvalue()


@pytest.mark.parametrize(
    ("file_name", "mime_type", "data", "kind", "mime", "extension"),
    [
        (
            "notes.txt",
            "text/plain",
            "Le café crème coûte trois euros à Paris; déjà très cher.\n".encode("cp1252") * 30,
            "TEXT",
            "text/plain; charset=utf-8",
            "txt",
        ),
        ("data.json", "application/json", b'{"a":[1,2]}', "TEXT", "text/plain; charset=utf-8", "txt"),
        ("ledger.csv", "text/csv", b"name;amount\nrent;1200\n", "TABLE", "application/vnd.bomesh.table+json", "table.json"),
        ("bundle.zip", "application/zip", _zip({"a.txt": b"a", "dir/": b""}), "ARCHIVE", "application/vnd.bomesh.archive+json", "archive.json"),
        ("scan.tiff", "image/tiff", _tiff(), "IMAGE", "image/webp", "webp"),
    ],
)
async def test_each_produced_kind_is_stored_and_shown(
    client, world, knowledge, runtime, sessions, fakes, file_name, mime_type, data, kind, mime,
    extension,
):
    _, _, collection, api = await _setup(world, client)
    document = await world.make_document(collection, mime_type=mime_type, item_name=file_name)
    # Appended directly: the engine shows formats an upload policy may not accept.
    await _append(sessions, fakes, document, data=data, file_name=file_name, mime_type=mime_type)
    document = await knowledge.row(document)

    assert await _engine(runtime).produce(document.id)

    body = await _preview(api, document)
    representation = body["representation"]
    key = _rep_key(document, document.current_revision)
    stored = fakes.storage.objects[key]
    assert (body["state"], representation["kind"], representation["mimeType"]) == ("READY", kind, mime)
    assert representation["uri"].startswith(_signed(key))
    assert stored.cache_control == IMMUTABLE and stored.content_type == mime
    assert fakes.gotenberg.conversions == []
    if kind == "TEXT":
        assert representation["textFormat"] == "PLAIN" and representation["truncated"] is False
        assert stored.content_encoding is None
        assert item_content_key(document) in fakes.storage.prefix_reads  # one Range read
        if file_name == "data.json":
            assert representation["language"] == "json"
            assert stored.data == b'{\n  "a": [\n    1,\n    2\n  ]\n}'
        else:
            assert "language" not in representation
            assert stored.data.decode("utf-8").startswith("Le café crème")
    if kind in ("TABLE", "ARCHIVE"):
        assert stored.content_encoding == "gzip" and representation["truncated"] is False
        payload = json.loads(gzip.decompress(stored.data))
        assert payload["schema"] == 1
        if kind == "TABLE":
            assert payload["sheets"][0]["rows"] == [["name", "amount"], ["rent", "1200"]]
            assert payload["sheets"][0]["name"] == "ledger"
        else:
            assert [entry["path"] for entry in payload["entries"]] == ["a.txt", "dir/"]
    if kind == "IMAGE":
        assert "truncated" not in representation
        with Image.open(BytesIO(stored.data)) as image:
            assert (image.format, image.size) == ("WEBP", (64, 48))


async def test_an_unreachable_converter_records_nothing(
    client, world, knowledge, runtime, sessions, fakes
):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(
        api, knowledge, collection, data=_docx("Twelve days."), file_name="leave.docx", mime_type=DOCX
    )
    engine = _engine(runtime)

    fakes.gotenberg.statuses = [503]
    with pytest.raises(ConverterUnavailable):
        await engine.produce(document.id)
    fakes.gotenberg.unreachable = True
    with pytest.raises(ConverterUnavailable):
        await engine.produce(document.id)

    revision = await _revision_row(sessions, document)
    assert "representation" not in revision.exports
    assert "representation_failure" not in revision.exports
    assert "cover" not in revision.exports
    assert document.id in await engine.pending(after=None, limit=10)
    assert (await _preview(api, document))["state"] == "PREPARING"

    fakes.gotenberg.unreachable = False
    assert await engine.produce(document.id)
    assert (await _preview(api, document))["state"] == "READY"
    assert document.id not in await engine.pending(after=None, limit=10)


async def test_a_storage_failure_is_not_a_conversion_failure(
    client, world, knowledge, runtime, sessions, fakes, monkeypatch
):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(
        api, knowledge, collection, data=b"a,b\n1,2\n", file_name="t.csv", mime_type="text/csv"
    )
    write = fakes.storage.put_bytes

    def unavailable(*args, **kwargs):
        raise ObjectStorageError("storage is down")

    monkeypatch.setattr(fakes.storage, "put_bytes", unavailable)
    with pytest.raises(ObjectStorageError):
        await _engine(runtime).produce(document.id)

    revision = await _revision_row(sessions, document)
    assert "representation" not in revision.exports
    assert "representation_failure" not in revision.exports
    assert (await _preview(api, document))["state"] == "PREPARING"
    monkeypatch.setattr(fakes.storage, "put_bytes", write)
    assert await _engine(runtime).produce(document.id)
    assert (await _preview(api, document))["state"] == "READY"


async def test_a_file_the_converter_rejects_is_unavailable_and_not_converted_again(
    client, world, knowledge, runtime, sessions, fakes
):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(
        api, knowledge, collection, data=b"PK\x03\x04 not a document", file_name="broken.docx",
        mime_type=DOCX,
    )
    engine = _engine(runtime)
    fakes.gotenberg.statuses = [400]

    assert await engine.produce(document.id)

    revision = await _revision_row(sessions, document)
    assert revision.exports["representation_failure"] == {"reason": "CONVERSION_ERROR"}
    assert revision.exports["cover"]["kind"] == "none"
    async with _preview_requests() as requests:
        body = await _preview(api, document)
        await asyncio.sleep(0.2)
        assert requests.empty()
    assert (body["state"], body["unavailableReason"]) == ("UNAVAILABLE", "CONVERSION_FAILED")
    assert "representation" not in body
    assert body["original"]["uri"].startswith(_signed(content_key(document.tenant_id, revision.content_id)))

    assert not await engine.produce(document.id)
    assert len(fakes.gotenberg.conversions) == 1

    await _append(
        sessions, fakes, document, data=_docx("Fixed."), file_name="fixed.docx", mime_type=DOCX
    )
    assert (await _preview(api, document))["state"] == "PREPARING"
    assert await engine.produce(document.id)
    assert (await _preview(api, document))["state"] == "READY"


async def test_the_manifest_lands_only_on_the_revision_that_still_holds_the_file(
    client, world, knowledge, runtime, sessions, fakes, monkeypatch
):
    _, _, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection, data=b"one\n", file_name="notes.txt")
    number = await _append(
        sessions, fakes, document, data=b"two\n", file_name="notes.txt", mime_type="text/plain"
    )
    engine = _engine(runtime)
    produce = engine._output

    async def replaced_meanwhile(*args, **kwargs):
        output = await produce(*args, **kwargs)
        async with transaction_scope(sessions) as session:
            await session.execute(
                update(ItemRevision)
                .where(ItemRevision.item_id == document.id, ItemRevision.revision_number == number)
                .values(deleted_at=ItemRevision.created_at)
            )
            # The newest live revision is the current one again.
            first = await ItemService(session).revision(document.id, 1)
            assert first is not None
            await session.execute(
                update(Item).where(Item.id == document.id).values(current_revision_id=first.id)
            )
        return output

    monkeypatch.setattr(engine, "_output", replaced_meanwhile)

    assert not await engine.produce(document.id, number)

    async with transaction_scope(sessions) as session:
        stale = await session.scalar(
            select(ItemRevision).where(
                ItemRevision.item_id == document.id, ItemRevision.revision_number == number
            )
        )
        assert stale is not None and "representation" not in stale.exports
    assert "representation" not in (await _revision_row(sessions, document, 1)).exports


async def test_an_original_over_the_limit_is_too_large(client, world, knowledge, sessions, fakes):
    _, _, collection, api = await _setup(world, client)
    document = await world.make_document(collection, mime_type=DOCX, item_name="huge.docx")
    content = new_content_id()
    fakes.storage.put_bytes(b"PK", content_key(document.tenant_id, content), content_type=DOCX)
    huge = 101 * 1024 * 1024
    async with transaction_scope(sessions) as session:
        row = await session.get(Item, document.id)
        assert row is not None
        await ItemService(session).append_revision(
            row, content_id=content, mime_type=DOCX, size_bytes=huge, file_name="huge.docx"
        )

    async with _preview_requests() as requests:
        body = await _preview(api, document)
        await asyncio.sleep(0.2)
        assert requests.empty()

    assert (body["state"], body["unavailableReason"]) == ("UNAVAILABLE", "TOO_LARGE")
    assert body["original"]["sizeBytes"] == str(huge)


async def test_preview_before_the_content_arrives_is_failed_precondition(client, world):
    _, _, collection, api = await _setup(world, client)
    created = await api.post(
        f"{ws_url(collection.tenant_id)}/items",
        json={
            "itemKind": "DOCUMENT",
            "displayName": "Policy",
            "parentItem": item_name(collection),
            "document": {
                "mimeType": "application/pdf",
                "sizeBytes": "10",
                "fileName": "policy.pdf",
            },
        },
    )
    assert created.status_code == 200, created.text

    response = await api.get(f"/api/v1/{created.json()['name']}/preview")

    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert error_reason(response) == "CONTENT_NOT_AVAILABLE"


async def test_preview_of_collection_is_invalid(client, world):
    _, _, collection, api = await _setup(world, client)
    response = await api.get(item_url(collection, "/preview"))
    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"


async def test_preview_of_deleted_document(client, world, knowledge):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    viewer = await _viewer(world, client, ws, collection)
    await world.delete(document)

    response = await api.get(item_url(document, "/preview"))
    assert response.status_code == 404, response.text
    response = await viewer.get(item_url(document, "/preview"))
    assert response.status_code == 403, response.text


async def test_preview_of_unreadable_document(client, world, knowledge):
    _, ws, collection, api = await _setup(world, client)
    document = await _uploaded(api, knowledge, collection)
    outsider = await client.as_(await world.add_member(ws))
    response = await outsider.get(item_url(document, "/preview"))
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
