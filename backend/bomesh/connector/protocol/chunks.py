"""Retrieval chunks cut from a Structured Document."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

#: Bounds shared with :class:`bomesh.document_structure.CitationTarget`.
MAX_CHUNK_QUOTE = 280
MAX_CHUNK_LOCATION = 200


class Chunk(BaseModel):
    """One retrieval unit and the Structured Document blocks it was cut from.

    ``id`` (``{item}:{index}``) is internal to the index: it changes whenever
    chunking does. What outlives it is ``refs`` — block references into the
    immutable Structured Document — with the ``quote``, ``location`` and
    ``page`` read from those blocks, never generated.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1)
    item_id: str = Field(min_length=1)
    chunk_index: int = Field(ge=0)
    chunk_text: str = Field(min_length=1)
    content_type: str = Field(min_length=1)
    section_path: list[str] = Field(default_factory=list)
    refs: tuple[str, ...] = Field(min_length=1)
    quote: str = Field(default="", max_length=MAX_CHUNK_QUOTE)
    location: str = Field(default="", max_length=MAX_CHUNK_LOCATION)
    page: int | None = Field(default=None, ge=1)


__all__ = ["MAX_CHUNK_LOCATION", "MAX_CHUNK_QUOTE", "Chunk"]
