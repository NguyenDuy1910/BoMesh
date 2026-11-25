from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

import pytest
from docling_core.types.doc import DocItemLabel, DoclingDocument

from bomesh.db.models import Item, ItemRevision
from bomesh.services.knowledge_items.original_parser import (
    MAX_TRANSCRIPT_BYTES,
    OriginalParser,
    StoredTranscripts,
)
from bomesh.services.knowledge_items.file_types import file_class
from bomesh.services.knowledge_items.item_store import show_revision
from bomesh.storage import ObjectNotFoundError, StoredObject


class _Storage:
    """Object storage in memory: the original, and whatever is written."""

    def __init__(self, original: bytes = b"") -> None:
        self.original = original
        self.objects: dict[str, bytes] = {}
        self.writes: list[tuple[str, str | None, str | None]] = []

    async def download_to_path(self, key: str, path: Path, *, max_bytes: int) -> StoredObject:
        del key, max_bytes
        path.write_bytes(self.original)
        return StoredObject(size_bytes=len(self.original), content_type="application/pdf")

    async def read(self, key: str, *, max_bytes: int) -> bytes:
        assert max_bytes == MAX_TRANSCRIPT_BYTES
        if key not in self.objects:
            raise ObjectNotFoundError(key)
        return self.objects[key]

    def put_bytes(
        self,
        data: bytes,
        key: str,
        *,
        content_type: str | None = None,
        content_encoding: str | None = None,
        cache_control: str | None = None,
    ) -> StoredObject:
        del content_encoding
        self.objects[key] = data
        self.writes.append((key, content_type, cache_control))
        return StoredObject(size_bytes=len(data), content_type=content_type)


def _document(size_bytes: int) -> Item:
    document = Item(
        id=uuid4(),
        item_kind="document",
        item_type=file_class("application/pdf", "scan.pdf"),
        parent_item_id=uuid4(),
        tenant_id=uuid4(),
        item_name="scan",
        purpose="knowledge",
        is_published=True,
    )
    document.upload = None
    revision = ItemRevision(
        id=uuid4(),
        item_id=document.id,
        revision_number=1,
        content_id=uuid4(),
        mime_type="application/pdf",
        size_bytes=size_bytes,
        file_name="scan.pdf",
        exports={},
    )
    document.current_revision = revision
    show_revision(document, revision)
    return document


@pytest.mark.asyncio
async def test_transcriptions_are_a_derived_product_of_the_content() -> None:
    storage = _Storage()
    tenant_id, content_id = uuid4(), uuid4()
    transcripts = StoredTranscripts(
        cast(Any, storage),
        tenant_id=tenant_id,
        content_id=content_id,
        loop=asyncio.get_running_loop(),
    )
    key = "0123456789abcdef-p00002-00004"

    # The processing worker thread reads through the loop and writes directly.
    assert await asyncio.to_thread(transcripts.get, key) is None
    await asyncio.to_thread(transcripts.put, key, '{"name": "scan"}')

    object_key = f"derived/{tenant_id}/{content_id}/transcript-v1/{key}.json"
    assert transcripts.object_key(key) == object_key
    assert storage.writes == [
        (object_key, "application/json", "private, max-age=31536000, immutable")
    ]
    assert await asyncio.to_thread(transcripts.get, key) == '{"name": "scan"}'


class _Processor:
    """The file connector: records the transcription store it is handed and uses it."""

    def __init__(self) -> None:
        self.found: list[str | None] = []

    def parse_path(self, path: Path, **kwargs: Any) -> DoclingDocument:
        del path
        transcripts = kwargs["transcripts"]
        self.found.append(transcripts.get("0123456789abcdef-p00001-00001"))
        transcripts.put("0123456789abcdef-p00001-00001", '{"name": "scan"}')
        document = DoclingDocument(name="scan")
        document.add_text(label=DocItemLabel.PARAGRAPH, text="Transcribed page.")
        return document


@pytest.mark.asyncio
async def test_parsing_hands_the_parser_the_contents_transcriptions() -> None:
    original = b"%PDF-1.7"
    storage = _Storage(original)
    processor = _Processor()
    parser = OriginalParser(object_storage=cast(Any, storage), processor=cast(Any, processor))
    document = _document(len(original))
    assert document.current_revision is not None

    await parser.parse(document, revision=document.current_revision)
    await parser.parse(document, revision=document.current_revision)

    # Processing the same content again finds what the first pass stored.
    assert processor.found == [None, '{"name": "scan"}']
    content_id = document.current_revision.content_id
    assert list(storage.objects) == [
        f"derived/{document.tenant_id}/{content_id}/transcript-v1/0123456789abcdef-p00001-00001.json"
    ]
