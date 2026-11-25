"""A revision's Structured Document: parsed once per parse profile, then read.

The Docling JSON of a content lives at
``derived/{tenant}/{content_id}/structure-v1/{fingerprint}.json.gz`` with its
pictures beside it (``picture-v1/{sha256}.png``), both immutable: a key names
exactly one parse. ``item_revisions.exports.structure`` (a
:class:`~bomesh.document_structure.StructureManifest`) names the current one
of every revision showing that content. Indexing, the content API and the
agent read it here; only :meth:`StructureStore.ensure` ever parses.
"""

from __future__ import annotations

import asyncio
import threading
from collections import OrderedDict
from collections.abc import Hashable
from dataclasses import dataclass
from typing import Generic, TypeVar

from docling_core.types.doc import DoclingDocument
from docling_core.types.doc.document import CURRENT_VERSION
from sqlalchemy import literal, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm.attributes import set_committed_value

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.document_structure import (
    MEDIA_TYPE,
    ParseProfile,
    PictureObject,
    StructureDecodeError,
    StructureManifest,
    StructureRef,
    StructureView,
    decode_document,
    decode_json,
    encode,
    externalize_pictures,
)
from bomesh.services import PARSER_VERSION, DocumentUnavailableError
from bomesh.services.knowledge_items.original_parser import OriginalParser
from bomesh.storage import DocumentStorage, ObjectNotFoundError
from bomesh.storage.keys import IMMUTABLE_CACHE_CONTROL

#: Largest stored (gzip) Structured Document that is read back.
MAX_STRUCTURE_BYTES = 128 * 1024 * 1024
#: Decoded documents kept for chunking and Docling's serializers.
DOCUMENT_CACHE_SIZE = 8
#: Read projections kept for the content API.
VIEW_CACHE_SIZE = 32
#: A view of a document whose JSON is larger than this is not kept.
MAX_CACHED_VIEW_JSON_BYTES = 16 * 1024 * 1024
_NODE_COLLECTIONS = ("texts", "tables", "pictures", "groups", "key_value_items", "form_items")

_K = TypeVar("_K", bound=Hashable)
_V = TypeVar("_V")


@dataclass(frozen=True, slots=True)
class ParsedStructure:
    """A revision's Structured Document: where it lives, its manifest and the document."""

    ref: StructureRef
    manifest: StructureManifest
    document: DoclingDocument


class StructureUnavailable(Exception):
    """The Structured Document of a ref is missing from storage or unreadable."""


class _Lru(Generic[_K, _V]):
    """A bounded LRU map, safe to share between the event loop and worker threads."""

    def __init__(self, size: int) -> None:
        self._size = size
        self._values: OrderedDict[_K, _V] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: _K) -> _V | None:
        with self._lock:
            value = self._values.get(key)
            if value is not None:
                self._values.move_to_end(key)
            return value

    def put(self, key: _K, value: _V) -> None:
        with self._lock:
            self._values[key] = value
            self._values.move_to_end(key)
            while len(self._values) > self._size:
                self._values.popitem(last=False)


class StructureStore:
    """Parse, store and read the Structured Documents of Document revisions."""

    def __init__(
        self,
        sessions: SessionFactory,
        *,
        object_storage: DocumentStorage,
        parser: OriginalParser,
        vision_model: str | None = None,
    ) -> None:
        """``vision_model``: the configured ``BOMESH_DOCLING_MODEL`` when a vision
        model is configured (it transcribes scanned pages and reads pictures)."""
        self._sessions = sessions
        self._storage = object_storage
        self._parser = parser
        self._vision_model = vision_model
        self._documents: _Lru[StructureRef, DoclingDocument] = _Lru(DOCUMENT_CACHE_SIZE)
        self._views: _Lru[StructureRef, StructureView] = _Lru(VIEW_CACHE_SIZE)

    def profile(self, *, read_images: bool) -> ParseProfile:
        """What a parse made now depends on. Reading images needs a vision model:
        without one, it changes nothing and is not part of the profile."""

        return ParseProfile(
            parser_version=PARSER_VERSION,
            docling_schema=CURRENT_VERSION,
            read_images=read_images and self._vision_model is not None,
            vision_model=self._vision_model,
        )

    async def ensure(
        self,
        document: Item,
        *,
        revision: ItemRevision | None = None,
        read_images: bool = False,
        convert: bool = True,
    ) -> ParsedStructure:
        """The Structured Document of ``revision`` (default: the current one) for the
        current parse profile, parsed and stored first when there is none.

        A stored one is reused when the revision's manifest names this profile's
        fingerprint, or when the object of that fingerprint already exists (the
        key names one parse). ``convert=False`` never asks Gotenberg: a format
        parsed through its PDF whose PDF is not stored yet raises
        :class:`~bomesh.services.DocumentProcessingError`. Parsing errors are the
        parser's (:class:`~bomesh.services.DocumentProcessingError`).
        """

        if revision is None:
            revision = await self._current_revision(document)
        profile = self.profile(read_images=read_images)
        ref = StructureRef(document.tenant_id, revision.content_id, profile.fingerprint())
        manifest = StructureManifest.parse(revision.exports)
        if manifest is not None and manifest.fingerprint == ref.fingerprint:
            try:
                return ParsedStructure(ref, manifest, await self.document(ref))
            except StructureUnavailable:
                pass
        else:
            stored = await self._stored(ref)
            if stored is not None:
                await self._record(revision, stored.manifest)
                return stored
        parsed = await self._parser.parse(
            document, revision=revision, read_images=profile.read_images, convert=convert
        )
        pictures, data = await asyncio.to_thread(_externalized, parsed)
        for picture in pictures:
            await asyncio.to_thread(
                self._storage.put_bytes,
                picture.data,
                ref.picture_key(picture.name),
                content_type="image/png",
                cache_control=IMMUTABLE_CACHE_CONTROL,
            )
        # Pictures first: a stored document never names a missing picture.
        await asyncio.to_thread(
            self._storage.put_bytes,
            data,
            ref.key,
            content_type=MEDIA_TYPE,
            cache_control=IMMUTABLE_CACHE_CONTROL,
        )
        manifest = _manifest(parsed, fingerprint=ref.fingerprint, size_bytes=len(data))
        self._documents.put(ref, parsed)
        await self._record(revision, manifest)
        return ParsedStructure(ref, manifest, parsed)

    async def document(self, ref: StructureRef) -> DoclingDocument:
        """The validated ``DoclingDocument`` of ``ref`` (for chunking and serializers)."""

        cached = self._documents.get(ref)
        if cached is not None:
            return cached
        data = await self._read(ref)
        try:
            document = await asyncio.to_thread(decode_document, data)
        except StructureDecodeError as exc:
            raise StructureUnavailable(str(exc)) from exc
        self._documents.put(ref, document)
        return document

    async def view(self, ref: StructureRef) -> StructureView:
        """The read projection of ``ref`` (for the content API)."""

        cached = self._views.get(ref)
        if cached is not None:
            return cached
        data = await self._read(ref)
        try:
            view = await asyncio.to_thread(_view, data)
        except StructureDecodeError as exc:
            raise StructureUnavailable(str(exc)) from exc
        if _gzip_size(data) <= MAX_CACHED_VIEW_JSON_BYTES:
            self._views.put(ref, view)
        return view

    async def _stored(self, ref: StructureRef) -> ParsedStructure | None:
        """The object of ``ref`` when an earlier parse with this profile stored it."""

        try:
            data = await self._read(ref)
            document = await asyncio.to_thread(decode_document, data)
        except (StructureUnavailable, StructureDecodeError):
            return None
        self._documents.put(ref, document)
        manifest = _manifest(document, fingerprint=ref.fingerprint, size_bytes=len(data))
        return ParsedStructure(ref, manifest, document)

    async def _read(self, ref: StructureRef) -> bytes:
        try:
            return await self._storage.read(ref.key, max_bytes=MAX_STRUCTURE_BYTES)
        except ObjectNotFoundError as exc:
            raise StructureUnavailable("the Structured Document is not in storage") from exc

    async def _current_revision(self, document: Item) -> ItemRevision:
        if document.current_revision_id is None:
            raise DocumentUnavailableError("the document has no stored original")
        async with transaction_scope(self._sessions) as session:
            revision = await session.get(ItemRevision, document.current_revision_id)
        if revision is None:
            raise DocumentUnavailableError("the document has no stored original")
        return revision

    async def _record(self, revision: ItemRevision, manifest: StructureManifest) -> None:
        """Name ``manifest`` in every revision showing this content (one parse serves all)."""

        value = manifest.model_dump(mode="json")
        async with transaction_scope(self._sessions) as session:
            await session.execute(
                update(ItemRevision)
                .where(ItemRevision.content_id == revision.content_id)
                .values(
                    exports=ItemRevision.exports.op("||")(
                        literal({"structure": value}, type_=JSONB)
                    )
                )
                .execution_options(synchronize_session=False)
            )
        set_committed_value(revision, "exports", {**(revision.exports or {}), "structure": value})


def _externalized(document: DoclingDocument) -> tuple[tuple[PictureObject, ...], bytes]:
    """Move the pictures out of ``document`` and encode it (mutates ``document``)."""

    pictures = externalize_pictures(document)
    return pictures, encode(document)


def _view(data: bytes) -> StructureView:
    return StructureView(decode_json(data))


def _gzip_size(data: bytes) -> int:
    """The uncompressed size a gzip member records (its ISIZE trailer)."""

    return int.from_bytes(data[-4:], "little") if len(data) >= 4 else 0


def _manifest(document: DoclingDocument, *, fingerprint: str, size_bytes: int) -> StructureManifest:
    pictures = {
        str(picture.image.uri) for picture in document.pictures if picture.image is not None
    }
    return StructureManifest(
        fingerprint=fingerprint,
        docling_schema=document.version,
        size_bytes=size_bytes,
        nodes=sum(len(getattr(document, collection)) for collection in _NODE_COLLECTIONS),
        pictures=len(pictures),
        pages=len(document.pages) or None,
    )


__all__ = [
    "MAX_STRUCTURE_BYTES",
    "ParsedStructure",
    "StructureStore",
    "StructureUnavailable",
]
