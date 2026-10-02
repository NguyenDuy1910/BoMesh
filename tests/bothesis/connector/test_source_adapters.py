from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest

from bothesis.connector.adapter import CheckpointedSourceConnectorAdapter
from bothesis.connector.confluence import connector as confluence_module
from bothesis.connector.confluence.checkpoint import ConfluenceCheckpoint
from bothesis.connector.confluence.connector import ConfluenceConnector
from bothesis.connector.confluence.utils import (
    AttachmentProcessingResult,
    validate_attachment_filetype,
)
from bothesis.connector.protocol import (
    Chunk,
    CitationInfo,
    CitationSpan,
    ConnectorScope,
    DocumentItem,
    DocumentKind,
    TablePart,
    TextPart,
)
from bothesis.connector.registry import ConnectorRegistry


def test_confluence_validation_stops_after_first_result() -> None:
    """Validation proves one query answers; it must not page through the site."""

    pulled: list[int] = []

    def every_page_on_the_site(**_kwargs):
        # A real site pages for thousands of requests; a walk over all of them
        # would show up here as 1000 pulls rather than as a hang.
        for index in range(1000):
            pulled.append(index)
            yield {"id": str(index)}

    connector = ConfluenceConnector("https://example.atlassian.net/wiki", is_cloud=True)
    connector._confluence_client = SimpleNamespace(
        paginated_cql_retrieval=every_page_on_the_site
    )

    connector.validate_connector_settings()

    assert pulled == [0]


def test_confluence_lists_spaces_then_pages_for_a_picker() -> None:
    """A token connection can be browsed: spaces, a space's pages, a page's children."""

    calls: list[tuple[str, str]] = []

    def page(page_id: str, title: str, children: int) -> dict:
        return {
            "id": page_id,
            "title": title,
            "children": {"page": {"size": children}},
            "_links": {"webui": f"/spaces/ENG/pages/{page_id}"},
        }

    client = SimpleNamespace(
        retrieve_confluence_spaces=lambda: iter(
            [{"key": "ENG", "name": "Engineering"}, {"key": "HR", "name": "People"}]
        ),
        space_root_pages=lambda key: calls.append(("space", key))
        or iter([page("1", "Runbooks", 2)]),
        child_pages=lambda page_id: calls.append(("page", page_id))
        or iter([page("2", "On-call", 0)]),
    )
    connector = ConfluenceConnector("https://example.atlassian.net/wiki", is_cloud=True)
    connector._confluence_client = client

    spaces = connector.list_resources()
    assert [(s["resource_type"], s["external_id"], s["has_children"]) for s in spaces] == [
        ("space", "ENG", True),
        ("space", "HR", True),
    ]
    assert [s["name"] for s in connector.list_resources(search="engin")] == ["Engineering"]

    roots = connector.list_resources("ENG")
    assert roots[0]["external_id"] == "page:1"
    assert roots[0]["has_children"] is True
    assert roots[0]["url"] == "https://example.atlassian.net/wiki/spaces/ENG/pages/1"

    children = connector.list_resources("page:1")
    assert children[0]["external_id"] == "page:2"
    assert children[0]["has_children"] is False
    # A page parent is resolved as a page, never mistaken for a space key.
    assert calls == [("space", "ENG"), ("page", "1")]



def test_confluence_cql_escapes_configured_values() -> None:
    connector = ConfluenceConnector(
        "https://example.atlassian.net/wiki",
        is_cloud=True,
        space="BANK'OPS",
        labels_to_skip=["do'not-index"],
    )

    query = connector._construct_page_cql_query()

    assert "space='BANK\\'OPS'" in query
    assert "label != 'do\\'not-index'" in query


@pytest.mark.asyncio
async def test_integration_factory_adapts_confluence_to_the_async_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    validated: list[bool] = []
    configured_storage: list[object] = []
    monkeypatch.setattr(
        ConfluenceConnector,
        "set_credentials_provider",
        lambda *_: None,
    )
    monkeypatch.setattr(
        ConfluenceConnector,
        "validate_connector_settings",
        lambda *_: validated.append(True),
    )
    monkeypatch.setattr(
        ConfluenceConnector,
        "set_storage",
        lambda _self, storage: configured_storage.append(storage),
    )

    connector = ConnectorRegistry._confluence_factory(
        {
            "wiki_base": "https://example.atlassian.net/wiki",
            "is_cloud": True,
            "space": "RISK",
        },
        {},
        {
            "confluence_username": "person@example.test",
            "confluence_access_token": "secret",
        },
    )
    storage = object()

    assert await connector.test_connection() is True
    assert connector.source == "confluence"
    assert connector.checkpoint_model is ConfluenceCheckpoint
    assert (await connector.list_scopes())[0].model_dump() == {
        "scope_type": "space",
        "scope_value": "RISK",
        "display_name": "RISK",
        "metadata": {},
    }
    connector.set_storage(storage)  # type: ignore[arg-type]
    assert validated == [True]
    assert configured_storage == [storage]


def test_confluence_checkpoint_bounds_the_next_incremental_query() -> None:
    class FakeConfluence:
        requested_url = ""

        def retrieve_confluence_spaces(self, **kwargs):
            del kwargs
            return iter(())

        def paginated_page_retrieval(self, *, cql_url, **kwargs):
            del kwargs
            self.requested_url = cql_url
            return iter(())

    connector = ConfluenceConnector("https://example.atlassian.net/wiki", is_cloud=True)
    fake = FakeConfluence()
    connector._confluence_client = fake  # type: ignore[assignment]
    end = datetime(2026, 8, 10, tzinfo=timezone.utc).timestamp()
    generator = connector._fetch_document_batches(
        ConfluenceCheckpoint(last_updated_at="2026-08-01T00:00:00Z"),
        start=0,
        end=end,
    )

    try:
        next(generator)
    except StopIteration as stop:
        completed = stop.value

    cql = parse_qs(urlsplit(fake.requested_url).query)["cql"][0]
    assert "lastmodified >= '2026-08-01 00:00'" in cql
    assert completed.last_updated_at == "2026-08-10T00:00:00+00:00"


@pytest.mark.asyncio
async def test_confluence_page_html_uses_docling_processor_and_keeps_chunks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connector = ConfluenceConnector(
        "https://example.atlassian.net/wiki",
        is_cloud=True,
    )
    connector._confluence_client = object()  # type: ignore[assignment]
    stable_id = "confluence::42"
    authoritative_chunk = Chunk(
        id=f"{stable_id}:0",
        item_id=stable_id,
        chunk_index=0,
        chunk_text="Risk policy",
        content_type="text",
        section_path=["Risk"],
        citation=CitationInfo(
            section="Risk",
            section_path=("Risk",),
            spans=(CitationSpan(element_id="heading-1"),),
        ),
    )

    class Processor:
        def process_bytes(self, data: bytes, **kwargs):
            html = data.decode("utf-8")
            assert "<h1>Risk</h1>" in html
            assert "<p>Policy</p>" in html
            assert kwargs["file_name"] == "42.html"
            assert kwargs["item_id"] == stable_id
            return SimpleNamespace(
                item=DocumentItem(
                    id=stable_id,
                    title="Risk policy",
                    source=kwargs["source"],
                    hierarchy=kwargs["hierarchy"],
                    access=kwargs["access"],
                    metadata=kwargs["metadata"],
                    document_kind=DocumentKind.PAGE,
                    content=[
                        TextPart(
                            element_id="heading-1",
                            section_path=("Risk",),
                            text="Risk policy",
                        )
                    ],
                ),
                chunks=(authoritative_chunk,),
            )

    connector._file_processor = Processor()  # type: ignore[assignment]
    monkeypatch.setattr(connector, "_fetch_secondary_owners", lambda *_: [])
    monkeypatch.setattr(
        connector,
        "_fetch_page_restrictions",
        lambda *_: None,
    )
    page = {
        "id": "42",
        "title": "Risk policy",
        "_links": {"webui": "/spaces/RISK/pages/42"},
        "body": {"storage": {"value": "<h1>Risk</h1><p>Policy</p>"}},
        "space": {"key": "RISK", "name": "Risk"},
        "version": {"number": 2, "when": "2026-08-10T00:00:00Z"},
        "history": {},
    }

    item = connector._convert_page_to_document(page)

    assert isinstance(item, DocumentItem)
    assert item.content[0].section_path == ("Risk",)
    assert await connector.fetch_chunks(item) == (authoritative_chunk,)


def test_confluence_attachment_preserves_docling_content_and_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connector = ConfluenceConnector(
        "https://example.atlassian.net/wiki",
        is_cloud=True,
    )
    connector._confluence_client = object()  # type: ignore[assignment]
    table = TablePart(
        element_id="p001_table_001",
        page=1,
        columns=["Account", "Balance"],
        rows=[["A-100", "42"]],
        section_path=("Risk",),
    )
    monkeypatch.setattr(
        confluence_module,
        "convert_attachment_to_content",
        lambda **_: AttachmentProcessingResult(
            text="Account | Balance\nA-100 | 42",
            file_name="risk.pdf",
            content=[table],
            mime_type="application/pdf",
            size_bytes=100,
            storage_provider="cloudflare_r2",
            storage_bucket="documents",
            storage_region="auto",
            storage_key="confluence/risk.pdf",
        ),
    )

    item = connector._convert_attachment_to_document(
        page={"space": {"name": "Risk", "key": "RISK"}},
        page_id="42",
        attachment={
            "id": "9",
            "title": "risk.pdf",
            "metadata": {"mediaType": "application/pdf"},
            "version": {"number": 1},
            "_links": {"download": "/risk.pdf"},
        },
        parent_doc=None,
    )

    assert isinstance(item, DocumentItem)
    assert item.document_kind == DocumentKind.PDF
    assert item.content == [table]
    assert item.original is not None
    assert item.original.provider == "cloudflare_r2"
    assert item.original.key == "confluence/risk.pdf"


def test_confluence_image_attachments_are_not_knowledge() -> None:
    image = {"title": "diagram.png", "metadata": {"mediaType": "image/png"}}
    pdf = {"title": "risk.pdf", "metadata": {"mediaType": "application/pdf"}}

    assert validate_attachment_filetype(image) is False
    assert validate_attachment_filetype(pdf) is True


@pytest.mark.asyncio
async def test_confluence_attachment_keeps_authoritative_multispan_chunks() -> None:
    stable_id = "confluence::42::att::9"
    citation = CitationInfo(
        section="Risk",
        section_path=("Risk",),
        spans=(
            CitationSpan(
                page=1,
                element_id="p001_text_001",
                start_offset=0,
                end_offset=13,
            ),
            CitationSpan(
                page=2,
                element_id="p002_table_001",
            ),
        ),
    )
    authoritative_chunk = Chunk(
        id=f"{stable_id}:0",
        item_id=stable_id,
        chunk_index=0,
        chunk_text="Quarterly risk\nAccount | Balance",
        content_type="mixed",
        section_path=["Risk"],
        citation=citation,
    )

    class Processor:
        def process_path(self, path, **kwargs):
            assert path.read_bytes() == b"pdf-bytes"
            assert kwargs["file_name"] == "risk.pdf"
            assert kwargs["item_id"] == stable_id
            return SimpleNamespace(
                text=authoritative_chunk.chunk_text,
                item=SimpleNamespace(
                    content=[
                        TextPart(
                            element_id="p001_text_001",
                            page=1,
                            text="Quarterly risk",
                        )
                    ]
                ),
                chunks=(authoritative_chunk,),
            )

    response = SimpleNamespace(
        status_code=200,
        headers={"content-length": str(len(b"pdf-bytes"))},
        iter_content=lambda *, chunk_size: iter([b"pdf-bytes"]),
        close=lambda: None,
    )
    session = SimpleNamespace(get=lambda *_, **__: response)
    client = SimpleNamespace(
        base_url="https://confluence.example",
        config={"is_cloud": False},
        timeout_seconds=30,
        confluence_client=SimpleNamespace(_session=session),
    )
    connector = ConfluenceConnector(
        "https://confluence.example",
        is_cloud=False,
    )
    connector._confluence_client = client  # type: ignore[assignment]
    connector._file_processor = Processor()  # type: ignore[assignment]

    item = connector._convert_attachment_to_document(
        page={"space": {"name": "Risk", "key": "RISK"}},
        page_id="42",
        attachment={
            "id": "9",
            "title": "risk.pdf",
            "metadata": {"mediaType": "application/pdf"},
            "extensions": {"fileSize": len(b"pdf-bytes")},
            "version": {"number": 1},
            "_links": {"download": "/risk.pdf"},
        },
        parent_doc=None,
    )

    assert isinstance(item, DocumentItem)
    adapter = CheckpointedSourceConnectorAdapter(
        source="confluence",
        connector=connector,
        scopes=[
            ConnectorScope(
                scope_type="space",
                scope_value="RISK",
                display_name="Risk",
            )
        ],
    )
    chunks = await adapter.fetch_chunks(item)

    assert chunks == (authoritative_chunk,)
    assert chunks[0] is authoritative_chunk
    assert chunks[0].chunk_text == authoritative_chunk.chunk_text
    assert chunks[0].citation == citation
    assert chunks[0].citation.spans == citation.spans
