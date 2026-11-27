"""Cut a Structured Document into retrieval chunks that point back at its blocks.

Docling's chunkers decide the text (``HybridChunker``: heading-aware, token
bounded; ``LineBasedTokenChunker`` for line formats), with every table read as
one line per row (:mod:`.table_text`), so a split never cuts a row apart.
Every chunk then names the Structured Document **blocks** its items belong to
(:func:`~bomesh.document_structure.block_ref`) and carries a plain-text quote,
a location (sheet or section) read from those blocks, and the highlights a
:class:`~.highlights.Locator` finds for them in the Original preview — for a
table, only the rows the chunk holds (each line of :mod:`.table_text` names
its row, and a table's chunks take its lines in order).

A spreadsheet's sheets carry no headings, so Docling's peer merge would join
the last rows of one sheet with the first of the next; there the peers are
merged by the same rule, never across a sheet.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Literal

from docling.chunking import HybridChunker
from docling_core.transforms.chunker import DocChunk, DocMeta
from docling_core.transforms.chunker.hierarchical_chunker import ChunkingDocSerializer
from docling_core.transforms.chunker.line_chunker import LineBasedTokenChunker
from docling_core.types.doc import (
    CodeItem,
    DocItem,
    DoclingDocument,
    FormItem,
    GroupItem,
    KeyValueItem,
    PictureItem,
    SectionHeaderItem,
    TableItem,
    TextItem,
    TitleItem,
)

from bomesh.connector.protocol import Chunk
from bomesh.connector.protocol.chunks import MAX_CHUNK_LOCATION, MAX_CHUNK_QUOTE, MAX_CHUNK_REFS
from bomesh.document_structure import DoclingTree, block_ref, clip, node_ref

from . import ApproximateTokenizer, DoclingChunkingError
from .highlights import Locator, TableRows
from .table_text import RowTableSerializerProvider, table_lines

#: Tables as rows (:mod:`.table_text`) for chunk text and quotes alike.
_SERIALIZERS = RowTableSerializerProvider()

ChunkStrategy = Literal["hybrid", "line"]


class DoclingChunker:
    """Chunk a ``DoclingDocument`` into :class:`Chunk` objects with block references."""

    def __init__(
        self,
        *,
        tokenizer: Any | None = None,
        hybrid_chunker: Any | None = None,
        line_chunker: Any | None = None,
    ) -> None:
        self._tokenizer = tokenizer or ApproximateTokenizer()
        self._hybrid_chunker = hybrid_chunker
        self._line_chunker = line_chunker
        self._sheet_chunker: HybridChunker | None = None

    def chunk(
        self,
        document: DoclingDocument,
        *,
        item_id: str,
        strategy: ChunkStrategy = "hybrid",
        locator: Locator | None = None,
    ) -> list[Chunk]:
        """``locator`` places every chunk's blocks in the Original preview; without
        one, chunks carry no highlights."""
        try:
            if strategy == "line":
                docling_chunks = _line_chunks(document, self._resolve_chunker(strategy))
            elif _has_sheets(document):
                chunker = self._resolve_sheet_chunker()
                docling_chunks = _merged_within_sheets(
                    document, list(chunker.chunk(document)), chunker
                )
            else:
                docling_chunks = list(self._resolve_chunker(strategy).chunk(document))
        except Exception as exc:
            raise DoclingChunkingError(
                f"Docling {strategy} chunking failed for {item_id}"
            ) from exc

        tree = DoclingTree(document)
        heading_paths = _heading_paths(document)
        serializer = _SERIALIZERS.get_serializer(document)
        tables = _TableCursor(document)
        output: list[Chunk] = []
        for docling_chunk in docling_chunks:
            chunk_text = str(getattr(docling_chunk, "text", ""))
            if not chunk_text.strip():
                continue
            items = _chunk_items(document, docling_chunk)
            for part, text in _ref_bounded(tree, serializer, items, chunk_text):
                refs = _block_refs(tree, part)
                if not refs:
                    continue
                rows = tables.rows(part, text)
                section_path = _chunk_section_path(docling_chunk, part, heading_paths=heading_paths)
                sheet = _sheet_name(document, part[0])
                index = len(output)
                output.append(
                    Chunk(
                        id=f"{item_id}:{index}",
                        item_id=item_id,
                        chunk_index=index,
                        chunk_text=text.rstrip(),
                        content_type=_content_type(part),
                        section_path=list(section_path),
                        refs=refs,
                        quote=_quote(document, serializer, part, text),
                        location=clip(
                            sheet or (section_path[-1] if section_path else ""), MAX_CHUNK_LOCATION
                        ),
                        highlights=locator.locate(part, rows) if locator is not None else (),
                    )
                )
        if not output:
            raise DoclingChunkingError(f"Document {item_id!r} has no indexable content")
        return output

    def _resolve_chunker(self, strategy: ChunkStrategy) -> Any:
        if strategy == "hybrid":
            if self._hybrid_chunker is None:
                self._hybrid_chunker = HybridChunker(
                    tokenizer=self._tokenizer, serializer_provider=_SERIALIZERS
                )
            return self._hybrid_chunker
        if strategy == "line":
            if self._line_chunker is None:
                self._line_chunker = LineBasedTokenChunker(tokenizer=self._tokenizer)
            return self._line_chunker
        raise ValueError(f"Unknown Docling chunk strategy: {strategy}")

    def _resolve_sheet_chunker(self) -> HybridChunker:
        """Docling's hybrid chunker without its peer merge (done per sheet instead)."""

        if self._sheet_chunker is None:
            self._sheet_chunker = HybridChunker(
                tokenizer=self._tokenizer, serializer_provider=_SERIALIZERS, merge_peers=False
            )
        return self._sheet_chunker


def _has_sheets(document: DoclingDocument) -> bool:
    return any(_is_sheet(group) for group in document.groups)


def _is_sheet(node: Any) -> bool:
    return isinstance(node, GroupItem) and getattr(node.label, "value", node.label) == "sheet"


def _merged_within_sheets(
    document: DoclingDocument, chunks: list[DocChunk], chunker: HybridChunker
) -> list[DocChunk]:
    """Docling's peer merge, bounded by sheets.

    Like ``HybridChunker`` with ``merge_peers``: consecutive chunks under the
    same headings join while the joined chunk, headings included, fits
    ``max_tokens``. Here they must also be on the same sheet.
    """

    output: list[DocChunk] = []
    keys: list[tuple[tuple[str, ...], str | None]] = []
    for chunk in chunks:
        items = chunk.meta.doc_items
        key = (tuple(chunk.meta.headings or ()), _sheet_name(document, items[0]) if items else None)
        if output and keys[-1] == key:
            previous = output[-1]
            candidate = DocChunk(
                text=chunker.delim.join([previous.text, chunk.text]),
                meta=DocMeta(
                    doc_items=[*previous.meta.doc_items, *items],
                    headings=previous.meta.headings,
                    origin=chunk.meta.origin,
                ),
            )
            if chunker.tokenizer.count_tokens(chunker.contextualize(candidate)) <= chunker.max_tokens:
                output[-1] = candidate
                continue
        output.append(chunk)
        keys.append(key)
    return output


def _block_refs(tree: DoclingTree, items: list[DocItem]) -> tuple[str, ...]:
    refs: dict[str, None] = {}
    for item in items:
        try:
            refs[block_ref(tree, node_ref(item.self_ref))] = None
        except ValueError:
            continue
    return tuple(refs)


def _ref_bounded(
    tree: DoclingTree,
    serializer: ChunkingDocSerializer,
    items: list[DocItem],
    chunk_text: str,
) -> list[tuple[list[DocItem], str]]:
    """``items`` in consecutive parts naming at most ``MAX_CHUNK_REFS`` blocks each.

    A citation names at most that many blocks. A chunk of many tiny blocks (a
    sheet of scattered cells) is cut into parts, each keeping the lines of the
    chunk its items wrote: a block's own lines, or the rows of a table the
    chunk carries (a split table is never written out whole).
    """

    if len(_block_refs(tree, items)) <= MAX_CHUNK_REFS:
        return [(items, chunk_text)]
    lines = chunk_text.splitlines()
    cursor = 0
    written: list[list[str]] = []
    for item in items:
        own = serializer.serialize(item=item).text.splitlines()
        start = cursor
        if isinstance(item, TableItem):
            rows = set(own)
            while cursor < len(lines) and lines[cursor] in rows:
                cursor += 1
        else:
            cursor = min(cursor + len(own), len(lines))
        written.append(lines[start:cursor])
    written[-1] += lines[cursor:]
    parts: list[tuple[list[DocItem], list[str]]] = [([], [])]
    seen: set[str] = set()
    for item, item_lines in zip(items, written, strict=True):
        ref = _block_refs(tree, [item])
        if ref and ref[0] not in seen and len(seen) == MAX_CHUNK_REFS:
            parts.append(([], []))
            seen = set()
        parts[-1][0].append(item)
        parts[-1][1].extend(item_lines)
        seen.update(ref)
    return [(part, "\n".join(part_lines)) for part, part_lines in parts if "".join(part_lines).strip()]


def _quote(
    document: DoclingDocument,
    serializer: ChunkingDocSerializer,
    items: list[DocItem],
    chunk_text: str,
) -> str:
    """What the chunk says, as plain text from its blocks (never Markdown)."""

    structured = (TableItem, KeyValueItem, FormItem)
    if items and all(isinstance(item, structured) for item in items):
        # Table chunks are rows of "column = value" statements: already plain.
        return clip(_rows(chunk_text), MAX_CHUNK_QUOTE)
    texts = [_plain_text(document, serializer, item) for item in items]
    if len(items) == 1 and isinstance(items[0], TextItem):
        whole = " ".join(texts[0].split())
        part = " ".join(chunk_text.split())
        if part and part in whole:
            # One block split into several chunks: quote this chunk's part.
            return clip(part, MAX_CHUNK_QUOTE)
    return clip(" ".join(value for value in texts if value), MAX_CHUNK_QUOTE)


def _plain_text(
    document: DoclingDocument, serializer: ChunkingDocSerializer, item: DocItem
) -> str:
    """A block's own text: a table as the chunker's rows of "column = value" statements.

    Pictures speak through their captions, which are blocks of their own.
    """

    if isinstance(item, TextItem):
        return item.text
    if isinstance(item, TableItem):
        return _rows(serializer.serialize(item=item).text)
    return " ".join(_item_text(document, item).split())


def _rows(text: str) -> str:
    """Table rows on one line: each row ends with a full stop."""

    return ". ".join(" ".join(line.split()) for line in text.splitlines() if line.strip())


class _TableCursor:
    """Which rows of each table a chunk holds: its lines, taken in order.

    Every line of :func:`~.table_text.table_lines` names the grid row it was
    written from, and a table's chunks carry its lines in order, so a chunk
    holds the rows of the lines it takes from where the previous chunk of
    that table stopped. A table whose lines are not found (the line strategy
    writes tables as Markdown) is held whole.
    """

    def __init__(self, document: DoclingDocument) -> None:
        self._document = document
        self._lines: dict[str, list[tuple[str, int]]] = {}
        self._next: dict[str, int] = {}

    def rows(self, items: list[DocItem], text: str) -> TableRows:
        found: dict[str, tuple[int, int]] = {}
        chunk_lines = [line.strip() for line in text.splitlines() if line.strip()]
        for item in items:
            if not isinstance(item, TableItem):
                continue
            lines = self._lines.get(item.self_ref)
            if lines is None:
                lines = [(line.strip(), row) for line, row in table_lines(item, self._document)]
                self._lines[item.self_ref] = lines
            if not lines:
                continue
            taken = self._take(item.self_ref, lines, chunk_lines)
            held = [row for _, row in taken] or [row for _, row in lines]
            found[item.self_ref] = (min(held), max(held))
        return found

    def _take(
        self, ref: str, lines: list[tuple[str, int]], chunk_lines: list[str]
    ) -> list[tuple[str, int]]:
        position = self._next.get(ref, 0)
        texts = [line for line, _ in lines]
        known = set(texts)
        first = next((index for index, line in enumerate(chunk_lines) if line in known), None)
        if first is None:
            return []
        try:
            start = texts.index(chunk_lines[first], position)
        except ValueError:
            start = texts.index(chunk_lines[first])
        end = start
        while (
            end < len(texts)
            and first + end - start < len(chunk_lines)
            and chunk_lines[first + end - start] == texts[end]
        ):
            end += 1
        self._next[ref] = end
        return lines[start:end]


def _sheet_name(document: DoclingDocument, item: DocItem) -> str | None:
    """The worksheet a spreadsheet block is on (its page number is only the sheet index)."""

    node: Any = item
    while (parent := getattr(node, "parent", None)) is not None:
        try:
            node = parent.resolve(document)
        except (KeyError, IndexError, ValueError):
            return None
        if _is_sheet(node):
            return (node.name or "").strip() or None
    return None


def _chunk_items(document: DoclingDocument, chunk: Any) -> list[DocItem]:
    meta = getattr(chunk, "meta", None)
    output: list[DocItem] = []
    seen: set[str] = set()
    for item in getattr(meta, "doc_items", None) or []:
        if not isinstance(item, DocItem) or item.self_ref in seen:
            continue
        try:
            resolved = item.get_ref().resolve(document)
        except (KeyError, IndexError, ValueError):
            resolved = item
        if isinstance(resolved, DocItem):
            seen.add(resolved.self_ref)
            output.append(resolved)
    return output


def _line_chunks(document: DoclingDocument, chunker: Any) -> list[Any]:
    """Run Docling's line splitter per item, so every chunk names one item.

    ``LineBasedTokenChunker.chunk`` associates every output with every
    serialized item; one item at a time keeps the reference unambiguous.
    """

    output: list[Any] = []
    paths = _heading_paths(document)
    captions = _caption_refs(document)
    for item, _ in document.iterate_items(traverse_pictures=False):
        if (
            not isinstance(item, DocItem)
            or isinstance(item, (TitleItem, SectionHeaderItem))
            or item.self_ref in captions
        ):
            continue
        source_text = _item_text(document, item)
        if not source_text.strip():
            continue
        lines = source_text.splitlines(keepends=True) or [source_text]
        for text in chunker.chunk_text(lines=lines):
            output.append(
                SimpleNamespace(
                    text=text,
                    meta=SimpleNamespace(
                        doc_items=[item],
                        headings=list(paths.get(item.self_ref, ())) or None,
                    ),
                )
            )
    return output


def _item_text(document: DoclingDocument, item: DocItem) -> str:
    if isinstance(item, TableItem):
        return item.export_to_markdown(document)
    if isinstance(item, TextItem):
        return item.text
    if isinstance(item, (KeyValueItem, FormItem)):
        return " ".join(cell.text for cell in item.graph.cells if cell.text)
    return ""


def _heading_paths(document: DoclingDocument) -> dict[str, tuple[str, ...]]:
    paths: dict[str, tuple[str, ...]] = {}
    headings: list[str] = []
    for item, _ in document.iterate_items(traverse_pictures=False):
        if not isinstance(item, DocItem):
            continue
        if isinstance(item, TitleItem):
            headings = [item.text.strip()] if item.text.strip() else []
        elif isinstance(item, SectionHeaderItem):
            heading = item.text.strip()
            if heading:
                level = max(1, item.level)
                headings = headings[: level - 1]
                headings.append(heading)
        paths[item.self_ref] = tuple(headings)
    return paths


def _caption_refs(document: DoclingDocument) -> set[str]:
    refs: set[str] = set()
    for item in [*document.tables, *document.pictures]:
        refs.update(ref.cref for ref in item.captions)
    return refs


def _chunk_section_path(
    chunk: Any,
    items: list[DocItem],
    *,
    heading_paths: dict[str, tuple[str, ...]],
) -> tuple[str, ...]:
    headings = getattr(getattr(chunk, "meta", None), "headings", None)
    if headings:
        return tuple(str(value) for value in headings if str(value).strip())
    for item in items:
        if path := heading_paths.get(item.self_ref):
            return path
    return ()


def _content_type(items: list[DocItem]) -> str:
    kinds = {
        "table"
        if isinstance(item, TableItem)
        else "image"
        if isinstance(item, PictureItem)
        else "code"
        if isinstance(item, CodeItem)
        else "structured"
        if isinstance(item, (KeyValueItem, FormItem))
        else "text"
        for item in items
    }
    if not kinds:
        return "text"
    return next(iter(kinds)) if len(kinds) == 1 else "mixed"


__all__ = ["ChunkStrategy", "DoclingChunker"]
