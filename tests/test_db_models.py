from __future__ import annotations

import base64
import hashlib
import hmac
import json
from uuid import uuid4

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import configure_mappers
from sqlalchemy.schema import CreateTable

from bothesis.db.engine import get_engine, get_session_factory
from bothesis.db.models import Base
from bothesis.services import AuthContext, AuthenticationError
from bothesis.services.identity_access.jwt_tokens import JwtTokenService
from bothesis.services.identity_access.passwords import PasswordCredentialService


EXPECTED_TABLES = {
    "access_sessions",
    "approval_requests",
    "artifact_revisions",
    "audit_logs",
    "auth_identities",
    "conversations",
    "citations",
    "group_memberships",
    "groups",
    "item_uploads",
    "external_resources",
    "items",
    "memories",
    "message_items",
    "permissions",
    "messages",
    "ingestion_sources",
    "integration_connections",
    "integration_credentials",
    "role_assignments",
    "role_permissions",
    "roles",
    "sandbox_sessions",
    "tenant_memberships",
    "tenants",
    "users",
}


def test_all_dbml_tables_compile_for_postgresql() -> None:
    configure_mappers()

    assert set(Base.metadata.tables) == EXPECTED_TABLES
    for table in Base.metadata.sorted_tables:
        ddl = str(CreateTable(table).compile(dialect=postgresql.dialect()))
        assert f"CREATE TABLE {table.name}" in ddl


def test_user_status_is_a_required_boolean() -> None:
    columns = Base.metadata.tables["users"].c
    column = columns.status

    assert column.type.python_type is bool
    assert column.nullable is False


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


def test_access_tokens_are_always_bound_to_a_user() -> None:
    secret = "t" * 32
    tokens = JwtTokenService(
        secret=secret,
        issuer="bothesis",
        audience="bothesis-api",
        expires_in_seconds=900,
    )
    context = AuthContext(
        session_id=uuid4(),
        user_id=None,
        email=None,
        display_name=None,
        tenant_id=uuid4(),
        permission_codes=("knowledge.read",),
        group_ids=(),
    )

    with pytest.raises(AuthenticationError, match="signed-in user"):
        tokens.issue(context)

    user_token, _ = tokens.issue(
        AuthContext(
            session_id=context.session_id,
            user_id=uuid4(),
            email="person@example.com",
            display_name="Person",
            tenant_id=context.tenant_id,
            permission_codes=context.permission_codes,
            group_ids=(),
        )
    )
    header, payload, _ = user_token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    claims["user_id"] = None
    anonymous = base64.urlsafe_b64encode(
        json.dumps(claims, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    signature = hmac.new(
        secret.encode(), f"{header}.{anonymous}".encode(), hashlib.sha256
    ).digest()
    forged = f"{header}.{anonymous}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"

    with pytest.raises(AuthenticationError, match="user"):
        tokens.verify(forged)


def test_engine_normalizes_standard_postgres_url_and_is_cached() -> None:
    database_url = "postgresql://user:password@localhost/bothesis"

    first = get_engine(database_url, echo=False)
    second = get_engine(database_url, echo=False)

    assert first is second
    assert first.url.drivername == "postgresql+asyncpg"
    assert get_session_factory(first).kw["bind"] is first


def test_engine_rejects_non_postgres_urls() -> None:
    with pytest.raises(ValueError, match="must use PostgreSQL"):
        get_engine("sqlite:///bothesis.db")
