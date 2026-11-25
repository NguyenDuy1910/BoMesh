"""The Structured Document: parsed once per parse profile, pictures by name, chunks point into it."""

from __future__ import annotations

import gzip
import json
from hashlib import sha256
from io import BytesIO
from typing import Any

import pytest
from docx import Document as DocxDocument
from openpyxl import Workbook
from PIL import Image
from sqlalchemy import select, update

from bomesh.connector.processing import DoclingChunker
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.document_structure import StructureManifest, StructureView
from bomesh.runtime import AppRuntime
from bomesh.services.knowledge_items.structure_store import StructureStore
from bomesh.storage.keys import content_key
from harness import Fakes, World

pytestmark = pytest.mark.asyncio

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class _CountingParser:
    """The runtime's OriginalParser, counting parses."""

    def __init__(self, runtime: AppRuntime) -> None:
        self._parser = runtime.original_parser()
        self.calls = 0

    async def parse(self, document: Item, **options: Any) -> Any:
        self.calls += 1
        return await self._parser.parse(document, **options)


def _store(runtime: AppRuntime, parser: _CountingParser, *, vision_model: str | None = None) -> StructureStore:
    return StructureStore(
        runtime.sessions(),
        object_storage=runtime.object_storage(),
        parser=parser,  # type: ignore[arg-type]
        vision_model=vision_model,
    )


def _png() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (64, 48), "teal").save(buffer, "PNG")
    return buffer.getvalue()


def _docx() -> bytes:
    document = DocxDocument()
    document.add_heading("Refund policy", level=1)
    paragraph = document.add_paragraph("Refunds are paid within ")
    paragraph.add_run("thirty").bold = True
    paragraph.add_run(" days of approval.")
    document.add_picture(BytesIO(_png()))
    document.add_heading("Exceptions", level=2)
    document.add_paragraph("Gift cards are never refunded.")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Region"
    table.cell(0, 1).text = "Days"
    table.cell(1, 0).text = "EU"
    table.cell(1, 1).text = "14"
    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _xlsx() -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Budget"
    sheet.append(["Team", "Quarter", "Amount"])
    sheet.append(["Sales", "Q1", 1200])
    sheet.append(["Support", "Q1", 800])
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


_MARKDOWN = (
    b"# Onboarding\n\nRead the [handbook](https://example.test/handbook) first.\n\n"
    b"## Tools\n\n- **Laptop** from IT\n- Badge from security\n\n"
    b"```python\nprint('hello')\n```\n"
)
_HTML = (
    b"<html><body><h1>Release notes</h1><p>Version <b>2.1</b> adds "
    b"<a href='https://example.test/export'>exports</a>.</p>"
    b"<ul><li>Faster search</li><li>Dark mode</li></ul></body></html>"
)


async def _stored_document(
    world: World, fakes: Fakes, *, name: str, mime_type: str, data: bytes
) -> Item:
    """A document whose current revision's original ``data`` is stored."""

    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace, item_name="Library")
    document = await world.make_document(collection, item_name=name, mime_type=mime_type)
    revision = document.current_revision
    assert revision is not None
    async with transaction_scope(world.sessions) as session:
        await session.execute(
            update(ItemRevision).where(ItemRevision.id == revision.id).values(size_bytes=len(data))
        )
    revision.size_bytes = len(data)
    fakes.storage.put_bytes(data, content_key(document.tenant_id, revision.content_id))
    return document


async def _exports(world: World, document: Item) -> dict[str, Any]:
    async with transaction_scope(world.sessions) as session:
        return await session.scalar(
            select(ItemRevision.exports).where(ItemRevision.item_id == document.id)
        )


async def test_a_structure_is_parsed_once_and_reused_while_the_profile_matches(
    runtime: AppRuntime, fakes: Fakes, world: World
) -> None:
    document = await _stored_document(world, fakes, name="policy.docx", mime_type=DOCX, data=_docx())
    parser = _CountingParser(runtime)
    store = _store(runtime, parser)

    first = await store.ensure(document)
    # A fresh store (another process) reads what the first one stored.
    again = await _store(runtime, parser).ensure(document)

    assert parser.calls == 1
    assert again.ref == first.ref
    assert again.manifest == first.manifest
    manifest = StructureManifest.parse(await _exports(world, document))
    assert manifest == first.manifest
    assert manifest is not None and manifest.fingerprint == store.profile(read_images=False).fingerprint()
    assert first.ref.key in fakes.storage.objects


async def test_reading_images_is_another_parse_profile(
    runtime: AppRuntime, fakes: Fakes, world: World
) -> None:
    document = await _stored_document(world, fakes, name="policy.docx", mime_type=DOCX, data=_docx())
    parser = _CountingParser(runtime)
    store = _store(runtime, parser, vision_model="vision/test-model")

    plain = await store.ensure(document)
    reading = await store.ensure(document, read_images=True)

    assert reading.ref.fingerprint != plain.ref.fingerprint
    assert parser.calls == 2
    # Without a vision model, reading images changes nothing and is the same profile.
    unseeing = _store(runtime, parser)
    assert unseeing.profile(read_images=True) == unseeing.profile(read_images=False)


async def test_pictures_are_stored_by_hash_beside_a_json_without_inline_data(
    runtime: AppRuntime, fakes: Fakes, world: World
) -> None:
    document = await _stored_document(world, fakes, name="policy.docx", mime_type=DOCX, data=_docx())
    store = _store(runtime, _CountingParser(runtime))

    parsed = await store.ensure(document)

    raw = gzip.decompress(fakes.storage.objects[parsed.ref.key].data).decode("utf-8")
    assert "data:" not in raw
    names = {picture["image"]["uri"] for picture in json.loads(raw)["pictures"] if picture.get("image")}
    assert len(names) == 1 and parsed.manifest.pictures == 1
    (name,) = names
    stored = fakes.storage.objects[parsed.ref.picture_key(name)]
    assert stored.data.startswith(b"\x89PNG")
    assert name.removesuffix(".png") == sha256(stored.data).hexdigest()


@pytest.mark.parametrize(
    ("name", "mime_type", "data"),
    [
        ("policy.docx", DOCX, _docx()),
        ("onboarding.md", "text/markdown", _MARKDOWN),
        ("budget.xlsx", XLSX, _xlsx()),
        ("release.html", "text/html", _HTML),
    ],
    ids=["docx", "markdown", "xlsx", "html"],
)
async def test_every_chunk_points_at_blocks_of_its_structure_and_quotes_plain_text(
    runtime: AppRuntime, fakes: Fakes, world: World, name: str, mime_type: str, data: bytes
) -> None:
    document = await _stored_document(world, fakes, name=name, mime_type=mime_type, data=data)
    store = _store(runtime, _CountingParser(runtime))

    parsed = await store.ensure(document)
    chunks = DoclingChunker().chunk(parsed.document, item_id=str(document.id))
    view = await store.view(parsed.ref)

    assert chunks
    for chunk in chunks:
        for ref in chunk.refs:
            assert ref in view
            assert view.unit_index(ref) is not None
        assert not any(marker in chunk.quote for marker in ("**", "](", "```"))
    assert view.total > 0
