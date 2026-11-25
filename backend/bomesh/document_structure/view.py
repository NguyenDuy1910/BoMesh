"""Read a Structured Document as BoMesh blocks, straight from its JSON.

The API reads documents here without validating them into ``DoclingDocument``
(about 10× faster on large documents): one pass indexes the nodes and lays the
body out as a **reading flow** of blocks. Hierarchy groups (sections, sheets,
slides) are transparent; a list, an inline paragraph, a table and a picture
are one block each. Windows of that flow are what readers page through.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

from .identity import PICTURE_NAME_PATTERN, node_ref
from .nodes import (
    ContentCell,
    ContentImage,
    ContentNode,
    ContentRun,
    ContentWindow,
    NodeKind,
)
from .tree import (
    CAPTION,
    FURNITURE_LABELS,
    INLINE,
    LIST_GROUPS,
    LIST_ITEM,
    block_ref,
)

#: Rows of one table returned in a block; the rest stays in the original.
MAX_TABLE_ROWS = 1_000
_COLLECTIONS = ("texts", "tables", "pictures", "groups", "key_value_items", "form_items")
_SAFE_URI_SCHEMES = ("http://", "https://", "mailto:")
_NO_SPACE_BEFORE = frozenset(".,;:!?)]}%…»”’")
_NO_SPACE_AFTER = frozenset("([{«“‘/")


class StructureView:
    """Blocks, windows and the outline of one Structured Document (pure, no I/O)."""

    def __init__(self, data: Mapping[str, Any]) -> None:
        self._nodes: dict[str, Mapping[str, Any]] = {}
        for collection in _COLLECTIONS:
            for raw in data.get(collection) or ():
                ref = _ref(raw)
                if ref is not None:
                    self._nodes[ref] = raw
        self._captions: dict[str, str] = {}
        for collection in ("tables", "pictures"):
            for raw in data.get(collection) or ():
                owner = _ref(raw)
                for caption in raw.get("captions") or ():
                    target = _cref(caption)
                    if owner is not None and target is not None:
                        self._captions[target] = owner
        #: The reading flow: ``(block ref, sheet name)``.
        self._units: list[tuple[str, str | None]] = []
        self._unit_of: dict[str, int] = {}
        body = data.get("body") or {}
        for child in _children(body):
            self._lay_out(child, sheet=None)

    # ---- NodeTree ----

    def label(self, ref: str) -> str | None:
        raw = self._nodes.get(ref)
        return raw.get("label") if raw is not None else None

    def parent(self, ref: str) -> str | None:
        raw = self._nodes.get(ref)
        return _cref(raw.get("parent")) if raw is not None else None

    def caption_owner(self, ref: str) -> str | None:
        return self._captions.get(ref)

    # ---- Reading flow ----

    @property
    def total(self) -> int:
        return len(self._units)

    def __contains__(self, ref: object) -> bool:
        return isinstance(ref, str) and ref in self._nodes

    def unit_index(self, ref: str) -> int | None:
        """Position in the reading flow of the block that shows ``ref``."""

        if ref not in self._nodes:
            return None
        found = self._unit_of.get(ref)
        return found if found is not None else self._unit_of.get(block_ref(self, ref))

    def window(self, *, start: int = 0, size: int) -> ContentWindow:
        start = max(0, min(start, self.total))
        stop = min(self.total, start + max(1, size))
        return ContentWindow(
            start=start,
            stop=stop,
            total=self.total,
            nodes=tuple(self._block(*self._units[index]) for index in range(start, stop)),
        )

    def window_around(self, anchor: str, *, size: int) -> ContentWindow | None:
        """A window that shows ``anchor`` with some context before it; ``None`` if unknown."""

        index = self.unit_index(anchor)
        if index is None:
            return None
        return self.window(start=index - max(1, size) // 4, size=size)

    def outline(self) -> tuple[ContentNode, ...]:
        return tuple(
            self._block(ref, sheet)
            for ref, sheet in self._units
            if self.label(ref) in ("title", "section_header")
        )

    # ---- Layout ----

    def _lay_out(self, ref: str, *, sheet: str | None) -> None:
        raw = self._nodes.get(ref)
        if raw is None or not _in_body(raw):
            return
        label = raw.get("label")
        if label in FURNITURE_LABELS:
            return
        if label == CAPTION and ref in self._captions:
            return  # shown with its table or picture
        if ref.startswith("groups/"):
            if label == INLINE:
                if self._runs_of(ref):
                    self._add_unit(ref, sheet)
                return
            if label in LIST_GROUPS:
                self._add_unit(ref, sheet)
                return
            inner = str(raw.get("name") or "").strip() or sheet if label == "sheet" else sheet
            for child in _children(raw):
                self._lay_out(child, sheet=inner)
            return
        if ref.startswith(("tables/", "pictures/", "key_value_items/", "form_items/")):
            self._add_unit(ref, sheet)
            return
        # A text block: a heading owns what follows it, a paragraph may own a list.
        if str(raw.get("text") or "").strip():
            self._add_unit(ref, sheet)
        for child in _children(raw):
            self._lay_out(child, sheet=sheet)

    def _add_unit(self, ref: str, sheet: str | None) -> None:
        index = len(self._units)
        self._units.append((ref, sheet))
        self._claim(ref, index, top=True)

    def _claim(self, ref: str, index: int, *, top: bool = False) -> None:
        """Every node a block shows maps to the block's position."""

        self._unit_of.setdefault(ref, index)
        raw = self._nodes.get(ref)
        if raw is None:
            return
        # A heading or paragraph's children are blocks of their own.
        if top and ref.startswith("texts/") and self.label(ref) != LIST_ITEM:
            return
        for child in _children(raw):
            self._claim(child, index)
        for caption in raw.get("captions") or ():
            if (target := _cref(caption)) is not None:
                self._unit_of.setdefault(target, index)

    # ---- Projection ----

    def _block(self, ref: str, sheet: str | None) -> ContentNode:
        raw = self._nodes[ref]
        label = raw.get("label")
        page = None if sheet is not None else _page(raw)
        if ref.startswith("groups/"):
            if label in LIST_GROUPS:
                return self._list(ref, sheet=sheet)
            return ContentNode(
                id=ref, kind=NodeKind.PARAGRAPH, runs=self._runs_of(ref), sheet=sheet, page=page
            )
        if ref.startswith("tables/"):
            return self._table(ref, raw, sheet=sheet, page=page)
        if ref.startswith("pictures/"):
            return self._picture(ref, raw, sheet=sheet, page=page)
        if ref.startswith(("key_value_items/", "form_items/")):
            cells = (raw.get("graph") or {}).get("cells") or ()
            text = " ".join(str(cell.get("text") or "").strip() for cell in cells).strip()
            return ContentNode(
                id=ref,
                kind=NodeKind.PARAGRAPH,
                runs=(ContentRun(text=text),) if text else (),
                sheet=sheet,
                page=page,
            )
        runs = (_run(raw),)
        if label == "title":
            return ContentNode(id=ref, kind=NodeKind.HEADING, level=1, runs=runs, sheet=sheet, page=page)
        if label == "section_header":
            level = min(max(int(raw.get("level") or 1), 1) + 1, 6)
            return ContentNode(
                id=ref, kind=NodeKind.HEADING, level=level, runs=runs, sheet=sheet, page=page
            )
        if label == "code":
            language = raw.get("code_language")
            return ContentNode(
                id=ref,
                kind=NodeKind.CODE,
                runs=(ContentRun(text=str(raw.get("text") or "")),),
                language=None if language in (None, "unknown") else str(language),
                sheet=sheet,
                page=page,
            )
        if label == "formula":
            return ContentNode(id=ref, kind=NodeKind.FORMULA, runs=runs, sheet=sheet, page=page)
        if label == LIST_ITEM:
            return self._list_item(ref)
        return ContentNode(id=ref, kind=NodeKind.PARAGRAPH, runs=runs, sheet=sheet, page=page)

    def _list(self, ref: str, *, sheet: str | None = None) -> ContentNode:
        raw = self._nodes[ref]
        items = tuple(
            self._list_item(child)
            for child in _children(raw)
            if self.label(child) == LIST_ITEM and _in_body(self._nodes[child])
        )
        ordered = raw.get("label") == "ordered_list" or any(
            bool(self._nodes[item.id].get("enumerated")) for item in items
        )
        return ContentNode(
            id=ref,
            kind=NodeKind.LIST,
            ordered=ordered,
            children=items,
            sheet=sheet,
            page=None if sheet is not None else _page(raw),
        )

    def _list_item(self, ref: str) -> ContentNode:
        raw = self._nodes[ref]
        runs: list[ContentRun] = []
        if str(raw.get("text") or "").strip():
            runs.append(_run(raw))
        nested: list[ContentNode] = []
        for child in _children(raw):
            label = self.label(child)
            if label == INLINE:
                runs.extend(self._runs_of(child))
            elif label in LIST_GROUPS:
                nested.append(self._list(child))
            elif child.startswith("texts/") and label != LIST_ITEM:
                runs.append(_run(self._nodes[child]))
        marker = str(raw.get("marker") or "").strip() or None
        return ContentNode(
            id=ref,
            kind=NodeKind.LIST_ITEM,
            runs=_spaced(runs),
            marker=marker,
            children=tuple(nested),
            page=_page(raw),
        )

    def _table(
        self, ref: str, raw: Mapping[str, Any], *, sheet: str | None, page: int | None
    ) -> ContentNode:
        data = raw.get("data") or {}
        by_row: dict[int, list[Mapping[str, Any]]] = {}
        for cell in data.get("table_cells") or ():
            by_row.setdefault(int(cell.get("start_row_offset_idx") or 0), []).append(cell)
        total = int(data.get("num_rows") or (max(by_row) + 1 if by_row else 0))
        rows = tuple(
            tuple(
                ContentCell(
                    text=str(cell.get("text") or ""),
                    row_span=max(
                        1,
                        int(cell.get("end_row_offset_idx") or 0)
                        - int(cell.get("start_row_offset_idx") or 0),
                    ),
                    col_span=max(
                        1,
                        int(cell.get("end_col_offset_idx") or 0)
                        - int(cell.get("start_col_offset_idx") or 0),
                    ),
                    header=bool(cell.get("column_header") or cell.get("row_header")),
                )
                for cell in sorted(
                    by_row[row], key=lambda value: int(value.get("start_col_offset_idx") or 0)
                )
            )
            for row in sorted(by_row)[:MAX_TABLE_ROWS]
        )
        return ContentNode(
            id=ref,
            kind=NodeKind.TABLE,
            rows=rows,
            total_rows=total,
            caption=self._caption(raw),
            sheet=sheet,
            page=page,
        )

    def _picture(
        self, ref: str, raw: Mapping[str, Any], *, sheet: str | None, page: int | None
    ) -> ContentNode:
        description = _picture_description(raw)
        return ContentNode(
            id=ref,
            kind=NodeKind.PICTURE,
            runs=(ContentRun(text=description),) if description else (),
            caption=self._caption(raw),
            image=_image(raw.get("image")),
            sheet=sheet,
            page=page,
        )

    def _caption(self, raw: Mapping[str, Any]) -> str | None:
        texts = [
            str(self._nodes[target].get("text") or "").strip()
            for caption in raw.get("captions") or ()
            if (target := _cref(caption)) is not None and target in self._nodes
        ]
        text = " ".join(value for value in texts if value)
        return text or None

    def _runs_of(self, ref: str) -> tuple[ContentRun, ...]:
        return _spaced(list(self._leaf_runs(ref)))

    def _leaf_runs(self, ref: str) -> Iterator[ContentRun]:
        raw = self._nodes.get(ref)
        if raw is None or not _in_body(raw):
            return
        if ref.startswith("texts/"):
            if str(raw.get("text") or ""):
                yield _run(raw)
            return
        for child in _children(raw):
            yield from self._leaf_runs(child)


def _spaced(runs: list[ContentRun]) -> tuple[ContentRun, ...]:
    """Inline children are words without their spaces: put them back."""

    output: list[ContentRun] = []
    for run in runs:
        if not run.text:
            continue
        if output:
            previous = output[-1].text
            if (
                previous
                and not previous[-1].isspace()
                and previous[-1] not in _NO_SPACE_AFTER
                and not run.text[0].isspace()
                and run.text[0] not in _NO_SPACE_BEFORE
            ):
                run = ContentRun(text=f" {run.text}", bold=run.bold, italic=run.italic, uri=run.uri)
        output.append(run)
    return tuple(output)


def _run(raw: Mapping[str, Any]) -> ContentRun:
    formatting = raw.get("formatting") or {}
    return ContentRun(
        text=str(raw.get("text") or ""),
        bold=bool(formatting.get("bold")),
        italic=bool(formatting.get("italic")),
        uri=_safe_uri(raw.get("hyperlink")),
    )


def _safe_uri(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    uri = value.strip()
    return uri if uri.lower().startswith(_SAFE_URI_SCHEMES) else None


def _image(raw: Any) -> ContentImage | None:
    """Only a picture stored beside the document is shown; never a data or external URI."""

    if not isinstance(raw, Mapping):
        return None
    name = str(raw.get("uri") or "")
    if not PICTURE_NAME_PATTERN.match(name):
        return None
    size = raw.get("size") or {}
    return ContentImage(
        name=name,
        mime_type=str(raw.get("mimetype") or "image/png"),
        width=int(round(float(size.get("width") or 0))),
        height=int(round(float(size.get("height") or 0))),
    )


def _picture_description(raw: Mapping[str, Any]) -> str:
    meta = raw.get("meta") or {}
    description = meta.get("description") if isinstance(meta, Mapping) else None
    if isinstance(description, Mapping) and str(description.get("text") or "").strip():
        return str(description["text"]).strip()
    for annotation in raw.get("annotations") or ():
        if (
            isinstance(annotation, Mapping)
            and annotation.get("kind") == "description"
            and str(annotation.get("text") or "").strip()
        ):
            return str(annotation["text"]).strip()
    return ""


def _page(raw: Mapping[str, Any]) -> int | None:
    for provenance in raw.get("prov") or ():
        page = provenance.get("page_no")
        if isinstance(page, int) and page >= 1:
            return page
    return None


def _in_body(raw: Mapping[str, Any]) -> bool:
    return raw.get("content_layer", "body") == "body"


def _children(raw: Mapping[str, Any]) -> Iterator[str]:
    for child in raw.get("children") or ():
        ref = _cref(child)
        if ref is not None:
            yield ref


def _cref(value: Any) -> str | None:
    if not isinstance(value, Mapping):
        return None
    cref = value.get("cref") or value.get("$ref")
    if not isinstance(cref, str) or cref == "#/body":
        return None
    try:
        return node_ref(cref)
    except ValueError:
        return None


def _ref(raw: Any) -> str | None:
    if not isinstance(raw, Mapping) or not isinstance(raw.get("self_ref"), str):
        return None
    try:
        return node_ref(raw["self_ref"])
    except ValueError:
        return None


__all__ = ["MAX_TABLE_ROWS", "StructureView"]
