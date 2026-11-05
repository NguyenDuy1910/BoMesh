"""ExportArtifact formats: Markdown, CSV, PDF and DOCX, rendered for one reader.

Text revisions convert line by line (Markdown headings and bullets are kept
as structure); an evidence review renders its matrix. Content the reader may
not open arrives here already replaced by placeholders.
"""

from __future__ import annotations

import csv
import io
import textwrap
from dataclasses import dataclass
from pathlib import PurePosixPath

from docx import Document

from bomesh.errors import InvalidArgument
from bomesh.services.artifacts.records import (
    CellRecord,
    EvidenceReviewRecord,
    ReviewEntry,
)
from bomesh.services.artifacts.support import UNAVAILABLE_TEXT

MARKDOWN = "text/markdown"
CSV = "text/csv"
PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
EXPORT_FORMATS = (CSV, PDF, MARKDOWN, DOCX)
EXTENSIONS = {MARKDOWN: ".md", CSV: ".csv", PDF: ".pdf", DOCX: ".docx"}

_PAGE_WIDTH, _PAGE_HEIGHT, _MARGIN = 595, 842, 56
_FONT_SIZE, _LEADING, _LINE_CHARACTERS = 10, 14, 92


@dataclass(frozen=True, slots=True)
class ExportSource:
    """One revision as the reader may see it.

    ``text`` is set for text revisions (the placeholder when withheld),
    ``review`` for an evidence review; otherwise ``data`` holds the stored bytes.
    """

    title: str
    mime_type: str
    text: str | None = None
    review: EvidenceReviewRecord | None = None
    data: bytes | None = None


def render(source: ExportSource, target: str) -> bytes:
    """``source`` in the ``target`` format; INVALID_ARGUMENT when the kind cannot be."""
    if source.review is not None:
        if target == CSV:
            return _review_csv(source.review)
        return _from_markdown(review_markdown(source.title, source.review), target)
    if source.text is not None:
        if target == CSV:
            if source.mime_type != CSV:
                raise _unsupported(target)
            return source.text.encode()
        return _from_markdown(source.text, target)
    if source.data is not None and source.mime_type == target:
        return source.data
    raise _unsupported(target)


def review_markdown(title: str, review: EvidenceReviewRecord) -> str:
    labels = {entry.key: _label(entry) for entry in (*review.options, *review.criteria)}
    lines = [f"# {title}", ""]
    by_option: dict[str, list[CellRecord]] = {}
    for cell in review.cells or ():
        by_option.setdefault(cell.option, []).append(cell)
    for option in review.options:
        lines += [f"## {labels[option.key]}", ""]
        for cell in by_option.get(option.key, []):
            lines.append(f"- **{labels.get(cell.criterion, cell.criterion)}**: {_cell_text(cell)}")
        lines.append("")
    lines += ["## Synthesis", ""]
    if review.synthesis_available is False:
        lines.append(UNAVAILABLE_TEXT)
    elif review.synthesis:
        lines.append(review.synthesis)
    return "\n".join(lines).rstrip() + "\n"


def export_file_name(stored_name: str, target: str) -> str:
    return f"{PurePosixPath(stored_name).stem or 'artifact'}{EXTENSIONS[target]}"


def _label(entry: ReviewEntry) -> str:
    return entry.display_name or entry.key


def _cell_text(cell: CellRecord) -> str:
    if not cell.available:
        return UNAVAILABLE_TEXT
    sources = "; ".join(
        citation.display_name + (f", p. {citation.page_number}" if citation.page_number else "")
        for citation in cell.citations
        if citation.display_name
    )
    text = f"{cell.state}" + (f" — {cell.summary}" if cell.summary else "")
    return text + (f" ({sources})" if sources else "")


def _review_csv(review: EvidenceReviewRecord) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["option", "criterion", "state", "summary", "sources"])
    for cell in review.cells or ():
        if not cell.available:
            writer.writerow([cell.option, cell.criterion, "UNAVAILABLE", UNAVAILABLE_TEXT, ""])
            continue
        writer.writerow(
            [
                cell.option,
                cell.criterion,
                cell.state,
                cell.summary or "",
                "; ".join(citation.item or "" for citation in cell.citations),
            ]
        )
    return buffer.getvalue().encode()


def _from_markdown(markdown: str, target: str) -> bytes:
    if target == MARKDOWN:
        return markdown.encode()
    if target == PDF:
        return _pdf(markdown)
    if target == DOCX:
        return _docx(markdown)
    raise _unsupported(target)


def _docx(markdown: str) -> bytes:
    document = Document()
    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        level = len(stripped) - len(stripped.lstrip("#"))
        if 0 < level <= 6 and stripped[level:].startswith(" "):
            document.add_heading(stripped[level:].strip(), level=min(level, 4))
        elif stripped.startswith(("- ", "* ")):
            document.add_paragraph(stripped[2:].strip(), style="List Bullet")
        else:
            document.add_paragraph(stripped)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _pdf(markdown: str) -> bytes:
    """A plain-text PDF (Helvetica, WinAnsi): one line per wrapped Markdown line."""
    lines: list[str] = []
    for line in markdown.splitlines():
        lines += textwrap.wrap(line, _LINE_CHARACTERS) or [""]
    per_page = (_PAGE_HEIGHT - 2 * _MARGIN) // _LEADING
    pages = [lines[start : start + per_page] for start in range(0, len(lines), per_page)] or [[]]
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"",  # the page tree, filled in once the page objects are numbered
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    kids: list[int] = []
    for page in pages:
        stream = _page_stream(page)
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        content = len(objects)
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>"
            % (_PAGE_WIDTH, _PAGE_HEIGHT, content)
        )
        kids.append(len(objects))
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % kid for kid in kids),
        len(kids),
    )
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return bytes(out)


def _page_stream(lines: list[str]) -> bytes:
    top = _PAGE_HEIGHT - _MARGIN
    commands = [b"BT", b"/F1 %d Tf" % _FONT_SIZE, b"%d TL" % _LEADING, b"%d %d Td" % (_MARGIN, top)]
    for line in lines:
        commands.append(b"(%s) Tj T*" % _pdf_string(line))
    commands.append(b"ET")
    return b"\n".join(commands)


def _pdf_string(text: str) -> bytes:
    encoded = text.encode("cp1252", errors="replace")
    return encoded.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _unsupported(target: str) -> InvalidArgument:
    return InvalidArgument.for_field(
        "mimeType", f"This artifact cannot be exported as {target}."
    )


__all__ = [
    "CSV",
    "DOCX",
    "EXPORT_FORMATS",
    "MARKDOWN",
    "PDF",
    "ExportSource",
    "export_file_name",
    "render",
    "review_markdown",
]
