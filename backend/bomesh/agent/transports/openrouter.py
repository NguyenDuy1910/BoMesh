"""Thin async boundary over OpenRouter's native API.

OpenRouter serves ``POST /responses`` in OpenResponses format and is
OpenAI-compatible on the wire, so the model path is the official OpenAI SDK
pointed at OpenRouter's base URL. That keeps this class thin — no hand-rolled
SSE reader, no chat-completions reconstruction — and gives the agent one set of
transport error types for every provider, which is what
:mod:`bomesh.agent.sampling` classifies for retries.

Three things are genuinely OpenRouter-specific and are normalized here:

* the base URL and the optional ``HTTP-Referer`` / ``X-Title`` attribution
  headers;
* request options outside the specification (``provider`` routing preferences,
  ``plugins``, ``top_k``, ``models``, ``session_id``, …), which ride in
  ``extra_body`` and are therefore never named by the agent; and
* embeddings, which are a separate API with a separate client and a raw payload
  contract, deliberately not routed through the Responses client.
"""

from __future__ import annotations

import math
import os
from pathlib import PurePosixPath
from typing import Any, cast
from urllib.parse import quote

import httpx
from openai import AsyncOpenAI, AsyncStream
from openai.types.responses import (
    Response,
    ResponseInputParam,
    ResponseStreamEvent,
)

from bomesh.agent.execution import ExecutionCapability
from bomesh.agent.protocol import Item, ProviderResourceRef
from bomesh.agent.transports.openrouter_execution_mapper import (
    OpenRouterExecutionMapper,
)
from bomesh.agent.transports.openrouter_tool_builder import OpenRouterToolBuilder
from bomesh.document_index import EmbeddingRejectedError

#: Embedding responses no retry can change: bad request, key, credit, model.
_REJECTED_EMBEDDING_STATUSES = frozenset({400, 401, 402, 403, 404, 422})

class OpenRouterTransport:
    """Expose OpenRouter Responses and embedding operations."""

    DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
    provider = "openrouter"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        embedding_model: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        site_url: str | None = None,
        app_name: str | None = None,
        timeout: float = 60.0,
        execution_mapper: OpenRouterExecutionMapper | None = None,
        tool_builder: OpenRouterToolBuilder | None = None,
        client: httpx.AsyncClient | None = None,
        responses_client: AsyncOpenAI | None = None,
    ) -> None:
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        self.model = model or os.getenv("OPENROUTER_MODEL")
        self.embedding_model = (
            embedding_model or os.getenv("EMBEDDING_MODEL") or ""
        ).strip()
        if not self.api_key:
            raise ValueError("OpenRouter API key is required")
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        self._base_url = base_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        attribution: dict[str, str] = {}
        if site_url:
            attribution["HTTP-Referer"] = site_url
        if app_name:
            attribution["X-Title"] = app_name
        self._headers.update(attribution)
        self._attribution = attribution
        self._timeout = timeout
        self._execution_mapper = execution_mapper or OpenRouterExecutionMapper()
        self._tool_builder = tool_builder or OpenRouterToolBuilder()
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None
        # Built on first model call: a transport created only for embeddings
        # should not open a second connection pool it never uses.
        self._responses_client = responses_client
        self._owns_responses_client = responses_client is None

    def _responses(self) -> AsyncOpenAI:
        if self._responses_client is None:
            self._responses_client = AsyncOpenAI(
                api_key=self.api_key,
                base_url=self._base_url,
                default_headers=self._attribution or None,
                timeout=self._timeout,
            )
        return self._responses_client

    async def responses(
        self,
        *,
        input: str | ResponseInputParam,
        model: str | None = None,
        execution_capability: ExecutionCapability | None = None,
        **params: Any,
    ) -> Response:
        """Create a non-streaming response and return the payload unchanged."""

        if "stream" in params:
            raise ValueError("use stream_response for streaming Responses requests")
        response = await self._responses().responses.create(
            model=self._model(model),
            input=self._execution_mapper.render_input(input),
            **self._execution_params(params, execution_capability),
        )
        return cast(Response, response)

    async def stream_response(
        self,
        *,
        input: str | ResponseInputParam,
        model: str | None = None,
        execution_capability: ExecutionCapability | None = None,
        **params: Any,
    ) -> AsyncStream[ResponseStreamEvent]:
        """Create a streaming response over OpenRouter's OpenResponses endpoint."""

        if "stream" in params:
            raise ValueError("stream_response controls the stream parameter")
        stream = await self._responses().responses.create(
            model=self._model(model),
            input=self._execution_mapper.render_input(input),
            stream=True,
            **self._execution_params(params, execution_capability),
        )
        return cast(AsyncStream[ResponseStreamEvent], stream)

    async def embeddings(
        self,
        *,
        input: object,
        model: str | None = None,
        **params: Any,
    ) -> dict[str, Any]:
        """Return one native OpenRouter embedding payload.

        Embeddings stay on their own HTTP client and keep their raw payload
        contract: they are a different API from the model path and share none of
        its semantics.
        """

        selected_model = model or self.embedding_model
        if not selected_model:
            raise ValueError("OpenRouter embedding model is required")
        response = await self._client.post(
            f"{self._base_url}/embeddings",
            headers=self._headers,
            json={"model": selected_model, "input": input, **params},
        )
        if response.status_code in _REJECTED_EMBEDDING_STATUSES:
            raise EmbeddingRejectedError(response.status_code, _error_detail(response))
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("OpenRouter returned a non-object response")
        return payload

    async def upload_file(
        self, *, file_name: str, mime_type: str, data: bytes
    ) -> ProviderResourceRef:
        """Upload one already-authorized file through OpenRouter's Files API."""

        name = _file_name(file_name)
        content_type = mime_type.strip() or "application/octet-stream"
        if not data:
            raise ValueError("sandbox file must not be empty")
        headers = {
            key: value for key, value in self._headers.items() if key != "Content-Type"
        }
        response = await self._client.post(
            f"{self._base_url}/files",
            headers=headers,
            files={"file": (name, data, content_type)},
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("OpenRouter returned an invalid uploaded file")
        identifier = _provider_identifier(payload.get("id"), "file id")
        reported_name = payload.get("filename")
        return ProviderResourceRef(
            provider=self.provider,
            id=identifier,
            name=reported_name if isinstance(reported_name, str) and reported_name else name,
        )

    async def download_file(
        self, *, environment_id: str, file_id: str
    ) -> bytes:
        """Download a reported container file only for explicit artifact export."""

        container = _provider_identifier(environment_id, "container id")
        file = _provider_identifier(file_id, "file id")
        response = await self._client.get(
            f"{self._base_url}/containers/{quote(container, safe='')}/files/"
            f"{quote(file, safe='')}/content",
            headers=self._headers,
        )
        response.raise_for_status()
        return response.content

    def workspace_path(self, *, file_id: str, file_name: str) -> str:
        """Where an attached file appears in the container.

        OpenRouter copies an attached file into the home directory as the last
        eight characters of its id, a dash, and its base name, so two files
        with one name never collide.
        """

        identifier = _provider_identifier(file_id, "file id")
        base = PurePosixPath(_file_name(file_name)).name
        return f"~/{identifier[-8:]}-{base}"

    async def find_file(
        self, *, environment_id: str, path: str
    ) -> ProviderResourceRef | None:
        """Find a saved container file by its path under the home directory."""

        container = _provider_identifier(environment_id, "container id")
        wanted = path.strip()
        after: str | None = None
        # Bounded: a workspace with more than 10,000 saved files is not one a
        # chat turn should be searching.
        for _ in range(10):
            params: dict[str, str | int] = {"limit": 1000}
            if after is not None:
                params["after"] = after
            response = await self._client.get(
                f"{self._base_url}/containers/{quote(container, safe='')}/files",
                headers=self._headers,
                params=params,
            )
            response.raise_for_status()
            payload = response.json()
            entries = payload.get("data") if isinstance(payload, dict) else None
            for entry in entries if isinstance(entries, list) else ():
                if isinstance(entry, dict) and entry.get("path") == wanted:
                    return ProviderResourceRef(
                        provider=self.provider,
                        id=_provider_identifier(entry.get("id"), "file id"),
                        name=wanted,
                    )
            if not (isinstance(payload, dict) and payload.get("has_more")):
                return None
            last = payload.get("last_id")
            if not isinstance(last, str) or not last:
                return None
            after = last
        return None

    async def embed_query(self, query: str) -> list[float]:
        """Embed one non-empty query for document retrieval."""

        normalized = query.strip()
        if not normalized:
            raise ValueError("query must not be empty")
        return (await self._embed([normalized]))[0]

    async def embed_documents(self, documents: list[str]) -> list[list[float]]:
        """Embed non-empty document texts in provider response order."""

        normalized = [document.strip() for document in documents]
        if not normalized or any(not document for document in normalized):
            raise ValueError("documents must contain non-empty text")
        return await self._embed(normalized)

    async def aclose(self) -> None:
        """Close the internally-created clients when the app shuts down."""

        if self._owns_client:
            await self._client.aclose()
        if self._owns_responses_client and self._responses_client is not None:
            await self._responses_client.close()

    def _model(self, model: str | None) -> str:
        selected_model = model or self.model
        if not selected_model:
            raise ValueError("OpenRouter model is required")
        return selected_model

    def _execution_params(
        self,
        params: dict[str, Any],
        capability: ExecutionCapability | None,
    ) -> dict[str, Any]:
        rendered = dict(params)
        rendered["tools"] = self._tool_builder.with_hosted_shell(
            rendered.get("tools", ()), capability
        )
        if not rendered["tools"]:
            rendered.pop("tools")
        return rendered

    def normalize_output_item(self, native: Any) -> Item | None:
        """Normalize OpenRouter shell output before it crosses the adapter boundary."""

        return self._execution_mapper.normalize_output_item(native)

    async def _embed(self, inputs: list[str]) -> list[list[float]]:
        payload = await self.embeddings(
            input=inputs[0] if len(inputs) == 1 else inputs,
        )
        data = payload.get("data")
        if not isinstance(data, list) or len(data) != len(inputs):
            raise ValueError("embedding response does not contain all vectors")
        indexed: list[tuple[int, list[float]]] = []
        for fallback_index, item in enumerate(data):
            if not isinstance(item, dict):
                raise ValueError("embedding response vector is invalid")
            raw_vector = item.get("embedding")
            if not isinstance(raw_vector, list) or not raw_vector:
                raise ValueError("embedding response vector is invalid")
            if any(
                isinstance(value, bool) or not isinstance(value, (int, float))
                for value in raw_vector
            ):
                raise ValueError("embedding response vector is invalid")
            vector = [float(value) for value in raw_vector]
            if any(not math.isfinite(value) for value in vector):
                raise ValueError("embedding response vector is invalid")
            raw_index = item.get("index", fallback_index)
            if isinstance(raw_index, bool) or not isinstance(raw_index, int):
                raise ValueError("embedding response index is invalid")
            indexed.append((raw_index, vector))
        indexed.sort(key=lambda item: item[0])
        if [index for index, _ in indexed] != list(range(len(inputs))):
            raise ValueError("embedding response indexes are invalid")
        return [vector for _, vector in indexed]


def _file_name(value: str) -> str:
    name = value.strip()
    if not name or "/" in name or "\\" in name or "\x00" in name:
        raise ValueError("sandbox upload file name is invalid")
    if len(name) > 255:
        raise ValueError("sandbox upload file name is invalid")
    return name


def _error_detail(response: httpx.Response) -> str:
    """OpenRouter's own error message, for operators' logs."""

    try:
        error = response.json().get("error")
    except (ValueError, AttributeError):
        error = None
    message = error.get("message") if isinstance(error, dict) else None
    if isinstance(message, str) and message.strip():
        return message.strip()[:500]
    return response.reason_phrase or "request rejected"


def _provider_identifier(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"OpenRouter {label} is invalid")
    identifier = value.strip()
    if any(character in identifier for character in "/\\?#"):
        raise ValueError(f"OpenRouter {label} is invalid")
    return identifier


__all__ = ["OpenRouterTransport"]
