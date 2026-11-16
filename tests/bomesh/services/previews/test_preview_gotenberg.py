"""The Gotenberg client over ``httpx.MockTransport``: what counts as the file's failure.

A rejected file (400/422) or a conversion error while Gotenberg is healthy
is ``ConversionFailed`` (recorded); a 503, any other server error while it is
unhealthy, or a refused connection is ``ConverterUnavailable`` (nothing is
recorded, the next read or sweep retries).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from bomesh.services.previews.gotenberg import (
    CHROMIUM_HTML_ROUTE,
    LIBREOFFICE_ROUTE,
    GotenbergClient,
)
from bomesh.services.previews.results import (
    CONVERSION_ERROR,
    TIMEOUT,
    ConversionFailed,
    ConverterUnavailable,
)
from fakes import FakeGotenberg, pdf_page

pytestmark = pytest.mark.asyncio


def _client(handler: Callable[..., object], **kwargs: object) -> GotenbergClient:
    return GotenbergClient(
        "http://gotenberg.test", transport=httpx.MockTransport(handler), **kwargs  # type: ignore[arg-type]
    )


@pytest.fixture
def docx(tmp_path: Path) -> Path:
    path = tmp_path / "source.docx"
    path.write_bytes(b"PK\x03\x04 docx bytes")
    return path


async def test_an_office_file_is_uploaded_and_its_pdf_returned(docx: Path) -> None:
    gotenberg = FakeGotenberg()
    client = GotenbergClient("http://gotenberg.test", transport=gotenberg.transport)

    output = await client.office_to_pdf(docx, "docx")

    assert output.data.startswith(b"%PDF")
    assert (output.mime_type, output.extension) == ("application/pdf", "pdf")
    assert gotenberg.conversions == [(LIBREOFFICE_ROUTE, "document.docx", b"PK\x03\x04 docx bytes")]
    await client.aclose()


async def test_html_is_uploaded_as_the_index_page() -> None:
    gotenberg = FakeGotenberg()
    client = GotenbergClient("http://gotenberg.test", transport=gotenberg.transport)

    await client.html_to_pdf(b"<p>hi</p>")

    assert gotenberg.conversions == [(CHROMIUM_HTML_ROUTE, "index.html", b"<p>hi</p>")]
    await client.aclose()


@pytest.mark.parametrize("status", [400, 413, 422])
async def test_a_rejected_file_is_a_conversion_failure(docx: Path, status: int) -> None:
    gotenberg = FakeGotenberg()
    gotenberg.statuses = [status]
    client = GotenbergClient("http://gotenberg.test", transport=gotenberg.transport)

    with pytest.raises(ConversionFailed) as failed:
        await client.office_to_pdf(docx, "docx")

    assert failed.value.reason == CONVERSION_ERROR
    assert len(gotenberg.conversions) == 1


async def test_a_conversion_error_is_retried_once_then_is_the_files(docx: Path) -> None:
    gotenberg = FakeGotenberg()
    gotenberg.statuses = [500, 500]
    client = GotenbergClient("http://gotenberg.test", transport=gotenberg.transport)

    with pytest.raises(ConversionFailed) as failed:
        await client.office_to_pdf(docx, "docx")

    assert failed.value.reason == CONVERSION_ERROR
    assert len(gotenberg.conversions) == 2

    gotenberg.statuses = [500]
    assert (await client.office_to_pdf(docx, "docx")).data.startswith(b"%PDF")


async def test_a_conversion_error_of_an_unhealthy_gotenberg_is_infrastructure(docx: Path) -> None:
    gotenberg = FakeGotenberg()
    gotenberg.statuses = [500, 500]
    gotenberg.healthy = False
    client = GotenbergClient("http://gotenberg.test", transport=gotenberg.transport)

    with pytest.raises(ConverterUnavailable):
        await client.office_to_pdf(docx, "docx")


@pytest.mark.parametrize("status", [503, 502, 429])
async def test_an_unavailable_gotenberg_records_nothing(docx: Path, status: int) -> None:
    gotenberg = FakeGotenberg()
    gotenberg.statuses = [status]
    client = GotenbergClient("http://gotenberg.test", transport=gotenberg.transport)

    with pytest.raises(ConverterUnavailable):
        await client.office_to_pdf(docx, "docx")


async def test_an_unreachable_gotenberg_records_nothing(docx: Path) -> None:
    gotenberg = FakeGotenberg()
    gotenberg.unreachable = True
    client = GotenbergClient("http://gotenberg.test", transport=gotenberg.transport)

    with pytest.raises(ConverterUnavailable):
        await client.office_to_pdf(docx, "docx")


async def test_an_answer_that_is_no_pdf_is_the_files(docx: Path) -> None:
    client = _client(lambda request: httpx.Response(200, content=b"<html>oops</html>"))

    with pytest.raises(ConversionFailed) as failed:
        await client.office_to_pdf(docx, "docx")

    assert failed.value.reason == CONVERSION_ERROR


async def test_a_conversion_out_of_time_is_the_files(docx: Path) -> None:
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200, content=pdf_page())

    client = _client(slow, timeout_seconds=0.05)

    with pytest.raises(ConversionFailed) as failed:
        await client.office_to_pdf(docx, "docx")

    assert failed.value.reason == TIMEOUT


async def test_conversions_run_at_most_n_at_once(docx: Path) -> None:
    running = 0
    peak = 0

    async def convert(request: httpx.Request) -> httpx.Response:
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.02)
        running -= 1
        return httpx.Response(200, content=pdf_page())

    client = _client(convert, conversions=2)

    await asyncio.gather(*(client.office_to_pdf(docx, "docx") for _ in range(6)))

    assert peak == 2
