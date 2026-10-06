"""Bounded connector-to-inventory registration.

A sync discovers what changed in a source, acquires each changed original and
registers it in the knowledge inventory. It never parses, chunks, embeds or
indexes: processing is an Ingestion Run, started separately.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from enum import StrEnum
from time import perf_counter
from typing import Protocol

from .base import BaseSourceConnector
from bomesh.connector.protocol import (
    AnyItem,
    ChangeType,
    CollectionItem,
    ConnectorCheckpoint,
    ConnectorScope,
    DocumentItem,
    ItemChange,
)

log = logging.getLogger(__name__)


class Registration(StrEnum):
    """What registering one Document did to the inventory."""

    ADDED = "added"
    UPDATED = "updated"
    UNCHANGED = "unchanged"


class ConnectorRegistrationSink(Protocol):
    """The knowledge inventory a sync writes to, bound to one Source."""

    async def register_collection(self, item: CollectionItem) -> None:
        """Map one source container onto the Source's Collection."""

    async def register_document(self, item: DocumentItem) -> Registration:
        """Register one Document whose original is already stored."""

    async def is_current(self, external_id: str, version: str) -> bool:
        """Whether this exact version is already registered with its original."""

    async def remove(self, external_id: str) -> bool:
        """Tombstone one Document removed at the source; False when unknown."""


@dataclass(frozen=True, slots=True)
class PipelineFailure:
    item_id: str
    operation: str
    error_type: str
    message: str


@dataclass(frozen=True, slots=True)
class PipelineResult:
    checkpoint: ConnectorCheckpoint
    checkpoint_advanced: bool
    discovered_changes: int
    added: int
    updated: int
    unchanged: int
    removed: int
    hierarchy: tuple[AnyItem, ...] = ()
    failures: tuple[PipelineFailure, ...] = ()
    duration_ms: int = 0


@dataclass(frozen=True, slots=True)
class ConnectorPipelineConfig:
    fetch_concurrency: int = 8
    fetch_hierarchy: bool = True

    def __post_init__(self) -> None:
        if self.fetch_concurrency < 1:
            raise ValueError("fetch_concurrency must be at least one")


class ConnectorPipeline:
    """Register changes with bounded concurrency and retry-safe identities.

    One change that fails is recorded and the rest still register. A run with
    any failure never advances the returned checkpoint, so the next sync sees
    the same changes again; registration is idempotent.
    """

    def __init__(
        self,
        connector: BaseSourceConnector,
        sink: ConnectorRegistrationSink,
        *,
        config: ConnectorPipelineConfig | None = None,
    ) -> None:
        self._connector = connector
        self._sink = sink
        self._config = config or ConnectorPipelineConfig()

    async def run_scope(
        self,
        scope: ConnectorScope,
        checkpoint: ConnectorCheckpoint,
        *,
        test_connection: bool = False,
    ) -> PipelineResult:
        started_at = perf_counter()
        if test_connection:
            connected = await self._connector.test_connection()
            if not connected:
                raise ConnectionError(f"Connector {self._connector.source!r} is unavailable")

        changes = _deduplicate_changes(
            await self._connector.discover_changes(checkpoint, scope)
        )
        failures: list[PipelineFailure] = []
        hierarchy: tuple[AnyItem, ...] = ()
        if self._config.fetch_hierarchy:
            try:
                hierarchy = tuple(await self._connector.fetch_hierarchy(scope))
                for item in sorted(
                    hierarchy,
                    key=lambda value: (value.hierarchy.depth, value.id),
                ):
                    if isinstance(item, CollectionItem):
                        await self._sink.register_collection(item)
            except Exception as exc:
                failures.append(_failure("<scope>", "hierarchy", exc))

        removed = 0
        for change in changes:
            if change.type != ChangeType.DELETED:
                continue
            try:
                if await self._sink.remove(change.item_id):
                    removed += 1
            except Exception as exc:
                failures.append(_failure(change.item_id, "remove", exc))

        counts = {outcome: 0 for outcome in Registration}
        pending: list[ItemChange] = []
        for change in changes:
            if change.type not in {ChangeType.CREATED, ChangeType.UPDATED}:
                continue
            if change.item is None and change.provider_version is not None:
                # Acquiring an original means downloading it; skip what the
                # inventory already holds at this exact version.
                try:
                    current = await self._sink.is_current(
                        change.item_id, change.provider_version
                    )
                except Exception as exc:
                    failures.append(_failure(change.item_id, "register", exc))
                    continue
                if current:
                    counts[Registration.UNCHANGED] += 1
                    continue
            pending.append(change)

        for start in range(0, len(pending), self._config.fetch_concurrency):
            change_batch = pending[start : start + self._config.fetch_concurrency]
            loaded = await asyncio.gather(
                *(self._load_item(change) for change in change_batch),
                return_exceptions=True,
            )
            # Registration stays in discovery order: a parent Document is in
            # the inventory before the attachments that point at it.
            for change, outcome in zip(change_batch, loaded, strict=True):
                if isinstance(outcome, BaseException):
                    failures.append(_failure(change.item_id, "fetch", outcome))
                    continue
                try:
                    counts[await self._sink.register_document(outcome)] += 1
                except Exception as exc:
                    failures.append(_failure(change.item_id, "register", exc))

        advanced = not failures
        result = PipelineResult(
            checkpoint=(self._connector.next_checkpoint() if advanced else checkpoint),
            checkpoint_advanced=advanced,
            discovered_changes=len(changes),
            added=counts[Registration.ADDED],
            updated=counts[Registration.UPDATED],
            unchanged=counts[Registration.UNCHANGED],
            removed=removed,
            hierarchy=hierarchy,
            failures=tuple(failures),
            duration_ms=round((perf_counter() - started_at) * 1000),
        )
        log.info(
            "connector_registration source=%s scope=%s changes=%d added=%d updated=%d "
            "unchanged=%d removed=%d failures=%d duration_ms=%d",
            self._connector.source,
            scope.scope_value,
            result.discovered_changes,
            result.added,
            result.updated,
            result.unchanged,
            result.removed,
            len(result.failures),
            result.duration_ms,
        )
        return result

    async def _load_item(self, change: ItemChange) -> DocumentItem:
        item_id = change.item_id
        item = change.item
        if item is None:
            item = await self._connector.fetch_item(item_id)
        if item.id != item_id:
            raise ValueError(
                f"Connector returned item {item.id!r} for change {item_id!r}"
            )
        if item.source.provider.value != self._connector.source:
            raise ValueError(
                f"Connector source {self._connector.source!r} returned {item.source.provider.value!r}"
            )
        if not isinstance(item, DocumentItem):
            raise ValueError(
                f"Connector change {item_id!r} did not produce a DocumentItem"
            )
        if item.original is None:
            raise ValueError(f"Connector did not store the original of {item_id!r}")
        return item


def _deduplicate_changes(changes: list[ItemChange]) -> list[ItemChange]:
    by_item_id: dict[str, ItemChange] = {}
    for change in changes:
        # Moving a duplicate to the end preserves the source's latest ordering.
        by_item_id.pop(change.item_id, None)
        by_item_id[change.item_id] = change
    return list(by_item_id.values())


def _failure(item_id: str, operation: str, exc: BaseException) -> PipelineFailure:
    message = str(exc).strip()
    if len(message) > 500:
        message = f"{message[:497]}..."
    return PipelineFailure(
        item_id=item_id,
        operation=operation,
        error_type=type(exc).__name__,
        message=message or type(exc).__name__,
    )


__all__ = [
    "ConnectorPipeline",
    "ConnectorPipelineConfig",
    "ConnectorRegistrationSink",
    "PipelineFailure",
    "PipelineResult",
    "Registration",
]
