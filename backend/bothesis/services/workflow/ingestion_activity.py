"""Side-effecting Temporal Activities of managed ingestion.

Two Activities, one per target, and both only orchestrate the shared core:
``ingest_source`` runs a connector Source through ``ConnectorPipeline`` into
``ItemIngestionService``; ``ingest_document`` runs one stored Document through
``ItemIngestionService.index_upload`` (or expands an archive and starts an
ingestion per child). Heartbeats carry the core's ``PhaseRecorder`` snapshot,
which is what the live monitor draws.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from temporalio import activity
from temporalio.exceptions import ApplicationError

from bothesis.connector import ConnectorPipeline, ConnectorPipelineConfig
from bothesis.connector.pipeline import ConnectorPipelineError, PipelineResult
from bothesis.connector.registry import ConnectorRegistry
from bothesis.db.engine import transaction_scope
from bothesis.db.models import IngestionSource, Item
from bothesis.document_index import EmbeddingRejectedError, ItemIndex
from bothesis.integrations.registry import ConnectionProviderRegistry
from bothesis.services import (
    ControlPlaneNotFoundError,
    ControlPlaneValidationError,
    DocumentProcessingError,
    InvalidDocumentStateError,
    StoredFileContent,
)
from bothesis.services.archive_expansion import ArchiveExpansionService
from bothesis.services.ingestion_sources import IngestionSourceService
from bothesis.services.integration_connections import IntegrationConnectionService
from bothesis.services.item import ItemService
from bothesis.services.item_ingestion import ItemIngestionService, PhaseRecorder, failure_message
from bothesis.services.preview import KnowledgePreview
from bothesis.services.workflow import (
    DOCUMENT_FAILURE_TYPE,
    DOCUMENT_INGESTION_ACTIVITY_NAME,
    INTERRUPTED_FAILURE_TYPE,
    PROVIDER_FAILURE_TYPE,
    SOURCE_INGESTION_ACTIVITY_NAME,
    IngestionResult,
    IngestionWorkflowInput,
)
from bothesis.services.workflow.service import TemporalWorkflowService
from bothesis.storage import DocumentStorage

log = logging.getLogger(__name__)

_NON_RETRYABLE_FAILURE_TYPES = frozenset(
    {
        "ControlPlaneNotFoundError",
        "EmbeddingRejectedError",
        "InvalidDocumentStateError",
        "PermissionError",
        "ValueError",
    }
)
#: How often a running Activity repeats its last heartbeat (the SDK throttles
#: the rest); a phase can run long without reporting.
_HEARTBEAT_SECONDS = 1.0


class IngestionActivities:
    """Load targets by stable ids and run them through the ingestion core."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        index: ItemIndex,
        raw_storage: DocumentStorage,
        stored_content: StoredFileContent,
        archives: ArchiveExpansionService,
        workflows: TemporalWorkflowService,
        registry: ConnectorRegistry | None = None,
        providers: ConnectionProviderRegistry | None = None,
        credential_encryption_key: str | None = None,
        pipeline_config: ConnectorPipelineConfig | None = None,
        preview: KnowledgePreview | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._index = index
        self._raw_storage = raw_storage
        self._stored_content = stored_content
        self._archives = archives
        self._workflows = workflows
        self._registry = registry
        self._providers = providers
        self._credential_encryption_key = credential_encryption_key
        self._pipeline_config = pipeline_config
        self._preview = preview

    # -- Source -------------------------------------------------------------

    @activity.defn(name=SOURCE_INGESTION_ACTIVITY_NAME)
    async def ingest_source(self, input: IngestionWorkflowInput) -> IngestionResult:
        assert input.source_id is not None
        heartbeat = asyncio.create_task(_heartbeat(lambda: {"phase": "syncing"}))
        try:
            result = await self._sync(UUID(input.source_id), test_connection=input.test_connection)
        except ConnectorPipelineError as exc:
            non_retryable = bool(exc.result.failures) and all(
                self._is_non_retryable_failure(failure.error_type, failure.message)
                for failure in exc.result.failures
            )
            raise ApplicationError(
                str(exc),
                [asdict(failure) for failure in exc.result.failures],
                type="IngestionItemError" if non_retryable else "IngestionTransientError",
                non_retryable=non_retryable,
            ) from exc
        except httpx.HTTPStatusError as exc:
            non_retryable = exc.response.status_code in {400, 401, 403, 404, 422}
            raise ApplicationError(
                str(exc), type="ConnectorHTTPError", non_retryable=non_retryable
            ) from exc
        except (
            ControlPlaneNotFoundError,
            ControlPlaneValidationError,
            InvalidDocumentStateError,
            PermissionError,
            ValueError,
        ) as exc:
            raise ApplicationError(str(exc), type=type(exc).__name__, non_retryable=True) from exc
        finally:
            await _stop(heartbeat)
        return IngestionResult(
            source_id=input.source_id,
            discovered_count=result.discovered_changes,
            processed_count=result.processed_items,
            indexed_count=result.written_chunks,
            deleted_count=result.deleted_items,
            failed_count=len(result.failures),
            checkpoint_advanced=result.checkpoint_advanced,
            duration_ms=result.duration_ms,
        )

    async def _sync(self, source_id: UUID, *, test_connection: bool) -> PipelineResult:
        async with transaction_scope(self._session_factory) as session:
            source, connector = await self._sources(session).runtime_for_source(source_id)
            resolved_source_id = source.id
            integration_connection_id = source.integration_connection_id
            connector_key = source.integration_connection.connector_key
            tenant_id = source.integration_connection.tenant_id
            checkpoint_data = dict(source.checkpoint or {})

        if connector.source != connector_key:
            raise ValueError("connector key does not match integration connection")
        set_storage = getattr(connector, "set_storage", None)
        if set_storage is not None:
            set_storage(self._raw_storage)
        scopes = await connector.list_scopes()
        if len(scopes) != 1:
            raise ValueError("an ingestion source must resolve to exactly one runtime scope")

        pipeline = ConnectorPipeline(
            connector,
            ItemIngestionService(
                self._session_factory,
                index=self._index,
                ingestion_source_id=resolved_source_id,
                preview=self._preview or KnowledgePreview(self._raw_storage),
            ),
            tenant_id=str(tenant_id),
            connector_id=str(integration_connection_id),
            config=self._pipeline_config or ConnectorPipelineConfig(),
        )
        try:
            result = await pipeline.run_scope(
                scopes[0],
                connector.checkpoint_model.model_validate(checkpoint_data),
                test_connection=test_connection,
            )
        finally:
            # A connector that refreshed its own token mid-run holds the only
            # copy of the rotated secret. Persist it whether the run succeeded
            # or not, or the next run starts from a credential that is gone.
            await self._persist_rotated_credentials(integration_connection_id, connector)
        await self._complete(resolved_source_id, result)
        return result

    def _sources(self, session: AsyncSession) -> IngestionSourceService:
        return IngestionSourceService(
            session,
            registry=self._registry,
            providers=self._providers,
            credential_encryption_key=self._credential_encryption_key,
        )

    async def _persist_rotated_credentials(
        self, integration_connection_id: UUID, connector: object
    ) -> None:
        rotated = getattr(connector, "refreshed_credentials", None)
        if not rotated:
            return
        async with transaction_scope(self._session_factory) as session:
            await IntegrationConnectionService(
                session,
                registry=self._registry,
                providers=self._providers,
                credential_encryption_key=self._credential_encryption_key,
            ).persist_rotated_credentials(integration_connection_id, rotated)

    async def _complete(self, source_id: UUID, result: PipelineResult) -> None:
        async with transaction_scope(self._session_factory) as session:
            source = await session.scalar(
                select(IngestionSource).where(IngestionSource.id == source_id).with_for_update()
            )
            if source is None or source.deleted_at is not None:
                raise InvalidDocumentStateError(f"ingestion source not found: {source_id}")
            if result.checkpoint_advanced:
                source.checkpoint = result.checkpoint.model_dump(mode="json")
            finished = datetime.now(UTC)
            source.last_ingested_at = finished
            source.last_indexed_at = finished
            await session.flush()

    @staticmethod
    def _is_non_retryable_failure(error_type: str, message: str) -> bool:
        if error_type in _NON_RETRYABLE_FAILURE_TYPES:
            return True
        if error_type != "HTTPStatusError":
            return False
        return any(token in message for token in ("400", "401", "403", "404", "422"))

    # -- Document -----------------------------------------------------------

    @activity.defn(name=DOCUMENT_INGESTION_ACTIVITY_NAME)
    async def ingest_document(self, input: IngestionWorkflowInput) -> IngestionResult:
        assert input.document_id is not None and input.owner_user_id is not None
        document_id = UUID(input.document_id)
        recorder = PhaseRecorder()
        heartbeat = asyncio.create_task(_heartbeat(recorder.snapshot))
        try:
            return await self._ingest_document(input, document_id, recorder)
        except asyncio.CancelledError:
            # Cancelled from the monitor: the Document must not stay "running".
            with suppress(Exception):
                async with transaction_scope(self._session_factory) as session:
                    await ItemService(session).mark_ingestion_cancelled(document_id)
            raise
        except (DocumentProcessingError, ValueError) as exc:
            # The core has recorded the state and the reason. Retrying cannot
            # make an immutable upload readable. ``from None``: Temporal would
            # otherwise ship the Python cause chain, which is not for people.
            log.warning("document ingestion failed document_id=%s", document_id, exc_info=exc)
            raise ApplicationError(
                failure_message(exc),
                {"phases": recorder.phases},
                type=DOCUMENT_FAILURE_TYPE,
                non_retryable=True,
            ) from None
        except EmbeddingRejectedError as exc:
            # The provider refused the key, credit or model: every retry would
            # parse and contextualize again only to be refused again.
            log.warning(
                "document ingestion rejected by the model provider document_id=%s: %s",
                document_id,
                exc,
            )
            raise ApplicationError(
                failure_message(exc),
                {"phases": recorder.phases},
                type=PROVIDER_FAILURE_TYPE,
                non_retryable=True,
            ) from None
        except Exception as exc:
            # Infrastructure (storage, model, index) failed; Temporal retries.
            log.exception("document ingestion interrupted document_id=%s", document_id)
            raise ApplicationError(
                failure_message(exc),
                {"phases": recorder.phases},
                type=INTERRUPTED_FAILURE_TYPE,
            ) from None
        finally:
            await _stop(heartbeat)

    async def _ingest_document(
        self, input: IngestionWorkflowInput, document_id: UUID, recorder: PhaseRecorder
    ) -> IngestionResult:
        owner_user_id = UUID(str(input.owner_user_id))
        tenant_id = UUID(input.tenant_id)
        expanded = await self._archives.expand_if_archive(
            document_id,
            owner_user_id=owner_user_id,
            tenant_id=tenant_id,
            start_child=self._start_child,
            progress=recorder,
        )
        if expanded is not None:
            return IngestionResult(
                document_id=str(expanded.archive_id),
                document_count=len(expanded.document_ids),
                phases=recorder.close(completed=True),
            )
        document = await ItemIngestionService(
            self._session_factory, index=self._index, preview=self._preview
        ).index_upload(
            document_id,
            owner_user_id=owner_user_id,
            tenant_id=tenant_id,
            source=self._stored_content,
            progress=recorder,
        )
        stored = next((phase for phase in recorder.phases if phase["phase"] == "storing"), None)
        return IngestionResult(
            document_id=str(document.id),
            indexed_count=int(stored["total"]) if stored else 0,
            phases=recorder.phases,
        )

    async def _start_child(self, child: Item) -> None:
        # A dispatch failure fails this Activity: nobody else would start the
        # child, and a retry is idempotent.
        assert child.upload is not None
        await self._workflows.start_ingestion(
            IngestionWorkflowInput(
                tenant_id=str(child.tenant_id),
                document_id=str(child.id),
                owner_user_id=str(child.upload.owner_user_id),
                trigger_type="upload",
            ),
            title=child.title,
            collection_id=str(child.parent_item_id),
        )


async def _heartbeat(details: Any) -> None:
    while True:
        activity.heartbeat(details())
        await asyncio.sleep(_HEARTBEAT_SECONDS)


async def _stop(task: asyncio.Task[None]) -> None:
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


__all__ = ["IngestionActivities"]
