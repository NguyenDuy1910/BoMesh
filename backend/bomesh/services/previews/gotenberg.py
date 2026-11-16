"""PDF through Gotenberg: LibreOffice for office documents, Chromium for HTML and e-mail.

Gotenberg (``gotenberg/gotenberg:8``) runs beside the worker and receives the
file's bytes, never a URL. Chromium runs with JavaScript disabled and every
request but the uploaded page denied (``deployment/compose.yml``), so
converted HTML can neither run code nor reach anything. An e-mail (``.eml``)
becomes one escaped HTML page first (headers, the body as plain text,
attachment names); an MHTML archive contributes its HTML part.

Failures are told apart: what is a property of the file raises
:class:`~.results.ConversionFailed` (recorded, not retried until the content
changes); a converter that cannot be reached or is overloaded raises
:class:`~.results.ConverterUnavailable` (nothing is recorded; the next read
or sweep tries again). Gotenberg answers 400/413/422 for a file it rejects
and 500 when LibreOffice fails on one; a 500 is tried once more and counts
as the file's only while ``/health`` reports Gotenberg up.
"""

from __future__ import annotations

import asyncio
import email
import email.policy
import logging
from collections.abc import Callable
from email.message import EmailMessage
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import httpx

from bomesh.services.previews.results import (
    CONVERSION_ERROR,
    EMPTY,
    TIMEOUT,
    UNREADABLE,
    ConversionFailed,
    ConverterUnavailable,
    Output,
)

log = logging.getLogger(__name__)

LIBREOFFICE_ROUTE = "/forms/libreoffice/convert"
CHROMIUM_HTML_ROUTE = "/forms/chromium/convert/html"
#: Wall-clock bound of one conversion (both attempts), once a slot is held.
CONVERSION_SECONDS = 120.0
_FILE_REJECTED = frozenset({400, 413, 422})
_E_MAIL_HEADERS = ("Subject", "From", "To", "Cc", "Date")
#: The multipart ``files`` of one request, built afresh for each attempt.
Parts = Callable[[], dict[str, tuple[str, Any, str]]]


class GotenbergClient:
    """Convert files to PDF; at most ``conversions`` at a time per process."""

    def __init__(
        self,
        base_url: str,
        *,
        conversions: int = 2,
        timeout_seconds: float = CONVERSION_SECONDS,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if conversions < 1:
            raise ValueError("conversions must be at least 1")
        self.conversions = conversions
        self._timeout_seconds = timeout_seconds
        self._slots = asyncio.Semaphore(conversions)
        # The conversion deadline is ours (asyncio); httpx only bounds connecting.
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            transport=transport,
            timeout=httpx.Timeout(timeout_seconds + 30.0, connect=5.0),
        )

    async def office_to_pdf(self, source: Path, extension: str) -> Output:
        """A LibreOffice-readable document (``docx``, ``pptx``, ``odt`` …) as PDF."""

        def files() -> dict[str, tuple[str, Any, str]]:
            return {
                "files": (f"document.{extension}", source.open("rb"), "application/octet-stream")
            }

        return await self._convert(LIBREOFFICE_ROUTE, files)

    async def html_to_pdf(self, html: bytes) -> Output:
        """One HTML page (no other resources) as PDF."""

        def files() -> dict[str, tuple[str, Any, str]]:
            return {"files": ("index.html", html, "text/html; charset=utf-8")}

        return await self._convert(CHROMIUM_HTML_ROUTE, files)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _convert(self, route: str, files: Parts) -> Output:
        async with self._slots:
            try:
                async with asyncio.timeout(self._timeout_seconds):
                    return await self._attempts(route, files)
            except TimeoutError as exc:
                raise ConversionFailed(TIMEOUT, "the conversion ran out of time") from exc

    async def _attempts(self, route: str, files: Parts) -> Output:
        for attempt in (1, 2):
            parts = files()
            try:
                response = await self._http.post(route, files=parts)
            except httpx.TransportError as exc:
                raise ConverterUnavailable(f"Gotenberg is unreachable: {exc}") from exc
            finally:
                for _, stream, _ in parts.values():
                    close = getattr(stream, "close", None)
                    if close is not None:
                        close()
            status = response.status_code
            if status == 200:
                return _pdf(response.content)
            detail = response.text[:300]
            if status in _FILE_REJECTED:
                raise ConversionFailed(CONVERSION_ERROR, f"Gotenberg rejected the file: {detail}")
            if status == 500 and attempt == 1:
                log.info("gotenberg conversion failed, trying once more route=%s", route)
                continue
            if status == 500 and await self._healthy():
                raise ConversionFailed(CONVERSION_ERROR, f"the converter failed on the file: {detail}")
            raise ConverterUnavailable(f"Gotenberg answered HTTP {status}: {detail}")
        raise AssertionError("unreachable")

    async def _healthy(self) -> bool:
        try:
            response = await self._http.get("/health", timeout=5.0)
        except httpx.HTTPError:
            return False
        return response.status_code == 200


def _pdf(data: bytes) -> Output:
    if not data:
        raise ConversionFailed(EMPTY, "the conversion produced nothing")
    if not data.startswith(b"%PDF"):
        raise ConversionFailed(CONVERSION_ERROR, "the conversion did not produce a PDF")
    return Output(data=data, mime_type="application/pdf", extension="pdf")


# -- HTML of e-mail and MHTML ---------------------------------------------------------


def email_html(data: bytes) -> bytes:
    """An e-mail as one self-contained, escaped HTML page.

    Headers, the body as plain text (an HTML-only body is reduced to its
    text, never rendered), and the names of its attachments.
    """
    message = email.message_from_bytes(data, policy=email.policy.default)
    if not isinstance(message, EmailMessage) or not message.keys():
        raise ConversionFailed(UNREADABLE, "the file is not an e-mail message")
    subject = str(message.get("Subject") or "")
    rows = "".join(
        f"<tr><th>{escape(name)}</th><td>{escape(str(value))}</td></tr>"
        for name in _E_MAIL_HEADERS
        if (value := message.get(name))
    )
    attachments = [
        escape(part.get_filename() or "attachment")
        for part in message.iter_attachments()
    ]
    attachment_list = (
        "<h2>Attachments</h2><ul>" + "".join(f"<li>{name}</li>" for name in attachments) + "</ul>"
        if attachments
        else ""
    )
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        f"<title>{escape(subject)}</title><style>"
        "body{font-family:sans-serif;margin:2em;color:#111}"
        "table{border-collapse:collapse;margin-bottom:1.5em}"
        "th{text-align:left;padding:.2em 1em .2em 0;color:#555;vertical-align:top}"
        "pre{white-space:pre-wrap;word-wrap:break-word;font-family:inherit}"
        "h2{font-size:1em;color:#555}"
        "</style></head><body>"
        f"<table>{rows}</table><pre>{escape(_email_body(message))}</pre>{attachment_list}"
        "</body></html>"
    ).encode("utf-8")


def _email_body(message: EmailMessage) -> str:
    body = message.get_body(preferencelist=("plain", "html"))
    if body is None:
        return ""
    try:
        content = body.get_content()
    except (LookupError, ValueError):
        payload = body.get_payload(decode=True)
        content = payload.decode("utf-8", errors="replace") if isinstance(payload, bytes) else ""
    if not isinstance(content, str):
        return ""
    return _html_text(content) if body.get_content_subtype() == "html" else content


def mhtml_html(data: bytes) -> bytes:
    """The HTML part of an MHTML archive (``.mht``), as UTF-8."""
    message = email.message_from_bytes(data, policy=email.policy.default)
    for part in message.walk():
        if part.get_content_type() == "text/html":
            try:
                content = part.get_content()  # type: ignore[attr-defined]
            except (LookupError, ValueError) as exc:
                raise ConversionFailed(UNREADABLE, "the archived page cannot be decoded") from exc
            if isinstance(content, str) and content.strip():
                return ('<meta charset="utf-8">' + content).encode("utf-8")
    raise ConversionFailed(UNREADABLE, "the file has no HTML page")


class _TextOf(HTMLParser):
    """The visible text of an HTML fragment: blocks become lines; scripts and styles vanish."""

    _BLOCKS = frozenset(
        {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section", "blockquote"}
    )
    _HIDDEN = frozenset({"script", "style", "head", "template", "noscript"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._hidden = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._HIDDEN:
            self._hidden += 1
        elif tag in self._BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._HIDDEN:
            self._hidden = max(0, self._hidden - 1)
        elif tag in self._BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._hidden:
            self.parts.append(data)


def _html_text(html: str) -> str:
    reader = _TextOf()
    reader.feed(html)
    reader.close()
    lines = (" ".join(line.split()) for line in "".join(reader.parts).splitlines())
    text: list[str] = []
    for line in lines:
        if line or (text and text[-1]):
            text.append(line)
    return "\n".join(text).strip()


__all__ = [
    "CHROMIUM_HTML_ROUTE",
    "CONVERSION_SECONDS",
    "LIBREOFFICE_ROUTE",
    "GotenbergClient",
    "email_html",
    "mhtml_html",
]
