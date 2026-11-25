from __future__ import annotations

import json
from pathlib import Path
import sys

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from openai import AsyncOpenAI, RateLimitError

from bomesh.agent.transports.openai import OpenAITransport
from bomesh.agent.transports.opencode import OpenCodeTransport
from bomesh.agent.transports.openrouter import OpenRouterTransport
from bomesh.document_index import EmbeddingRejectedError, EmbeddingService
from bomesh.services.knowledge_items.indexing import failure_message
from config.env_config import ModelConfig


@pytest.mark.asyncio
async def test_openrouter_embeddings_returns_the_native_payload() -> None:
    seen_request: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_request
        seen_request = request
        return httpx.Response(
            200,
            json={"data": [{"embedding": [0.1, 0.2]}]},
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = OpenRouterTransport(
        api_key="test-key",
        embedding_model="openai/text-embedding-3-small",
        client=client,
    )

    response = await transport.embeddings(input="annual leave")

    assert response == {"data": [{"embedding": [0.1, 0.2]}]}
    assert seen_request is not None
    assert seen_request.url.path == "/api/v1/embeddings"
    assert json.loads(seen_request.content) == {
        "model": "openai/text-embedding-3-small",
        "input": "annual leave",
    }
    await client.aclose()


@pytest.mark.asyncio
async def test_openrouter_embeddings_does_not_normalize_provider_data() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{}]}, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = OpenRouterTransport(
        api_key="test-key",
        embedding_model="test-model",
        client=client,
    )

    response = await transport.embeddings(input=["annual leave"])

    assert response == {"data": [{}]}

    await client.aclose()


@pytest.mark.asyncio
async def test_openrouter_transport_implements_the_embedding_service_contract() -> None:
    seen_input: object | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_input
        seen_input = json.loads(request.content)["input"]
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": [3, 4.5]},
                    {"index": 0, "embedding": [1.0, 2]},
                ]
            },
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = OpenRouterTransport(
        api_key="test-key",
        embedding_model="test-model",
        client=client,
    )

    assert isinstance(transport, EmbeddingService)
    assert transport.embedding_model == "test-model"
    assert await transport.embed_documents([" first ", "second"]) == [
        [1.0, 2.0],
        [3.0, 4.5],
    ]
    assert seen_input == ["first", "second"]

    await client.aclose()


@pytest.mark.asyncio
async def test_openrouter_query_embedding_validates_input_and_vector() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"data": [{"embedding": [True]}]},
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = OpenRouterTransport(
        api_key="test-key",
        embedding_model="test-model",
        client=client,
    )

    with pytest.raises(ValueError, match="query must not be empty"):
        await transport.embed_query("  ")
    with pytest.raises(ValueError, match="embedding response vector is invalid"):
        await transport.embed_query("policy")

    await client.aclose()


def _status_transport(status: int, body: dict[str, object]) -> tuple[OpenRouterTransport, httpx.AsyncClient]:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return (
        OpenRouterTransport(api_key="test-key", embedding_model="test-model", client=client),
        client,
    )


@pytest.mark.asyncio
async def test_a_refused_key_is_a_rejection_people_can_act_on() -> None:
    transport, client = _status_transport(
        403,
        {"error": {"message": "Key limit exceeded (total limit). Manage it using https://openrouter.ai/keys/secret-hash", "code": 403}},
    )

    with pytest.raises(EmbeddingRejectedError) as rejected:
        await transport.embed_documents(["policy"])

    assert rejected.value.status_code == 403
    assert "Key limit exceeded" in str(rejected.value)
    shown = failure_message(rejected.value)
    assert "HTTP 403" in shown and "administrator" in shown
    assert "secret-hash" not in shown
    await client.aclose()


@pytest.mark.asyncio
async def test_rate_limiting_stays_a_transient_failure() -> None:
    transport, client = _status_transport(429, {"error": {"message": "slow down"}})

    with pytest.raises(httpx.HTTPStatusError):
        await transport.embed_documents(["policy"])
    await client.aclose()


def _openai_transport(
    handler, embedding_model: str = "openai/text-embedding-3-small"
) -> tuple[OpenAITransport, httpx.AsyncClient]:
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncOpenAI(
        api_key="test-key",
        base_url="https://api.openai.test/v1",
        http_client=http_client,
        max_retries=0,
    )
    return OpenAITransport(embedding_model=embedding_model, client=client), http_client


@pytest.mark.asyncio
async def test_openai_serves_the_openrouter_named_model_under_the_same_identity() -> None:
    """Moving EMBEDDING_MODEL to OpenAI must keep the identity points record."""

    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "object": "list",
                "model": "text-embedding-3-small",
                "data": [
                    {"object": "embedding", "index": 1, "embedding": [3, 4.5]},
                    {"object": "embedding", "index": 0, "embedding": [1.0, 2]},
                ],
                "usage": {"prompt_tokens": 2, "total_tokens": 2},
            },
            request=request,
        )

    transport, client = _openai_transport(handler)

    assert isinstance(transport, EmbeddingService)
    assert transport.embedding_model == "openai/text-embedding-3-small"
    assert await transport.embed_documents([" first ", "second"]) == [[1.0, 2.0], [3.0, 4.5]]
    assert seen["model"] == "text-embedding-3-small"
    assert seen["input"] == ["first", "second"]
    await client.aclose()


@pytest.mark.asyncio
async def test_openai_embedding_refusals_and_rate_limits_keep_their_meaning() -> None:
    status = 401

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status, json={"error": {"message": "Incorrect API key provided"}}, request=request
        )

    transport, client = _openai_transport(handler)
    with pytest.raises(EmbeddingRejectedError) as rejected:
        await transport.embed_query("policy")
    assert rejected.value.status_code == 401

    status = 429
    with pytest.raises(RateLimitError):
        await transport.embed_query("policy")
    await client.aclose()


@pytest.mark.asyncio
async def test_openai_refuses_to_serve_another_vendors_model() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request may be sent")

    transport, client = _openai_transport(handler, embedding_model="qwen/qwen3-embedding-8b")
    with pytest.raises(ValueError, match="not an OpenAI model"):
        await transport.embed_query("policy")
    await client.aclose()

    with pytest.raises(ValueError, match="not an OpenAI model"):
        ModelConfig(embedding_model="qwen/qwen3-embedding-8b", embedding_provider="openai")


def test_embedding_provider_defaults_to_openrouter_and_rejects_unknown_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BOMESH_EMBEDDING_PROVIDER", raising=False)
    assert ModelConfig.from_environment().embedding_provider == "openrouter"

    monkeypatch.setenv("BOMESH_EMBEDDING_PROVIDER", "OpenAI")
    monkeypatch.setenv("EMBEDDING_MODEL", "openai/text-embedding-3-small")
    assert ModelConfig.from_environment().embedding_provider == "openai"

    monkeypatch.setenv("BOMESH_EMBEDDING_PROVIDER", "azure")
    with pytest.raises(RuntimeError, match="BOMESH_EMBEDDING_PROVIDER"):
        ModelConfig.from_environment()


def _opencode_transport(handler, **kwargs) -> tuple[OpenCodeTransport, httpx.AsyncClient]:
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncOpenAI(
        api_key="test-key",
        base_url=OpenCodeTransport.DEFAULT_BASE_URL,
        http_client=http_client,
        max_retries=0,
    )
    return OpenCodeTransport(client=client, **kwargs), http_client


@pytest.mark.asyncio
async def test_opencode_serves_vendor_named_models_under_their_bare_id() -> None:
    """OpenCode names models bare; the configured ``vendor/model`` stays the identity."""

    seen: list[tuple[str, dict[str, object]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append((request.url.path, {"model": body["model"], "input": body["input"]}))
        if request.url.path.endswith("/embeddings"):
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "model": body["model"],
                    "data": [
                        {"object": "embedding", "index": 1, "embedding": [3, 4.5]},
                        {"object": "embedding", "index": 0, "embedding": [1.0, 2]},
                    ],
                    "usage": {"prompt_tokens": 2, "total_tokens": 2},
                },
                request=request,
            )
        return httpx.Response(
            200,
            json={
                "id": "resp_1",
                "object": "response",
                "created_at": 0,
                "model": body["model"],
                "status": "completed",
                "output": [],
                "parallel_tool_calls": True,
                "tool_choice": "auto",
                "tools": [],
            },
            request=request,
        )

    transport, client = _opencode_transport(
        handler,
        model="openai/gpt-5.6-luna",
        embedding_model="openai/text-embedding-3-small",
    )

    assert isinstance(transport, EmbeddingService)
    assert transport.embedding_model == "openai/text-embedding-3-small"
    assert await transport.embed_documents([" first ", "second"]) == [[1.0, 2.0], [3.0, 4.5]]
    await transport.responses(input="hi")
    assert seen == [
        (
            "/inference/openai/v1/embeddings",
            {"model": "text-embedding-3-small", "input": ["first", "second"]},
        ),
        ("/inference/openai/v1/responses", {"model": "gpt-5.6-luna", "input": "hi"}),
    ]
    await client.aclose()


@pytest.mark.asyncio
async def test_opencode_embedding_refusals_are_not_retried() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401, json={"type": "error", "error": {"message": "Missing API key."}}, request=request
        )

    transport, client = _opencode_transport(handler, embedding_model="qwen/qwen3-embedding-8b")
    with pytest.raises(EmbeddingRejectedError) as rejected:
        await transport.embed_query("policy")
    assert rejected.value.status_code == 401
    await client.aclose()


def test_opencode_provider_serves_the_agent_from_opencode_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BOMESH_AGENT_MODEL_PROVIDER", "opencode")
    monkeypatch.setenv("OPENROUTER_MODEL", "openai/gpt-5.6-luna")
    monkeypatch.setenv("OPENCODE_MODEL", "openai/gpt-6.1-sol")
    monkeypatch.setenv("BOMESH_EMBEDDING_PROVIDER", "opencode")
    monkeypatch.setenv("EMBEDDING_MODEL", "qwen/qwen3-embedding-8b")

    config = ModelConfig.from_environment()

    assert (config.agent_provider, config.chat_model) == ("opencode", "openai/gpt-6.1-sol")
    assert config.embedding_provider == "opencode"
