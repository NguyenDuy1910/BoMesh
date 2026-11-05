"""The deployment ingestion policy (``ingestionPolicies/default``), platform-only.

The row is created from :class:`~config.env_config.IngestionPolicyConfig` the
first time it is read; ``UpdateIngestionPolicy`` owns it afterwards.
``contributionReviewRequired`` is not stored: member contributions are always
reviewed.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import IngestionPolicy
from bomesh.errors import InvalidArgument, NotFound
from bomesh.iam.authorizer import PlatformRef
from bomesh.services.ingestion.common import DEFAULT_POLICY, ingestion_policy_name
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from config.env_config import IngestionPolicyConfig

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: Mutable paths of ``UpdateIngestionPolicy`` (``api.aip.fieldmask``).
UPDATABLE_FIELDS = (
    "allowedMimeTypes",
    "maxFileSizeBytes",
    "ocrScannedPdfs",
    "parseSpreadsheets",
    "rejectedRetentionDuration",
)


@dataclass(frozen=True, slots=True)
class IngestionPolicyRecord:
    policy: IngestionPolicy
    etag: str

    @property
    def name(self) -> str:
        return ingestion_policy_name(self.policy.code)


class IngestionPolicyService:
    """Get, List and Update the one ingestion policy."""

    def __init__(self, sessions: SessionFactory, defaults: IngestionPolicyConfig) -> None:
        self._sessions = sessions
        self._defaults = defaults

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> IngestionPolicyService:
        return cls(runtime.sessions(), runtime.config.ingestion_policy)

    async def list(self, ctx: RequestContext) -> list[IngestionPolicyRecord]:
        await ctx.authorizer.require(ctx.principal, "ingestionPolicies.list", PlatformRef())
        async with transaction_scope(self._sessions) as session:
            return [_record(await self._default(session))]

    async def get(self, ctx: RequestContext, policy_id: str) -> IngestionPolicyRecord:
        await self._require(ctx, "ingestionPolicies.get", policy_id)
        async with transaction_scope(self._sessions) as session:
            return _record(await self._default(session))

    async def update(
        self,
        ctx: RequestContext,
        policy_id: str,
        changes: Mapping[str, Any],
        *,
        etag: str | None,
    ) -> IngestionPolicyRecord:
        """Apply ``changes`` (UPDATABLE_FIELDS path → value; ``None`` clears)."""
        await self._require(ctx, "ingestionPolicies.update", policy_id)
        async with transaction_scope(self._sessions) as session:
            policy = await self._default(session, for_update=True)
            etags.check(etag, _record(policy).etag)
            for path, value in changes.items():
                _apply(policy, path, value)
            policy.updated_by_user_id = ctx.user_id
            policy.updated_at = func.clock_timestamp()
            await session.flush()
            await session.refresh(policy)
            await Audit(session).record(
                ctx,
                workspace_id=None,
                category="sources",
                action="UpdateIngestionPolicy",
                target=ingestion_policy_name(policy.code),
                details={"fields": sorted(changes)},
            )
            return _record(policy)

    async def _require(self, ctx: RequestContext, permission: str, policy_id: str) -> None:
        name = ingestion_policy_name(policy_id)
        await ctx.authorizer.require(ctx.principal, permission, PlatformRef(name))
        if policy_id != DEFAULT_POLICY:
            raise NotFound(f"Ingestion policy '{name}' does not exist.")

    async def _default(self, session: AsyncSession, *, for_update: bool = False) -> IngestionPolicy:
        defaults = self._defaults
        await session.execute(
            insert(IngestionPolicy)
            .values(
                code=DEFAULT_POLICY,
                allowed_mime_types=list(defaults.allowed_mime_types),
                max_file_size_bytes=defaults.max_file_size_bytes,
                ocr_scanned_pdfs=defaults.ocr_scanned_pdfs,
                parse_spreadsheets=defaults.parse_spreadsheets,
                rejected_retention_duration=timedelta(
                    seconds=defaults.rejected_retention_seconds
                ),
            )
            .on_conflict_do_nothing(index_elements=[IngestionPolicy.code])
        )
        statement = select(IngestionPolicy).where(IngestionPolicy.code == DEFAULT_POLICY)
        if for_update:
            statement = statement.with_for_update()
        policy = await session.scalar(statement.execution_options(populate_existing=True))
        assert policy is not None
        return policy


def _apply(policy: IngestionPolicy, path: str, value: Any) -> None:
    match path:
        case "allowedMimeTypes":
            policy.allowed_mime_types = list(value or [])
        case "maxFileSizeBytes":
            if value is None or value <= 0:
                raise InvalidArgument.for_field(path, "maxFileSizeBytes must be greater than zero.")
            policy.max_file_size_bytes = value
        case "ocrScannedPdfs":
            policy.ocr_scanned_pdfs = bool(value)
        case "parseSpreadsheets":
            policy.parse_spreadsheets = bool(value)
        case "rejectedRetentionDuration":
            if value is None:
                raise InvalidArgument.for_field(path, "rejectedRetentionDuration must be set.")
            policy.rejected_retention_duration = value


def _record(policy: IngestionPolicy) -> IngestionPolicyRecord:
    return IngestionPolicyRecord(
        policy=policy,
        etag=etags.compute(ingestion_policy_name(policy.code), policy.updated_at),
    )


__all__ = ["UPDATABLE_FIELDS", "IngestionPolicyRecord", "IngestionPolicyService"]
