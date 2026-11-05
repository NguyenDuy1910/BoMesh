"""Helpers of the Conversations slice tests: URLs, the scripted model, SSE and indexing.

The model is never real: :func:`script_model` installs a
``ScriptedResponsesTransport`` that replays one native event list per
sampling request (a tool round is one request, the answer the next).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    CitationInfo,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from bomesh.document_index import IndexingContext
from bomesh.runtime import AppRuntime
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from harness import Fakes, Sessions
from native_responses import (
    ScriptedResponsesTransport,
    completed,
    created,
    failed,
    function_call,
    message,
)


def ws_url(workspace: Any) -> str:
    return f"/api/v1/workspaces/{workspace.id}"


def conversations_url(workspace: Any) -> str:
    return f"{ws_url(workspace)}/conversations"


def conversation_url(workspace: Any, code: str, suffix: str = "") -> str:
    return f"{conversations_url(workspace)}/{code}{suffix}"


def item_name(item: Item) -> str:
    return f"workspaces/{item.tenant_id}/items/{item.id}"


def error_reason(response: Any) -> str | None:
    for detail in response.json()["error"]["details"]:
        if "reason" in detail:
            return detail["reason"]
    return None


# -- The scripted model ----------------------------------------------------------


def script_model(runtime: AppRuntime, fakes: Fakes, *requests: Sequence[Any]) -> ScriptedResponsesTransport:
    """Replay ``requests`` (one native event list per sampling request), in order."""
    transport = ScriptedResponsesTransport(list(requests))
    fakes.agent = transport
    runtime._agent_transport = transport  # type: ignore[assignment]
    runtime._agent = None
    return transport


def answer(*deltas: str) -> list[Any]:
    """One sampling request that answers directly with ``deltas``."""
    return [
        *created(),
        *message(item_id="msg_answer", output_index=0, deltas=deltas, phase="final_answer"),
        *completed(),
    ]


def search(*queries: str) -> list[Any]:
    """One sampling request that calls ``knowledge_search`` with ``queries``."""
    return [
        *created("resp_search"),
        *function_call(
            item_id="fc_search",
            output_index=0,
            call_id="call_search",
            name="knowledge_search",
            argument_deltas=[json.dumps({"queries": list(queries)})],
        ),
        *completed("resp_search"),
    ]


def failure(code: str = "server_error", text: str = "provider exploded") -> list[Any]:
    return [*created(), *failed(code, text)]


# -- SSE -------------------------------------------------------------------------


def sse_events(body: str) -> list[tuple[str, dict[str, Any]]]:
    """``(event name, data)`` of every Server-Sent Event in ``body``."""
    events: list[tuple[str, dict[str, Any]]] = []
    for frame in body.split("\n\n"):
        if not frame.strip():
            continue
        fields = dict(line.split(": ", 1) for line in frame.splitlines())
        data = json.loads(fields["data"])
        assert data["type"] == fields["event"]
        events.append((fields["event"], data))
    return events


# -- Indexing --------------------------------------------------------------------


async def index(
    runtime: AppRuntime, sessions: Sessions, document: Item, texts: Sequence[str], *, page: int | None = None
) -> list[str]:
    """Index ``texts`` as chunks ``{item}:{n}`` of ``document``; returns the chunk IDs."""
    async with transaction_scope(sessions) as session:
        row = await session.get(Item, document.id)
        assert row is not None
        collection = row
        while collection.item_type != "collection":
            parent = await session.get(Item, collection.parent_item_id)
            assert parent is not None
            collection = parent
        revision = await ItemService(session).current_revision(document.id)
    canonical = DocumentItem(
        id=str(row.id),
        title=row.title,
        document_kind=DocumentKind.NOTE,
        source=SourceIdentity(
            connector_id="upload", provider=SourceProvider.FILE, external_id=str(row.id)
        ),
        hierarchy=Hierarchy(parent_id=str(row.parent_item_id)),
        access=AccessPolicy(),
    )
    chunks = [
        Chunk(
            id=f"{row.id}:{position}",
            item_id=str(row.id),
            chunk_index=position,
            chunk_text=text,
            content_type="text",
            citation=CitationInfo(page_start=page, page_end=page),
        )
        for position, text in enumerate(texts)
    ]
    await ItemIngestionService(sessions, index=runtime.item_index()).process_item_content(
        row,
        canonical,
        chunks,
        context=IndexingContext(
            tenant_id=str(row.tenant_id),
            collection_item_id=str(collection.id),
            parent_item_id=str(row.parent_item_id),
            document_type=row.document_type or "plain_text",
            connector_key="file",
            published=row.publication_state == "published",
        ),
        processed_version=runtime.processing_version(),
        revision_number=revision.revision_number if revision is not None else None,
    )
    return [chunk.id for chunk in chunks]
