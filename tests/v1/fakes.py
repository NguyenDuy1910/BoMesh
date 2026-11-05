"""In-memory stand-ins for the infrastructure behind :class:`bomesh.runtime.AppRuntime`.

Each fake implements the surface its production class exposes to services,
answering the way the real dependency does (return types, not-found errors,
size limits), and records what it was asked so tests can assert on it:

- :class:`FakeObjectStorage` — ``bomesh.storage.aws_s3.S3DocumentStorage``;
- :class:`FakeIndexBackend` — the backend of a real ``ItemIndex`` (Qdrant);
- :class:`FakeEmbedder` — the ``EmbeddingService`` of an ``ItemIndex``;
- :class:`FakeWorkflows` — ``bomesh.services.workflow.service.TemporalWorkflowService``;
- :class:`FakeAtlassian` + :func:`fake_connection_providers` — the Atlassian
  OAuth/Confluence HTTP endpoints behind a real ``AtlassianConnectionProvider``.

The agent transport needs no fake here: ``native_responses.ScriptedResponsesTransport``
replays native Responses events.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import ModuleType
from typing import Any
from uuid import UUID

import httpx
import pytest

from bomesh.document_index import INDEX_SCHEMA_VERSION
from bomesh.integrations import atlassian as atlassian_module
from bomesh.integrations.atlassian import AtlassianConnectionProvider
from bomesh.integrations.registry import ConnectionProviderRegistry
from bomesh.services.workflow import WorkflowExecutionNotFoundError, ingestion_schedule_id
from bomesh.storage import (
    ObjectNotFoundError,
    ObjectStorageError,
    PresignedRequest,
    StoredObject,
)

# -- Object storage ------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FakeObject:
    data: bytes
    content_type: str | None
    etag: str


class FakeObjectStorage:
    """``S3DocumentStorage`` over a dict; presigned URLs point at a fake host."""

    def __init__(self, *, bucket: str = "test-bucket", provider: str = "fake") -> None:
        self._bucket = bucket
        self._provider = provider
        self.objects: dict[str, FakeObject] = {}
        self.closed = False

    @property
    def bucket(self) -> str:
        return self._bucket

    @property
    def provider(self) -> str:
        return self._provider

    def put_bytes(
        self,
        data: bytes,
        key: str,
        *,
        content_type: str | None = None,
        content_encoding: str | None = None,
        cache_control: str | None = None,
    ) -> StoredObject:
        if not data:
            raise ValueError("object storage bytes must not be empty")
        stored = FakeObject(bytes(data), content_type, hashlib.md5(data).hexdigest())
        self.objects[_object_key(key)] = stored
        return StoredObject(
            size_bytes=len(data), content_type=content_type, etag=stored.etag
        )

    def put_path(
        self, path: Path, key: str, *, content_type: str | None = None
    ) -> StoredObject:
        data = path.read_bytes()
        if not data:
            raise ValueError("object storage file must not be empty")
        return self.put_bytes(data, key, content_type=content_type)

    def presign_upload(
        self, key: str, *, content_type: str, expires_seconds: int
    ) -> PresignedRequest:
        return PresignedRequest(
            url=self._url(key, expires_seconds),
            method="PUT",
            headers={"Content-Type": content_type},
            expires_at=datetime.now(UTC) + timedelta(seconds=_expiry(expires_seconds)),
        )

    def presign_download(self, key: str, *, expires_seconds: int) -> PresignedRequest:
        return PresignedRequest(
            url=self._url(key, expires_seconds),
            method="GET",
            headers={},
            expires_at=datetime.now(UTC) + timedelta(seconds=_expiry(expires_seconds)),
        )

    async def head(self, key: str) -> StoredObject:
        stored = self._get(key)
        return StoredObject(
            size_bytes=len(stored.data), content_type=stored.content_type, etag=stored.etag
        )

    async def read(self, key: str, *, max_bytes: int) -> bytes:
        if max_bytes < 1:
            raise ValueError("max_bytes must be greater than zero")
        stored = self._get(key)
        if len(stored.data) > max_bytes:
            raise ObjectStorageError(f"raw document exceeds the {max_bytes} byte read limit")
        return stored.data

    async def download_to_path(
        self, key: str, path: Path, *, max_bytes: int
    ) -> StoredObject:
        data = await self.read(key, max_bytes=max_bytes)
        path.write_bytes(data)
        return await self.head(key)

    async def delete(self, key: str) -> None:
        self.objects.pop(_object_key(key), None)

    async def aclose(self) -> None:
        self.closed = True

    def _get(self, key: str) -> FakeObject:
        stored = self.objects.get(_object_key(key))
        if stored is None:
            raise ObjectNotFoundError("raw document object was not found")
        return stored

    def _url(self, key: str, expires_seconds: int) -> str:
        return (
            f"https://storage.test/{self._bucket}/{_object_key(key)}"
            f"?expires={_expiry(expires_seconds)}"
        )


def _object_key(value: str) -> str:
    normalized = value.strip().lstrip("/")
    if not normalized:
        raise ValueError("object key must not be blank")
    return normalized


def _expiry(value: int) -> int:
    if not 1 <= value <= 604_800:
        raise ValueError("presigned URL lifetime must be between 1 and 604800 seconds")
    return value


# -- Vector index --------------------------------------------------------------

_TOKEN = re.compile(r"\w+")


@dataclass(frozen=True, slots=True)
class FakePoint:
    """What the Qdrant SDK returns: ``.id``, ``.payload`` and (for searches) ``.score``."""

    id: str
    payload: dict[str, Any]
    vector: tuple[float, ...] = ()
    score: float | None = None


class FakeIndexBackend:
    """The ``ItemIndex`` backend over a dict; search ranks by query-term overlap.

    Search applies the same access filter as Qdrant: tenant, readable
    collection ids, ``published`` or an editable collection, not deleted,
    current schema version.
    """

    def __init__(self) -> None:
        self.points: dict[str, FakePoint] = {}
        self.closed = False

    async def replace_item_points(
        self,
        *,
        item_id: str,
        tenant_id: str,
        records: Iterable[Any],
        vectors: Iterable[Iterable[float]],
    ) -> None:
        resolved_records = list(records)
        resolved_vectors = [tuple(vector) for vector in vectors]
        if len(resolved_records) != len(resolved_vectors):
            raise ValueError("every indexed chunk requires one embedding")
        await self.tombstone_item_points(item_id, tenant_id=tenant_id)
        for record, vector in zip(resolved_records, resolved_vectors, strict=True):
            self.points[record.point_id] = FakePoint(
                id=record.point_id, payload=record.payload.to_payload(), vector=vector
            )

    async def search_item_points(
        self,
        *,
        queries: Sequence[tuple[str, list[float]]],
        tenant_id: str,
        collection_item_ids: Iterable[str],
        editable_collection_ids: Iterable[str],
        limit: int,
        candidate_limit: int,
    ) -> list[FakePoint]:
        if not queries:
            raise ValueError("at least one query is required")
        if limit < 1 or candidate_limit < limit:
            raise ValueError("candidate_limit must be at least the result limit")
        collections = set(collection_item_ids)
        editable = set(editable_collection_ids)
        terms = {term for text, _ in queries for term in _terms(text)}
        scored: list[FakePoint] = []
        for point in self.points.values():
            if not self._live(point, tenant_id) or (
                point.payload.get("collection_item_id") not in collections
            ):
                continue
            if (
                point.payload.get("published") is False
                and point.payload.get("collection_item_id") not in editable
            ):
                continue
            overlap = len(terms & _terms(str(point.payload.get("contextual_text", ""))))
            if overlap:
                scored.append(replace(point, score=overlap / len(terms)))
        scored.sort(key=lambda point: (-(point.score or 0.0), point.id))
        return scored[:limit]

    async def get_item_points(
        self,
        *,
        item_id: str,
        tenant_id: str,
        chunk_id: str | None,
        limit: int,
    ) -> list[FakePoint]:
        return [
            point
            for point in self.points.values()
            if self._live(point, tenant_id)
            and point.payload.get("item_id") == item_id
            and (not chunk_id or point.payload.get("chunk_id") == chunk_id)
        ][:limit]

    async def tombstone_item_points(self, item_id: str, *, tenant_id: str) -> None:
        await self.set_item_payload(item_id, tenant_id=tenant_id, payload={"is_deleted": True})

    async def set_item_payload(
        self, item_id: str, *, tenant_id: str, payload: dict[str, Any]
    ) -> None:
        for point_id, point in self._item_points(item_id, tenant_id):
            self.points[point_id] = replace(point, payload={**point.payload, **payload})

    async def count_item_points(self, item_id: str, *, tenant_id: str) -> int:
        return len(self._item_points(item_id, tenant_id))

    async def delete_item_points(self, item_id: str, *, tenant_id: str) -> None:
        for point_id, _ in self._item_points(item_id, tenant_id):
            del self.points[point_id]

    async def aclose(self) -> None:
        self.closed = True

    def live_points(self, item_id: str | UUID) -> list[FakePoint]:
        """Points of one item that are not tombstoned (assertion helper)."""
        return [
            point
            for point in self.points.values()
            if point.payload.get("item_id") == str(item_id)
            and not point.payload.get("is_deleted")
        ]

    def _item_points(self, item_id: str, tenant_id: str) -> list[tuple[str, FakePoint]]:
        return [
            (point_id, point)
            for point_id, point in self.points.items()
            if point.payload.get("tenant_id") == tenant_id
            and point.payload.get("item_id") == item_id
        ]

    @staticmethod
    def _live(point: FakePoint, tenant_id: str) -> bool:
        payload = point.payload
        return (
            payload.get("tenant_id") == tenant_id
            and not payload.get("is_deleted", False)
            and payload.get("schema_version") == INDEX_SCHEMA_VERSION
        )


def _terms(text: str) -> set[str]:
    return {token.casefold() for token in _TOKEN.findall(text)}


class FakeEmbedder:
    """Deterministic 8-dimensional vectors derived from a hash of the text."""

    def __init__(self, embedding_model: str = "fake-embedding") -> None:
        self.embedding_model = embedding_model
        self.document_batches: list[list[str]] = []
        self.queries: list[str] = []

    async def embed_documents(self, documents: list[str]) -> list[list[float]]:
        self.document_batches.append(list(documents))
        return [_vector(document) for document in documents]

    async def embed_query(self, query: str) -> list[float]:
        self.queries.append(query)
        return _vector(query)


def _vector(text: str) -> list[float]:
    digest = hashlib.sha256(text.encode()).digest()
    return [(byte + 1) / 256 for byte in digest[:8]]


# -- Workflows -----------------------------------------------------------------


@dataclass(slots=True)
class FakeWorkflows:
    """``TemporalWorkflowService`` that records every call and keeps executions open.

    ``calls`` holds ``(method, arguments)`` in order. A started run or sync
    stays open until the test calls :meth:`finish_run` / :meth:`finish_sync`.
    """

    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    open_runs: set[str] = field(default_factory=set)
    open_syncs: set[str] = field(default_factory=set)
    schedules: dict[str, dict[str, Any]] = field(default_factory=dict)

    async def start_run(self, run_id: UUID | str, tenant_id: UUID | str) -> None:
        self._record("start_run", run_id=str(run_id), tenant_id=str(tenant_id))
        self.open_runs.add(str(run_id))

    async def cancel_run(self, run_id: UUID | str) -> bool:
        self._record("cancel_run", run_id=str(run_id))
        if str(run_id) not in self.open_runs:
            return False
        self.open_runs.discard(str(run_id))
        return True

    async def run_is_open(self, run_id: UUID | str) -> bool:
        return str(run_id) in self.open_runs

    async def start_source_sync(
        self, source_id: UUID | str, tenant_id: UUID | str, *, sync_id: UUID | str
    ) -> bool:
        self._record(
            "start_source_sync",
            source_id=str(source_id),
            tenant_id=str(tenant_id),
            sync_id=str(sync_id),
        )
        if str(source_id) in self.open_syncs:
            return False
        self.open_syncs.add(str(source_id))
        return True

    async def source_sync_is_open(self, source_id: UUID | str) -> bool:
        return str(source_id) in self.open_syncs

    async def upsert_schedule(
        self, source_id: UUID | str, tenant_id: UUID | str, values: dict[str, Any]
    ) -> dict[str, Any]:
        self._record(
            "upsert_schedule", source_id=str(source_id), tenant_id=str(tenant_id), values=values
        )
        enabled = values.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError("schedule enabled must be a boolean")
        if not str(values.get("cron_expression") or "").strip():
            raise ValueError("schedule expression is required")
        payload = {
            "id": ingestion_schedule_id(str(source_id)),
            "schedule_type": str(values.get("schedule_type") or "cron").strip().casefold(),
            "cron_expression": str(values["cron_expression"]).strip(),
            "timezone": str(values.get("timezone") or "UTC").strip(),
            "enabled": enabled,
            "paused": not enabled,
            "overlap_policy": str(values.get("overlap_policy") or "skip").strip().casefold(),
            "next_run_at": None,
            "last_run_at": None,
            "num_actions": 0,
            "num_actions_skipped_overlap": 0,
        }
        self.schedules[str(source_id)] = payload
        return dict(payload)

    async def describe_schedule(self, source_id: UUID | str) -> dict[str, Any] | None:
        schedule = self.schedules.get(str(source_id))
        return dict(schedule) if schedule is not None else None

    async def pause_schedule(self, source_id: UUID | str) -> dict[str, Any]:
        self._record("pause_schedule", source_id=str(source_id))
        return self._set_paused(source_id, paused=True)

    async def resume_schedule(self, source_id: UUID | str) -> dict[str, Any]:
        self._record("resume_schedule", source_id=str(source_id))
        return self._set_paused(source_id, paused=False)

    async def delete_schedule(self, source_id: UUID | str) -> None:
        self._record("delete_schedule", source_id=str(source_id))
        self.schedules.pop(str(source_id), None)

    def finish_run(self, run_id: UUID | str) -> None:
        self.open_runs.discard(str(run_id))

    def finish_sync(self, source_id: UUID | str) -> None:
        self.open_syncs.discard(str(source_id))

    def called(self, method: str) -> list[dict[str, Any]]:
        """Arguments of every call to ``method``, in order."""
        return [arguments for name, arguments in self.calls if name == method]

    def _record(self, method: str, **arguments: Any) -> None:
        self.calls.append((method, arguments))

    def _set_paused(self, source_id: UUID | str, *, paused: bool) -> dict[str, Any]:
        schedule = self.schedules.get(str(source_id))
        if schedule is None:
            raise WorkflowExecutionNotFoundError(str(source_id))
        schedule.update(paused=paused, enabled=not paused)
        return dict(schedule)


# -- Connection providers ------------------------------------------------------

ATLASSIAN_CLOUD_ID = "11111111-aaaa-bbbb-cccc-222222222222"
ATLASSIAN_ACCOUNT_ID = "557058:abcdef"
ATLASSIAN_REDIRECT_URI = "https://api.example/callback"


class FakeAtlassian:
    """Atlassian's endpoints, answering the way the documented API does.

    :meth:`install` routes the HTTP clients of ``bomesh.integrations.atlassian``
    (and only those) to :meth:`handler`, so an API test client in the same
    test keeps its own transport.
    """

    def __init__(self) -> None:
        self.issued_refresh_tokens = ["refresh-1"]
        self.exchanges = 0
        self.spaces = [
            {"id": "1", "key": "ENG", "name": "Engineering"},
            {"id": "2", "key": "DATA", "name": "Data Platform"},
            {"id": "3", "key": "HR", "name": "People"},
        ]

    def install(self, monkeypatch: pytest.MonkeyPatch) -> FakeAtlassian:
        monkeypatch.setattr(atlassian_module, "httpx", _routed_httpx(self.handler))
        return self

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/oauth/token"):
            self.exchanges += 1
            # Atlassian rotates the refresh token on every use.
            issued = f"refresh-{len(self.issued_refresh_tokens) + 1}"
            self.issued_refresh_tokens.append(issued)
            return httpx.Response(
                200,
                json={
                    "access_token": f"access-{self.exchanges}",
                    "refresh_token": issued,
                    "expires_in": 3600,
                    "scope": "read:confluence-content.all offline_access",
                },
            )
        if url.endswith("/oauth/token/accessible-resources"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": ATLASSIAN_CLOUD_ID,
                        "url": "https://galaxyfinx.atlassian.net",
                        "name": "Galaxy FinX",
                    }
                ],
            )
        if url.endswith("/me"):
            return httpx.Response(
                200,
                json={
                    "account_id": ATLASSIAN_ACCOUNT_ID,
                    "email": "duy@company.com",
                    "name": "Duy",
                },
            )
        if "/wiki/api/v2/spaces" in url:
            return httpx.Response(200, json={"results": self.spaces, "_links": {}})
        return httpx.Response(404, json={"message": f"unexpected call: {url}"})


def fake_connection_providers() -> ConnectionProviderRegistry:
    """A registry with a configured Atlassian provider (pair it with :class:`FakeAtlassian`)."""
    return ConnectionProviderRegistry(
        (
            AtlassianConnectionProvider(
                client_id="client",
                client_secret="secret",
                redirect_uri=ATLASSIAN_REDIRECT_URI,
            ),
        )
    )


def _routed_httpx(handler: Any) -> ModuleType:
    """A stand-in ``httpx`` module whose ``AsyncClient`` always uses ``handler``."""

    class RoutedAsyncClient(httpx.AsyncClient):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    module = ModuleType("httpx")
    module.__dict__.update(vars(httpx))
    module.AsyncClient = RoutedAsyncClient  # type: ignore[attr-defined]
    return module


__all__ = [
    "ATLASSIAN_ACCOUNT_ID",
    "ATLASSIAN_CLOUD_ID",
    "ATLASSIAN_REDIRECT_URI",
    "FakeAtlassian",
    "FakeEmbedder",
    "FakeIndexBackend",
    "FakeObject",
    "FakeObjectStorage",
    "FakePoint",
    "FakeWorkflows",
    "fake_connection_providers",
]
