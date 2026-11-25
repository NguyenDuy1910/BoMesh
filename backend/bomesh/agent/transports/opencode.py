"""Thin async boundary over OpenCode's inference API.

OpenCode (``https://opencode.ai/inference``) serves each model through the API
family of its vendor. Its OpenAI family, ``/inference/openai/v1``, is the
OpenAI wire format, so this transport is the official OpenAI SDK pointed at
that base URL and offers exactly what BoMesh needs from it:

* ``POST /responses`` in OpenResponses format, for the models OpenCode serves
  on the Responses API (GPT and other ``responses`` models in its model list);
  models served only on Chat Completions, Anthropic Messages or Gemini are not
  reachable through this transport;
* ``POST /embeddings``.

OpenCode names models by a bare id (``gpt-5.6-luna``); BoMesh configures models
as ``vendor/model`` (``openai/gpt-5.6-luna``) and that name stays the identity
index points and ``processing_version()`` record. The vendor prefix is dropped
only on the wire, so moving a model to OpenCode keeps every stored vector.
"""

from __future__ import annotations

import os
from typing import Any, cast

from openai import APIStatusError, AsyncOpenAI, AsyncStream
from openai.types import CreateEmbeddingResponse
from openai.types.responses import Response, ResponseInputParam, ResponseStreamEvent

from bomesh.agent.transports.openai import ordered_vectors
from bomesh.document_index import EmbeddingRejectedError

#: Embedding responses no retry can change: bad request, key, credit, model.
_REJECTED_EMBEDDING_STATUSES = frozenset({400, 401, 402, 403, 404, 422})


class OpenCodeTransport:
    """Expose OpenCode Responses and embedding operations."""

    DEFAULT_BASE_URL = "https://opencode.ai/inference/openai/v1"
    provider = "opencode"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        embedding_model: str | None = None,
        timeout: float = 60.0,
        client: AsyncOpenAI | None = None,
    ) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        self.model = model or os.getenv("OPENCODE_MODEL")
        self.embedding_model = (
            embedding_model or os.getenv("EMBEDDING_MODEL") or ""
        ).strip()
        if client is None:
            api_key = api_key or os.getenv("OPENCODE_API_KEY")
            if not api_key:
                raise ValueError("OpenCode API key is required")
            client = AsyncOpenAI(
                api_key=api_key,
                base_url=base_url or os.getenv("OPENCODE_BASE_URL") or self.DEFAULT_BASE_URL,
                timeout=timeout,
            )
            self._owns_client = True
        else:
            self._owns_client = False
        self._client = client

    async def responses(
        self,
        *,
        input: str | ResponseInputParam,
        model: str | None = None,
        **params: Any,
    ) -> Response:
        """Create a non-streaming response and return the payload unchanged."""

        if "stream" in params:
            raise ValueError("use stream_response for streaming Responses requests")
        response = await self._client.responses.create(
            model=self._model(model), input=input, **params
        )
        return cast(Response, response)

    async def stream_response(
        self,
        *,
        input: str | ResponseInputParam,
        model: str | None = None,
        **params: Any,
    ) -> AsyncStream[ResponseStreamEvent]:
        """Create a streaming response over OpenCode's OpenResponses endpoint."""

        if "stream" in params:
            raise ValueError("stream_response controls the stream parameter")
        stream = await self._client.responses.create(
            model=self._model(model), input=input, stream=True, **params
        )
        return cast(AsyncStream[ResponseStreamEvent], stream)

    async def embeddings(
        self,
        *,
        input: str | list[str],
        model: str | None = None,
        **params: Any,
    ) -> CreateEmbeddingResponse:
        """Create embeddings and return the SDK response unchanged."""

        return await self._client.embeddings.create(
            model=opencode_model_id(model or self.embedding_model),
            input=input,
            **params,
        )

    async def embed_query(self, query: str) -> list[float]:
        """Embed one non-empty query for document retrieval."""

        normalized = query.strip()
        if not normalized:
            raise ValueError("query must not be empty")
        return (await self._embed([normalized]))[0]

    async def embed_documents(self, documents: list[str]) -> list[list[float]]:
        """Embed non-empty document texts in input order."""

        normalized = [document.strip() for document in documents]
        if not normalized or any(not document for document in normalized):
            raise ValueError("documents must contain non-empty text")
        return await self._embed(normalized)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.close()

    def _model(self, model: str | None) -> str:
        return opencode_model_id(model or self.model)

    async def _embed(self, inputs: list[str]) -> list[list[float]]:
        try:
            response = await self.embeddings(input=inputs)
        except APIStatusError as exc:
            if exc.status_code in _REJECTED_EMBEDDING_STATUSES:
                raise EmbeddingRejectedError(exc.status_code, exc.message) from exc
            raise
        return ordered_vectors(response, len(inputs))


def opencode_model_id(model: str | None) -> str:
    """The OpenCode id of a model named ``vendor/<id>`` or ``<id>``."""

    model_id = (model or "").rpartition("/")[2].strip()
    if not model_id:
        raise ValueError("OpenCode model is required")
    return model_id


__all__ = ["OpenCodeTransport", "opencode_model_id"]
