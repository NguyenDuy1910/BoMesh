"""What a producer returns, and the two ways it can fail."""

from __future__ import annotations

from dataclasses import dataclass

#: ``item_revisions.exports.representation_failure.reason`` values.
UNREADABLE = "UNREADABLE"
CONVERSION_ERROR = "CONVERSION_ERROR"
TIMEOUT = "TIMEOUT"
EMPTY = "EMPTY"
#: The original is over the engine's source bound (answered ``TOO_LARGE``).
TOO_LARGE = "TOO_LARGE"
#: The registry has no row for the file (answered ``FORMAT_NOT_SUPPORTED``).
FORMAT_NOT_SUPPORTED = "FORMAT_NOT_SUPPORTED"


@dataclass(frozen=True, slots=True)
class Output:
    """A produced representation object, ready to store."""

    data: bytes
    mime_type: str
    #: The object's extension (``pdf``, ``webp``, ``table.json`` …).
    extension: str
    #: ``gzip`` for the JSON payloads (the browser decompresses them).
    content_encoding: str | None = None
    truncated: bool = False


class ConversionFailed(Exception):
    """The file itself cannot be shown: recorded, and not tried again until the content changes."""

    def __init__(self, reason: str, detail: str | None = None) -> None:
        super().__init__(detail or reason)
        self.reason = reason


class ConverterUnavailable(RuntimeError):
    """The converter (Gotenberg) cannot be used now: infrastructure, nothing is recorded."""


__all__ = [
    "CONVERSION_ERROR",
    "EMPTY",
    "FORMAT_NOT_SUPPORTED",
    "TIMEOUT",
    "TOO_LARGE",
    "UNREADABLE",
    "ConversionFailed",
    "ConverterUnavailable",
    "Output",
]
