"""Docling conversion, normalization, provenance, and chunking."""

from __future__ import annotations

from collections.abc import Callable
from math import ceil
from typing import Protocol

from docling_core.transforms.chunker.tokenizer.base import BaseTokenizer


class DoclingProcessingError(ValueError):
    """Raised when a source cannot be converted into a Docling document."""


class DoclingTranscriptionError(DoclingProcessingError):
    """Raised when the vision model did not transcribe a scanned PDF page."""


class DoclingChunkingError(ValueError):
    """Raised when a converted document has no valid Docling chunks."""


class TranscriptCache(Protocol):
    """Stored transcriptions of scanned PDF page runs of one content, by key.

    Called synchronously from the processing worker thread; a key already
    names the model, prompt and page run (``docling.transcript_key``).
    """

    def get(self, key: str) -> str | None:
        """The Docling document JSON stored under ``key``, or ``None``."""
        ...

    def put(self, key: str, document_json: str) -> None: ...


class ApproximateTokenizer(BaseTokenizer):
    """Bound chunk sizes without loading or downloading tokenizer model data."""

    max_tokens: int = 256
    utf8_bytes_per_token: int = 3

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        return ceil(len(text.encode("utf-8")) / self.utf8_bytes_per_token)

    def get_max_tokens(self) -> int:
        return self.max_tokens

    def get_tokenizer(self) -> Callable[[str], int]:
        return self.count_tokens


from .chunking import ChunkStrategy, DoclingChunker
from .docling import DoclingProcessor
from .vision import VisionModel

__all__ = [
    "ApproximateTokenizer",
    "ChunkStrategy",
    "DoclingChunker",
    "DoclingChunkingError",
    "DoclingProcessingError",
    "DoclingProcessor",
    "DoclingTranscriptionError",
    "TranscriptCache",
    "VisionModel",
]
