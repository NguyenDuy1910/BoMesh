"""BoMesh's projection of a Structured Document: what readers and clients see.

Never Docling's schema: the API maps these one to one, so a docling-core
change stays inside :mod:`bomesh.document_structure.view`.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class NodeKind(StrEnum):
    HEADING = "HEADING"
    PARAGRAPH = "PARAGRAPH"
    LIST = "LIST"
    LIST_ITEM = "LIST_ITEM"
    TABLE = "TABLE"
    CODE = "CODE"
    FORMULA = "FORMULA"
    PICTURE = "PICTURE"


@dataclass(frozen=True, slots=True)
class ContentRun:
    """A span of text with the formatting a reader needs: emphasis and links."""

    text: str
    bold: bool = False
    italic: bool = False
    uri: str | None = None


@dataclass(frozen=True, slots=True)
class ContentCell:
    text: str
    row_span: int = 1
    col_span: int = 1
    header: bool = False


@dataclass(frozen=True, slots=True)
class ContentImage:
    """A picture the document references; ``name`` is its object (``{sha256}.png``)."""

    name: str
    mime_type: str
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class ContentNode:
    """One block of the reading flow (``children`` only for LIST and LIST_ITEM)."""

    id: str
    kind: NodeKind
    runs: tuple[ContentRun, ...] = ()
    level: int | None = None
    marker: str | None = None
    ordered: bool | None = None
    children: tuple[ContentNode, ...] = ()
    rows: tuple[tuple[ContentCell, ...], ...] = ()
    total_rows: int | None = None
    caption: str | None = None
    image: ContentImage | None = None
    language: str | None = None
    sheet: str | None = None
    page: int | None = None

    @property
    def text(self) -> str:
        return "".join(run.text for run in self.runs)


@dataclass(frozen=True, slots=True)
class ContentWindow:
    """Blocks ``[start, stop)`` of the reading flow, out of ``total``."""

    start: int
    stop: int
    total: int
    nodes: tuple[ContentNode, ...]


__all__ = [
    "ContentCell",
    "ContentImage",
    "ContentNode",
    "ContentRun",
    "ContentWindow",
    "NodeKind",
]
