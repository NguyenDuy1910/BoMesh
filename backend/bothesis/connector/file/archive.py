"""Safe reading of ZIP archives uploaded as knowledge.

An archive is untrusted input from a person's disk. Nothing here writes a
file at a path taken from the archive: members are listed, judged, and then
streamed into destinations the caller chooses, so a ``../../etc/passwd`` entry
has nowhere to go. Every size stated in the archive is treated as a claim and
re-checked while the bytes are actually read.
"""

from __future__ import annotations

import stat
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from . import FileProcessingError, FinxFileExtensions

ARCHIVE_EXTENSIONS = frozenset({".zip"})

_MIB = 1024 * 1024
_COPY_CHUNK_BYTES = _MIB
# Folders and files that archiving tools add on their own; they are not
# anyone's knowledge, so they are dropped without being reported as skipped.
_SYSTEM_PARTS = frozenset({"__MACOSX", ".DS_Store", "Thumbs.db", "desktop.ini"})


class ArchiveError(FileProcessingError):
    """The archive as a whole cannot be read safely."""


@dataclass(frozen=True, slots=True)
class ArchiveLimits:
    """Bounds that keep one upload from exhausting disk, memory, or the queue."""

    #: Entries inspected at all, directories included.
    max_entries: int = 5_000
    #: Documents one archive may produce; the rest are reported as skipped.
    max_documents: int = 500
    #: Uncompressed bytes across every accepted member.
    max_total_bytes: int = 2 * 1024 * _MIB
    #: One member; larger files could not be processed after extraction anyway.
    max_member_bytes: int = 100 * _MIB
    #: Uncompressed-to-compressed ratio beyond which a large member is a bomb.
    max_compression_ratio: int = 200

    def __post_init__(self) -> None:
        if min(
            self.max_entries,
            self.max_documents,
            self.max_total_bytes,
            self.max_member_bytes,
            self.max_compression_ratio,
        ) < 1:
            raise ValueError("archive limits must be greater than zero")


@dataclass(frozen=True, slots=True)
class ArchiveMember:
    """One file inside the archive that can become a Document."""

    #: Normalized relative POSIX path inside the archive, e.g. ``policies/leave.pdf``.
    path: str
    size_bytes: int
    #: Original entry name, used only to read the member back out.
    entry_name: str

    @property
    def name(self) -> str:
        return PurePosixPath(self.path).name


@dataclass(frozen=True, slots=True)
class SkippedMember:
    path: str
    reason: str


@dataclass(frozen=True, slots=True)
class ArchiveListing:
    members: tuple[ArchiveMember, ...]
    skipped: tuple[SkippedMember, ...] = field(default_factory=tuple)


def is_archive_name(file_name: str) -> bool:
    return PurePosixPath(file_name).suffix.casefold() in ARCHIVE_EXTENSIONS


def list_archive(path: Path, limits: ArchiveLimits = ArchiveLimits()) -> ArchiveListing:
    """Decide which members become Documents and why the others do not."""

    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise ArchiveError("the file is not a readable ZIP archive") from exc
    with archive:
        entries = archive.infolist()
        if len(entries) > limits.max_entries:
            raise ArchiveError(
                f"the archive has {len(entries)} entries; at most "
                f"{limits.max_entries} are accepted"
            )
        members: list[ArchiveMember] = []
        skipped: list[SkippedMember] = []
        seen: set[str] = set()
        total = 0
        for entry in entries:
            if entry.is_dir():
                continue
            normalized = _normalized_path(entry.filename)
            if normalized is None:
                skipped.append(SkippedMember(entry.filename, "unsafe path"))
                continue
            parts = PurePosixPath(normalized).parts
            if any(part in _SYSTEM_PARTS or part.startswith("._") for part in parts):
                continue
            if any(part.startswith(".") for part in parts):
                skipped.append(SkippedMember(normalized, "hidden file"))
                continue
            reason = _rejection(entry, normalized, limits)
            if reason is not None:
                skipped.append(SkippedMember(normalized, reason))
                continue
            key = normalized.casefold()
            if key in seen:
                skipped.append(SkippedMember(normalized, "duplicate entry"))
                continue
            if len(members) >= limits.max_documents:
                skipped.append(SkippedMember(normalized, "archive document limit reached"))
                continue
            total += entry.file_size
            if total > limits.max_total_bytes:
                raise ArchiveError(
                    "the archive expands beyond "
                    f"{limits.max_total_bytes // _MIB} MiB"
                )
            seen.add(key)
            members.append(
                ArchiveMember(
                    path=normalized,
                    size_bytes=entry.file_size,
                    entry_name=entry.filename,
                )
            )
    return ArchiveListing(members=tuple(members), skipped=tuple(skipped))


def extract_member(
    archive_path: Path,
    member: ArchiveMember,
    destination: Path,
    limits: ArchiveLimits = ArchiveLimits(),
) -> int:
    """Stream one member into ``destination``; the stated size is enforced."""

    ceiling = min(member.size_bytes, limits.max_member_bytes)
    written = 0
    try:
        with zipfile.ZipFile(archive_path) as archive:
            with archive.open(member.entry_name) as source, destination.open("wb") as target:
                while chunk := source.read(_COPY_CHUNK_BYTES):
                    written += len(chunk)
                    if written > ceiling:
                        raise ArchiveError(
                            f"{member.path} expands beyond the size its entry declares"
                        )
                    target.write(chunk)
    except (zipfile.BadZipFile, KeyError, RuntimeError, OSError) as exc:
        raise ArchiveError(f"{member.path} could not be read from the archive") from exc
    if written != member.size_bytes:
        raise ArchiveError(f"{member.path} is truncated in the archive")
    return written


def _normalized_path(name: str) -> str | None:
    candidate = name.replace("\\", "/")
    if not candidate or "\x00" in candidate or candidate.startswith("/"):
        return None
    if len(candidate) > 1 and candidate[1] == ":":  # a Windows drive letter
        return None
    parts = [part for part in candidate.split("/") if part not in {"", "."}]
    if not parts or any(part == ".." for part in parts):
        return None
    return "/".join(parts)


def _rejection(
    entry: zipfile.ZipInfo, normalized: str, limits: ArchiveLimits
) -> str | None:
    mode = entry.external_attr >> 16
    if stat.S_ISLNK(mode):
        return "symbolic link"
    if entry.flag_bits & 0x1:
        return "encrypted"
    extension = PurePosixPath(normalized).suffix.casefold()
    if extension in ARCHIVE_EXTENSIONS:
        return "nested archive"
    if extension not in FinxFileExtensions.KNOWLEDGE_EXTENSIONS:
        return "unsupported file type"
    if entry.file_size < 1:
        return "empty file"
    if entry.file_size > limits.max_member_bytes:
        return "file too large"
    if (
        entry.compress_size > 0
        and entry.file_size > _MIB
        and entry.file_size / entry.compress_size > limits.max_compression_ratio
    ):
        raise ArchiveError(
            f"{normalized} is compressed beyond {limits.max_compression_ratio}:1; "
            "the archive looks like a decompression bomb"
        )
    return None


__all__ = [
    "ARCHIVE_EXTENSIONS",
    "ArchiveError",
    "ArchiveLimits",
    "ArchiveListing",
    "ArchiveMember",
    "SkippedMember",
    "extract_member",
    "is_archive_name",
    "list_archive",
]
