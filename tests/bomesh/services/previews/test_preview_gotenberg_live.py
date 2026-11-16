"""Real conversions through a live Gotenberg (``BOMESH_GOTENBERG_URL``, default 127.0.0.1:3010).

Skipped when no Gotenberg answers ``/health``. Start one with
``make services`` or ``docker run -d --rm -p 127.0.0.1:3010:3000
gotenberg/gotenberg:8 gotenberg --chromium-disable-javascript=true``.
Each conversion's wall time is printed (``pytest -s``).
"""

from __future__ import annotations

import os
import time
from email.message import EmailMessage
from pathlib import Path

import docx
import httpx
import pypdfium2 as pdfium
import pytest
from pptx import Presentation

from bomesh.services.previews.covers import CoverPlan, render_cover
from bomesh.services.previews.gotenberg import GotenbergClient, email_html
from bomesh.services.previews.results import ConversionFailed

GOTENBERG_URL = os.getenv("BOMESH_GOTENBERG_URL", "http://127.0.0.1:3010")


def _reachable() -> bool:
    try:
        return httpx.get(f"{GOTENBERG_URL}/health", timeout=2.0).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(not _reachable(), reason=f"no Gotenberg at {GOTENBERG_URL}"),
]


def _text_of(pdf: bytes) -> tuple[int, str]:
    document = pdfium.PdfDocument(pdf)
    try:
        page = document[0]
        text = page.get_textpage().get_text_range()
        return len(document), " ".join(text.split())
    finally:
        document.close()


async def _timed(label: str, conversion) -> bytes:  # type: ignore[no-untyped-def]
    started = time.perf_counter()
    output = await conversion
    print(f"\ngotenberg {label}: {time.perf_counter() - started:.2f} s, {len(output.data)} bytes")
    return output.data


async def test_docx_pptx_html_and_email_become_pdfs(tmp_path: Path) -> None:
    client = GotenbergClient(GOTENBERG_URL)
    try:
        word = docx.Document()
        word.add_heading("Leave policy", level=1)
        word.add_paragraph("Employees take twelve days of paid leave.")
        word.save(tmp_path / "source.docx")
        for attempt in ("first", "warm"):
            pdf = await _timed(f"docx ({attempt})", client.office_to_pdf(tmp_path / "source.docx", "docx"))
        pages, text = _text_of(pdf)
        assert pages == 1 and "Leave policy" in text and "twelve days" in text

        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = "Quarterly review"
        slide.placeholders[1].text = "Revenue grew"
        deck.slides.add_slide(deck.slide_layouts[5]).shapes.title.text = "Second slide"
        deck.save(tmp_path / "source.pptx")
        pdf = await _timed("pptx", client.office_to_pdf(tmp_path / "source.pptx", "pptx"))
        pages, text = _text_of(pdf)
        assert pages == 2 and "Quarterly review" in text
        (tmp_path / "deck.pdf").write_bytes(pdf)
        cover = render_cover(tmp_path / "deck.pdf", CoverPlan("pdf", "k", len(pdf), "pdf", kind="slide"))
        assert cover is not None and cover.kind == "slide" and cover.image
        assert cover.width == 480

        page = (
            b"<html><body><h1>Hello page</h1>"
            b"<script>document.body.innerHTML='script ran'</script>"
            b"<img src='https://example.com/tracker.png'></body></html>"
        )
        pdf = await _timed("html", client.html_to_pdf(page))
        _, text = _text_of(pdf)
        assert "Hello page" in text and "script ran" not in text

        message = EmailMessage()
        message["Subject"] = "Budget review"
        message["From"] = "ana@example.com"
        message.set_content("Numbers attached.")
        message.add_attachment(b"x", maintype="text", subtype="csv", filename="q3.csv")
        pdf = await _timed("eml", client.html_to_pdf(email_html(message.as_bytes())))
        _, text = _text_of(pdf)
        assert "Budget review" in text and "Numbers attached." in text and "q3.csv" in text
    finally:
        await client.aclose()


async def test_a_broken_document_is_a_conversion_failure(tmp_path: Path) -> None:
    client = GotenbergClient(GOTENBERG_URL)
    source = tmp_path / "source.docx"
    source.write_bytes(b"PK\x03\x04 not a document")
    try:
        with pytest.raises(ConversionFailed):
            await client.office_to_pdf(source, "docx")
    finally:
        await client.aclose()
