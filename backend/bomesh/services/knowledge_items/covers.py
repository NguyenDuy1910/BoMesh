"""Document covers: what a document's first page looks like.

``document_viewer.md`` "Cover on the Item". The ingestion worker produces a
cover when a document's content arrives (``trg_items_cover`` notifies
:data:`COVER_CHANNEL`) and in its periodic sweep; requests never produce one.
One document at a time, page one only, bounded by :data:`COVER_MAX_SOURCE_BYTES`
and :data:`COVER_SECONDS`. The cover lives in ``items.metadata.cover`` (a few
hundred bytes); its image, when there is one, is an immutable WebP under the
Item's preview prefix, named after the original it shows.

Per format: a PDF renders page one; an image is scaled down; DOCX/PPTX/XLSX
use the package's embedded thumbnail, else the first page's text (the first
slide's title and text, the first sheet's top-left cells); text formats keep
their first lines. Anything else, or a file that cannot be read, is stored as
``none`` so it is not tried again until its content changes.
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import logging
import posixpath
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, replace
from datetime import date, datetime
from html.parser import HTMLParser
from io import BytesIO, StringIO
from pathlib import Path
from typing import IO, Any
from uuid import UUID

import openpyxl
import pypdfium2 as pdfium
from openpyxl.utils.exceptions import InvalidFileException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import or_, select, type_coerce, update
from sqlalchemy.dialects.postgresql import JSONB

from bomesh.connector.processing.pdfium_lock import PDFIUM_LOCK
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Item
from bomesh.services.knowledge_items.preview import preview_prefix
from bomesh.services.knowledge_items.records import Cover
from bomesh.storage import DocumentStorage, ObjectNotFoundError

log = logging.getLogger(__name__)

#: Producer version: a stored cover of another version is produced again.
COVER_VERSION = 1
#: ``pg_notify`` channel of ``trg_items_cover``; the payload is the Item ID.
COVER_CHANNEL = "bomesh_cover"
#: Originals larger than this get no cover (the format's typed tile).
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
COVER_CACHE_CONTROL = "private, max-age=31536000, immutable"

TITLE_CHARS = 200
LINE_COUNT = 8
LINE_CHARS = 160
#: Characters all lines of a cover hold together: a card shows a few lines,
#: and the cover rides on every listed row (``items.metadata``, list JSON).
TEXT_CHARS = 480
ROW_COUNT = 6
COLUMN_COUNT = 5
CELL_CHARS = 40

#: Decoded pixels an image may have (a decompression bomb is refused).
_MAX_PIXELS = 40_000_000
#: Bytes of a text original read for its first lines.
_TEXT_BYTES = 16 * 1024
_HTML_BYTES = 64 * 1024
#: Largest package part (XML, thumbnail) read whole.
_PART_BYTES = 4 * 1024 * 1024
#: DOCX paragraphs scanned at most for the first page's lines.
_DOCX_PARAGRAPHS = 400

#: Stored ``kind`` → ``DocumentCover.kind``; ``none`` shows the typed tile.
_KINDS = {"page": "PAGE", "slide": "SLIDE", "sheet": "SHEET", "text": "TEXT", "image": "IMAGE"}

_FORMATS_BY_EXTENSION = {
    ".pdf": "pdf",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".gif": "image",
    ".docx": "docx",
    ".pptx": "pptx",
    ".xlsx": "xlsx",
    ".txt": "text",
    ".md": "markdown",
    ".markdown": "markdown",
    ".csv": "csv",
    ".tsv": "csv",
    ".html": "html",
    ".htm": "html",
}
_FORMATS_BY_TYPE = {
    "application/pdf": "pdf",
    "image/png": "image",
    "image/jpeg": "image",
    "image/webp": "image",
    "image/gif": "image",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/plain": "text",
    "text/markdown": "markdown",
    "text/csv": "csv",
    "text/tab-separated-values": "csv",
    "text/html": "html",
}

_PACKAGE_RELS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_THUMBNAIL_RELATIONSHIP = (
    "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"
)
_RASTER_THUMBNAILS = frozenset({".jpeg", ".jpg", ".png"})
_PML = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
_DML = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_WML = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


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


# -- Producing ----------------------------------------------------------------------


def cover_format(file_name: str, content_type: str | None) -> str | None:
    """The producer of a file (``pdf``, ``image``, ``docx`` …), or ``None``."""
    extension = Path(file_name).suffix.casefold()
    normalized = (content_type or "").split(";", 1)[0].strip().casefold()
    return _FORMATS_BY_EXTENSION.get(extension) or _FORMATS_BY_TYPE.get(normalized)


def render_cover(
    source: Path, *, file_name: str, content_type: str | None
) -> RenderedCover | None:
    """The first page of ``source`` (blocking; bounded); ``None`` when it has nothing to show."""
    producer = _PRODUCERS.get(cover_format(file_name, content_type) or "")
    cover = producer(source) if producer is not None else None
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


def _docx(source: Path) -> RenderedCover | None:
    with zipfile.ZipFile(source) as package:
        embedded = _embedded_thumbnail(package, "page")
        if embedded is not None:
            return embedded
        with package.open("word/document.xml") as part:
            title, lines = _docx_first_page(part)
    if title is None and not lines:
        return None
    return RenderedCover("page", title=title, lines=lines)


def _docx_first_page(part: IO[bytes]) -> tuple[str | None, tuple[str, ...]]:
    """The first heading and the opening lines, read until the first page break."""
    title: str | None = None
    lines: list[str] = []
    scanned = 0
    for _, element in ET.iterparse(part, events=("end",)):
        if element.tag != f"{_WML}p":
            continue
        scanned += 1
        breaks = any(br.get(f"{_WML}type") == "page" for br in element.iter(f"{_WML}br"))
        breaks = breaks or next(element.iter(f"{_WML}lastRenderedPageBreak"), None) is not None
        if breaks and (title is not None or lines):
            break
        text = _line("".join(node.text or "" for node in element.iter(f"{_WML}t")), LINE_CHARS)
        style = element.find(f"{_WML}pPr/{_WML}pStyle")
        style_id = (style.get(f"{_WML}val") or "").casefold() if style is not None else ""
        if text and title is None and (style_id == "title" or style_id.startswith("heading")):
            title = text[:TITLE_CHARS]
        elif text:
            lines.append(text)
        element.clear()
        if len(lines) >= LINE_COUNT or scanned >= _DOCX_PARAGRAPHS:
            break
    return title, tuple(lines[:LINE_COUNT])


def _pptx(source: Path) -> RenderedCover | None:
    with zipfile.ZipFile(source) as package:
        embedded = _embedded_thumbnail(package, "slide")
        if embedded is not None:
            return embedded
        slide = _first_slide(package)
        if slide is None:
            return None
        title: str | None = None
        lines: list[str] = []
        with package.open(slide) as part:
            for _, element in ET.iterparse(part, events=("end",)):
                if element.tag != f"{_PML}sp":
                    continue
                placeholder = element.find(f"{_PML}nvSpPr/{_PML}nvPr/{_PML}ph")
                is_title = placeholder is not None and placeholder.get("type") in {
                    "title",
                    "ctrTitle",
                }
                paragraphs = [
                    text
                    for paragraph in element.iter(f"{_DML}p")
                    if (text := _line("".join(n.text or "" for n in paragraph.iter(f"{_DML}t")), LINE_CHARS))
                ]
                if is_title and title is None and paragraphs:
                    title = " ".join(paragraphs)[:TITLE_CHARS]
                else:
                    lines.extend(paragraphs)
                element.clear()
                if len(lines) >= LINE_COUNT and title is not None:
                    break
    if title is None and not lines:
        return None
    return RenderedCover("slide", title=title, lines=tuple(lines[:LINE_COUNT]))


def _first_slide(package: zipfile.ZipFile) -> str | None:
    """The part name of the presentation's first slide (``sldIdLst`` order)."""
    presentation = ET.fromstring(_part(package, "ppt/presentation.xml"))
    first = presentation.find(f"{_PML}sldIdLst/{_PML}sldId")
    if first is None:
        return None
    relationship_id = first.get(f"{_REL}id")
    relationships = ET.fromstring(_part(package, "ppt/_rels/presentation.xml.rels"))
    for relationship in relationships.iter(f"{_PACKAGE_RELS}Relationship"):
        if relationship.get("Id") == relationship_id:
            return _part_name("ppt", relationship.get("Target") or "")
    return None


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
        name = _part_name("", relationship.get("Target") or "")
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


def _part_name(base: str, target: str) -> str:
    """A relationship target as a part name (``/ppt/slides/slide1.xml`` → ``ppt/slides/slide1.xml``)."""
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(base, target))


def _text(source: Path) -> RenderedCover | None:
    lines = tuple(line[:LINE_CHARS] for line in _head_lines(source, _TEXT_BYTES)[:LINE_COUNT])
    return RenderedCover("text", lines=lines) if lines else None


def _markdown(source: Path) -> RenderedCover | None:
    title: str | None = None
    lines: list[str] = []
    for line in _head_lines(source, _TEXT_BYTES):
        if line.startswith("#") and title is None and not lines:
            title = _line(line.lstrip("#"), TITLE_CHARS) or None
        elif text := _line(line.lstrip("#>*- "), LINE_CHARS):
            lines.append(text)
        if len(lines) >= LINE_COUNT:
            break
    if title is None and not lines:
        return None
    return RenderedCover("text", title=title, lines=tuple(lines))


def _html(source: Path) -> RenderedCover | None:
    reader = _HtmlText()
    reader.feed(_head(source, _HTML_BYTES))
    reader.close()
    lines = [line for line in reader.lines if line != reader.title][:LINE_COUNT]
    if reader.title is None and not lines:
        return None
    return RenderedCover("text", title=reader.title, lines=tuple(lines))


class _HtmlText(HTMLParser):
    """The ``<title>`` (else first ``<h1>``) and the first visible text lines."""

    _BLOCKS = frozenset({"p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "br", "section"})
    _HIDDEN = frozenset({"script", "style", "noscript", "template", "svg"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: str | None = None
        self.lines: list[str] = []
        self._buffer: list[str] = []
        self._hidden = 0
        self._in_title = False
        self._in_h1 = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
        elif tag in self._HIDDEN:
            self._hidden += 1
        elif tag in self._BLOCKS:
            self._flush()
            self._in_h1 = tag == "h1"

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag in self._HIDDEN:
            self._hidden = max(0, self._hidden - 1)
        elif tag in self._BLOCKS:
            if self._in_h1 and self.title is None:
                self.title = _line(" ".join(self._buffer), TITLE_CHARS) or None
            self._flush()
            self._in_h1 = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title = self.title or _line(data, TITLE_CHARS) or None
        elif not self._hidden and len(self.lines) < LINE_COUNT + 1:
            self._buffer.append(data)

    def close(self) -> None:
        super().close()
        self._flush()

    def _flush(self) -> None:
        line = _line(" ".join(self._buffer), LINE_CHARS)
        self._buffer.clear()
        if line and len(self.lines) < LINE_COUNT + 1:
            self.lines.append(line)


def _csv(source: Path) -> RenderedCover | None:
    text = _head(source, _TEXT_BYTES)
    sample = text.splitlines()[:ROW_COUNT]
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


def _head(source: Path, limit: int) -> str:
    with source.open("rb") as stream:
        return stream.read(limit).decode("utf-8-sig", errors="replace")


def _head_lines(source: Path, limit: int) -> list[str]:
    """The first non-blank lines (whitespace collapsed), one more than a cover shows."""
    lines: list[str] = []
    for raw in _head(source, limit).splitlines():
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
    "docx": _docx,
    "pptx": _pptx,
    "xlsx": _xlsx,
    "text": _text,
    "markdown": _markdown,
    "html": _html,
    "csv": _csv,
}


# -- Storing -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Source:
    item: Item
    storage_key: str
    file_name: str
    content_type: str | None
    size_bytes: int | None


class DocumentCovers:
    """Produce and store covers (ingestion worker); find the documents that lack one."""

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

    async def refresh(self, item_id: UUID) -> str | None:
        """Produce the cover of ``item_id`` unless it is current; the stored kind, else ``None``.

        A storage failure propagates (the next sweep tries again); a file that
        cannot be read is stored as ``none``.
        """
        source = await self._source(item_id)
        if source is None:
            return None
        cover: dict[str, Any] = {"version": COVER_VERSION, "source": source.storage_key}
        rendered = await self._render(source)
        if rendered is None:
            cover["kind"] = "none"
        else:
            cover.update(_stored(rendered))
            if rendered.image is not None:
                key = (
                    f"{preview_prefix(source.item)}cover-v{COVER_VERSION}/"
                    f"{hashlib.sha256(source.storage_key.encode()).hexdigest()}.webp"
                )
                await asyncio.to_thread(
                    self._storage.put_bytes,
                    rendered.image,
                    key,
                    content_type="image/webp",
                    cache_control=COVER_CACHE_CONTROL,
                )
                cover.update(key=key, width=rendered.width, height=rendered.height)
        async with transaction_scope(self._sessions) as session:
            # Only onto the content it shows; a cover is no edit (updated_at, etag stay).
            written = await session.execute(
                update(Item)
                .where(Item.id == item_id, Item.storage_key == source.storage_key)
                .values(
                    metadata_=Item.metadata_.op("||")(type_coerce({"cover": cover}, JSONB)),
                    updated_at=Item.updated_at,
                )
            )
        return cover["kind"] if written.rowcount else None  # type: ignore[attr-defined]

    async def stale(self, *, after: UUID | None, limit: int) -> list[UUID]:
        """Available documents whose cover is missing or not of their content, by ID."""
        cover = Item.metadata_["cover"]
        statement = (
            select(Item.id)
            .where(
                Item.item_type == "document",
                Item.status == "ready",
                Item.deleted_at.is_(None),
                Item.storage_key.is_not(None),
                or_(
                    cover["source"].astext.is_distinct_from(Item.storage_key),
                    cover["version"].astext.is_distinct_from(str(COVER_VERSION)),
                ),
            )
            .order_by(Item.id)
            .limit(limit)
        )
        if after is not None:
            statement = statement.where(Item.id > after)
        async with transaction_scope(self._sessions) as session:
            return list(await session.scalars(statement))

    async def _source(self, item_id: UUID) -> _Source | None:
        async with transaction_scope(self._sessions) as session:
            item = await session.get(Item, item_id)
            if (
                item is None
                or item.item_type != "document"
                or item.status != "ready"
                or item.deleted_at is not None
                or item.storage_key is None
                or _is_current(item.metadata_.get("cover"), item.storage_key)
            ):
                return None
            file_name = item.metadata_.get("file_name")
            return _Source(
                item=item,
                storage_key=item.storage_key,
                file_name=file_name if isinstance(file_name, str) else item.title,
                content_type=item.mime_type,
                size_bytes=item.size_bytes,
            )

    async def _render(self, source: _Source) -> RenderedCover | None:
        if cover_format(source.file_name, source.content_type) is None:
            return None
        if source.size_bytes is not None and source.size_bytes > self._max_source_bytes:
            return None
        suffix = Path(source.file_name).suffix[:16]
        with tempfile.TemporaryDirectory(prefix="bomesh-cover-") as directory:
            path = Path(directory) / f"source{suffix}"
            try:
                await self._storage.download_to_path(
                    source.storage_key, path, max_bytes=self._max_source_bytes
                )
            except ObjectNotFoundError:
                return None
            try:
                return await asyncio.wait_for(
                    asyncio.to_thread(
                        render_cover,
                        path,
                        file_name=source.file_name,
                        content_type=source.content_type,
                    ),
                    self._timeout_seconds,
                )
            except _UNREADABLE as exc:
                # The file's own content (corrupt, encrypted, mislabelled): its typed tile shows.
                log.debug(
                    "document has no readable first page item_id=%s error_type=%s",
                    source.item.id,
                    type(exc).__name__,
                )
                return None
            except Exception as exc:  # noqa: BLE001 - never fails the worker; the tile shows
                log.warning(
                    "document cover failed item_id=%s error_type=%s",
                    source.item.id,
                    type(exc).__name__,
                )
                return None


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


def _stored(rendered: RenderedCover) -> dict[str, Any]:
    stored: dict[str, Any] = {"kind": rendered.kind}
    if rendered.title:
        stored["title"] = rendered.title
    if rendered.lines:
        stored["lines"] = list(rendered.lines)
    if rendered.cells:
        stored["cells"] = [list(row) for row in rendered.cells]
    return stored


def _is_current(stored: object, storage_key: str) -> bool:
    return (
        isinstance(stored, Mapping)
        and stored.get("version") == COVER_VERSION
        and stored.get("source") == storage_key
    )


# -- Reading -------------------------------------------------------------------------


def resolve_cover(storage: DocumentStorage, item: Item, *, expires_seconds: int) -> Cover | None:
    """``document.cover`` of a loaded Item: at most one signed URL, no query.

    ``None`` for a collection, a DELETED item, a cover of other content than
    the current revision's, or a document with nothing to show.
    """
    if item.item_type != "document" or item.deleted_at is not None:
        return None
    stored = item.metadata_.get("cover")
    if not isinstance(stored, Mapping) or stored.get("source") != item.storage_key:
        return None
    kind = stored.get("kind")
    kind = _KINDS.get(kind) if isinstance(kind, str) else None
    if kind is None:
        return None
    image_uri = _image_uri(storage, item, stored.get("key"), expires_seconds)
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
    storage: DocumentStorage, item: Item, key: object, expires_seconds: int
) -> str | None:
    if not isinstance(key, str) or not key.startswith(preview_prefix(item)):
        return None
    try:
        return storage.presign_download(key, expires_seconds=expires_seconds, stable=True).url
    except Exception:  # noqa: BLE001 - the cover falls back to its text or tile
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
    "DocumentCovers",
    "RenderedCover",
    "cover_format",
    "render_cover",
    "resolve_cover",
]
