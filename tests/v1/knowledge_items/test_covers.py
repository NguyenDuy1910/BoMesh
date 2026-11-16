"""Document covers on real PostgreSQL: the trigger, producing, and the list projection.

``document_viewer.md`` "Cover on the Item": content arriving notifies
``bomesh_cover``; the preview engine stores the representation, then the
cover on the row (page one of a PDF representation, so office documents get
their first page); List, Get and Home sign at most the cover image (one
presign per document) and ignore a cover of other content.
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
from bomesh.db.models import Item
from bomesh.runtime import AppRuntime
from bomesh.services.previews.covers import COVER_CHANNEL
from bomesh.services.previews.engine import PreviewEngine
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


async def _list_documents(api: ApiClient, workspace: Any) -> dict[str, dict[str, Any]]:
    response = await api.get(f"{ws_url(workspace)}/items", params={"pageSize": 100})
    assert response.status_code == 200, response.text
    return {
        item["displayName"]: item["document"]
        for item in response.json()["items"]
        if item["itemType"] == "DOCUMENT"
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
        assert await asyncio.wait_for(received.get(), 5) == str(uploaded)

        document = await knowledge.row(uploaded)
        await knowledge.add_revision(document, key=f"objects/{uploaded}/2")
        assert await asyncio.wait_for(received.get(), 5) == str(uploaded)

        # Metadata changes (including the cover itself) notify nothing.
        async with transaction_scope(knowledge.sessions) as session:
            await session.execute(
                update(Item).where(Item.id == uploaded).values(metadata_={"summary": "s"})
            )
        await asyncio.sleep(0.2)
        assert received.empty()
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

    keys = [(await knowledge.row(item_id)).metadata_["cover"]["key"] for item_id in pdfs]
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
    key = (await knowledge.row(report)).metadata_["cover"]["key"]
    with Image.open(BytesIO(fakes.storage.objects[key].data)) as image:
        red, green, blue = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
    assert green > 120 and red < 100  # the converted PDF's page, not a placeholder


async def test_a_cover_of_other_content_is_ignored_and_produced_again(
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

    # A cover written for an older object (a race with a new revision) is not shown.
    async with transaction_scope(knowledge.sessions) as session:
        await session.execute(
            update(Item)
            .where(Item.id == item_id)
            .values(
                metadata_={
                    **document.metadata_,
                    "cover": {**document.metadata_["cover"], "source": "objects/older"},
                }
            )
        )
    assert "cover" not in (await api.get(item_url(document))).json()["document"]
    assert item_id in await engine.pending(after=None, limit=10)

    # A new revision drops the cover; the next job shows the new content.
    await knowledge.add_revision(document, key=f"objects/{item_id}/2", size=4)
    knowledge.fakes.storage.put_bytes(b"next", f"objects/{item_id}/2", content_type="text/plain")
    assert "cover" not in (await knowledge.row(item_id)).metadata_
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
        assert (await knowledge.row(item_id)).metadata_["cover"]["kind"] == "none"
        assert "cover" not in (await api.get(item_url(await knowledge.row(item_id)))).json()["document"]
    assert await engine.pending(after=None, limit=10) == []
    assert not await engine.produce(broken)


async def test_home_entries_carry_the_cover(
    client: ApiClient, world: World, runtime: AppRuntime, fakes: Fakes, knowledge: Knowledge
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    root = await world.make_collection(workspace, grants={"workspaceMembers": "roles/collectionViewer"})
    api = await client.as_(admin)
    item_id = await _uploaded(api, root, _pdf(), "a.pdf", "application/pdf")
    assert await _engine(runtime).produce(item_id)
    key = (await knowledge.row(item_id)).metadata_["cover"]["key"]

    response = await api.get(f"/api/v1/workspaces/{workspace.id}/members/me/home")

    assert response.status_code == 200, response.text
    entries = [
        entry
        for entry in response.json().get("recentlyPublished", [])
        if entry["item"].endswith(str(item_id))
    ]
    assert entries and entries[0]["cover"]["kind"] == "PAGE"
    assert key in entries[0]["cover"]["imageUri"]
