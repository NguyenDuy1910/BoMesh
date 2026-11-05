"""Probe the services BoMesh depends on, record the history and name the platform components.

- :class:`HealthService` probes every dependency once (no user workload).
- :class:`HealthRecorder` writes each probe to ``platform_health_checks``
  (kept :data:`HISTORY_RETENTION`); the Operations interface derives
  ``components`` and ``incidents`` from that history.
- :func:`platform_components` is the fixed component catalog, configured
  from the deployment settings.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from time import perf_counter
from typing import Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import PlatformHealthCheck
from bomesh.document_index import DENSE_VECTOR_NAME, SPARSE_VECTOR_NAME
from config.env_config import AppConfig

log = logging.getLogger(__name__)

#: Probe history older than this is deleted when new probes are recorded.
HISTORY_RETENTION = timedelta(days=90)
#: Default interval between two recorded probes.
PROBE_INTERVAL_SECONDS = 60.0

ServiceStatus = Literal["healthy", "unhealthy", "not_configured"]
AggregateStatus = Literal["healthy", "degraded", "unhealthy"]


class ServiceHealth(BaseModel):
    """Safe readiness information for one external dependency."""

    model_config = ConfigDict(extra="forbid")

    name: str
    status: ServiceStatus
    required: bool
    latency_ms: int
    error_category: str | None = None
    model: str | None = None
    collection: str | None = None


class HealthReport(BaseModel):
    """Typed response returned by the aggregate health endpoint."""

    model_config = ConfigDict(extra="forbid")

    status: AggregateStatus
    checked_at: datetime
    duration_ms: int
    services: list[ServiceHealth]


@dataclass(frozen=True, slots=True)
class HealthSettings:
    qdrant_url: str | None
    qdrant_api_key: str | None
    qdrant_collection: str | None
    openai_base_url: str
    openai_api_key: str | None
    openrouter_base_url: str
    openrouter_api_key: str | None
    chat_model: str | None
    embedding_model: str | None
    langfuse_base_url: str
    langfuse_public_key: str | None
    langfuse_secret_key: str | None


class HealthService:
    """Probe independent dependencies without executing user workloads."""

    def __init__(
        self,
        settings: HealthSettings,
        *,
        timeout_seconds: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("health timeout must be greater than zero")
        self._settings = settings
        self._timeout_seconds = timeout_seconds
        self._transport = transport

    async def check(self) -> HealthReport:
        started_at = perf_counter()
        async with httpx.AsyncClient(
            timeout=self._timeout_seconds,
            transport=self._transport,
        ) as client:
            qdrant, openai_chat, openrouter_embeddings, langfuse = await asyncio.gather(
                self._check_qdrant(client),
                self._check_openai_chat(client),
                self._check_openrouter_model(
                    client,
                    "openrouter_embeddings",
                    self._settings.embedding_model,
                    "embeddings/models",
                ),
                self._check_langfuse(client),
            )

        services = [
            ServiceHealth(
                name="api",
                status="healthy",
                required=True,
                latency_ms=0,
            ),
            qdrant,
            openai_chat,
            openrouter_embeddings,
            langfuse,
        ]
        required_failed = any(
            service.required and service.status != "healthy" for service in services
        )
        optional_failed = any(
            not service.required and service.status == "unhealthy"
            for service in services
        )
        aggregate_status: AggregateStatus = (
            "unhealthy"
            if required_failed
            else "degraded"
            if optional_failed
            else "healthy"
        )
        return HealthReport(
            status=aggregate_status,
            checked_at=datetime.now(UTC),
            duration_ms=_duration_ms(started_at),
            services=services,
        )

    async def _check_qdrant(self, client: httpx.AsyncClient) -> ServiceHealth:
        name = "qdrant"
        required = True
        collection = self._settings.qdrant_collection
        if not self._settings.qdrant_url or not collection:
            return _not_configured(name, required, collection=collection)

        started_at = perf_counter()
        headers = (
            {"api-key": self._settings.qdrant_api_key}
            if self._settings.qdrant_api_key
            else None
        )
        url = (
            f"{self._settings.qdrant_url.rstrip('/')}/collections/"
            f"{quote(collection, safe='')}"
        )
        try:
            async with asyncio.timeout(self._timeout_seconds):
                response = await client.get(url, headers=headers)
        except (TimeoutError, httpx.TimeoutException):
            return _unhealthy(
                name,
                required,
                started_at,
                "timeout",
                collection=collection,
            )
        except httpx.HTTPError:
            return _unhealthy(
                name,
                required,
                started_at,
                "connection_failed",
                collection=collection,
            )

        error_category = _http_error_category(response.status_code)
        if error_category is not None:
            return _unhealthy(
                name,
                required,
                started_at,
                error_category,
                collection=collection,
            )
        try:
            payload = response.json()
        except ValueError:
            return _unhealthy(
                name,
                required,
                started_at,
                "invalid_response",
                collection=collection,
            )
        if not isinstance(payload, dict) or not isinstance(payload.get("result"), dict):
            return _unhealthy(
                name,
                required,
                started_at,
                "invalid_response",
                collection=collection,
            )
        result = payload["result"]
        config = result.get("config")
        params = config.get("params") if isinstance(config, dict) else None
        vectors = params.get("vectors") if isinstance(params, dict) else None
        sparse_vectors = (
            params.get("sparse_vectors") if isinstance(params, dict) else None
        )
        if (
            not isinstance(vectors, dict)
            or DENSE_VECTOR_NAME not in vectors
            or not isinstance(sparse_vectors, dict)
            or SPARSE_VECTOR_NAME not in sparse_vectors
        ):
            return _unhealthy(
                name,
                required,
                started_at,
                "incompatible_schema",
                collection=collection,
            )
        return _healthy(name, required, started_at, collection=collection)

    async def _check_openai_chat(
        self,
        client: httpx.AsyncClient,
    ) -> ServiceHealth:
        name = "openai_chat"
        model = self._settings.chat_model
        if not self._settings.openai_api_key or not model:
            return _not_configured(name, True, model=model)

        started_at = perf_counter()
        try:
            async with asyncio.timeout(self._timeout_seconds):
                response = await client.get(
                    f"{self._settings.openai_base_url.rstrip('/')}/models/"
                    f"{quote(model, safe='')}",
                    headers={
                        "Authorization": f"Bearer {self._settings.openai_api_key}"
                    },
                )
        except (TimeoutError, httpx.TimeoutException):
            return _unhealthy(name, True, started_at, "timeout", model=model)
        except httpx.HTTPError:
            return _unhealthy(
                name,
                True,
                started_at,
                "connection_failed",
                model=model,
            )

        error_category = _http_error_category(response.status_code)
        if error_category is not None:
            return _unhealthy(
                name,
                True,
                started_at,
                error_category,
                model=model,
            )
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if not isinstance(payload, dict) or payload.get("id") != model:
            return _unhealthy(
                name,
                True,
                started_at,
                "invalid_response",
                model=model,
            )
        return _healthy(name, True, started_at, model=model)

    async def _check_openrouter_model(
        self,
        client: httpx.AsyncClient,
        name: str,
        model: str | None,
        path: str,
    ) -> ServiceHealth:
        if not self._settings.openrouter_api_key or not model:
            return _not_configured(name, True, model=model)

        started_at = perf_counter()
        try:
            async with asyncio.timeout(self._timeout_seconds):
                response = await client.get(
                    f"{self._settings.openrouter_base_url.rstrip('/')}/{path}",
                    headers={
                        "Authorization": (f"Bearer {self._settings.openrouter_api_key}")
                    },
                )
        except (TimeoutError, httpx.TimeoutException):
            return _unhealthy(name, True, started_at, "timeout", model=model)
        except httpx.HTTPError:
            return _unhealthy(
                name,
                True,
                started_at,
                "connection_failed",
                model=model,
            )

        error_category = _http_error_category(response.status_code)
        if error_category is not None:
            return _unhealthy(
                name,
                True,
                started_at,
                error_category,
                model=model,
            )
        try:
            payload = response.json()
            raw_models = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(raw_models, list):
                raise ValueError
            available_models = {
                item["id"]
                for item in raw_models
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
        except (KeyError, ValueError):
            return _unhealthy(
                name,
                True,
                started_at,
                "invalid_response",
                model=model,
            )
        return _model_health(name, model, available_models, started_at)

    async def _check_langfuse(self, client: httpx.AsyncClient) -> ServiceHealth:
        name = "langfuse"
        required = False
        public_key = self._settings.langfuse_public_key
        secret_key = self._settings.langfuse_secret_key
        if not public_key and not secret_key:
            return _not_configured(name, required)
        if not public_key or not secret_key:
            return ServiceHealth(
                name=name,
                status="unhealthy",
                required=required,
                latency_ms=0,
                error_category="incomplete_configuration",
            )

        started_at = perf_counter()
        try:
            async with asyncio.timeout(self._timeout_seconds):
                response = await client.get(
                    f"{self._settings.langfuse_base_url.rstrip('/')}/api/public/projects",
                    auth=httpx.BasicAuth(public_key, secret_key),
                )
        except (TimeoutError, httpx.TimeoutException):
            return _unhealthy(name, required, started_at, "timeout")
        except httpx.HTTPError:
            return _unhealthy(name, required, started_at, "connection_failed")

        error_category = _http_error_category(response.status_code)
        if error_category is not None:
            return _unhealthy(name, required, started_at, error_category)
        try:
            payload = response.json()
            projects = payload.get("data") if isinstance(payload, dict) else None
        except ValueError:
            projects = None
        if not isinstance(projects, list):
            return _unhealthy(name, required, started_at, "invalid_response")
        if not projects:
            return _unhealthy(name, required, started_at, "no_project_access")
        return _healthy(name, required, started_at)


def _model_health(
    name: str,
    model: str | None,
    available_models: set[str],
    started_at: float,
) -> ServiceHealth:
    if not model:
        return _not_configured(name, True)
    if model not in available_models:
        return _unhealthy(
            name,
            True,
            started_at,
            "model_not_available",
            model=model,
        )
    return _healthy(name, True, started_at, model=model)


def _healthy(
    name: str,
    required: bool,
    started_at: float,
    *,
    model: str | None = None,
    collection: str | None = None,
) -> ServiceHealth:
    return ServiceHealth(
        name=name,
        status="healthy",
        required=required,
        latency_ms=_duration_ms(started_at),
        model=model,
        collection=collection,
    )


def _unhealthy(
    name: str,
    required: bool,
    started_at: float,
    error_category: str,
    *,
    model: str | None = None,
    collection: str | None = None,
) -> ServiceHealth:
    return ServiceHealth(
        name=name,
        status="unhealthy",
        required=required,
        latency_ms=_duration_ms(started_at),
        error_category=error_category,
        model=model,
        collection=collection,
    )


def _not_configured(
    name: str,
    required: bool,
    *,
    model: str | None = None,
    collection: str | None = None,
) -> ServiceHealth:
    return ServiceHealth(
        name=name,
        status="not_configured",
        required=required,
        latency_ms=0,
        error_category="not_configured",
        model=model,
        collection=collection,
    )


def _http_error_category(status_code: int) -> str | None:
    if 200 <= status_code < 300:
        return None
    if status_code in {401, 403}:
        return "authentication_failed"
    if status_code == 404:
        return "resource_not_found"
    if status_code == 429:
        return "rate_limited"
    return "upstream_error"


def _duration_ms(started_at: float) -> int:
    return round((perf_counter() - started_at) * 1_000)


ComponentKind = Literal["SERVICE", "AI_MODEL"]


@dataclass(frozen=True, slots=True)
class ComponentSpec:
    """One platform component (``components/{id}``) and the probe that checks it."""

    id: str
    display_name: str
    kind: ComponentKind
    probe: str
    configured: bool
    setting: str | None = None
    model: str | None = None


def platform_components(config: AppConfig) -> tuple[ComponentSpec, ...]:
    """The components of this deployment; ``probe`` is the :class:`ServiceHealth` name."""
    model = config.model
    index = config.vector_index
    observability = config.observability
    chat_setting = "OPENROUTER_MODEL" if model.agent_provider == "openrouter" else "OPENAI_MODEL"
    return (
        ComponentSpec("api", "API", "SERVICE", probe="api", configured=True),
        ComponentSpec(
            "vector-index",
            "Vector index",
            "SERVICE",
            probe="qdrant",
            configured=bool(index.url and index.collection),
            setting="QDRANT_URL",
        ),
        ComponentSpec(
            "chat-model",
            "Chat model",
            "AI_MODEL",
            probe="openai_chat",
            configured=bool(model.chat_model),
            setting=chat_setting,
            model=model.chat_model,
        ),
        ComponentSpec(
            "embedding-model",
            "Embedding model",
            "AI_MODEL",
            probe="openrouter_embeddings",
            configured=bool(model.embedding_model),
            setting="EMBEDDING_MODEL",
            model=model.embedding_model,
        ),
        ComponentSpec(
            "observability",
            "Observability",
            "SERVICE",
            probe="langfuse",
            configured=bool(
                observability.langfuse_public_key or observability.langfuse_secret_key
            ),
            setting="LANGFUSE_PUBLIC_KEY",
        ),
    )


class HealthRecorder:
    """Probe periodically and append each service's result to ``platform_health_checks``."""

    def __init__(self, health: HealthService, sessions: SessionFactory) -> None:
        self._health = health
        self._sessions = sessions

    async def record(self) -> HealthReport:
        """Probe once, store one row per service and prune expired history."""
        report = await self._health.check()
        async with transaction_scope(self._sessions) as session:
            session.add_all(
                PlatformHealthCheck(
                    checked_at=report.checked_at,
                    service=service.name,
                    status=service.status,
                    error_category=service.error_category,
                    latency_ms=service.latency_ms,
                )
                for service in report.services
            )
            await session.execute(
                delete(PlatformHealthCheck).where(
                    PlatformHealthCheck.checked_at < report.checked_at - HISTORY_RETENTION
                )
            )
        return report

    async def run(self, interval_seconds: float = PROBE_INTERVAL_SECONDS) -> None:
        """Record forever (until cancelled); a failed round is logged and retried."""
        while True:
            try:
                await self.record()
            except Exception:  # noqa: BLE001 - the next round retries
                log.warning("platform health could not be recorded", exc_info=True)
            await asyncio.sleep(interval_seconds)


__all__ = [
    "HISTORY_RETENTION",
    "PROBE_INTERVAL_SECONDS",
    "ComponentKind",
    "ComponentSpec",
    "HealthRecorder",
    "HealthReport",
    "HealthService",
    "HealthSettings",
    "ServiceHealth",
    "platform_components",
]
