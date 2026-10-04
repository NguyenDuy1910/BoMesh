from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from bomesh.connector.adapter import CheckpointedSourceConnectorAdapter
from bomesh.connector.base import StaticCredentialsProvider
from bomesh.connector.confluence.checkpoint import ConfluenceCheckpoint
from bomesh.connector.confluence.connector import ConfluenceConnector
from bomesh.connector.confluence.utils import validate_attachment_filetype
from bomesh.connector.file.processing import FileProcessor
from bomesh.connector.google_drive import GoogleDriveConnector
from bomesh.connector.google_drive.checkpoint import GoogleDriveCheckpoint
from bomesh.connector.protocol import (
    ChangeType,
    ConnectorScope,
    DocumentItem,
    DocumentKind,
)
from bomesh.connector.registry import ConnectorRegistry
from bomesh.storage import StoredObject


class RecordingStorage:
    """Object storage that keeps what it was given."""

    provider = "test"
    bucket = "originals"

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str | None]] = {}

    def put_bytes(
        self, data: bytes, key: str, *, content_type: str | None = None
    ) -> StoredObject:
        self.objects[key] = (data, content_type)
        return StoredObject(size_bytes=len(data), content_type=content_type)

    def put_path(
        self, path: Path, key: str, *, content_type: str | None = None
    ) -> StoredObject:
        return self.put_bytes(path.read_bytes(), key, content_type=content_type)


@pytest.fixture
def no_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    """A sync acquires originals; any attempt to parse one fails the test."""

    def refuse(*_: Any, **__: Any) -> None:
        raise AssertionError("a sync must not parse content")

    monkeypatch.setattr(FileProcessor, "process_bytes", refuse)
    monkeypatch.setattr(FileProcessor, "process_path", refuse)


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
@pytest.mark.usefixtures("no_parsing")
async def test_confluence_sync_stores_page_and_attachment_originals_without_parsing() -> None:
    storage = RecordingStorage()
    response = SimpleNamespace(
        status_code=200,
        headers={"content-length": str(len(b"pdf-bytes"))},
        iter_content=lambda *, chunk_size: iter([b"pdf-bytes"]),
        close=lambda: None,
    )
    page = {
        "id": "42",
        "title": "Risk policy",
        "_links": {"webui": "/spaces/RISK/pages/42"},
        "body": {"storage": {"value": "<h1>Risk</h1><p>Policy</p>"}},
        "space": {"key": "RISK", "name": "Risk"},
        "version": {"number": 2, "when": "2026-08-10T00:00:00Z"},
        "history": {},
        "ancestors": [],
    }
    attachment = {
        "id": "9",
        "title": "risk.pdf",
        "metadata": {"mediaType": "application/pdf"},
        "extensions": {"fileSize": len(b"pdf-bytes")},
        "version": {"number": 1, "when": "2026-08-10T00:00:00Z"},
        "_links": {"download": "/download/attachments/42/risk.pdf"},
    }
    connector = ConfluenceConnector("https://confluence.example", is_cloud=False, space="RISK")
    connector._confluence_client = SimpleNamespace(  # type: ignore[assignment]
        base_url="https://confluence.example",
        config={"is_cloud": False},
        timeout_seconds=30,
        confluence_client=SimpleNamespace(
            _session=SimpleNamespace(get=lambda *_, **__: response)
        ),
        retrieve_confluence_spaces=lambda **_: iter([{"key": "RISK", "name": "Risk"}]),
        paginated_page_retrieval=lambda **_: iter([page]),
        paginated_cql_retrieval=lambda **_: iter([attachment]),
        get_page_restrictions=lambda _page_id: {"results": []},
        get_page_owner_and_contributors=lambda _page_id: {},
    )
    connector._credentials_provider = StaticCredentialsProvider(
        tenant_id="tenant-1", provider_key="conn-1"
    )
    scope = ConnectorScope(scope_type="space", scope_value="RISK", display_name="Risk")
    adapter = CheckpointedSourceConnectorAdapter(
        source="confluence", connector=connector, scopes=[scope]
    )
    adapter.set_storage(storage)

    changes = await adapter.discover_changes(ConfluenceCheckpoint(), scope)
    page_item, attachment_item = [
        await adapter.fetch_item(change.item_id) for change in changes
    ]

    assert [change.type for change in changes] == [ChangeType.UPDATED, ChangeType.UPDATED]
    assert adapter.next_checkpoint().last_updated_at is not None

    assert isinstance(page_item, DocumentItem)
    assert page_item.document_kind == DocumentKind.PAGE
    assert page_item.content == []
    page_key = "tenants/tenant-1/sources/conn-1/confluence/confluence%3A%3A42/Risk%20policy.html"
    assert page_item.original is not None
    assert page_item.original.key == page_key
    assert page_item.original.content_type == "text/html"
    page_bytes, page_type = storage.objects[page_key]
    assert page_type == "text/html"
    assert b"<h1>Risk</h1>" in page_bytes and b"<p>Policy</p>" in page_bytes

    assert isinstance(attachment_item, DocumentItem)
    assert attachment_item.document_kind == DocumentKind.PDF
    assert attachment_item.content == []
    assert attachment_item.hierarchy.parent_id == "confluence::42"
    assert attachment_item.metadata["file_name"] == "risk.pdf"
    attachment_key = (
        "tenants/tenant-1/sources/conn-1/confluence/"
        "confluence%3A%3A42%3A%3Aatt%3A%3A9/risk.pdf"
    )
    assert attachment_item.original is not None
    assert attachment_item.original.key == attachment_key
    assert storage.objects[attachment_key] == (b"pdf-bytes", "application/pdf")


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_parsing")
async def test_google_drive_stores_the_downloaded_original_without_parsing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    file = {
        "id": "f1",
        "name": "Policy.pdf",
        "mimeType": "application/pdf",
        "version": "7",
        "modifiedTime": "2026-08-10T00:00:00Z",
        "createdTime": "2026-08-01T00:00:00Z",
        "md5Checksum": "abc",
        "webViewLink": "https://drive.example/file/f1",
        "permissions": [],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/changes/startPageToken"):
            return httpx.Response(200, json={"startPageToken": "token-1"})
        if path.endswith("/files"):
            return httpx.Response(200, json={"files": [file]})
        if path.endswith("/files/f1") and request.url.params.get("alt") == "media":
            return httpx.Response(200, content=b"%PDF-original")
        return httpx.Response(404, json={"message": f"unexpected call: {request.url}"})

    original_init = httpx.AsyncClient.__init__

    def patched(self: httpx.AsyncClient, *args: Any, **kwargs: Any) -> None:
        kwargs["transport"] = httpx.MockTransport(handler)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)
    storage = RecordingStorage()
    connector = GoogleDriveConnector(
        {
            "_google_drive_api_url": "https://drive.example/drive/v3",
            "_google_drive_token_url": "https://oauth.example/token",
            "_google_drive_client_id": "client",
            "_google_drive_client_secret": "secret",
            "_integration_connection_id": "conn-1",
            "_tenant_id": "tenant-1",
        },
        {
            "access_token": "access",
            "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        },
    )
    connector.set_storage(storage)
    scope = (await connector.list_scopes())[0]

    changes = await connector.discover_changes(GoogleDriveCheckpoint(), scope)
    item = await connector.fetch_item(changes[0].item_id)

    assert [(change.item_id, change.provider_version) for change in changes] == [("f1", "7")]
    assert item.content == []
    assert item.document_kind == DocumentKind.PDF
    assert item.source.external_version == "7"
    key = "tenants/tenant-1/sources/conn-1/google_drive/f1/Policy.pdf"
    assert item.original is not None
    assert item.original.key == key
    assert item.original.size_bytes == len(b"%PDF-original")
    assert storage.objects[key] == (b"%PDF-original", "application/pdf")


def test_confluence_image_attachments_are_not_knowledge() -> None:
    image = {"title": "diagram.png", "metadata": {"mediaType": "image/png"}}
    pdf = {"title": "risk.pdf", "metadata": {"mediaType": "application/pdf"}}

    assert validate_attachment_filetype(image) is False
    assert validate_attachment_filetype(pdf) is True

