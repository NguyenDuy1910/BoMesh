"""ARCHIVE: a ZIP file's entry list, read from its central directory only.

``application/vnd.bomesh.archive+json``::

    {"schema": 1, "entries": [{"path", "sizeBytes", "directory"}, ...],
     "totalEntries", "truncated"}

Nothing is extracted or decompressed: the end-of-central-directory record
(ZIP64 included) gives the directory's place and entry count, and at most
:data:`MAX_ENTRIES` entries are read from it.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import BinaryIO

from bomesh.services.previews.results import UNREADABLE, ConversionFailed, Output
from bomesh.services.previews.tables import gzip_json

ARCHIVE_CONTENT_TYPE = "application/vnd.bomesh.archive+json"
ARCHIVE_SCHEMA = 1
MAX_ENTRIES = 10_000

_EOCD = struct.Struct("<4s4H2LH")
_EOCD_SIGNATURE = b"PK\x05\x06"
_ZIP64_LOCATOR = struct.Struct("<4sLQL")
_ZIP64_LOCATOR_SIGNATURE = b"PK\x06\x07"
_ZIP64_EOCD = struct.Struct("<4sQ2H2L4Q")
_ZIP64_EOCD_SIGNATURE = b"PK\x06\x06"
_CENTRAL = struct.Struct("<4s6H3L5H2L")
_CENTRAL_SIGNATURE = b"PK\x01\x02"
#: The end record is the last 22 bytes plus a comment of at most 64 KiB.
_TAIL_BYTES = _EOCD.size + 0xFFFF
_UTF8_FLAG = 0x800
_ZIP64_EXTRA = 0x0001


def produce_archive(source: Path) -> Output:
    """The ARCHIVE representation of the ZIP file ``source``."""
    with source.open("rb") as stream:
        total, entries = _central_directory(stream, source.stat().st_size)
    payload = {
        "schema": ARCHIVE_SCHEMA,
        "entries": entries,
        "totalEntries": total,
        "truncated": total > len(entries),
    }
    return Output(
        data=gzip_json(payload),
        mime_type=ARCHIVE_CONTENT_TYPE,
        extension="archive.json",
        content_encoding="gzip",
        truncated=total > len(entries),
    )


def _central_directory(stream: BinaryIO, size: int) -> tuple[int, list[dict[str, object]]]:
    tail_start = max(0, size - _TAIL_BYTES)
    stream.seek(tail_start)
    tail = stream.read()
    position = tail.rfind(_EOCD_SIGNATURE)
    if position < 0 or len(tail) - position < _EOCD.size:
        raise ConversionFailed(UNREADABLE, "the file is not a ZIP archive")
    end = _EOCD.unpack_from(tail, position)
    total, directory_size, directory_offset = end[4], end[5], end[6]
    end_offset = tail_start + position
    if total == 0xFFFF or 0xFFFFFFFF in (directory_size, directory_offset):
        total, directory_size, directory_offset, end_offset = _zip64(stream, end_offset)
    # Bytes before the archive (a self-extracting stub) shift every offset.
    start = end_offset - directory_size
    if start < 0 or directory_offset > start:
        raise ConversionFailed(UNREADABLE, "the ZIP central directory is damaged")
    stream.seek(start)
    entries: list[dict[str, object]] = []
    for _ in range(min(total, MAX_ENTRIES)):
        header = stream.read(_CENTRAL.size)
        if len(header) < _CENTRAL.size or header[:4] != _CENTRAL_SIGNATURE:
            raise ConversionFailed(UNREADABLE, "the ZIP central directory is damaged")
        fields = _CENTRAL.unpack(header)
        flags, uncompressed = fields[3], fields[9]
        name_length, extra_length, comment_length = fields[10], fields[11], fields[12]
        raw_name = stream.read(name_length)
        extra = stream.read(extra_length)
        stream.seek(comment_length, 1)
        if uncompressed == 0xFFFFFFFF:
            uncompressed = _zip64_size(extra, uncompressed)
        name = raw_name.decode("utf-8" if flags & _UTF8_FLAG else "cp437", errors="replace")
        directory = name.endswith("/")
        entries.append({"path": name, "sizeBytes": 0 if directory else uncompressed, "directory": directory})
    return total, entries


def _zip64(stream: BinaryIO, end_offset: int) -> tuple[int, int, int, int]:
    locator_offset = end_offset - _ZIP64_LOCATOR.size
    if locator_offset < 0:
        raise ConversionFailed(UNREADABLE, "the ZIP64 end record is missing")
    stream.seek(locator_offset)
    locator = _ZIP64_LOCATOR.unpack(stream.read(_ZIP64_LOCATOR.size))
    if locator[0] != _ZIP64_LOCATOR_SIGNATURE:
        raise ConversionFailed(UNREADABLE, "the ZIP64 end record is missing")
    record_offset = locator_offset - _ZIP64_EOCD.size
    stream.seek(record_offset)
    record = _ZIP64_EOCD.unpack(stream.read(_ZIP64_EOCD.size))
    if record[0] != _ZIP64_EOCD_SIGNATURE:
        raise ConversionFailed(UNREADABLE, "the ZIP64 end record is damaged")
    return record[7], record[8], record[9], record_offset


def _zip64_size(extra: bytes, fallback: int) -> int:
    """The uncompressed size from a ZIP64 extra field (its first value)."""
    position = 0
    while position + 4 <= len(extra):
        tag, length = struct.unpack_from("<2H", extra, position)
        if tag == _ZIP64_EXTRA and length >= 8:
            return int(struct.unpack_from("<Q", extra, position + 4)[0])
        position += 4 + length
    return fallback


__all__ = ["ARCHIVE_CONTENT_TYPE", "ARCHIVE_SCHEMA", "MAX_ENTRIES", "produce_archive"]
