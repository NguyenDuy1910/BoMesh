from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import configure_mappers
from sqlalchemy.schema import CreateTable

from bomesh.db.engine import get_engine, get_session_factory
from bomesh.db.models import Base
from bomesh.errors import Unauthenticated
from bomesh.services.identity.jwt_tokens import JwtTokenService
from bomesh.services.identity.passwords import PasswordCredentialService


EXPECTED_TABLES = {
    "access_sessions",
    "artifact_source_items",
    "artifacts",
    "audit_logs",
    "auth_identities",
    "citations",
    "contribution_topics",
    "contributions",
    "conversation_share_recipients",
    "conversation_shares",
    "conversations",
    "evidence_review_cells",
    "external_resources",
    "group_memberships",
    "groups",
    "ingestion_policies",
    "ingestion_run_items",
    "ingestion_runs",
    "ingestion_sources",
    "ingestion_syncs",
    "integration_connections",
    "integration_credentials",
    "item_links",
    "item_revisions",
    "item_topics",
    "item_uploads",
    "items",
    "knowledge_gap_decisions",
    "memories",
    "message_items",
    "messages",
    "notifications",
    "operations",
    "password_reset_tokens",
    "permissions",
    "platform_connector_settings",
    "platform_health_checks",
    "reading_list_entries",
    "reading_lists",
    "recent_items",
    "request_idempotency",
    "request_messages",
    "request_types",
    "requests",
    "role_assignments",
    "role_permissions",
    "roles",
    "sandbox_sessions",
    "saved_items",
    "saved_searches",
    "space_announcements",
    "space_events",
    "space_materials",
    "spaces",
    "tenant_memberships",
    "tenants",
    "topics",
    "users",
    "workspace_assistant_settings",
}


def test_all_dbml_tables_compile_for_postgresql() -> None:
    configure_mappers()

    assert set(Base.metadata.tables) == EXPECTED_TABLES
    for table in Base.metadata.sorted_tables:
        ddl = str(CreateTable(table).compile(dialect=postgresql.dialect()))
        assert f"CREATE TABLE {table.name}" in ddl


def test_user_status_is_a_required_state() -> None:
    users = Base.metadata.tables["users"]
    column = users.c.status

    assert column.type.python_type is str
    assert column.nullable is False
    assert column.server_default is not None
    assert "ck_users_user_status_is_valid" in {
        constraint.name for constraint in users.constraints
    }


def test_username_uniqueness_matches_normalized_local_login_rule() -> None:
    users = Base.metadata.tables["users"]
    username_index = next(
        index for index in users.indexes if index.name == "uq_users_username"
    )

    assert username_index.unique is True
    assert str(username_index.expressions[0]) == "lower(users.username)"


def test_local_passwords_are_scrypt_hashes_and_never_compare_as_plaintext() -> None:
    encoded = PasswordCredentialService.hash("correct horse battery staple")

    assert encoded.startswith("scrypt$")
    assert PasswordCredentialService.verify("correct horse battery staple", encoded)
    assert not PasswordCredentialService.verify("wrong password", encoded)


def test_users_carry_no_administration_flag() -> None:
    """Identity is not authorization: no admin boolean may return to users."""

    forbidden = {"is_root_admin", "is_admin", "is_superuser", "role_id"}

    assert forbidden.isdisjoint(Base.metadata.tables["users"].c.keys())
    assert "role_id" not in Base.metadata.tables["tenant_memberships"].c.keys()
    assert "permission_codes" not in Base.metadata.tables["roles"].c.keys()


def test_workspaces_are_reached_only_through_membership() -> None:
    tenants = Base.metadata.tables["tenants"].c

    assert {"visibility", "public_access_role_id"}.isdisjoint(tenants.keys())


def test_access_tokens_name_a_session_and_its_user_only() -> None:
    secret = "t" * 32
    tokens = JwtTokenService(
        secret=secret,
        issuer="bomesh",
        audience="bomesh-api",
        expires_in_seconds=900,
    )
    session_id, user_id = uuid4(), uuid4()
    token = tokens.issue(
        session_id=session_id,
        user_id=user_id,
        token_version=1,
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )
    claims = tokens.verify(token)
    assert (claims.session_id, claims.user_id, claims.token_version) == (session_id, user_id, 1)

    header, payload, _ = token.split(".")
    decoded = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert not {"tenant_id", "workspace", "permissions", "platform_permissions", "email"} & set(
        decoded
    )
    decoded["user_id"] = None
    anonymous = base64.urlsafe_b64encode(
        json.dumps(decoded, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    signature = hmac.new(
        secret.encode(), f"{header}.{anonymous}".encode(), hashlib.sha256
    ).digest()
    forged = f"{header}.{anonymous}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"

    with pytest.raises(Unauthenticated, match="user_id"):
        tokens.verify(forged)


def test_engine_normalizes_standard_postgres_url_and_is_cached() -> None:
    database_url = "postgresql://user:password@localhost/bomesh"

    first = get_engine(database_url, echo=False)
    second = get_engine(database_url, echo=False)

    assert first is second
    assert first.url.drivername == "postgresql+asyncpg"
    assert get_session_factory(first).kw["bind"] is first


def test_engine_rejects_non_postgres_urls() -> None:
    with pytest.raises(ValueError, match="must use PostgreSQL"):
        get_engine("sqlite:///bomesh.db")
