"""Connections, sources, syncs, ingestion runs and deployment ingestion settings."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Index,
    Integer,
    Interval,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bomesh.db.models.base import (
    Base,
    JsonObject,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    choice,
    flag,
    json_array,
    json_object,
    one_of,
    text_array,
    timestamp,
    updated_now,
    uuid_fk,
)
from bomesh.db.models.knowledge import Item

CONNECTION_STATUSES = ("authorizing", "active", "reauthorization_required", "failed")
CREDENTIAL_TYPES = ("oauth_grant", "api_token")
PUBLISHING_POLICIES = ("auto_publish", "review_first")
SYNC_TRIGGERS = ("manual", "scheduled", "creation")
SYNC_STATUSES = ("running", "succeeded", "failed")
RUN_TRIGGERS = ("manual", "api", "schedule", "platform_retry")
RUN_STATUSES = ("queued", "running", "succeeded", "failed", "cancelled")
RUN_ITEM_STATUSES = ("queued", "running", "succeeded", "failed", "cancelled")


class IntegrationConnection(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One authorized external account, reusable by many Ingestion Sources.

    Authorizing the same provider account twice must not create a second
    Connection, so the provider account and resource identifiers are unique
    per tenant, connector and owner while the connection is live.
    """

    __tablename__ = "integration_connections"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        Index(None, "tenant_id", "connector_key", "status"),
        Index(None, "owner_user_id", "status"),
        UniqueConstraint("tenant_id", "display_name"),
        Index(
            "uq_integration_connections_provider_account",
            "tenant_id",
            "connector_key",
            "owner_user_id",
            "provider_account_id",
            "provider_resource_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
            postgresql_where=text("deleted_at IS NULL AND provider_account_id IS NOT NULL"),
        ),
        CheckConstraint(
            one_of("status", CONNECTION_STATUSES), name="connection_status_is_valid"
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    connector_key: Mapped[str] = mapped_column(String(64), nullable=False)
    #: Set for a personal connection; null for a workspace-owned one.
    owner_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    provider_account_id: Mapped[str | None] = mapped_column(String(255))
    provider_account_label: Mapped[str | None] = mapped_column(String(255))
    provider_resource_id: Mapped[str | None] = mapped_column(String(255))
    provider_resource_label: Mapped[str | None] = mapped_column(String(255))
    #: Scopes the provider actually granted, not the ones that were requested.
    scopes: Mapped[list[str]] = text_array()
    config: Mapped[JsonObject] = json_object()
    status: Mapped[str] = choice("authorizing", 32)
    #: Why the connection is not healthy, in words a person may be shown.
    status_detail: Mapped[str | None] = mapped_column(Text)
    #: Mirrors the credential expiry so listing does not decrypt secrets.
    expires_at: Mapped[datetime | None] = timestamp()
    connected_at: Mapped[datetime | None] = timestamp()
    last_checked_at: Mapped[datetime | None] = timestamp()
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    deleted_at: Mapped[datetime | None] = timestamp()

    credential: Mapped[IntegrationCredential | None] = relationship(
        back_populates="integration_connection", uselist=False
    )
    ingestion_sources: Mapped[list[IngestionSource]] = relationship(
        back_populates="integration_connection"
    )


class IntegrationCredential(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "integration_credentials"
    __table_args__ = (
        CheckConstraint(
            one_of("credential_type", CREDENTIAL_TYPES), name="credential_type_is_valid"
        ),
    )

    integration_connection_id: Mapped[UUID] = uuid_fk(
        "integration_connections.id", nullable=False, unique=True
    )
    credential_type: Mapped[str] = mapped_column(String(64), nullable=False)
    encrypted_payload: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime | None] = timestamp()
    key_version: Mapped[str | None] = mapped_column(String(64))

    integration_connection: Mapped[IntegrationConnection] = relationship(
        back_populates="credential"
    )


class IngestionSource(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One external resource synchronized into one destination Collection.

    ``Source.state`` is computed from ``paused_at``, the connection status and
    the latest ``ingestion_syncs`` row; nothing here duplicates it.
    """

    __tablename__ = "ingestion_sources"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        Index(None, "integration_connection_id", "deleted_at"),
        Index(None, "target_item_id", "deleted_at"),
        Index(
            "ix_ingestion_sources_due",
            "next_sync_at",
            postgresql_where=text(
                "next_sync_at IS NOT NULL AND paused_at IS NULL AND deleted_at IS NULL"
            ),
        ),
        Index(
            "uq_ingestion_sources_connection_resource",
            "integration_connection_id",
            "resource_type",
            "external_resource_id",
            unique=True,
            postgresql_where=text("deleted_at IS NULL AND external_resource_id IS NOT NULL"),
        ),
        CheckConstraint(
            one_of("publishing_policy", PUBLISHING_POLICIES),
            name="ingestion_source_publishing_policy_is_valid",
        ),
        CheckConstraint(
            "(schedule_cron IS NULL) = (schedule_time_zone IS NULL)",
            name="ingestion_source_schedule_is_complete",
        ),
        CheckConstraint(
            "schedule_cron IS NOT NULL OR next_sync_at IS NULL",
            name="unscheduled_source_has_no_next_sync",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    integration_connection_id: Mapped[UUID] = uuid_fk(
        "integration_connections.id", nullable=False
    )
    target_item_id: Mapped[UUID] = uuid_fk("items.id", nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(255))
    #: The provider resource kind this source reads: space, shared_drive, folder.
    resource_type: Mapped[str | None] = mapped_column(String(64))
    #: The provider identifier of that resource; unique per live connection.
    external_resource_id: Mapped[str | None] = mapped_column(Text)
    external_resource_label: Mapped[str | None] = mapped_column(String(255))
    config: Mapped[JsonObject] = json_object()
    #: Connector-owned incremental cursor; ``None`` makes the next sync list everything.
    sync_checkpoint: Mapped[JsonObject | None] = mapped_column(JSONB(none_as_null=True))
    schedule_cron: Mapped[str | None] = mapped_column(String(128))
    schedule_time_zone: Mapped[str | None] = mapped_column(String(64))
    next_sync_at: Mapped[datetime | None] = timestamp()
    publishing_policy: Mapped[str] = choice("auto_publish")
    paused_at: Mapped[datetime | None] = timestamp()
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    deleted_at: Mapped[datetime | None] = timestamp()

    integration_connection: Mapped[IntegrationConnection] = relationship(
        back_populates="ingestion_sources"
    )
    target_item: Mapped[Item] = relationship()


class IngestionSync(UUIDPrimaryKeyMixin, Base):
    """One sync execution of one source; it never processes Items."""

    __tablename__ = "ingestion_syncs"
    __table_args__ = (
        Index(None, "ingestion_source_id", "started_at"),
        Index(
            "uq_ingestion_syncs_running_source",
            "ingestion_source_id",
            unique=True,
            postgresql_where=text("status = 'running'"),
        ),
        CheckConstraint(
            one_of("trigger_type", SYNC_TRIGGERS), name="ingestion_sync_trigger_is_valid"
        ),
        CheckConstraint(one_of("status", SYNC_STATUSES), name="ingestion_sync_status_is_valid"),
        CheckConstraint(
            "added_count >= 0 AND updated_count >= 0 AND removed_count >= 0 "
            "AND failed_count >= 0",
            name="ingestion_sync_counts_are_valid",
        ),
        CheckConstraint(
            "jsonb_typeof(failures) = 'array' AND jsonb_array_length(failures) <= 100",
            name="ingestion_sync_failures_are_bounded",
        ),
        CheckConstraint(
            "(status = 'running') = (finished_at IS NULL)",
            name="ingestion_sync_finish_is_complete",
        ),
    )

    ingestion_source_id: Mapped[UUID] = uuid_fk("ingestion_sources.id", nullable=False)
    trigger_type: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = choice("running")
    added_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    updated_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    removed_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    failed_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    failures: Mapped[list[Any]] = json_array()
    error: Mapped[JsonObject | None] = mapped_column(JSONB(none_as_null=True))
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    started_at: Mapped[datetime] = timestamp(nullable=False)
    finished_at: Mapped[datetime | None] = timestamp()


class ExternalResource(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Stable provider identity of one synced Item."""

    __tablename__ = "external_resources"
    __table_args__ = (
        UniqueConstraint("ingestion_source_id", "external_id"),
        Index(None, "item_id"),
        Index(None, "ingestion_source_id", "last_seen_at"),
    )

    item_id: Mapped[UUID] = uuid_fk("items.id", nullable=False)
    ingestion_source_id: Mapped[UUID] = uuid_fk("ingestion_sources.id", nullable=False)
    external_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_version: Mapped[str | None] = mapped_column(Text)
    etag: Mapped[str | None] = mapped_column(Text)
    external_updated_at: Mapped[datetime | None] = timestamp()
    source_url: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[JsonObject] = json_object("metadata")
    last_seen_at: Mapped[datetime | None] = timestamp()
    deleted_at: Mapped[datetime | None] = timestamp()

    item: Mapped[Item] = relationship()


class IngestionRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One explicit processing execution over a snapshot of Documents.

    The only way a Document is parsed, embedded and indexed. Its Documents are
    fixed at creation (``ingestion_run_items``); later uploads never join it.
    """

    __tablename__ = "ingestion_runs"
    __table_args__ = (
        Index(None, "tenant_id", "created_at"),
        Index(None, "tenant_id", "status"),
        Index(None, "retry_of_run_id"),
        CheckConstraint(
            one_of("trigger_type", RUN_TRIGGERS), name="ingestion_run_trigger_is_valid"
        ),
        CheckConstraint(one_of("status", RUN_STATUSES), name="ingestion_run_status_is_valid"),
        CheckConstraint("item_count >= 0", name="ingestion_run_item_count_is_valid"),
        CheckConstraint(
            "retry_of_run_id IS NULL OR retry_of_run_id <> id",
            name="ingestion_run_cannot_retry_itself",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    trigger_type: Mapped[str] = mapped_column(String(16), nullable=False)
    #: The selector as it was asked for; the Documents are the run items.
    scope: Mapped[JsonObject] = json_object()
    status: Mapped[str] = choice("queued")
    #: Processing configuration and batching limits fixed at creation.
    configuration: Mapped[JsonObject] = json_object()
    item_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    retry_of_run_id: Mapped[UUID | None] = uuid_fk("ingestion_runs.id")
    #: User-safe google.rpc.Status when the run as a whole stopped.
    error: Mapped[JsonObject | None] = mapped_column(JSONB(none_as_null=True))
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    started_at: Mapped[datetime | None] = timestamp()
    finished_at: Mapped[datetime | None] = timestamp()

    items: Mapped[list[IngestionRunItem]] = relationship(back_populates="run")


class IngestionRunItem(TimestampMixin, Base):
    """One Document's participation in one Ingestion Run (the API task)."""

    __tablename__ = "ingestion_run_items"
    __table_args__ = (
        Index(None, "item_id", "created_at"),
        Index(None, "run_id", "status"),
        Index(None, "run_id", "batch_number"),
        CheckConstraint(
            one_of("status", RUN_ITEM_STATUSES), name="ingestion_run_item_status_is_valid"
        ),
        CheckConstraint(
            "chunk_count IS NULL OR chunk_count >= 0",
            name="ingestion_run_item_chunk_count_is_valid",
        ),
        CheckConstraint("jsonb_typeof(phases) = 'array'", name="phases_is_array"),
    )

    run_id: Mapped[UUID] = uuid_fk("ingestion_runs.id", primary_key=True)
    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    status: Mapped[str] = choice("queued")
    #: The planner's batch for this Document; null until planned.
    batch_number: Mapped[int | None] = mapped_column(Integer)
    #: ``[{phase, state, started_at, finished_at, done, total}]``.
    phases: Mapped[list[Any]] = json_array()
    #: User-safe google.rpc.Status why this Document was not processed.
    error: Mapped[JsonObject | None] = mapped_column(JSONB(none_as_null=True))
    #: Provider-neutral failure category; never a raw message.
    error_class: Mapped[str | None] = mapped_column(String(64))
    revision_number: Mapped[int | None] = mapped_column(Integer)
    chunk_count: Mapped[int | None] = mapped_column(Integer)
    started_at: Mapped[datetime | None] = timestamp()
    finished_at: Mapped[datetime | None] = timestamp()

    run: Mapped[IngestionRun] = relationship(back_populates="items")


class IngestionPolicy(Base):
    """The deployment ingestion policy; only ``default`` exists."""

    __tablename__ = "ingestion_policies"
    __table_args__ = (
        CheckConstraint("code = 'default'", name="only_default_policy_exists"),
        CheckConstraint(
            "max_file_size_bytes > 0", name="ingestion_policy_max_size_is_valid"
        ),
    )

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    allowed_mime_types: Mapped[list[str]] = text_array()
    max_file_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    ocr_scanned_pdfs: Mapped[bool] = flag(True)
    parse_spreadsheets: Mapped[bool] = flag(True)
    rejected_retention_duration: Mapped[timedelta] = mapped_column(
        Interval, nullable=False
    )
    updated_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    updated_at: Mapped[datetime] = updated_now()


class PlatformConnectorSettings(Base):
    """Deployment-wide connector settings; secrets encrypted and write-only."""

    __tablename__ = "platform_connector_settings"

    connector_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    available: Mapped[bool] = flag(True)
    oauth_client_id: Mapped[str | None] = mapped_column(String(512))
    oauth_client_secret_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    updated_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    updated_at: Mapped[datetime] = updated_now()
