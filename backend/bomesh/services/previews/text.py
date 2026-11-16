"""TEXT: the first MiB of a text or code file, decoded to UTF-8.

The engine reads at most :data:`TEXT_BYTES` of the original (one ``Range``
read). A byte-order mark names the encoding; otherwise valid UTF-8 is UTF-8,
and anything else is detected (``charset-normalizer``). The result is UTF-8,
at most :data:`TEXT_BYTES`, cut on a character boundary (``truncated``).
JSON that parses is pretty-printed with two spaces when it still fits.
"""

from __future__ import annotations

import codecs
import json

from charset_normalizer import from_bytes
from charset_normalizer.md import mess_ratio

from bomesh.services.previews.results import EMPTY, UNREADABLE, ConversionFailed, Output

#: Bytes of the original read, and bytes of UTF-8 a TEXT representation holds.
TEXT_BYTES = 1024 * 1024

_BOMS: tuple[tuple[bytes, str], ...] = (
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)
#: C0 control bytes other than tab, line feed, form feed and carriage return.
_CONTROL_BYTES = bytes([*range(0, 9), 11, *range(14, 32)])
#: How garbled (``charset-normalizer``'s mess ratio) Windows-1252 text may read.
_WESTERN_MESS = 0.1


def detect_encoding(data: bytes, *, complete: bool) -> str:
    """The Python codec of ``data``: its byte-order mark, UTF-8 when valid, else detected.

    ``complete`` false: ``data`` is a prefix, so a cut last character is no error.
    Legacy single-byte text that reads cleanly as Windows-1252 (the Western
    default, which byte statistics confuse with its Baltic and Central
    European siblings) is Windows-1252; anything else is detected
    (``charset-normalizer``). Mostly control bytes is no text at all.
    """
    for bom, encoding in _BOMS:
        if data.startswith(bom):
            return encoding
    try:
        text = _decode(data, "utf-8", complete=complete, errors="strict")
    except UnicodeDecodeError:
        pass
    else:
        if "\x00" not in text:
            return "utf-8"
    if len(data) - len(data.translate(None, _CONTROL_BYTES)) > len(data) // 10:
        raise ConversionFailed(UNREADABLE, "the file is binary, not text")
    try:
        western = data.decode("cp1252")
    except UnicodeDecodeError:
        pass
    else:
        if mess_ratio(western, maximum_threshold=1.0) <= _WESTERN_MESS:
            return "cp1252"
    best = from_bytes(data).best() or from_bytes(data, threshold=1.0).best()
    if best is None or best.encoding is None:
        raise ConversionFailed(UNREADABLE, "the file is not text in a known encoding")
    return best.encoding


def decode_text(data: bytes, *, complete: bool) -> str:
    """``data`` as text; ``complete`` false when it is a prefix (a cut last character is dropped)."""
    encoding = detect_encoding(data, complete=complete)
    return _decode(data, encoding, complete=complete, errors="replace")


def produce_text(
    data: bytes, *, complete: bool, markdown: bool, pretty_json: bool
) -> Output:
    """The TEXT representation of the first :data:`TEXT_BYTES` of a file."""
    text = decode_text(data[:TEXT_BYTES], complete=complete and len(data) <= TEXT_BYTES)
    truncated = not complete or len(data) > TEXT_BYTES
    if pretty_json and not truncated:
        text = _pretty_json(text)
    encoded = text.encode("utf-8")
    if len(encoded) > TEXT_BYTES:
        encoded = encoded[:TEXT_BYTES].decode("utf-8", errors="ignore").encode("utf-8")
        truncated = True
    if not encoded.strip():
        raise ConversionFailed(EMPTY, "the file has no text")
    subtype = "markdown" if markdown else "plain"
    return Output(
        data=encoded,
        mime_type=f"text/{subtype}; charset=utf-8",
        extension="md" if markdown else "txt",
        truncated=truncated,
    )


def _decode(data: bytes, encoding: str, *, complete: bool, errors: str) -> str:
    decoder = codecs.getincrementaldecoder(encoding)(errors=errors)
    text = decoder.decode(data, final=complete)
    return text.removeprefix("\ufeff")


def _pretty_json(text: str) -> str:
    try:
        value = json.loads(text)
    except ValueError:
        return text
    pretty = json.dumps(value, indent=2, ensure_ascii=False)
    return pretty if len(pretty.encode("utf-8")) <= TEXT_BYTES else text


__all__ = ["TEXT_BYTES", "decode_text", "detect_encoding", "produce_text"]
