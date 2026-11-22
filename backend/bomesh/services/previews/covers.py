"""Document covers: what a document's first page looks like (``document_viewer.md`` "Cover on the Item").

The engine produces the cover in the content-arrival job, after the
representation, from what the representation made viewable
(:func:`cover_plan`): page one of a PDF representation (the original or the
converted file, so office documents get real first pages; ``slide`` for
presentations), the picture (or its WebP), the first sheet's top-left cells
(XLSX, CSV, TSV) and the first lines of TEXT. Anything else, a file that
cannot be shown or read, stores ``none`` and is not tried again until its
content changes. One page only, bounded by :data:`COVER_MAX_SOURCE_BYTES` and
:data:`COVER_SECONDS`. The cover lives in ``item_revisions.exports.cover`` of
the revision the Item shows (a few hundred bytes, never a key); its image,
when there is one, is the immutable WebP ``derived/{tenant}/{content_id}/cover-v{n}``.
Requests never produce covers; every listed Item resolves one from its
read-only ``Item.cover`` view of the current revision (:func:`resolve_cover`).
"""

from __future__ import annotations

import asyncio
import csv
import logging
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, replace
from datetime import date, datetime
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any
from uuid import UUID

import openpyxl
import pypdfium2 as pdfium
from openpyxl.utils.exceptions import InvalidFileException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import type_coerce, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm.attributes import set_committed_value

from bomesh.connector.processing.pdfium_lock import PDFIUM_LOCK
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.services.knowledge_items.records import Cover
from bomesh.services.previews.formats import Format
from bomesh.services.previews.manifest import StoredRepresentation, representation_key
from bomesh.services.previews.results import ConversionFailed
from bomesh.services.previews.text import decode_text
from bomesh.storage import DocumentStorage, ObjectNotFoundError
from bomesh.storage.keys import COVER, IMMUTABLE_CACHE_CONTROL, content_key, derived_key

log = logging.getLogger(__name__)

#: Producer version: a stored cover of another version is produced again. 2: covers are drawn from the
#: representation (page 1 of a converted PDF, the picture, the table, the text).
COVER_VERSION = 2
#: ``pg_notify`` channel of ``trg_items_cover``; the payload is the Item ID.
COVER_CHANNEL = "bomesh_cover"
#: Sources larger than this get no cover (the format's typed tile).
COVER_MAX_SOURCE_BYTES = 50 * 1024 * 1024
#: Wall-clock bound of producing one cover.
COVER_SECONDS = 30.0
COVER_WIDTH = 480
COVER_MAX_HEIGHT = 960
COVER_WEBP_QUALITY = 75
#: A cover above this is encoded again at :data:`_DENSE_WEBP_QUALITY` (busy pages, photos).
COVER_TARGET_BYTES = 40 * 1024
_DENSE_WEBP_QUALITY = 55
#: An embedded thumbnail whose grey levels span less than this is blank.
_BLANK_RANGE = 8

TITLE_CHARS = 200
LINE_COUNT = 8
LINE_CHARS = 160
#: Characters all lines of a cover hold together: a card shows a few lines,
#: and the cover rides on every listed row (the current revision, list JSON).
TEXT_CHARS = 480
ROW_COUNT = 6
COLUMN_COUNT = 5
CELL_CHARS = 40

#: Decoded pixels an image may have (a decompression bomb is refused).
_MAX_PIXELS = 40_000_000
#: Bytes of a text source read for its first lines.
_TEXT_BYTES = 16 * 1024
#: Largest package part (XML, thumbnail) read whole.
_PART_BYTES = 4 * 1024 * 1024

#: Stored ``kind`` → ``DocumentCover.kind``; ``none`` shows the typed tile.
_KINDS = {"page": "PAGE", "slide": "SLIDE", "sheet": "SHEET", "text": "TEXT", "image": "IMAGE"}

_PACKAGE_RELS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_THUMBNAIL_RELATIONSHIP = (
    "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"
)
_RASTER_THUMBNAILS = frozenset({".jpeg", ".jpg", ".png"})


@dataclass(frozen=True, slots=True)
class RenderedCover:
    """A produced cover: an image of the first page, or its text."""

    #: ``page``, ``slide``, ``sheet``, ``text`` or ``image``.
    kind: str
    image: bytes | None = None
    width: int | None = None
    height: int | None = None
    title: str | None = None
    lines: tuple[str, ...] = ()
    cells: tuple[tuple[str, ...], ...] = ()


@dataclass(frozen=True, slots=True)
class CoverPlan:
    """Which object a cover is drawn from, and how."""

    #: ``pdf``, ``image``, ``xlsx``, ``csv``, ``text`` or ``markdown``.
    producer: str
    key: str
    size_bytes: int
    #: The object's extension (the producer of a CSV tells ``tsv`` by it).
    extension: str
    #: ``slide`` for a presentation's PDF; else the producer's own kind.
    kind: str | None = None


def cover_plan(
    file_format: Format | None,
    representation: StoredRepresentation | None,
    *,
    tenant_id: UUID,
    content_id: UUID,
    size_bytes: int,
) -> CoverPlan | None:
    """The cover source of a content whose representation is settled; ``None``: no picture.

    PDF and IMAGE covers draw the representation (the original when it is
    one); TABLE covers read the original's first cells; TEXT covers the
    UTF-8 representation's first lines.
    """
    if file_format is None or representation is None:
        return None
    original = content_key(tenant_id, content_id)
    made = representation_key(tenant_id, content_id) if representation.stored else None
    key = made or original
    size = representation.size_bytes if made else size_bytes
    if representation.kind == "PDF":
        return CoverPlan("pdf", key, size, "pdf", kind="slide" if file_format.slides else "page")
    if representation.kind == "IMAGE":
        return CoverPlan("image", key, size, "webp" if made else file_format.name)
    if representation.kind == "TABLE":
        producer = "xlsx" if file_format.name in ("xlsx", "xlsm") else "csv"
        return CoverPlan(producer, original, size_bytes, file_format.name)
    if representation.kind == "TEXT" and made:
        producer = "markdown" if representation.text_format == "MARKDOWN" else "text"
        return CoverPlan(producer, made, representation.size_bytes, "txt")
    return None


# -- Rendering ------------------------------------------------------------------------


def render_cover(source: Path, plan: CoverPlan) -> RenderedCover | None:
    """The first page of ``source`` (blocking; bounded); ``None`` when it has nothing to show."""
    cover = _PRODUCERS[plan.producer](source)
    if cover is not None and plan.kind is not None:
        cover = replace(cover, kind=plan.kind)
    if cover is None or not cover.lines:
        return cover
    lines: list[str] = []
    left = TEXT_CHARS
    for line in cover.lines:
        if left <= 0:
            break
        lines.append(line[:left])
        left -= len(lines[-1])
    return replace(cover, lines=tuple(lines))


def _pdf(source: Path) -> RenderedCover | None:
    with PDFIUM_LOCK:
        document = pdfium.PdfDocument(str(source))
        try:
            if len(document) < 1:
                return None
            page = document[0]
            try:
                width, height = page.get_size()
                if width <= 0 or height <= 0:
                    return None
                bitmap = page.render(scale=min(COVER_WIDTH / width, COVER_MAX_HEIGHT / height))
                try:
                    image = bitmap.to_pil()
                    try:
                        return _image_cover("page", image)
                    finally:
                        image.close()
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            document.close()


def _picture(source: Path) -> RenderedCover | None:
    with Image.open(source) as image:
        return _image_cover("image", image)


def _image_cover(kind: str, image: Image.Image) -> RenderedCover:
    """``image`` scaled into the cover box and encoded as WebP."""
    width, height = image.size
    if width < 1 or height < 1 or width * height > _MAX_PIXELS:
        raise ValueError("cover image has unusable dimensions")
    # JPEG decodes straight at a reduced scale; other formats ignore the draft.
    image.draft("RGB", (COVER_WIDTH, COVER_MAX_HEIGHT))
    oriented = ImageOps.exif_transpose(image)
    mode = "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
    frame = oriented.convert(mode)
    try:
        frame.thumbnail((COVER_WIDTH, COVER_MAX_HEIGHT), Image.Resampling.LANCZOS)
        data = _webp(frame, COVER_WEBP_QUALITY)
        if len(data) > COVER_TARGET_BYTES:
            data = _webp(frame, _DENSE_WEBP_QUALITY)
        return RenderedCover(kind, image=data, width=frame.width, height=frame.height)
    finally:
        frame.close()
        if oriented is not image:
            oriented.close()


def _webp(image: Image.Image, quality: int) -> bytes:
    output = BytesIO()
    image.save(output, format="WEBP", quality=quality, method=4)
    return output.getvalue()


def _xlsx(source: Path) -> RenderedCover | None:
    with zipfile.ZipFile(source) as package:
        embedded = _embedded_thumbnail(package, "sheet")
    if embedded is not None:
        return embedded
    workbook = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        if not workbook.worksheets:
            return None
        sheet = workbook.worksheets[0]
        rows = [
            tuple(_cell(value) for value in row)
            for row in sheet.iter_rows(
                min_row=1, max_row=ROW_COUNT, max_col=COLUMN_COUNT, values_only=True
            )
        ]
        title = _line(sheet.title, TITLE_CHARS) or None
    finally:
        workbook.close()
    cells = _grid(rows)
    if not cells:
        return None
    return RenderedCover("sheet", title=title, cells=cells)


def _embedded_thumbnail(package: zipfile.ZipFile, kind: str) -> RenderedCover | None:
    """The package's raster ``docProps/thumbnail`` (EMF/WMF are ignored)."""
    try:
        relationships = ET.fromstring(_part(package, "_rels/.rels"))
    except KeyError:
        return None
    for relationship in relationships.iter(f"{_PACKAGE_RELS}Relationship"):
        if relationship.get("Type") != _THUMBNAIL_RELATIONSHIP:
            continue
        name = (relationship.get("Target") or "").lstrip("/")
        if Path(name).suffix.casefold() not in _RASTER_THUMBNAILS:
            return None
        try:
            data = _part(package, name)
        except KeyError:
            return None
        with Image.open(BytesIO(data)) as image:
            low, high = image.convert("L").getextrema()  # type: ignore[misc]
            # A blank picture is a template's placeholder, not this file's page.
            return _image_cover(kind, image) if high - low > _BLANK_RANGE else None
    return None


def _part(package: zipfile.ZipFile, name: str) -> bytes:
    """A package part read whole; :data:`_PART_BYTES` at most."""
    if package.getinfo(name).file_size > _PART_BYTES:
        raise ValueError(f"package part {name} is too large for a cover")
    return package.read(name)


def _text(source: Path) -> RenderedCover | None:
    lines = tuple(line[:LINE_CHARS] for line in _head_lines(source)[:LINE_COUNT])
    return RenderedCover("text", lines=lines) if lines else None


def _markdown(source: Path) -> RenderedCover | None:
    title: str | None = None
    lines: list[str] = []
    for line in _head_lines(source):
        if line.startswith("#") and title is None and not lines:
            title = _line(line.lstrip("#"), TITLE_CHARS) or None
        elif text := _line(line.lstrip("#>*- "), LINE_CHARS):
            lines.append(text)
        if len(lines) >= LINE_COUNT:
            break
    if title is None and not lines:
        return None
    return RenderedCover("text", title=title, lines=tuple(lines))


def _csv(source: Path) -> RenderedCover | None:
    sample = _head(source).splitlines()[:ROW_COUNT]
    delimiter = "\t" if source.suffix.casefold() == ".tsv" else _delimiter(sample)
    rows = [
        tuple(_line(value, CELL_CHARS) for value in row[:COLUMN_COUNT])
        for row in csv.reader(StringIO("\n".join(sample)), delimiter=delimiter)
    ]
    cells = _grid(rows)
    return RenderedCover("sheet", cells=cells) if cells else None


def _delimiter(sample: list[str]) -> str:
    try:
        return csv.Sniffer().sniff("\n".join(sample), delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


def _head(source: Path) -> str:
    with source.open("rb") as stream:
        data = stream.read(_TEXT_BYTES)
    try:
        return decode_text(data, complete=source.stat().st_size <= _TEXT_BYTES)
    except ConversionFailed:
        return data.decode("utf-8", errors="replace")


def _head_lines(source: Path) -> list[str]:
    """The first non-blank lines (whitespace collapsed), one more than a cover shows."""
    lines: list[str] = []
    for raw in _head(source).splitlines():
        line = _line(raw, max(TITLE_CHARS, LINE_CHARS) + 2)
        if line:
            lines.append(line)
        if len(lines) > LINE_COUNT:
            break
    return lines


def _grid(rows: Iterable[tuple[str, ...]]) -> tuple[tuple[str, ...], ...]:
    """The non-empty rows, cut after the last column with a value; ``()`` when all empty."""
    kept = [row for row in rows if any(row)][:ROW_COUNT]
    width = max(
        (max((i + 1 for i, cell in enumerate(row) if cell), default=0) for row in kept),
        default=0,
    )
    return tuple(tuple((*row, *("",) * width)[:width]) for row in kept) if width else ()


def _cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, datetime):
        value = value.date() if value.time() == datetime.min.time() else value.replace(microsecond=0)
    if isinstance(value, date):
        return value.isoformat()
    return _line(str(value), CELL_CHARS)


def _line(value: str, limit: int) -> str:
    return " ".join(value.split())[:limit]


_PRODUCERS: dict[str, Callable[[Path], RenderedCover | None]] = {
    "pdf": _pdf,
    "image": _picture,
    "xlsx": _xlsx,
    "text": _text,
    "markdown": _markdown,
    "csv": _csv,
}

#: Errors a file's own content raises while its first page is read: expected,
#: recorded as ``none`` without a warning (a timeout or anything else warns).
_UNREADABLE: tuple[type[BaseException], ...] = (
    pdfium.PdfiumError,
    zipfile.BadZipFile,
    UnidentifiedImageError,
    InvalidFileException,
    ET.ParseError,
    csv.Error,
    KeyError,
    ValueError,
)


# -- Storing -------------------------------------------------------------------------


class DocumentCovers:
    """Draw and store the cover of a document's current content (the engine's last step)."""

    def __init__(
        self,
        sessions: SessionFactory,
        storage: DocumentStorage,
        *,
        max_source_bytes: int = COVER_MAX_SOURCE_BYTES,
        timeout_seconds: float = COVER_SECONDS,
    ) -> None:
        self._sessions = sessions
        self._storage = storage
        self._max_source_bytes = max_source_bytes
        self._timeout_seconds = timeout_seconds

    async def store(self, item: Item, revision: ItemRevision, plan: CoverPlan | None) -> str | None:
        """Draw ``plan`` (``None``: nothing to show) and store it as ``revision``'s cover.

        The stored kind, or ``None`` when ``revision`` was meanwhile deleted.
        A storage failure propagates (the next sweep tries again); a source
        that cannot be read is stored as ``none``.
        """
        cover: dict[str, Any] = {"version": COVER_VERSION}
        rendered = await self._render(item, plan) if plan is not None else None
        if rendered is None:
            cover["kind"] = "none"
        else:
            cover.update(_stored(rendered))
            if rendered.image is not None:
                await asyncio.to_thread(
                    self._storage.put_bytes,
                    rendered.image,
                    derived_key(item.tenant_id, revision.content_id, COVER, COVER_VERSION),
                    content_type="image/webp",
                    cache_control=IMMUTABLE_CACHE_CONTROL,
                )
                cover.update(stored=True, width=rendered.width, height=rendered.height)
        async with transaction_scope(self._sessions) as session:
            # The revision's content never changes; the Item row (updated_at, etag) is untouched.
            written = await session.execute(
                update(ItemRevision)
                .where(ItemRevision.id == revision.id, ItemRevision.deleted_at.is_(None))
                .values(exports=ItemRevision.exports.op("||")(type_coerce({"cover": cover}, JSONB)))
            )
        if not written.rowcount:  # type: ignore[attr-defined]
            return None
        if item.current_revision_id == revision.id:
            # The Item's read-only cover view (see ``ItemService``) follows its revision.
            set_committed_value(item, "cover", cover)
        return cover["kind"]

    async def _render(self, item: Item, plan: CoverPlan) -> RenderedCover | None:
        if plan.size_bytes > self._max_source_bytes:
            return None
        with tempfile.TemporaryDirectory(prefix="bomesh-cover-") as directory:
            path = Path(directory) / f"source.{plan.extension}"
            try:
                await self._storage.download_to_path(
                    plan.key, path, max_bytes=self._max_source_bytes
                )
            except ObjectNotFoundError:
                return None
            try:
                return await asyncio.wait_for(
                    asyncio.to_thread(render_cover, path, plan), self._timeout_seconds
                )
            except _UNREADABLE as exc:
                # The file's own content (corrupt, encrypted, mislabelled): its typed tile shows.
                log.debug(
                    "document has no readable first page item_id=%s error_type=%s",
                    item.id,
                    type(exc).__name__,
                )
                return None
            except Exception as exc:  # noqa: BLE001 - never fails the worker; the tile shows
                log.warning(
                    "document cover failed item_id=%s error_type=%s", item.id, type(exc).__name__
                )
                return None


def cover_is_current(revision: ItemRevision) -> bool:
    """Whether ``revision`` holds a cover by this producer version."""
    stored = revision.exports.get("cover")
    return isinstance(stored, Mapping) and stored.get("version") == COVER_VERSION


def _stored(rendered: RenderedCover) -> dict[str, Any]:
    stored: dict[str, Any] = {"kind": rendered.kind}
    if rendered.title:
        stored["title"] = rendered.title
    if rendered.lines:
        stored["lines"] = list(rendered.lines)
    if rendered.cells:
        stored["cells"] = [list(row) for row in rendered.cells]
    return stored


# -- Reading -------------------------------------------------------------------------


def resolve_cover(storage: DocumentStorage, item: Item, *, expires_seconds: int) -> Cover | None:
    """``document.cover`` of a loaded Item: its current revision's cover, at most one signed URL, no query.

    ``None`` for a collection, a DELETED item, a revision without a cover yet,
    or a document with nothing to show. A cover of an older producer version
    is shown until the sweep produces it again.
    """
    if item.item_kind != "document" or item.deleted_at is not None:
        return None
    stored = item.cover  # set only while a revision is shown
    if item.content_id is None or not isinstance(stored, Mapping):
        return None
    kind = stored.get("kind")
    kind = _KINDS.get(kind) if isinstance(kind, str) else None
    if kind is None:
        return None
    image_uri = _image_uri(storage, item, item.content_id, stored, expires_seconds)
    lines = _strings(stored.get("lines"))
    cells = tuple(
        _strings(row) for row in stored.get("cells") or () if isinstance(row, list)
    )
    title = stored.get("title")
    if image_uri is None and not lines and not cells and not title:
        return None
    return Cover(
        kind=kind,
        image_uri=image_uri,
        width_pixels=_pixels(stored.get("width")) if image_uri else None,
        height_pixels=_pixels(stored.get("height")) if image_uri else None,
        title=title if isinstance(title, str) else None,
        lines=() if image_uri else lines,
        cells=() if image_uri else cells,
    )


def _image_uri(
    storage: DocumentStorage,
    item: Item,
    content_id: UUID,
    stored: Mapping[str, Any],
    expires_seconds: int,
) -> str | None:
    version = stored.get("version")
    if stored.get("stored") is not True or not isinstance(version, int) or version < 1:
        return None
    key = derived_key(item.tenant_id, content_id, COVER, version)
    try:
        return storage.presign_download(key, expires_seconds=expires_seconds, stable=True).url
    except Exception:
        log.exception("could not sign a document cover")
        return None


def _strings(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(entry for entry in value if isinstance(entry, str))


def _pixels(value: object) -> int | None:
    return value if isinstance(value, int) and value > 0 else None


__all__ = [
    "COVER_CHANNEL",
    "COVER_VERSION",
    "CoverPlan",
    "DocumentCovers",
    "RenderedCover",
    "cover_is_current",
    "cover_plan",
    "render_cover",
    "resolve_cover",
]
