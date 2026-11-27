"""Document covers on real PostgreSQL: the trigger, producing, and the list projection.

``document_viewer.md`` "Cover on the Item": content arriving notifies
``bomesh_cover``; the preview engine stores the representation, then the
cover on the current revision (page one of a PDF representation, so office
documents get their first page); List, Get and Home sign at most the cover
image (one presign per document); a new revision has no cover until it is
produced.
"""

from __future__ import annotations

import asyncio
from io import BytesIO
from typing import Any
from uuid import UUID

import asyncpg
import pytest
from PIL import Image
from sqlalchemy import update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.runtime import AppRuntime
from bomesh.services.knowledge_items.item_store import item_content_key
from bomesh.services.previews.covers import COVER_CHANNEL, COVER_VERSION
from bomesh.services.previews.engine import PreviewEngine
from bomesh.services.previews.manifest import representation_key
from bomesh.storage.keys import COVER, derived_key
from fakes import pdf_page
from harness import TEST_DATABASE_URL, ApiClient, Fakes, World
from knowledge_support import Knowledge, item_url, upload, ws_url

pytestmark = pytest.mark.asyncio

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def _pdf(color: str = "#c0392b") -> bytes:
    return pdf_page(color)


async def _uploaded(api: ApiClient, parent: Item, data: bytes, file_name: str, mime: str) -> UUID:
    response = await upload(api, parent, data=data, file_name=file_name, mime_type=mime)
    assert response.status_code == 200, response.text
    return UUID(response.json()["name"].rsplit("/", 1)[1])


def _engine(runtime: AppRuntime) -> PreviewEngine:
    return runtime.preview_engine()


async def _cover(knowledge: Knowledge, item_id: UUID) -> dict[str, Any] | None:
    """``exports.cover`` of the revision the document shows."""
    revision = (await knowledge.row(item_id)).current_revision
    assert revision is not None
    return revision.exports.get("cover")


async def _cover_key(knowledge: Knowledge, item_id: UUID) -> str:
    """The cover image object: derived from the shown content, never stored."""
    document = await knowledge.row(item_id)
    revision = document.current_revision
    assert revision is not None
    cover = revision.exports["cover"]
    assert cover["stored"] is True
    return derived_key(document.workspace_code, revision.content_id, COVER, cover["version"])


async def _notified(received: asyncio.Queue[str], item_id: UUID) -> None:
    """The next notification about ``item_id`` (other tests' documents may notify too)."""
    while await received.get() != str(item_id):
        pass


async def _list_documents(api: ApiClient, workspace: Any) -> dict[str, dict[str, Any]]:
    response = await api.get(f"{ws_url(workspace)}/items", params={"pageSize": 100})
    assert response.status_code == 200, response.text
    return {
        item["displayName"]: item["document"]
        for item in response.json()["items"]
        if item["itemKind"] == "DOCUMENT"
    }


async def test_content_arriving_notifies_the_cover_channel(
    client: ApiClient, world: World, knowledge: Knowledge
) -> None:
    assert TEST_DATABASE_URL is not None
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    root = await world.make_collection(workspace)
    listener = await asyncpg.connect(TEST_DATABASE_URL.replace("+asyncpg", ""))
    received: asyncio.Queue[str] = asyncio.Queue()
    await listener.add_listener(COVER_CHANNEL, lambda *args: received.put_nowait(args[-1]))
    try:
        uploaded = await _uploaded(await client.as_(admin), root, _pdf(), "a.pdf", "application/pdf")
        await asyncio.wait_for(_notified(received, uploaded), 5)

        document = await knowledge.row(uploaded)
        await knowledge.add_revision(document)
        await asyncio.wait_for(_notified(received, uploaded), 5)

        # Metadata changes (including the cover itself) notify nothing.
        async with transaction_scope(knowledge.sessions) as session:
            await session.execute(
                update(Item).where(Item.id == uploaded).values(description="s")
            )
        await asyncio.sleep(0.2)
        assert str(uploaded) not in [received.get_nowait() for _ in range(received.qsize())]
    finally:
        await listener.close()


async def test_list_returns_each_cover_with_one_presign_per_document(
    client: ApiClient, world: World, runtime: AppRuntime, fakes: Fakes, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    root = await world.make_collection(workspace)
    api = await client.as_(admin)
    pdfs = [await _uploaded(api, root, _pdf(), f"report-{n}.pdf", "application/pdf") for n in range(3)]
    notes = await _uploaded(api, root, b"# Notes\nfirst line\n", "notes.md", "text/markdown")
    for item_id in [*pdfs, notes]:
        assert await _engine(runtime).produce(item_id)
    assert not await _engine(runtime).produce(pdfs[0])  # settled: nothing to do

    fakes.storage.presigned.clear()
    listed = await _list_documents(api, workspace)

    keys = [await _cover_key(knowledge, item_id) for item_id in pdfs]
    assert sorted(fakes.storage.presigned) == sorted(keys)
    for n, key in enumerate(keys):
        cover = listed[f"report-{n}.pdf"]["cover"]
        assert cover["kind"] == "PAGE" and key in cover["imageUri"]
        assert cover["widthPixels"] == 480 and cover["heightPixels"] > 480
        assert "lines" not in cover
        stored = fakes.storage.objects[key]
        assert stored.content_type == "image/webp"
        assert stored.cache_control == "private, max-age=31536000, immutable"
    assert listed["notes.md"]["cover"] == {"kind": "TEXT", "title": "Notes", "lines": ["first line"]}
    assert "thumbnailUri" not in listed["notes.md"]


async def test_office_documents_get_their_converted_first_page(
    client: ApiClient, world: World, runtime: AppRuntime, fakes: Fakes, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    root = await world.make_collection(workspace)
    api = await client.as_(admin)
    fakes.gotenberg.color = "#27ae60"
    report = await _uploaded(api, root, b"PK\x03\x04 docx", "report.docx", DOCX)
    deck = await _uploaded(api, root, b"PK\x03\x04 pptx", "deck.pptx", PPTX)

    for item_id in (report, deck):
        assert await _engine(runtime).produce(item_id)

    listed = await _list_documents(api, workspace)
    assert listed["report.docx"]["cover"]["kind"] == "PAGE"
    assert listed["deck.pptx"]["cover"]["kind"] == "SLIDE"
    key = await _cover_key(knowledge, report)
    with Image.open(BytesIO(fakes.storage.objects[key].data)) as image:
        red, green, blue = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
    assert green > 120 and red < 100  # the converted PDF's page, not a placeholder


async def test_an_older_cover_shows_until_produced_again_and_a_new_revision_has_none(
    client: ApiClient, world: World, runtime: AppRuntime, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    root = await world.make_collection(workspace)
    api = await client.as_(admin)
    item_id = await _uploaded(api, root, b"hello\n", "notes.txt", "text/plain")
    engine = _engine(runtime)
    assert await engine.produce(item_id)
    document = await knowledge.row(item_id)
    before = (await api.get(item_url(document))).json()
    assert before["document"]["cover"] == {"kind": "TEXT", "lines": ["hello"]}
    assert await engine.pending(after=None, limit=10) == []

    # A cover of an older producer version is shown until the sweep produces it again.
    cover = await _cover(knowledge, item_id)
    assert cover is not None
    async with transaction_scope(knowledge.sessions) as session:
        await session.execute(
            update(ItemRevision)
            .where(ItemRevision.id == document.current_revision_id)
            .values(exports={"cover": {**cover, "version": COVER_VERSION - 1}})
        )
    assert (await api.get(item_url(document))).json()["document"]["cover"] == before["document"]["cover"]
    assert item_id in await engine.pending(after=None, limit=10)

    # A new revision has no cover; the next job shows the new content.
    await knowledge.add_revision(document, data=b"next", mime_type="text/plain")
    assert await _cover(knowledge, item_id) is None
    assert "cover" not in (await api.get(item_url(document))).json()["document"]
    assert item_id in await engine.pending(after=None, limit=10)
    assert await engine.produce(item_id)
    after = (await api.get(item_url(document))).json()
    assert after["document"]["cover"] == {"kind": "TEXT", "lines": ["next"]}
    assert await engine.pending(after=None, limit=10) == []


async def test_writing_a_cover_is_not_an_edit(
    client: ApiClient, world: World, runtime: AppRuntime, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    root = await world.make_collection(workspace)
    api = await client.as_(admin)
    item_id = await _uploaded(api, root, _pdf(), "a.pdf", "application/pdf")
    document = await knowledge.row(item_id)
    before = (await api.get(item_url(document))).json()

    assert await _engine(runtime).produce(item_id)

    after = (await api.get(item_url(document))).json()
    assert after["etag"] == before["etag"] and after["updateTime"] == before["updateTime"]
    assert after["document"]["cover"]["kind"] == "PAGE"


async def test_an_unreadable_file_is_recorded_once_and_shows_no_cover(
    client: ApiClient, world: World, runtime: AppRuntime, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    root = await world.make_collection(workspace)
    api = await client.as_(admin)
    broken = await _uploaded(api, root, b"%PDF-1.7 broken", "broken.pdf", "application/pdf")
    unknown = await _uploaded(api, root, b"\x00\x01", "data.bin", "application/octet-stream")
    engine = _engine(runtime)

    for item_id in (broken, unknown):
        assert await engine.produce(item_id)
        assert (await _cover(knowledge, item_id) or {}).get("kind") == "none"
        assert "cover" not in (await api.get(item_url(await knowledge.row(item_id)))).json()["document"]
    assert await engine.pending(after=None, limit=10) == []
    assert not await engine.produce(broken)


async def test_processing_gets_a_legacy_files_pdf_converting_it_once_when_missing(
    client: ApiClient, world: World, runtime: AppRuntime, fakes: Fakes, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    root = await world.make_collection(workspace)
    api = await client.as_(admin)
    legacy = await _uploaded(api, root, b"\xd0\xcf\x11\xe0 doc", "minutes.doc", "application/msword")
    pdf = await _uploaded(api, root, _pdf(), "policy.pdf", "application/pdf")
    engine = _engine(runtime)
    fakes.gotenberg.conversions.clear()

    key = await engine.pdf_key(legacy)  # the content-arrival job has not run yet
    again = await engine.pdf_key(legacy)

    document = await knowledge.row(legacy)
    revision = document.current_revision
    assert revision is not None
    assert key == again == representation_key(document.workspace_code, revision.content_id)
    assert fakes.storage.objects[key].data.startswith(b"%PDF")
    assert len(fakes.gotenberg.conversions) == 1
    # A PDF is its own representation: the original is read, nothing is converted.
    original = await knowledge.row(pdf)
    assert await engine.pdf_key(pdf) == item_content_key(original)
    assert len(fakes.gotenberg.conversions) == 1


async def test_home_entries_carry_the_cover(
    client: ApiClient, world: World, runtime: AppRuntime, fakes: Fakes, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    root = await world.make_collection(workspace, grants={"workspaceMembers": "roles/collectionViewer"})
    api = await client.as_(admin)
    item_id = await _uploaded(api, root, _pdf(), "a.pdf", "application/pdf")
    assert await _engine(runtime).produce(item_id)
    key = await _cover_key(knowledge, item_id)

    response = await api.get(f"/api/v1/workspaces/{workspace.id}/members/me/home")

    assert response.status_code == 200, response.text
    entries = [
        entry
        for entry in response.json().get("recentlyPublished", [])
        if entry["item"].endswith(str(item_id))
    ]
    assert entries and entries[0]["cover"]["kind"] == "PAGE"
    assert key in entries[0]["cover"]["imageUri"]
