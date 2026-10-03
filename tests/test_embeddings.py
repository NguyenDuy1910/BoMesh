from __future__ import annotations

import json
from pathlib import Path
import sys

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from bomesh.agent.transports.openrouter import OpenRouterTransport
from bomesh.document_index import EmbeddingRejectedError, EmbeddingService
from bomesh.services.item_ingestion import failure_message


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
