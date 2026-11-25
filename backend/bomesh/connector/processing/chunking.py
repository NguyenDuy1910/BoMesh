"""Cut a Structured Document into retrieval chunks that point back at its blocks.

Docling's chunkers decide the text (``HybridChunker``: heading-aware, token
bounded, table headers repeated; ``LineBasedTokenChunker`` for line formats).
Every chunk then names the Structured Document **blocks** its items belong to
(:func:`~bomesh.document_structure.block_ref`) and carries a plain-text quote,
a location (sheet or section) and a page read from those blocks.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Literal

from docling.chunking import HybridChunker
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
from bomesh.connector.protocol.chunks import MAX_CHUNK_LOCATION, MAX_CHUNK_QUOTE
from bomesh.document_structure import DoclingTree, block_ref, clip, node_ref

from . import ApproximateTokenizer, DoclingChunkingError

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

    def chunk(
        self,
        document: DoclingDocument,
        *,
        item_id: str,
        strategy: ChunkStrategy = "hybrid",
    ) -> list[Chunk]:
        chunker = self._resolve_chunker(strategy)
        try:
            docling_chunks = (
                _line_chunks(document, chunker)
                if strategy == "line"
                else list(chunker.chunk(document))
            )
        except Exception as exc:
            raise DoclingChunkingError(
                f"Docling {strategy} chunking failed for {item_id}"
            ) from exc

        tree = DoclingTree(document)
        heading_paths = _heading_paths(document)
        output: list[Chunk] = []
        for docling_chunk in docling_chunks:
            chunk_text = str(getattr(docling_chunk, "text", ""))
            if not chunk_text.strip():
                continue
            items = _chunk_items(document, docling_chunk)
            refs = _block_refs(tree, items)
            if not refs:
                continue
            section_path = _chunk_section_path(docling_chunk, items, heading_paths=heading_paths)
            sheet = _sheet_name(document, items[0])
            index = len(output)
            output.append(
                Chunk(
                    id=f"{item_id}:{index}",
                    item_id=item_id,
                    chunk_index=index,
                    chunk_text=chunk_text,
                    content_type=_content_type(items),
                    section_path=list(section_path),
                    refs=refs,
                    quote=_quote(items, chunk_text),
                    location=clip(
                        sheet or (section_path[-1] if section_path else ""), MAX_CHUNK_LOCATION
                    ),
                    page=None if sheet is not None else _page(items),
                )
            )
        if not output:
            raise DoclingChunkingError(f"Document {item_id!r} has no indexable content")
        return output

    def _resolve_chunker(self, strategy: ChunkStrategy) -> Any:
        if strategy == "hybrid":
            if self._hybrid_chunker is None:
                self._hybrid_chunker = HybridChunker(
                    tokenizer=self._tokenizer, repeat_table_header=True
                )
            return self._hybrid_chunker
        if strategy == "line":
            if self._line_chunker is None:
                self._line_chunker = LineBasedTokenChunker(tokenizer=self._tokenizer)
            return self._line_chunker
        raise ValueError(f"Unknown Docling chunk strategy: {strategy}")


def _block_refs(tree: DoclingTree, items: list[DocItem]) -> tuple[str, ...]:
    refs: dict[str, None] = {}
    for item in items:
        try:
            refs[block_ref(tree, node_ref(item.self_ref))] = None
        except ValueError:
            continue
    return tuple(refs)


def _quote(items: list[DocItem], chunk_text: str) -> str:
    """What the chunk says, as plain text from its blocks (never Markdown)."""

    structured = (TableItem, KeyValueItem, FormItem)
    if items and all(isinstance(item, structured) for item in items):
        # Table chunks are "row, column = value" statements: already plain.
        return clip(chunk_text, MAX_CHUNK_QUOTE)
    texts = [_plain_text(item) for item in items]
    if len(items) == 1 and isinstance(items[0], TextItem):
        whole = " ".join(texts[0].split())
        part = " ".join(chunk_text.split())
        if part and part in whole:
            # One block split into several chunks: quote this chunk's part.
            return clip(part, MAX_CHUNK_QUOTE)
    return clip(" ".join(value for value in texts if value), MAX_CHUNK_QUOTE)


def _plain_text(item: DocItem) -> str:
    """A block's own text; pictures and tables speak through their captions and rows."""

    return item.text if isinstance(item, TextItem) else ""


def _page(items: list[DocItem]) -> int | None:
    for item in items:
        for provenance in item.prov:
            if provenance.page_no >= 1:
                return provenance.page_no
    return None


def _sheet_name(document: DoclingDocument, item: DocItem) -> str | None:
    """The worksheet a spreadsheet block is on (its page number is only the sheet index)."""

    node: Any = item
    while (parent := getattr(node, "parent", None)) is not None:
        try:
            node = parent.resolve(document)
        except (KeyError, IndexError, ValueError):
            return None
        if isinstance(node, GroupItem) and getattr(node.label, "value", node.label) == "sheet":
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
