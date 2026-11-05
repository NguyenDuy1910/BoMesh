from __future__ import annotations

import os
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from bomesh.db.models import Base

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


@pytest.mark.asyncio
async def test_final_source_storage_schema_contract() -> None:
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is not configured")

    schema = f"test_document_schema_{uuid4().hex}"
    admin_engine = create_async_engine(TEST_DATABASE_URL)
    async with admin_engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"server_settings": {"search_path": schema}},
    )
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with engine.connect() as connection:
            table_names = set(
                await connection.scalars(
                    text(
                        """
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_schema = current_schema()
                        """
                    )
                )
            )
            column_rows = await connection.execute(
                text(
                    """
                    SELECT table_name, column_name, data_type
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                    """
                )
            )
            columns_by_table: dict[str, set[str]] = {}
            column_types: dict[tuple[str, str], str] = {}
            for table_name, column_name, data_type in column_rows:
                columns_by_table.setdefault(table_name, set()).add(column_name)
                column_types[(table_name, column_name)] = data_type
            constraints = set(
                await connection.scalars(
                    text(
                        """
                        SELECT conname
                        FROM pg_constraint
                        WHERE conrelid = 'items'::regclass
                        """
                    )
                )
            )
            access_session_constraints = set(
                await connection.scalars(
                    text(
                        """
                        SELECT conname
                        FROM pg_constraint
                        WHERE conrelid = 'access_sessions'::regclass
                        """
                    )
                )
            )
    finally:
        await engine.dispose()
        async with admin_engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin_engine.dispose()

    assert {
        "items",
        "item_revisions",
        "auth_identities",
        "access_sessions",
        "conversations",
        "citations",
        "item_uploads",
        "message_items",
        "integration_connections",
        "integration_credentials",
        "ingestion_sources",
        "ingestion_syncs",
        "external_resources",
        "ingestion_runs",
        "ingestion_run_items",
    }.issubset(table_names)
    assert {"visibility", "public_access_role_id"}.isdisjoint(
        columns_by_table["tenants"]
    )
    assert {"issuer", "subject", "user_id", "status"}.issubset(
        columns_by_table["auth_identities"]
    )
    assert {
        "user_id",
        "auth_identity_id",
        "status",
        "token_version",
        "parent_session_id",
        "expires_at",
    }.issubset(columns_by_table["access_sessions"])
    assert {"tenant_id", "kind", "transition_reason"}.isdisjoint(
        columns_by_table["access_sessions"]
    )
    assert {"code", "owner_user_id", "created_by_session_id"}.issubset(
        columns_by_table["conversations"]
    )
    assert {"user_id", "status"}.isdisjoint(columns_by_table["conversations"])
    assert "actor_session_id" in columns_by_table["audit_logs"]
    assert {
        "documents",
        "document_blobs",
        "document_chunks",
        "message_documents",
        "artifact_revisions",
        "approval_requests",
    }.isdisjoint(table_names)
    assert {
        "item_type",
        "document_type",
        "parent_item_id",
        "parent_relation",
        "storage_key",
        "status",
        "publication_state",
        "index_status",
        "processed_version",
        "indexed_revision_number",
        "deleted_at",
    }.issubset(columns_by_table["items"])
    assert "idempotency_key" not in columns_by_table["item_uploads"]
    assert {
        "item_id",
        "chunk_id",
        "section_path",
        "anchor",
        "page_start",
        "page_end",
        "spans",
        "deleted_at",
    }.issubset(columns_by_table["citations"])
    assert {
        "code",
        "connector_key",
        "config",
        "status",
    }.issubset(columns_by_table["integration_connections"])
    assert {"owner_type", "disconnected_at"}.isdisjoint(
        columns_by_table["integration_connections"]
    )
    assert "encrypted_payload" in columns_by_table["integration_credentials"]
    assert column_types[("integration_credentials", "encrypted_payload")] == "text"
    assert {
        "tenant_id",
        "code",
        "integration_connection_id",
        "target_item_id",
        "paused_at",
    }.issubset(columns_by_table["ingestion_sources"])
    assert {
        "status",
        "sync_mode",
        "checkpoint",
        "last_synced_at",
        "last_sync_status",
        "last_sync_error",
        "last_sync_summary",
        "last_ingested_at",
        "last_indexed_at",
    }.isdisjoint(columns_by_table["ingestion_sources"])
    assert {
        "run_id",
        "item_id",
        "status",
        "batch_number",
        "phases",
        "error",
    }.issubset(columns_by_table["ingestion_run_items"])
    assert {
        "tenant_id",
        "trigger_type",
        "scope",
        "status",
        "configuration",
        "item_count",
    }.issubset(columns_by_table["ingestion_runs"])
    assert column_types[("ingestion_runs", "error")] == "jsonb"
    assert column_types[("ingestion_run_items", "error")] == "jsonb"
    assert {
        "ingestion_source_id",
        "item_id",
        "external_id",
        "external_version",
        "etag",
    }.issubset(columns_by_table["external_resources"])
    assert {
        "ck_items_item_type_is_valid",
        "ck_items_item_document_type_matches_type",
        "ck_items_item_status_is_valid",
        "ck_items_item_publication_matches_type",
        "ck_items_root_is_access_boundary",
    }.issubset(constraints)
    assert "ck_access_sessions_access_session_end_is_complete" in access_session_constraints

    # Original bytes live in object storage; only digests and sealed secrets
    # are stored as binary.
    assert {
        (table_name, column_name)
        for (table_name, column_name), data_type in column_types.items()
        if data_type == "bytea"
    } == {
        ("platform_connector_settings", "oauth_client_secret_encrypted"),
        ("request_idempotency", "request_hash"),
    }
