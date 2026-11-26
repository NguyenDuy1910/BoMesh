"""Identities of a Structured Document and of what points into it.

A Structured Document is the Docling JSON of one content (``content_id``) parsed
with one :class:`ParseProfile`. Its bytes never change, so a node reference
(:data:`NodeRef`, Docling's ``self_ref`` without ``#/``) names the same node
forever, and a :class:`CitationTarget` stays exact through rechunking,
re-embedding and reprocessing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from hashlib import sha256
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from bomesh.storage.keys import PICTURE, STRUCTURE, derived_key

#: Version of the object layout under ``structure-v{n}`` / ``picture-v{n}``.
STRUCTURE_LAYOUT_VERSION = 1

_NODE_REF = r"(texts|tables|pictures|groups|key_value_items|form_items)/\d{1,7}"
NODE_REF_PATTERN = re.compile(rf"^{_NODE_REF}$")
FINGERPRINT_PATTERN = re.compile(r"^[0-9a-f]{16}$")
PICTURE_NAME_PATTERN = re.compile(r"^[0-9a-f]{64}\.png$")

NodeRef = Annotated[str, StringConstraints(pattern=rf"^{_NODE_REF}$")]
Fingerprint = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{16}$")]

#: Bounds of what a citation carries (it is copied into messages and JSON).
MAX_QUOTE_CHARACTERS = 280
MAX_LOCATION_CHARACTERS = 200
MAX_TARGET_REFS = 64
#: Regions of one citation, and boxes of one page (one box per block).
MAX_TARGET_HIGHLIGHTS = 128
MAX_HIGHLIGHT_BOXES = 64
MAX_SHEET_NAME_CHARACTERS = 255
CELL_RANGE_PATTERN = re.compile(r"^([A-Z]{1,3})([1-9][0-9]*)(?::([A-Z]{1,3})([1-9][0-9]*))?$")


def node_ref(self_ref: str) -> str:
    """``#/texts/31`` → ``texts/31``; rejects anything that is not a node."""

    value = self_ref.removeprefix("#/")
    if not NODE_REF_PATTERN.match(value):
        raise ValueError(f"not a Structured Document node: {self_ref!r}")
    return value


def self_ref(ref: str) -> str:
    """``texts/31`` → ``#/texts/31`` (Docling's own form)."""

    return f"#/{ref}"


class _Frozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ParseProfile(_Frozen):
    """Everything that changes a Structured Document, and nothing else.

    Chunking, embedding and contextualization are deliberately absent: they
    rebuild the index from the same Structured Document, so citations into it
    stay valid.
    """

    parser_version: str = Field(min_length=1)
    docling_schema: str = Field(min_length=1)
    read_images: bool = False
    vision_model: str | None = None

    def fingerprint(self) -> str:
        return sha256(self.model_dump_json().encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True, slots=True)
class StructureRef:
    """Where one Structured Document lives: its workspace, content and fingerprint."""

    #: The owning workspace's immutable ``code`` (the object key's scope).
    workspace: str
    content_id: UUID
    fingerprint: str

    def __post_init__(self) -> None:
        if not FINGERPRINT_PATTERN.match(self.fingerprint):
            raise ValueError(f"invalid structure fingerprint: {self.fingerprint!r}")

    @property
    def key(self) -> str:
        return derived_key(
            self.workspace,
            self.content_id,
            STRUCTURE,
            STRUCTURE_LAYOUT_VERSION,
            f"{self.fingerprint}.json.gz",
        )

    def picture_key(self, name: str) -> str:
        """The object of a picture the document references by ``name`` (``{sha256}.png``)."""

        if not PICTURE_NAME_PATTERN.match(name):
            raise ValueError(f"invalid picture name: {name!r}")
        return derived_key(
            self.workspace, self.content_id, PICTURE, STRUCTURE_LAYOUT_VERSION, name
        )


class StructureManifest(_Frozen):
    """``item_revisions.exports.structure``: the revision's current Structured Document."""

    version: Literal[1] = STRUCTURE_LAYOUT_VERSION
    fingerprint: Fingerprint
    docling_schema: str
    size_bytes: int = Field(ge=0)
    nodes: int = Field(ge=0)
    pictures: int = Field(ge=0)
    pages: int | None = Field(default=None, ge=0)

    @classmethod
    def parse(cls, exports: Any) -> StructureManifest | None:
        """The manifest in a revision's ``exports``, or ``None`` when absent or unreadable."""

        raw = exports.get("structure") if isinstance(exports, dict) else None
        if not isinstance(raw, dict):
            return None
        try:
            return cls.model_validate(raw)
        except ValueError:
            return None


#: A box on a page: ``(left, top, right, bottom)``, fractions of the page from its top-left corner.
Box = tuple[float, float, float, float]


class Highlight(_Frozen):
    """One region of a document's Original preview (``document_viewer.md`` "Citations open in the Original").

    Exactly one form: a page of a PDF representation (``page``, with one box
    per block when the blocks were located on it), or a cell range of a TABLE
    representation sheet (``sheet``, ``range`` in A1 notation from cell A1).
    """

    page: int | None = Field(default=None, ge=1)
    boxes: tuple[Box, ...] = Field(default=(), max_length=MAX_HIGHLIGHT_BOXES)
    sheet: str | None = Field(default=None, min_length=1, max_length=MAX_SHEET_NAME_CHARACTERS)
    range: str | None = Field(default=None, pattern=CELL_RANGE_PATTERN.pattern)

    @model_validator(mode="after")
    def _one_form(self) -> Highlight:
        on_page = self.page is not None
        on_sheet = self.sheet is not None and self.range is not None
        if on_page == on_sheet or (self.sheet is None) != (self.range is None):
            raise ValueError("a highlight is a page or a sheet range")
        if self.boxes and not on_page:
            raise ValueError("boxes belong to a page")
        for left, top, right, bottom in self.boxes:
            if not (0 <= left <= right <= 1 and 0 <= top <= bottom <= 1):
                raise ValueError("a box is fractions of its page, left/top before right/bottom")
        return self

    def to_json(self) -> dict[str, Any]:
        """The stored form (index payload, citation JSON): ``{page, boxes}`` or ``{sheet, range}``."""

        return self.model_dump(mode="json", exclude_none=True, exclude_defaults=True)

    def to_wire(self) -> dict[str, Any]:
        """The API ``Highlight`` (also streamed): ``{pageNumber, boxes[{left, top, right, bottom}]}``
        or ``{sheet, cellRange}``."""

        if self.page is not None:
            return {
                "pageNumber": self.page,
                "boxes": [
                    {"left": left, "top": top, "right": right, "bottom": bottom}
                    for left, top, right, bottom in self.boxes
                ],
            }
        return {"sheet": self.sheet, "cellRange": self.range}

    @classmethod
    def from_wire(cls, value: Any) -> Highlight:
        """A Highlight from its API form (:meth:`to_wire`)."""

        if not isinstance(value, dict):
            raise ValueError("a highlight is an object")
        if "pageNumber" in value:
            return cls(
                page=value["pageNumber"],
                boxes=tuple(
                    (box["left"], box["top"], box["right"], box["bottom"]) for box in value.get("boxes") or ()
                ),
            )
        return cls(sheet=value.get("sheet"), range=value.get("cellRange"))


class CitationTarget(_Frozen):
    """What an answer, a review cell or a request cites: nodes of one Structured Document.

    ``quote``, ``location`` and ``highlights`` are read from those nodes when the
    document is indexed. The target is immutable, so these copies never go
    stale. Empty ``refs`` is never written: a target always names nodes.
    """

    item_id: UUID
    revision_number: int = Field(ge=1)
    structure_version: Fingerprint
    refs: tuple[NodeRef, ...] = Field(min_length=1, max_length=MAX_TARGET_REFS)
    quote: str = Field(default="", max_length=MAX_QUOTE_CHARACTERS)
    location: str = Field(default="", max_length=MAX_LOCATION_CHARACTERS)
    highlights: tuple[Highlight, ...] = Field(default=(), max_length=MAX_TARGET_HIGHLIGHTS)

    @property
    def page(self) -> int | None:
        """The page of the first highlight on a page, for people and the model."""

        return next((h.page for h in self.highlights if h.page is not None), None)

    def to_json(self) -> dict[str, Any]:
        value = self.model_dump(mode="json", exclude={"highlights"})
        value["highlights"] = [highlight.to_json() for highlight in self.highlights]
        return value

    @classmethod
    def from_json(cls, value: Any) -> CitationTarget | None:
        """A stored copy, or ``None`` when it is not a readable target."""

        if not isinstance(value, dict):
            return None
        try:
            return cls.model_validate(value)
        except ValueError:
            return None

    @property
    def key(self) -> tuple[UUID, int, str, tuple[str, ...]]:
        """Identity for deduplication: the same nodes of the same document version."""

        return (self.item_id, self.revision_number, self.structure_version, self.refs)


def clip(text: str, limit: int) -> str:
    """Whitespace-collapsed ``text`` of at most ``limit`` characters (``…`` when cut)."""

    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return f"{collapsed[: limit - 1].rstrip()}…"


__all__ = [
    "CELL_RANGE_PATTERN",
    "FINGERPRINT_PATTERN",
    "MAX_HIGHLIGHT_BOXES",
    "MAX_LOCATION_CHARACTERS",
    "MAX_QUOTE_CHARACTERS",
    "MAX_TARGET_HIGHLIGHTS",
    "MAX_TARGET_REFS",
    "NODE_REF_PATTERN",
    "PICTURE_NAME_PATTERN",
    "STRUCTURE_LAYOUT_VERSION",
    "Box",
    "CitationTarget",
    "Fingerprint",
    "Highlight",
    "NodeRef",
    "ParseProfile",
    "StructureManifest",
    "StructureRef",
    "clip",
    "node_ref",
    "self_ref",
]
