"""An uploaded archive is untrusted: it may lie, traverse, or explode."""

from __future__ import annotations

import stat
import zipfile
from pathlib import Path

import pytest

from bothesis.connector.file.archive import (
    ArchiveError,
    ArchiveLimits,
    extract_member,
    list_archive,
)


def _zip(path: Path, entries: dict[str, bytes], **kwargs) -> Path:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, **kwargs) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


def test_supported_files_become_members_and_everything_else_says_why(tmp_path: Path) -> None:
    archive = _zip(
        tmp_path / "handbook.zip",
        {
            "handbook/leave-policy.pdf": b"%PDF-1.7 policy",
            "handbook/notes/onboarding.md": b"# Onboarding",
            "handbook/tool.exe": b"MZ",
            "handbook/inner.zip": b"PK",
            "handbook/empty.txt": b"",
            "handbook/.env": b"SECRET=1",
            "__MACOSX/handbook/._leave-policy.pdf": b"resource fork",
            "handbook/.DS_Store": b"finder",
        },
    )

    listing = list_archive(archive)

    assert [(m.path, m.name) for m in listing.members] == [
        ("handbook/leave-policy.pdf", "leave-policy.pdf"),
        ("handbook/notes/onboarding.md", "onboarding.md"),
    ]
    assert {(s.path, s.reason) for s in listing.skipped} == {
        ("handbook/tool.exe", "unsupported file type"),
        ("handbook/inner.zip", "nested archive"),
        ("handbook/empty.txt", "empty file"),
        ("handbook/.env", "hidden file"),
    }


def test_a_traversing_or_absolute_entry_never_becomes_a_member(tmp_path: Path) -> None:
    archive = _zip(
        tmp_path / "evil.zip",
        {
            "../../etc/passwd.txt": b"root",
            "/abs/escape.txt": b"x",
            "C:/Windows/win.txt": b"x",
            "ok/../../escape.txt": b"x",
            "safe/readme.txt": b"hello",
        },
    )

    listing = list_archive(archive)

    assert [m.path for m in listing.members] == ["safe/readme.txt"]
    assert {s.reason for s in listing.skipped} == {"unsafe path"}
    assert len(listing.skipped) == 4


def test_a_symbolic_link_is_skipped(tmp_path: Path) -> None:
    path = tmp_path / "links.zip"
    with zipfile.ZipFile(path, "w") as archive:
        link = zipfile.ZipInfo("docs/link.txt")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, "/etc/passwd")
        archive.writestr("docs/real.txt", "content")

    listing = list_archive(path)

    assert [m.path for m in listing.members] == ["docs/real.txt"]
    assert [(s.path, s.reason) for s in listing.skipped] == [("docs/link.txt", "symbolic link")]


def test_a_decompression_bomb_rejects_the_whole_archive(tmp_path: Path) -> None:
    archive = _zip(tmp_path / "bomb.zip", {"zeros.txt": b"\0" * (8 * 1024 * 1024)})

    with pytest.raises(ArchiveError, match="decompression bomb"):
        list_archive(archive, ArchiveLimits(max_compression_ratio=100))


def test_total_expansion_is_bounded(tmp_path: Path) -> None:
    archive = _zip(tmp_path / "big.zip", {f"f{i}.txt": b"x" * 600 for i in range(3)})

    with pytest.raises(ArchiveError, match="expands beyond"):
        list_archive(archive, ArchiveLimits(max_total_bytes=1_000))


def test_the_document_limit_skips_the_rest_instead_of_failing(tmp_path: Path) -> None:
    archive = _zip(tmp_path / "many.zip", {f"doc-{i}.txt": b"x" for i in range(4)})

    listing = list_archive(archive, ArchiveLimits(max_documents=2))

    assert len(listing.members) == 2
    assert [s.reason for s in listing.skipped] == ["archive document limit reached"] * 2


def test_names_differing_only_in_case_are_read_once(tmp_path: Path) -> None:
    # They are one file on the disks most archives come from.
    archive = _zip(tmp_path / "dupes.zip", {"a/Report.txt": b"first", "a/report.txt": b"second"})

    listing = list_archive(archive)

    assert [m.path for m in listing.members] == ["a/Report.txt"]
    assert [(s.path, s.reason) for s in listing.skipped] == [("a/report.txt", "duplicate entry")]


def test_extraction_writes_only_where_the_caller_says(tmp_path: Path) -> None:
    archive = _zip(tmp_path / "a.zip", {"deep/dir/file.md": b"# Title"})
    member = list_archive(archive).members[0]
    destination = tmp_path / "out" / "member-1"
    destination.parent.mkdir()

    assert extract_member(archive, member, destination) == len(b"# Title")
    assert destination.read_bytes() == b"# Title"
    assert not (tmp_path / "out" / "deep").exists()


def test_an_entry_larger_than_its_header_claims_is_refused(tmp_path: Path) -> None:
    archive = _zip(tmp_path / "liar.zip", {"file.txt": b"x" * 100})
    member = list_archive(archive).members[0]
    liar = type(member)(path=member.path, size_bytes=10, entry_name=member.entry_name)

    with pytest.raises(ArchiveError, match="beyond the size"):
        extract_member(archive, liar, tmp_path / "out")


def test_something_that_is_not_a_zip_is_an_archive_error(tmp_path: Path) -> None:
    fake = tmp_path / "fake.zip"
    fake.write_bytes(b"this is plain text")

    with pytest.raises(ArchiveError, match="not a readable ZIP"):
        list_archive(fake)
