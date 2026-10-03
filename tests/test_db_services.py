from __future__ import annotations

import asyncio
import base64
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest
import pytest_asyncio
from bomesh.connector.protocol import BoundingBox, Chunk, CitationInfo, CitationSpan
from bomesh.db.models import (
    ArtifactRevision,
    AccessSession,
    AuditLog,
    Base,
    Citation,
    Conversation,
    ExternalResource,
    IngestionSource,
    IntegrationConnection,
    IntegrationCredential,
    Item,
    ItemUpload,
    Message,
    MessageItem,
    Role,
    RoleAssignment,
    SandboxSession,
    User,
)
from bomesh.agent.models import AgentContext
from bomesh.storage import (
    ObjectNotFoundError,
    ObjectStorageError,
    PresignedRequest,
    StoredObject,
)
from bomesh.services import (
    COLLECTION_EDITOR_ROLE,
    COLLECTION_OWNER_ROLE,
    COLLECTION_UPDATE_PERMISSION,
    COLLECTION_VIEWER_ROLE,
    PLATFORM_ADMIN_ROLE,
    ROLE_MANAGE_PERMISSION,
    TENANT_ADMIN_ROLE,
    TENANT_MEMBER_ROLE,
    USER_MANAGE_PERMISSION,
    ArtifactValidationError,
    AuthenticationError,
    ControlPlaneConflictError,
    ControlPlaneNotFoundError,
    ControlPlaneValidationError,
    IdentityInactiveError,
    AuthContext,
    AuthorizationError,
    DocumentNotFoundError,
    DocumentProcessingError,
    UploadConflictError,
    UploadTooLargeError,
    UploadValidationError,
    VerifiedGoogleIdentity,
    SandboxManifestResource,
    SandboxProviderFile,
)
from bomesh.services.approval_request import ApprovalRequestService
from bomesh.services.dashboard.activity import ActivityService
from bomesh.services.dashboard.dashboard import DashboardService
from bomesh.services.artifact import ArtifactService
from bomesh.services.identity_access.auth import AuthenticationService
from bomesh.services.identity_access.access_session import AccessSessionService
from bomesh.services.identity_access.identity_store import IdentityStoreService
from bomesh.services.identity_access.jwt_tokens import JwtTokenService
from bomesh.services.identity_access.passwords import PasswordCredentialService
from bomesh.services.citation import CitationService
from bomesh.services.identity_access.role_assignments import RoleAssignmentService
from bomesh.services.identity_access.roles import RoleService
from bomesh.services.identity_access.users import UserService
from bomesh.services.conversation import ConversationService
from bomesh.services.integration_connections import IntegrationConnectionService
from bomesh.services.integration_credential import IntegrationCredentialService
from bomesh.services.item import ItemService
from bomesh.services.item_catalog import ItemCatalogService
from bomesh.services.sandbox_session import SandboxSessionService
from bomesh.services.documents import DocumentService
from bomesh.services.document_presentation import DocumentPresenter
from bomesh.services.ingestion import IngestionService
from bomesh.services.workflow import WorkflowExecutionNotFoundError
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="TEST_DATABASE_URL is required for PostgreSQL service integration tests",
)


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    assert TEST_DATABASE_URL is not None
    schema = f"test_services_{uuid4().hex}"
    admin_engine = create_async_engine(TEST_DATABASE_URL)
    async with admin_engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))

    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"server_settings": {"search_path": schema}},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory.begin() as session:
        await IdentityStoreService(session).sync_system_roles()

    try:
        yield factory
    finally:
        await engine.dispose()
        async with admin_engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin_engine.dispose()


async def join_tenant(
    session: AsyncSession,
    user: User,
    tenant_id: UUID,
    *,
    permission_codes: tuple[str, ...] = (),
    role_code: str = "member",
    system_role: str | None = None,
) -> None:
    """Add a member and give them one role, the way the services do.

    Membership and role assignment are separate writes now, so tests that only
    need "this user can do X here" go through the same two steps the product
    does rather than a shortcut that would not prove anything.
    """

    identity = IdentityStoreService(session)
    await identity.assign_membership(user.id, tenant_id)
    if system_role is not None:
        role_id = await session.scalar(
            select(Role.id).where(Role.code == system_role, Role.is_system)
        )
    else:
        # Reuse the tenant's role when several members share one, which is the
        # normal shape: a role is a bundle, not a per-user record.
        role_id = await session.scalar(
            select(Role.id).where(Role.tenant_id == tenant_id, Role.code == role_code)
        )
        if role_id is None:
            role = await identity.create_role(
                tenant_id, role_code, role_code.replace("-", " ").title(),
                permission_codes=permission_codes,
            )
            role_id = role.id
    await RoleAssignmentService(session).replace_tenant_roles(
        user_id=user.id, tenant_id=tenant_id, role_ids=[role_id]
    )


@pytest.mark.asyncio
async def test_tenant_access_administration_cannot_escalate_or_lock_out_a_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Access managers cannot alter their own authority or remove the sole admin."""

    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        tenant = await identity.create_tenant("access-controls", "Access controls")
        administrator = await identity.create_user("administrator@example.com")
        operator = await identity.create_user("operator@example.com")
        member = await identity.create_user("member@example.com")
        await join_tenant(
            session, administrator, tenant.id, system_role=TENANT_ADMIN_ROLE
        )
        await join_tenant(
            session,
            operator,
            tenant.id,
            role_code="access-operator",
            permission_codes=(ROLE_MANAGE_PERMISSION, USER_MANAGE_PERMISSION),
        )
        await join_tenant(session, member, tenant.id)
        operator_context = await identity.get_context(operator.id, tenant_id=tenant.id)
        administrator_role_id = await session.scalar(
            select(Role.id).where(
                Role.code == TENANT_ADMIN_ROLE,
                Role.is_system,
            )
        )
        operator_role_id = await session.scalar(
            select(Role.id).where(
                Role.tenant_id == tenant.id,
                Role.code == "access-operator",
            )
        )
        assert administrator_role_id is not None
        assert operator_role_id is not None

        with pytest.raises(ControlPlaneValidationError, match="already held"):
            await RoleService(session).create_role(
                operator_context,
                code="elevated",
                display_name="Elevated",
                permission_codes=["tenant.manage"],
            )

        with pytest.raises(ControlPlaneConflictError, match="own workspace access"):
            await UserService(session).update_user(
                operator_context,
                operator.id,
                role_ids=[administrator_role_id],
            )

        with pytest.raises(ControlPlaneConflictError, match="role they hold"):
            await RoleService(session).update_role(
                operator_context,
                operator_role_id,
                permission_codes=[USER_MANAGE_PERMISSION],
            )

        with pytest.raises(ControlPlaneValidationError, match="beyond the acting"):
            await UserService(session).update_user(
                operator_context,
                member.id,
                role_ids=[administrator_role_id],
            )

        with pytest.raises(ControlPlaneConflictError, match="last active workspace administrator"):
            await UserService(session).update_user(
                operator_context,
                administrator.id,
                status=False,
            )


@pytest.mark.asyncio
async def test_adding_a_member_admits_an_existing_account_and_suspension_stays_local(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A workspace never creates an identity, and never switches one off."""

    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        workspace = await identity.create_tenant("adding", "Adding")
        elsewhere = await identity.create_tenant("elsewhere", "Elsewhere")
        administrator = await identity.create_user("admin@example.com")
        person = await identity.create_user("person@example.com", display_name="Person")
        await join_tenant(session, administrator, workspace.id, system_role=TENANT_ADMIN_ROLE)
        await join_tenant(session, person, elsewhere.id)
        context = await identity.get_context(administrator.id, tenant_id=workspace.id)
        member_role_id = await session.scalar(
            select(Role.id).where(Role.code == "tenant_member", Role.is_system)
        )
        assert member_role_id is not None
        users = UserService(session)

        assert await users.lookup_account(context, email="nobody@example.com") == {"items": [], "total": 0}
        with pytest.raises(ControlPlaneNotFoundError, match="sign up first"):
            await users.add_member(context, email="nobody@example.com", role_ids=[member_role_id])

        found = await users.lookup_account(context, email="PERSON@example.com")
        assert found["items"][0]["workspace_membership"] == "none"
        added = await users.add_member(
            context, email="Person@Example.com", role_ids=[member_role_id]
        )
        assert added["id"] == str(person.id)
        assert added["membership"]["roles"][0]["code"] == "tenant_member"
        # Adding reused the account; no identity was created.
        assert await session.scalar(select(func.count()).select_from(User)) == 2
        with pytest.raises(ControlPlaneConflictError, match="already a member"):
            await users.add_member(context, email="person@example.com", role_ids=[member_role_id])

        suspended = await users.update_user(context, person.id, status=False)
        assert suspended["status"] == "suspended"
        found = await users.lookup_account(context, email="person@example.com")
        assert found["items"][0]["workspace_membership"] == "suspended"
        assert found["items"][0]["status"] == "active"
        # The account still signs in and keeps its other workspace.
        assert (await identity.get_context(person.id, tenant_id=elsewhere.id)).tenant_id == elsewhere.id
        with pytest.raises(IdentityInactiveError):
            await identity.get_context(person.id, tenant_id=workspace.id)


async def grant_collection_role(
    session: AsyncSession, item_id: UUID, *, user: User, role_code: str
) -> None:
    """Give a user one Collection role directly, without the console's policy."""

    await RoleAssignmentService(session).grant_collection_role(
        item_id,
        principal_type="user",
        principal_id=user.id,
        role_code=role_code,
        created_by_user_id=user.id,
    )


@pytest.mark.asyncio
async def test_identity_supports_multiple_tenant_memberships(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        first_tenant = await auth.create_tenant("acme", "Acme")
        second_tenant = await auth.create_tenant("labs", "Labs")
        user = await auth.create_user("USER@EXAMPLE.COM")
        await join_tenant(
            session, user, first_tenant.id,
            role_code="reader", permission_codes=("knowledge.read",),
        )
        await join_tenant(
            session, user, second_tenant.id,
            role_code="manager", permission_codes=("knowledge.read", "source.manage"),
        )

        with pytest.raises(AuthorizationError, match="tenant ID is required"):
            await auth.get_context(user.id)

        first_context = await auth.get_context(user.id, tenant_id=first_tenant.id)
        second_context = await auth.get_context(user.id, tenant_id=second_tenant.id)

        assert user.email == "user@example.com"
        assert first_context.permission_codes == ("knowledge.read",)
        assert second_context.permission_codes == ("knowledge.read", "source.manage")
        assert first_context.role_codes == ("reader",)


@pytest.mark.asyncio
async def test_switch_session_replaces_session_and_resolves_new_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        home = await identity.create_tenant("switch-home", "Switch home")
        destination = await identity.create_tenant("switch-destination", "Switch destination")
        user = await identity.create_user("switch@example.com")
        await join_tenant(session, user, home.id, role_code="reader", permission_codes=("knowledge.read",))
        await join_tenant(session, user, destination.id, role_code="manager", permission_codes=("knowledge.read", "source.manage"))
        authentication = AuthenticationService(
            session,
            tokens=JwtTokenService(
                secret="s" * 32,
                issuer="bomesh",
                audience="bomesh-api",
                expires_in_seconds=900,
            ),
        )
        initial = await authentication.complete_verified_external_session(
            VerifiedGoogleIdentity(
                issuer="https://accounts.google.com",
                subject="switch-subject",
                email="switch@example.com",
                display_name="Switch User",
            )
        )

        switched = await authentication.update_session(
            current_session_id=initial.session_id,
            active_workspace_id=destination.id,
        )
        previous = await session.get(AccessSession, initial.session_id)

        assert switched.session_id != initial.session_id
        assert switched.active_tenant_id == destination.id
        assert switched.permissions == ("knowledge.read", "source.manage")
        assert previous is not None
        assert previous.status == "superseded"
        with pytest.raises(AuthenticationError, match="access session is unavailable"):
            await authentication.current_session(initial.session_id)


@pytest.mark.asyncio
async def test_platform_admin_holds_platform_permissions_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Administering the platform must not admit anyone to a workspace.

    This is the bypass the model used to have: a root-admin flag resolved to
    every permission inside any tenant, membership or not.
    """

    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        home = await auth.create_tenant("home", "Home")
        other = await auth.create_tenant("other", "Other Workspace")
        operator = await auth.create_user("operator@example.com")
        await join_tenant(
            session, operator, home.id, role_code="reader",
            permission_codes=("knowledge.read",),
        )
        await RoleAssignmentService(session).ensure_platform_role(
            operator.id, PLATFORM_ADMIN_ROLE
        )

        context = await auth.get_context(operator.id, tenant_id=home.id)
        assert context.platform_permissions == (
            "platform.audit.read",
            "platform.health.read",
            "platform.tenant.read",
            "platform.user.read",
        )
        # Platform capability never leaks into the workspace.
        assert context.permission_codes == ("knowledge.read",)
        assert not context.has_permissions("user.manage")

        with pytest.raises(AuthorizationError, match="not a member"):
            await auth.get_context(operator.id, tenant_id=other.id)


@pytest.mark.asyncio
async def test_platform_role_grant_is_idempotent_and_audited(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        authentication = AuthenticationService(
            session,
            tokens=JwtTokenService(
                secret="a" * 32,
                issuer="bomesh",
                audience="bomesh-api",
                expires_in_seconds=900,
            ),
            platform_admin_emails=frozenset({"root@example.com"}),
        )

        first = await authentication.complete_verified_external_session(
            VerifiedGoogleIdentity(
                issuer="https://accounts.google.com",
                subject="root-google-subject",
                email="ROOT@EXAMPLE.COM",
                display_name="Root User",
            )
        )
        second = await authentication.complete_verified_external_session(
            VerifiedGoogleIdentity(
                issuer="https://accounts.google.com",
                subject="root-google-subject",
                email="root@example.com",
                display_name="Root User",
            )
        )
        user = await IdentityStoreService(session).get_user_by_email("root@example.com")

        assert first.platform_permissions == (
            "platform.audit.read",
            "platform.health.read",
            "platform.tenant.read",
            "platform.user.read",
        )
        assert second.platform_permissions == first.platform_permissions
        # The personal workspace owner is a tenant_admin assignment, not a wildcard.
        assert "user.manage" in first.permissions
        assert "*:*" not in first.permissions

        grants = list(
            await session.scalars(
                select(RoleAssignment).where(
                    RoleAssignment.user_id == user.id,
                    RoleAssignment.tenant_id.is_(None),
                    RoleAssignment.item_id.is_(None),
                    RoleAssignment.deleted_at.is_(None),
                )
            )
        )
        assert len(grants) == 1

        events = list(
            await session.scalars(
                select(AuditLog).where(
                    AuditLog.action == "role_assignment.platform_admin.granted"
                )
            )
        )
        assert len(events) == 1
        assert events[0].tenant_id is None


@pytest.mark.asyncio
async def test_password_session_accepts_username_login(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        tenant = await identity.create_tenant("username-login", "Username Login")
        user = await identity.create_user(
            "analyst@example.com",
            username="analyst",
            password_hash=PasswordCredentialService.hash("correct horse battery staple"),
        )
        await join_tenant(session, user, tenant.id)
        authentication = AuthenticationService(
            session,
            tokens=JwtTokenService(
                secret="u" * 32,
                issuer="bomesh",
                audience="bomesh-api",
                expires_in_seconds=900,
            ),
        )

        authenticated = await authentication.create_session(
            method="password",
            username="ANALYST",
            password="correct horse battery staple",
        )

        assert authenticated.user_id == user.id
        assert authenticated.email == "analyst@example.com"


@pytest.mark.asyncio
async def test_workspace_switch_requires_an_active_membership(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        home = await identity.create_tenant("home", "Home")
        other = await identity.create_tenant("other", "Other")
        user = await identity.create_user(
            "member@example.com",
            password_hash=PasswordCredentialService.hash("correct horse battery staple"),
        )
        await join_tenant(session, user, home.id)
        authentication = AuthenticationService(
            session,
            tokens=JwtTokenService(
                secret="m" * 32,
                issuer="bomesh",
                audience="bomesh-api",
                expires_in_seconds=900,
            ),
        )
        signed_in = await authentication.create_session(
            method="password",
            email="member@example.com",
            password="correct horse battery staple",
        )

        assert [workspace.tenant_id for workspace in signed_in.tenants] == [home.id]
        with pytest.raises(AuthorizationError, match="not a member"):
            await authentication.update_session(
                current_session_id=signed_in.session_id,
                active_workspace_id=other.id,
            )


@pytest.mark.asyncio
async def test_platform_reporting_is_gated_and_reads_roles_not_memberships(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Platform reads need a platform grant, and find the workspace admin."""

    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("acme", "Acme")
        admin = await auth.create_user("workspace-admin@example.com")
        operator = await auth.create_user("operator@example.com")
        await join_tenant(session, admin, tenant.id, system_role=TENANT_ADMIN_ROLE)
        await join_tenant(session, operator, tenant.id, role_code="reader")
        await RoleAssignmentService(session).ensure_platform_role(
            operator.id, PLATFORM_ADMIN_ROLE
        )

        dashboard = DashboardService(session)
        admin_context = await auth.get_context(admin.id, tenant_id=tenant.id)
        operator_context = await auth.get_context(operator.id, tenant_id=tenant.id)

        # A workspace administrator is not a platform administrator.
        with pytest.raises(AuthorizationError, match="platform permissions"):
            await dashboard.platform_overview(admin_context)

        overview = await dashboard.platform_overview(operator_context)
        assert overview["metrics"]["workspaces"] == 1
        workspaces = await dashboard.list_platform_workspaces(operator_context)
        assert workspaces["items"][0]["owner"]["email"] == admin.email


def _local_midnight(zone_name: str) -> datetime:
    """Today's 00:00 on the given wall clock, as an aware datetime."""

    return datetime.now(ZoneInfo(zone_name)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def _session_row(
    user: User,
    tenant_id: UUID,
    *,
    at: datetime,
    method: str = "password",
    status: str = "active",
    expires_at: datetime | None = None,
    idle_expires_at: datetime | None = None,
    parent: AccessSession | None = None,
) -> AccessSession:
    ended = status != "active"
    return AccessSession(
        tenant_id=tenant_id,
        user_id=user.id,
        kind="user",
        authentication_method=method,
        assurance_level="aal1",
        status=status,
        parent_session_id=parent.id if parent is not None else None,
        transition_reason="tenant_switch" if parent is not None else None,
        created_at=at,
        last_seen_at=at,
        expires_at=expires_at or datetime.now(UTC) + timedelta(hours=1),
        idle_expires_at=idle_expires_at,
        ended_at=at if ended else None,
        end_reason="logout" if ended else None,
    )


async def _ask(
    session: AsyncSession,
    owner: User,
    tenant_id: UUID,
    access: AccessSession,
    *,
    at: datetime,
    questions: int = 1,
) -> None:
    """One conversation opened at ``at`` with ``questions`` user turns and a reply."""

    conversation = Conversation(
        tenant_id=tenant_id,
        owner_user_id=owner.id,
        created_by_session_id=access.id,
        created_at=at,
    )
    session.add(conversation)
    await session.flush()
    roles = ["user"] * questions + ["assistant"]
    session.add_all(
        Message(
            conversation_id=conversation.id,
            role=role,
            content=f"turn {index}",
            sequence_number=index + 1,
            created_at=at,
        )
        for index, role in enumerate(roles)
    )
    await session.flush()


@pytest.mark.asyncio
async def test_workspace_activity_counts_on_the_callers_wall_clock(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Buckets are local days; totals, previous span, and leaders come from real rows."""

    zone = "Asia/Ho_Chi_Minh"
    midnight = _local_midnight(zone)
    # Both instants fall on one UTC day (16:30Z and 17:30Z) but on two local days.
    before_boundary = midnight - timedelta(days=1, minutes=30)
    after_boundary = midnight - timedelta(days=1) + timedelta(minutes=30)
    now = datetime.now(UTC)

    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        tenant = await identity.create_tenant("activity", "Activity")
        elsewhere = await identity.create_tenant("activity-other", "Elsewhere")
        admin = await identity.create_user("admin@activity.test", display_name="Admin")
        member = await identity.create_user("member@activity.test")
        outsider = await identity.create_user("outsider@activity.test")
        await join_tenant(session, admin, tenant.id, system_role=TENANT_ADMIN_ROLE)
        await join_tenant(session, member, tenant.id, system_role=TENANT_MEMBER_ROLE)
        await join_tenant(session, outsider, elsewhere.id, system_role=TENANT_MEMBER_ROLE)

        member_session = _session_row(member, tenant.id, at=before_boundary)
        admin_session = _session_row(
            admin,
            tenant.id,
            at=after_boundary,
            method="oidc",
            expires_at=now - timedelta(minutes=1),  # stored active, lapsed: not live
        )
        outsider_session = _session_row(outsider, elsewhere.id, at=after_boundary)
        session.add_all([member_session, admin_session, outsider_session])
        await session.flush()
        await _ask(session, member, tenant.id, member_session, at=after_boundary, questions=2)
        # Eight local days ago sits in the previous span; forty in neither.
        await _ask(session, member, tenant.id, member_session, at=midnight - timedelta(days=8))
        await _ask(session, member, tenant.id, member_session, at=midnight - timedelta(days=40))
        await _ask(session, outsider, elsewhere.id, outsider_session, at=after_boundary)
        session.add_all(
            [
                AuditLog(
                    tenant_id=tenant.id,
                    actor_user_id=admin.id,
                    action="user.updated",
                    resource_type="user",
                    outcome="failure",
                    created_at=before_boundary,
                ),
                AuditLog(
                    tenant_id=tenant.id,
                    actor_user_id=admin.id,
                    action="user.updated",
                    resource_type="user",
                    created_at=after_boundary,
                ),
                AuditLog(
                    tenant_id=tenant.id,
                    actor_user_id=admin.id,
                    action="role.created",
                    resource_type="role",
                    created_at=after_boundary,
                ),
                AuditLog(
                    tenant_id=elsewhere.id,
                    actor_user_id=outsider.id,
                    action="user.updated",
                    resource_type="user",
                    created_at=after_boundary,
                ),
            ]
        )
        await session.flush()

        activity = ActivityService(session)
        admin_context = await identity.get_context(admin.id, tenant_id=tenant.id)
        member_context = await identity.get_context(member.id, tenant_id=tenant.id)

        report = await activity.workspace_activity(
            admin_context, tenant.id, window="7d", tz=zone
        )

        assert report["bucket"] == "day"
        assert report["timezone"] == zone
        assert datetime.fromisoformat(report["start"]) == midnight - timedelta(days=6)
        starts = [datetime.fromisoformat(bucket["start"]) for bucket in report["buckets"]]
        assert starts == [midnight - timedelta(days=6 - index) for index in range(7)]
        by_day = {
            datetime.fromisoformat(bucket["start"]): bucket for bucket in report["buckets"]
        }
        two_days_ago = by_day[midnight - timedelta(days=2)]
        yesterday = by_day[midnight - timedelta(days=1)]
        assert {key: two_days_ago[key] for key in two_days_ago if key != "start"} == {
            "active_users": 2,
            "sign_ins": 1,
            "questions": 0,
            "changes": 1,
            "failed_changes": 1,
        }
        assert {key: yesterday[key] for key in yesterday if key != "start"} == {
            "active_users": 2,
            "sign_ins": 1,
            "questions": 2,
            "changes": 2,
            "failed_changes": 0,
        }
        assert sum(bucket["questions"] for bucket in report["buckets"]) == 2
        assert report["totals"] == {
            "active_users": 2,
            "sign_ins": 2,
            "questions": 2,
            "conversations": 1,
            "changes": 3,
            "failed_changes": 1,
        }
        assert report["previous"] == {
            "active_users": 1,
            "sign_ins": 0,
            "questions": 1,
            "conversations": 1,
            "changes": 0,
            "failed_changes": 0,
        }
        assert report["live_sessions"] == 1
        assert report["sign_in_methods"] == [
            {"method": "oidc", "count": 1},
            {"method": "password", "count": 1},
        ]
        assert report["top_changes"] == [
            {"action": "user.updated", "count": 2, "failed": 1},
            {"action": "role.created", "count": 1, "failed": 0},
        ]
        people = report["people"]
        # Admin: 1 sign-in + 3 changes outranks member: 2 questions + 1 sign-in.
        assert [person["email"] for person in people] == [admin.email, member.email]
        assert people[1] | {"last_active_at": None} == {
            "user_id": str(member.id),
            "email": member.email,
            "display_name": None,
            "questions": 2,
            "conversations": 1,
            "sign_ins": 1,
            "changes": 0,
            "last_active_at": None,
        }
        assert datetime.fromisoformat(people[1]["last_active_at"]) == after_boundary

        hourly = await activity.workspace_activity(admin_context, tenant.id, window="24h", tz=zone)
        assert hourly["bucket"] == "hour" and len(hourly["buckets"]) == 24
        assert (await activity.workspace_activity(admin_context, tenant.id, window="30d"))[
            "timezone"
        ] == "UTC"

        # Members hold tenant.read but not audit.read; and only the active workspace answers.
        with pytest.raises(AuthorizationError):
            await activity.workspace_activity(member_context, tenant.id)
        with pytest.raises(ControlPlaneNotFoundError):
            await activity.workspace_activity(admin_context, elsewhere.id)
        with pytest.raises(ControlPlaneValidationError, match="timezone"):
            await activity.workspace_activity(admin_context, tenant.id, tz="Mars/Olympus")


@pytest.mark.asyncio
async def test_access_sessions_report_effective_status_and_stay_in_the_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    now = datetime.now(UTC)
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        tenant = await identity.create_tenant("sessions", "Sessions")
        elsewhere = await identity.create_tenant("sessions-other", "Elsewhere")
        admin = await identity.create_user("admin@sessions.test")
        member = await identity.create_user("member@sessions.test", display_name="Mai")
        await join_tenant(session, admin, tenant.id, system_role=TENANT_ADMIN_ROLE)
        await join_tenant(session, member, tenant.id, system_role=TENANT_MEMBER_ROLE)
        await join_tenant(session, member, elsewhere.id, system_role=TENANT_MEMBER_ROLE)
        sessions = AccessSessionService(session)
        _, admin_context = await sessions.create_user(
            user=admin,
            tenant_id=tenant.id,
            auth_identity=None,
            authentication_method="password",
            expires_in_seconds=3_600,
        )

        signed_in = _session_row(
            member, tenant.id, at=now - timedelta(hours=5), status="superseded"
        )
        session.add(signed_in)
        await session.flush()
        switched = _session_row(
            member, tenant.id, at=now - timedelta(hours=4), method="oidc", parent=signed_in
        )
        lapsed = _session_row(
            member,
            tenant.id,
            at=now - timedelta(hours=3),
            expires_at=now - timedelta(hours=1),
        )
        idle = _session_row(
            member,
            tenant.id,
            at=now - timedelta(hours=2),
            idle_expires_at=now - timedelta(minutes=10),
        )
        revoked = _session_row(
            member, tenant.id, at=now - timedelta(hours=6), status="revoked"
        )
        foreign = _session_row(member, elsewhere.id, at=now - timedelta(minutes=5))
        session.add_all([switched, lapsed, idle, revoked, foreign])
        await session.flush()

        page = await sessions.list_sessions(admin_context)
        assert page["total"] == 6
        records = {record["id"]: record for record in page["items"]}
        assert str(foreign.id) not in records
        # Newest first: the admin's own session was created by this transaction.
        assert page["items"][0]["id"] == str(admin_context.session_id)
        assert [record["id"] for record in page["items"][1:]] == [
            str(row.id) for row in (idle, lapsed, switched, signed_in, revoked)
        ]
        assert [record["id"] for record in page["items"] if record["current"]] == [
            str(admin_context.session_id)
        ]
        assert records[str(lapsed.id)]["status"] == "expired"
        assert records[str(lapsed.id)]["end_reason"] == "session_expired"
        assert datetime.fromisoformat(records[str(lapsed.id)]["ended_at"]) == lapsed.expires_at
        assert records[str(idle.id)]["status"] == "expired"
        assert records[str(switched.id)] | {"last_seen_at": None, "started_at": None,
                                            "expires_at": None} == {
            "id": str(switched.id),
            "user": {"id": str(member.id), "email": member.email, "display_name": "Mai"},
            "authentication_method": "oidc",
            "entry": "workspace_switch",
            "status": "active",
            "started_at": None,
            "last_seen_at": None,
            "ended_at": None,
            "end_reason": None,
            "expires_at": None,
            "current": False,
        }
        assert records[str(signed_in.id)]["entry"] == "sign_in"
        assert records[str(signed_in.id)]["status"] == "superseded"
        assert records[str(revoked.id)]["status"] == "revoked"

        active = await sessions.list_sessions(admin_context, status="active")
        assert {record["id"] for record in active["items"]} == {
            str(admin_context.session_id),
            str(switched.id),
        }
        ended = await sessions.list_sessions(admin_context, status="ended")
        assert ended["total"] == 4
        assert {record["status"] for record in ended["items"]} == {
            "expired",
            "superseded",
            "revoked",
        }
        mine = await sessions.list_sessions(admin_context, user_id=admin.id)
        assert [record["id"] for record in mine["items"]] == [str(admin_context.session_id)]
        found = await sessions.list_sessions(admin_context, search="MAI", page_size=2, page=2)
        assert found["total"] == 5
        assert [record["id"] for record in found["items"]] == [str(switched.id), str(signed_in.id)]

        member_context = await identity.get_context(member.id, tenant_id=tenant.id)
        with pytest.raises(AuthorizationError):
            await sessions.list_sessions(member_context)


@pytest.mark.asyncio
async def test_workspace_overview_reports_knowledge_health_and_usage(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    zone = "Asia/Ho_Chi_Minh"
    midnight = _local_midnight(zone)
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        tenant = await identity.create_tenant("overview", "Overview")
        member = await identity.create_user("member@overview.test")
        await join_tenant(session, member, tenant.id, system_role=TENANT_MEMBER_ROLE)

        collection = Item(tenant_id=tenant.id, item_type="collection", title="Policies")
        session.add(collection)
        await session.flush()
        deleted_at = datetime.now(UTC)
        session.add_all(
            Item(
                tenant_id=tenant.id,
                item_type="document",
                parent_item_id=collection.id,
                parent_relation="contains",
                document_type="pdf",
                title=f"Document {index}",
                status="deleted" if index_status == "deleted" else "ready",
                index_status="ready" if index_status == "deleted" else index_status,
                deleted_at=deleted_at if index_status == "deleted" else None,
            )
            for index, index_status in enumerate(
                ["ready", "ready", "pending", "processing", "failed", "unsupported", "deleted"]
            )
        )
        # Nine local days ago lies in the 7 days before the last 7; forty in no bucket.
        old_session = _session_row(member, tenant.id, at=midnight - timedelta(days=9))
        session.add(old_session)
        await session.flush()
        await _ask(session, member, tenant.id, old_session, at=midnight - timedelta(days=9))
        await _ask(
            session, member, tenant.id, old_session, at=midnight - timedelta(hours=23)
        )
        await _ask(session, member, tenant.id, old_session, at=midnight - timedelta(days=40))

        member_context = await identity.get_context(member.id, tenant_id=tenant.id)
        overview = await DashboardService(session).overview(member_context, tz=zone)

        assert overview["knowledge"] == {
            "collections": 1,
            "documents": 6,
            "indexed": 2,
            "indexing": 2,
            "failed": 1,
        }
        # tenant.read alone sees aggregate usage but no audit records.
        assert overview["recent_activity"] == []
        usage = overview["usage"]
        assert usage["timezone"] == zone
        starts = [datetime.fromisoformat(bucket["start"]) for bucket in usage["buckets"]]
        assert starts == [midnight - timedelta(days=29 - index) for index in range(30)]
        questions = {
            datetime.fromisoformat(bucket["start"]): bucket["questions"]
            for bucket in usage["buckets"]
            if bucket["questions"]
        }
        assert questions == {
            midnight - timedelta(days=9): 1,
            midnight - timedelta(days=1): 1,
        }
        assert usage["totals"] == {"active_users": 1, "questions": 1, "sign_ins": 0}
        assert usage["previous"] == {"active_users": 1, "questions": 1, "sign_ins": 1}
        with pytest.raises(ControlPlaneValidationError, match="timezone"):
            await DashboardService(session).overview(member_context, tz="Nowhere/Land")

@pytest.mark.asyncio
async def test_personal_upload_and_message_relation_store_metadata_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("acme", "Acme")
        owner = await auth.create_user("owner@example.com")
        await join_tenant(session, owner, tenant.id)
        context = await AccessSessionService(session).internal_user(
            user=owner, tenant_id=tenant.id
        )

        items = ItemService(session)
        item, created = await items.create_or_get_personal_upload(
            owner.id,
            tenant.id,
            idempotency_key="upload-1",
            file_name="report.pdf",
            mime_type="application/pdf",
            size_bytes=100,
            document_type="pdf",
        )
        repeated, repeated_created = await items.create_or_get_personal_upload(
            owner.id,
            tenant.id,
            idempotency_key="upload-1",
            file_name="report.pdf",
            mime_type="application/pdf",
            size_bytes=100,
            document_type="pdf",
        )
        assert created is True
        assert repeated_created is False
        assert repeated.id == item.id
        assert item.storage_key == f"tenants/{tenant.id}/items/{item.id}/raw"
        assert item.upload is not None and item.upload.status == "pending"

        conversation = Conversation(
            tenant_id=tenant.id,
            owner_user_id=owner.id,
            created_by_session_id=context.session_id,
            title="Review",
        )
        session.add(conversation)
        await session.flush()
        message = Message(
            conversation_id=conversation.id,
            role="user",
            content="Review the attachment",
            sequence_number=1,
        )
        session.add(message)
        await session.flush()
        link = await items.link_message(
            message.id,
            item.id,
            "attachment",
            access=context,
        )
        assert link.item_id == item.id
        assert link.relation_type == "attachment"

        await items.soft_delete_item(item.id, actor=context)
        assert item.status == "deleted"
        assert item.deleted_at is not None
        assert await session.scalar(
            select(ItemUpload).where(ItemUpload.item_id == item.id)
        )
        assert await session.scalar(
            select(MessageItem).where(MessageItem.item_id == item.id)
        )


@pytest.mark.asyncio
async def test_sandbox_recovery_state_is_private_to_its_conversation_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        first_tenant = await identity.create_tenant("sandbox-one", "Sandbox one")
        second_tenant = await identity.create_tenant("sandbox-two", "Sandbox two")
        owner = await identity.create_user("owner@sandbox.test")
        other = await identity.create_user("other@sandbox.test")
        await join_tenant(session, owner, first_tenant.id)
        await join_tenant(session, other, second_tenant.id)
        owner_access = await AccessSessionService(session).internal_user(
            user=owner, tenant_id=first_tenant.id
        )
        other_access = await identity.get_context(other.id, tenant_id=second_tenant.id)
        conversation = Conversation(
            tenant_id=first_tenant.id,
            owner_user_id=owner.id,
            created_by_session_id=owner_access.session_id,
            title="Sandbox work",
        )
        session.add(conversation)
        await session.flush()
        conversation_id = conversation.id

    sandboxes = SandboxSessionService(session_factory)
    created = await sandboxes.ensure(
        owner_access, conversation_id=conversation_id, provider="openrouter"
    )
    recorded = await sandboxes.record_materialization(
        owner_access,
        session_id=created.id,
        resource=SandboxManifestResource(
            resource_id=str(UUID(int=19)),
            name="revenue.csv",
            mime_type="text/csv",
            size_bytes=12,
        ),
        provider_file=SandboxProviderFile(
            id="or_file_1", name="revenue.csv", resource_id=str(UUID(int=19))
        ),
    )

    assert recorded.manifest[0].resource_id == str(UUID(int=19))
    async with session_factory() as session:
        row = await session.get(SandboxSession, created.id)
        assert row is not None
        assert row.provider_state["materialized_files"] == [
            {"id": "or_file_1", "name": "revenue.csv", "resource_id": str(UUID(int=19))}
        ]
    with pytest.raises(DocumentNotFoundError):
        await sandboxes.active(
            other_access, conversation_id=conversation_id, provider="openrouter"
        )


@pytest.mark.asyncio
async def test_referenced_resources_resolve_prior_turns_under_current_access(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A follow-up like "fill that form" resolves earlier Document IDs.

    Attachment, reference, and artifact "output" links all come back, newest
    reference first, and only while the caller can still read the document's
    Collection. A Collection role revoked after the turn that referenced a
    document must drop it from context, not merely fail a later tool call.
    """

    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("provenance", "Provenance")
        owner = await auth.create_user("owner@example.com")
        other = await auth.create_user("other@example.com")
        for member in (owner, other):
            await join_tenant(
                session, member, tenant.id,
                permission_codes=("knowledge.read", "access.manage"),
            )
        actor = await AccessSessionService(session).internal_user(
            user=owner, tenant_id=tenant.id
        )
        other_actor = await auth.get_context(other.id, tenant_id=tenant.id)

        items = ItemService(session)
        forms = await items.create_collection(
            tenant_id=tenant.id, title="Forms", created_by_user_id=owner.id
        )
        restricted = await items.create_collection(
            tenant_id=tenant.id, title="Restricted", created_by_user_id=owner.id
        )
        for collection in (forms, restricted):
            await grant_collection_role(
                session, collection.id, user=owner, role_code=COLLECTION_OWNER_ROLE
            )
        expense_form = await items.create_document(
            tenant_id=tenant.id,
            parent_item_id=forms.id,
            title="Expense report form",
            document_type="file",
            created_by_user_id=owner.id,
        )
        leave_policy = await items.create_document(
            tenant_id=tenant.id,
            parent_item_id=forms.id,
            title="Leave policy",
            document_type="file",
            created_by_user_id=owner.id,
        )
        secret = await items.create_document(
            tenant_id=tenant.id,
            parent_item_id=restricted.id,
            title="Restricted budget",
            document_type="file",
            created_by_user_id=owner.id,
        )
        draft = await items.create_document(
            tenant_id=tenant.id,
            parent_item_id=forms.id,
            title="Filled expense report",
            document_type="file",
            created_by_user_id=owner.id,
        )

        conversation = Conversation(
            tenant_id=tenant.id,
            owner_user_id=owner.id,
            created_by_session_id=actor.session_id,
            title="Expenses",
        )
        session.add(conversation)
        await session.flush()
        messages = []
        for sequence, message_role in enumerate(
            ("user", "assistant", "assistant"), start=1
        ):
            message = Message(
                conversation_id=conversation.id,
                role=message_role,
                content=f"turn {sequence}",
                sequence_number=sequence,
            )
            session.add(message)
            messages.append(message)
        await session.flush()
        await items.link_message(
            messages[0].id, expense_form.id, "attachment", access=actor
        )
        await items.link_message(messages[1].id, secret.id, "reference", access=actor)
        await items.link_message(
            messages[1].id, leave_policy.id, "reference", access=actor
        )
        await items.link_message(
            messages[2].id, expense_form.id, "reference", access=actor
        )
        # An artifact the turn exported stays reachable as a resource.
        await items.link_message(messages[2].id, draft.id, "output", access=actor)
        # Access revoked between turns must remove the document from context.
        await RoleAssignmentService(session).revoke_collection_role(
            restricted.id, principal_type="user", principal_id=owner.id
        )
        conversation_id = conversation.id

    conversations = ConversationService(session_factory)
    references = await conversations.referenced_resources(
        conversation_id, access=actor
    )
    # "Secret" sat in the Collection whose grant was revoked above, so it is
    # gone even though an earlier turn referenced it. The two documents the
    # latest turn touched come before the one only an earlier turn did; within
    # one turn the order is unspecified, so it is not asserted.
    names = [reference.name for reference in references]
    assert set(names[:2]) == {"Expense report form", "Filled expense report"}
    assert names[2:] == ["Leave policy"]
    by_id = {reference.id: reference for reference in references}
    assert by_id[str(expense_form.id)].mime_type == "application/octet-stream"
    # A conversation is private to its user: another member resolves nothing.
    assert (
        await conversations.referenced_resources(conversation_id, access=other_actor)
        == ()
    )


@pytest.mark.asyncio
async def test_citations_replace_geometry_by_stable_chunk_identity(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("citations", "Citations")
        owner = await auth.create_user("citations@example.com")
        collection = await ItemService(session).create_collection(
            tenant_id=tenant.id,
            title="Policies",
            created_by_user_id=owner.id,
        )
        document = await ItemService(session).create_document(
            tenant_id=tenant.id,
            parent_item_id=collection.id,
            title="Policy",
            document_type="pdf",
            created_by_user_id=owner.id,
        )
        chunks = (
            Chunk(
                id=f"{document.id}:0",
                item_id=str(document.id),
                chunk_index=0,
                chunk_text="First policy paragraph",
                content_type="text",
                section_path=["Policy", "Eligibility"],
                citation=CitationInfo(
                    anchor="eligibility",
                    spans=(
                        CitationSpan(
                            page=2,
                            element_id="p002_para_001",
                            start_offset=0,
                            end_offset=22,
                            bounding_box=BoundingBox(
                                x=0.1,
                                y=0.2,
                                width=0.3,
                                height=0.1,
                            ),
                        ),
                    ),
                ),
            ),
            Chunk(
                id=f"{document.id}:1",
                item_id=str(document.id),
                chunk_index=1,
                chunk_text="Second policy paragraph",
                content_type="text",
                citation=CitationInfo(spans=(CitationSpan(page=4),)),
            ),
        )

        citations = CitationService(session)
        await citations.replace_for_item(document.id, chunks)
        first = await citations.get(document.id, chunks[0].id)
        assert first is not None
        assert first.section_path == ("Policy", "Eligibility")
        assert first.section == "Eligibility"
        assert first.page_start == 2
        assert first.page_end == 2
        assert first.spans[0].bounding_box == BoundingBox(
            x=0.1,
            y=0.2,
            width=0.3,
            height=0.1,
        )

        await citations.replace_for_item(document.id, chunks[:1])
        assert await citations.get(document.id, chunks[1].id) is None
        stale = await session.scalar(
            select(Citation).where(
                Citation.item_id == document.id,
                Citation.chunk_id == chunks[1].id,
            )
        )
        assert stale is not None and stale.deleted_at is not None


@pytest.mark.asyncio
async def test_integration_credentials_are_encrypted_and_owner_models_are_explicit(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("acme", "Acme")
        owner = await auth.create_user("owner@example.com")
        await join_tenant(session, owner, tenant.id)

        personal = IntegrationConnection(
            tenant_id=tenant.id,
            owner_type="user",
            owner_user_id=owner.id,
            connector_key="confluence",
            display_name="Owner Confluence",
            created_by_user_id=owner.id,
        )
        tenant_owned = IntegrationConnection(
            tenant_id=tenant.id,
            owner_type="tenant",
            connector_key="google_drive",
            display_name="Company Drive",
            created_by_user_id=owner.id,
        )
        session.add_all([personal, tenant_owned])
        await session.flush()

        encryption_key = base64.urlsafe_b64encode(bytes(range(32))).decode("ascii")
        credentials = IntegrationCredentialService(session, encryption_key)
        record = await credentials.store(
            personal.id,
            credential_type="oauth2",
            payload={"access_token": "top-secret", "refresh_token": "refresh-secret"},
            key_version="local-v1",
        )

        assert personal.owner_user_id == owner.id
        assert tenant_owned.owner_user_id is None
        assert "top-secret" not in record.encrypted_payload
        assert "refresh-secret" not in record.encrypted_payload
        assert await credentials.resolve(personal.id) == {
            "access_token": "top-secret",
            "refresh_token": "refresh-secret",
        }
        assert (
            await session.scalar(
                select(IntegrationCredential).where(
                    IntegrationCredential.integration_connection_id == personal.id
                )
            )
            is record
        )


def test_integration_encryption_key_accepts_unpadded_urlsafe_base64() -> None:
    expected = bytes(range(32))
    encryption_key = base64.urlsafe_b64encode(expected).decode("ascii").rstrip("=")

    assert IntegrationCredentialService._decode_key(encryption_key) == expected


@pytest.mark.asyncio
async def test_integration_list_eager_loads_optional_credentials(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("acme", "Acme")
        owner = await auth.create_user("owner@example.com")
        await join_tenant(
            session, owner, tenant.id, role_code="source-manager",
            permission_codes=("source.manage",),
        )
        actor = await auth.get_context(owner.id, tenant_id=tenant.id)
        session.add(
            IntegrationConnection(
                tenant_id=tenant.id,
                owner_type="tenant",
                connector_key="file",
                display_name="Uploaded files",
                status="draft",
                created_by_user_id=owner.id,
            )
        )

    async with session_factory.begin() as session:
        result = await IntegrationConnectionService(session).list_connections(
            actor,
            page_size=100,
        )

    assert result["total"] == 1
    assert result["items"][0]["credential_configured"] is False


@pytest.mark.asyncio
async def test_authorized_item_is_projectable_without_further_database_io(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The knowledge viewer reads an authorized Item outside the await chain.

    Its upload lifecycle must already be loaded: a lazy load would run asyncpg
    I/O from synchronous code and fail the request with MissingGreenlet.
    """

    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("viewer", "Viewer")
        owner = await auth.create_user("viewer@example.com")
        await join_tenant(
            session, owner, tenant.id, role_code="reader",
            permission_codes=("knowledge.read", "access.manage"),
        )
        actor = await auth.get_context(owner.id, tenant_id=tenant.id)
        items = ItemService(session)
        collection = await items.create_collection(
            tenant_id=tenant.id,
            title="Policies",
            created_by_user_id=owner.id,
        )
        await grant_collection_role(
            session, collection.id, user=owner, role_code=COLLECTION_OWNER_ROLE
        )
        # A connector-ingested document has no upload row at all.
        ingested = await items.create_document(
            tenant_id=tenant.id,
            parent_item_id=collection.id,
            title="Ingested policy",
            document_type="pdf",
            created_by_user_id=owner.id,
        )
        ingested_id = ingested.id

    async with session_factory.begin() as session:
        item = await ItemService(session).get_item_by_canonical_id(
            str(ingested_id), access=actor
        )
        loaded = item

    # Outside the session, reading the relationship must not touch the database.
    assert loaded.upload is None
    assert loaded.status == "pending"


@pytest.mark.asyncio
async def test_external_resource_mapping_preserves_canonical_item_identity(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("source-map", "Source mapping")
        owner = await auth.create_user("source-map@example.com")
        await join_tenant(session, owner, tenant.id, role_code="source-manager")
        collection = await ItemService(session).create_collection(
            tenant_id=tenant.id,
            title="External knowledge",
            created_by_user_id=owner.id,
        )
        connection = IntegrationConnection(
            tenant_id=tenant.id,
            connector_key="confluence",
            owner_type="tenant",
            display_name="Company wiki",
            status="connected",
            created_by_user_id=owner.id,
        )
        session.add(connection)
        await session.flush()
        source = IngestionSource(
            integration_connection_id=connection.id,
            target_item_id=collection.id,
            checkpoint={},
            status="ready",
            created_by_user_id=owner.id,
        )
        session.add(source)
        await session.flush()

        existing_item = Item(
            id=uuid4(),
            tenant_id=tenant.id,
            item_type="document",
            parent_item_id=collection.id,
            parent_relation="child",
            document_type="confluence_page",
            title="Existing title",
            status="ready",
            index_status="ready",
        )
        session.add(existing_item)
        await session.flush()
        resource = ExternalResource(
            item_id=existing_item.id,
            ingestion_source_id=source.id,
            external_id="page-42",
            external_version="v1",
        )
        session.add(resource)
        await session.flush()

        updated = await ItemService(session).upsert_ingested_item(
            source.id,
            "page-42",
            canonical_external_id="confluence:page-42",
            item_type="document",
            title="Updated title",
            document_type="confluence_page",
            external_version="v2",
            etag="etag-v2",
        )

        assert updated.id == existing_item.id
        assert updated.title == "Updated title"
        stored_resources = list(
            await session.scalars(
                select(ExternalResource).where(
                    ExternalResource.ingestion_source_id == source.id,
                    ExternalResource.external_id == "page-42",
                )
            )
        )
        assert len(stored_resources) == 1
        assert stored_resources[0].item_id == existing_item.id
        assert stored_resources[0].external_version == "v2"
        assert stored_resources[0].etag == "etag-v2"


@pytest.mark.asyncio
async def test_admin_collection_creation_is_tenant_scoped_and_audited(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("acme-knowledge", "Acme Knowledge")
        owner = await auth.create_user("knowledge-owner@example.com")
        await join_tenant(
            session, owner, tenant.id, role_code="knowledge-admin",
            permission_codes=(
                "access.manage", "item.manage", "collection.read",
                "collection.share", "collection.update",
            ),
        )
        actor = await auth.get_context(owner.id, tenant_id=tenant.id)

        created = await ItemCatalogService(session).create_collection(
            actor,
            title="Engineering handbook",
            inherit_access=True,
            metadata={"description": "Governed engineering knowledge"},
        )

        assert created["item_type"] == "collection"
        assert created["title"] == "Engineering handbook"
        assert created["metadata"] == {"description": "Governed engineering knowledge"}
        listed = await ItemCatalogService(session).list_items(
            actor,
            item_type="collection",
            search="governed engineering",
            created_by_user_id=owner.id,
        )
        assert listed["total"] == 1

        nested = await ItemCatalogService(session).create_collection(
            actor,
            title="Engineering runbooks",
            parent_item_id=UUID(created["id"]),
            inherit_access=True,
        )
        scoped = await ItemCatalogService(session).list_items(
            actor,
            item_type="collection",
            parent_item_id=UUID(created["id"]),
        )
        assert scoped["total"] == 1
        assert scoped["items"][0]["id"] == nested["id"]
        assert listed["items"][0]["item_count"] == 0
        assert listed["items"][0]["source_count"] == 0
        assert listed["items"][0]["created_by_user_id"] == str(owner.id)
        audit_event = await session.scalar(
            select(AuditLog).where(
                AuditLog.resource_id == created["id"],
                AuditLog.action == "collection.created",
            )
        )
        assert audit_event is not None
        assert audit_event.tenant_id == tenant.id

        updated = await ItemCatalogService(session).update_collection(
            actor,
            UUID(created["id"]),
            title="Engineering playbook",
            description=None,
            description_provided=True,
        )

        assert updated["title"] == "Engineering playbook"
        assert updated["metadata"] == {}
        update_event = await session.scalar(
            select(AuditLog).where(
                AuditLog.resource_id == created["id"],
                AuditLog.action == "collection.updated",
            )
        )
        assert update_event is not None


def test_postgresql_models_have_no_raw_byte_or_chunk_columns() -> None:
    forbidden_tables = {"documents", "document_blobs", "document_chunks"}
    assert forbidden_tables.isdisjoint(Base.metadata.tables)
    assert all(
        column.type.__class__.__name__.casefold() not in {"largebinary", "bytea"}
        for table in Base.metadata.tables.values()
        for column in table.columns
    )


class _AsyncUpload:
    def __init__(self, body: bytes) -> None:
        self._body = body
        self._offset = 0
        self.read_count = 0

    async def read(self, size: int = -1) -> bytes:
        self.read_count += 1
        if self._offset >= len(self._body):
            return b""
        end = len(self._body) if size < 0 else self._offset + size
        chunk = self._body[self._offset : end]
        self._offset += len(chunk)
        return chunk


class _UploadStorage:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.uploads: list[tuple[str, bytes, str | None]] = []

    def put_path(
        self,
        path: Path,
        key: str,
        *,
        content_type: str | None = None,
    ) -> StoredObject:
        if self.fail:
            raise ObjectStorageError("storage unavailable")
        body = path.read_bytes()
        self.uploads.append((key, body, content_type))
        return StoredObject(
            size_bytes=len(body),
            content_type=content_type,
            etag="etag-upload",
            version_id="version-upload",
        )


class _PresignedUploadStorage:
    async def head(self, key: str) -> StoredObject:
        return StoredObject(
            size_bytes=15,
            content_type="text/plain",
            etag=f"etag-{key}",
            version_id="version-finalized",
        )

class _UnavailableIngestion:
    async def index_upload(self, *_: object, **__: object) -> Item:
        raise DocumentProcessingError("indexing is outside this integration test")


class _RecordingIndexWorkflow:
    def __init__(self) -> None:
        self.requests: list[object] = []

    async def start_ingestion(self, input: object, **_: object) -> dict[str, bool]:
        self.requests.append(input)
        return {"started": True}


def _uploads(
    session_factory: async_sessionmaker[AsyncSession],
    storage: _UploadStorage,
    workflows: _RecordingIndexWorkflow | None = None,
    ingestion: object | None = None,
    **kwargs: object,
) -> DocumentService:
    return DocumentService(
        session_factory,
        object_storage=storage,  # type: ignore[arg-type]
        ingestion=ingestion or _UnavailableIngestion(),  # type: ignore[arg-type]
        content=object(),  # type: ignore[arg-type]
        workflows=workflows or _RecordingIndexWorkflow(),  # type: ignore[arg-type]
        presenter=DocumentPresenter(
            object_storage=lambda: storage,
            preview=SimpleNamespace(resolve=lambda *_, **__: None),  # type: ignore[arg-type]
            citation_url_seconds=300,
            preview_url_seconds=300,
        ),
        **kwargs,
    )


async def _collection_upload_contexts(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[UUID, AuthContext, AuthContext, AuthContext]:
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("upload-tenant", "Upload tenant")
        other_tenant = await auth.create_tenant("upload-other", "Other tenant")
        owner = await auth.create_user("upload-owner@example.com")
        editor = await auth.create_user("upload-editor@example.com")
        viewer = await auth.create_user("upload-viewer@example.com")
        outsider = await auth.create_user("upload-outsider@example.com")
        await join_tenant(session, owner, tenant.id, system_role=TENANT_ADMIN_ROLE)
        for member in (editor, viewer):
            await join_tenant(session, member, tenant.id, role_code="upload-member")
        await join_tenant(
            session, outsider, other_tenant.id, role_code="upload-outsider"
        )
        editor_context = await auth.get_context(editor.id, tenant_id=tenant.id)
        viewer_context = await auth.get_context(viewer.id, tenant_id=tenant.id)
        outsider_context = await auth.get_context(
            outsider.id, tenant_id=other_tenant.id
        )
        collection = await ItemService(session).create_collection(
            tenant_id=tenant.id,
            title="Upload destination",
            created_by_user_id=owner.id,
        )
        for member, role_code in (
            (owner, COLLECTION_OWNER_ROLE),
            (editor, COLLECTION_EDITOR_ROLE),
            (viewer, COLLECTION_VIEWER_ROLE),
        ):
            await grant_collection_role(
                session, collection.id, user=member, role_code=role_code
            )
        return (
            collection.id,
            editor_context,
            viewer_context,
            outsider_context,
        )


@pytest.mark.asyncio
async def test_collection_upload_is_authorized_parented_and_retry_safe(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    collection_id, editor, viewer, _ = await _collection_upload_contexts(
        session_factory
    )
    storage = _UploadStorage()
    workflows = _RecordingIndexWorkflow()
    uploads = _uploads(session_factory, storage, workflows)

    first = await uploads.upload_to_collection(
        editor,
        collection_id,
        idempotency_key="collection-upload-1",
        file_name="policy.txt",
        content_type="text/plain",
        content=_AsyncUpload(b"governed policy"),
    )
    repeated = await uploads.upload_to_collection(
        editor,
        collection_id,
        idempotency_key="collection-upload-1",
        file_name="policy.txt",
        content_type="text/plain",
        content=_AsyncUpload(b"governed policy"),
    )
    second = await uploads.upload_to_collection(
        editor,
        collection_id,
        idempotency_key="collection-upload-2",
        file_name="controls.md",
        content_type="text/markdown",
        content=_AsyncUpload(b"# Controls"),
    )

    assert first.created is True
    assert repeated.created is False
    assert repeated.item.id == first.item.id
    assert second.item.id != first.item.id
    assert first.item.parent_item_id == collection_id
    assert first.item.upload is not None
    assert first.item.upload.owner_user_id == editor.user_id
    assert first.item.upload.status == "available"
    assert first.item.status == "ready"
    assert first.item.index_status == "pending"
    assert len(workflows.requests) == 3
    assert len(storage.uploads) == 2
    assert storage.uploads[0][1] == b"governed policy"
    async with session_factory() as session:
        external_resource = await session.scalar(
            select(ExternalResource.id).where(ExternalResource.item_id == first.item.id)
        )
        visible = await ItemService(session).get_upload_for_access(
            first.item.id,
            viewer,
        )
        with pytest.raises(AuthorizationError, match="collection.update"):
            await ItemService(session).get_upload_for_access(
                first.item.id,
                viewer,
                permission=COLLECTION_UPDATE_PERMISSION,
            )
    assert external_resource is None
    assert visible.id == first.item.id


class _RecordingIngestion:
    def __init__(self) -> None:
        self.indexed: list[UUID] = []

    async def index_upload(self, document_id: UUID, **_: object) -> None:
        self.indexed.append(document_id)


@pytest.mark.asyncio
async def test_own_uploads_are_processed_directly_and_workspace_uploads_are_managed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    workspace_id, editor, _, _ = await _collection_upload_contexts(session_factory)
    workflows = _RecordingIndexWorkflow()
    ingestion = _RecordingIngestion()
    documents = _uploads(session_factory, _UploadStorage(), workflows, ingestion)
    async with session_factory.begin() as session:
        personal_id = await ItemService(session).ensure_personal_collection(
            editor.user_id,
            editor.tenant_id,
            collection_id=ItemService.upload_collection_id(editor.tenant_id, editor.user_id),
            title="My uploads",
            system_kind="personal_uploads",
        )
    personal = {"id": personal_id}

    mine = await documents.upload_to_collection(
        editor, personal["id"], idempotency_key="chat-1", file_name="notes.txt",
        content_type="text/plain", content=_AsyncUpload(b"my notes"),
        purpose="conversation_attachment",
    )
    for _ in range(100):
        if ingestion.indexed:
            break
        await asyncio.sleep(0.01)
    shared = await documents.upload_to_collection(
        editor, workspace_id, idempotency_key="kb-1", file_name="policy.txt",
        content_type="text/plain", content=_AsyncUpload(b"workspace policy"),
    )

    # The user's own upload never touches Temporal; the workspace one only does.
    assert ingestion.indexed == [mine.item.id]
    assert mine.item.metadata_["ingestion"]["mode"] == "direct"
    assert [request.document_id for request in workflows.requests] == [str(shared.item.id)]
    assert shared.item.metadata_["ingestion"]["mode"] == "managed"
    with pytest.raises(UploadValidationError, match="workspace collection"):
        await documents.upload_to_collection(
            editor, personal["id"], idempotency_key="zip-1", file_name="bulk.zip",
            content_type="application/zip", content=_AsyncUpload(b"PK"),
        )


@pytest.mark.asyncio
async def test_an_image_is_a_conversation_attachment_never_knowledge(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    workspace_id, editor, _, _ = await _collection_upload_contexts(session_factory)
    workflows = _RecordingIndexWorkflow()
    ingestion = _RecordingIngestion()
    documents = _uploads(session_factory, _UploadStorage(), workflows, ingestion)
    async with session_factory.begin() as session:
        personal_id = await ItemService(session).ensure_personal_collection(
            editor.user_id,
            editor.tenant_id,
            collection_id=ItemService.upload_collection_id(editor.tenant_id, editor.user_id),
            title="My uploads",
            system_kind="personal_uploads",
        )

    for collection_id in (workspace_id, personal_id):
        with pytest.raises(UploadValidationError, match="images are not supported as knowledge"):
            await documents.upload_to_collection(
                editor, collection_id, idempotency_key=f"kb-image-{collection_id}",
                file_name="chart.png", content_type="image/png", content=_AsyncUpload(b"png"),
            )
    attached = await documents.upload_to_collection(
        editor, personal_id, idempotency_key="chat-image", file_name="chart.png",
        content_type="image/png", content=_AsyncUpload(b"png"),
        purpose="conversation_attachment",
    )
    await asyncio.sleep(0.05)

    # Kept for the agent to open; never indexed, so no Ingestion at all.
    assert attached.item.upload.status == "available"
    assert attached.item.index_status == "unsupported"
    assert "ingestion" not in attached.item.metadata_
    assert ingestion.indexed == [] and workflows.requests == []
    with pytest.raises(UploadConflictError, match="not processed as knowledge"):
        await documents.restart_ingestion(editor, attached.item.id, trigger_type="retry")


class _TemporalIngestions(_RecordingIndexWorkflow):
    """Managed runs as Temporal reports them: the latest run of each document."""

    def __init__(self) -> None:
        super().__init__()
        self.status: dict[str, str] = {}

    async def start_ingestion(self, input: Any, **kwargs: object) -> dict[str, bool]:
        self.status[input.document_id] = "running"
        return await super().start_ingestion(input, **kwargs)

    async def describe_ingestion(self, workflow_id: str) -> dict[str, Any]:
        document_id = workflow_id.rsplit(":", 1)[-1]
        if document_id not in self.status:
            raise WorkflowExecutionNotFoundError(workflow_id)
        latest = next(r for r in reversed(self.requests) if r.document_id == document_id)
        return {
            "workflow_id": workflow_id,
            "kind": "document",
            "document_id": document_id,
            "status": self.status[document_id],
            "trigger_type": latest.trigger_type,
        }


@pytest.mark.asyncio
async def test_an_indexed_document_is_reindexed_on_request_but_never_doubled(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    workspace_id, editor, viewer, _ = await _collection_upload_contexts(session_factory)
    workflows = _TemporalIngestions()
    documents = _uploads(session_factory, _UploadStorage(), workflows)
    ingestions = IngestionService(
        session_factory,
        workflows=workflows,  # type: ignore[arg-type]
        documents=documents,
        sources=None,  # type: ignore[arg-type]
    )
    uploaded = await documents.upload_to_collection(
        editor, workspace_id, idempotency_key="kb-reindex", file_name="policy.txt",
        content_type="text/plain", content=_AsyncUpload(b"workspace policy"),
    )
    document_id = uploaded.item.id

    # The first run is still going: a re-index would double it.
    with pytest.raises(ControlPlaneConflictError, match="already being indexed"):
        await ingestions.start_document_ingestion(editor, document_id)

    # It finished and the document is indexed.
    workflows.status[str(document_id)] = "completed"
    async with session_factory.begin() as session:
        (await session.get(Item, document_id)).index_status = "ready"

    with pytest.raises(AuthorizationError, match="collection.update"):
        await ingestions.start_document_ingestion(viewer, document_id)
    started = await ingestions.start_document_ingestion(editor, document_id)

    assert started["status"] == "running"
    assert started["trigger_type"] == "manual"
    assert str(started["id"]) == uploaded.item.metadata_["ingestion"]["id"]
    assert [request.trigger_type for request in workflows.requests] == ["upload", "manual"]
    async with session_factory() as session:
        document = await session.get(Item, document_id)
        # Pending, not ready: the core's "index is current" shortcut cannot skip it.
        assert document.index_status == "pending"
        assert document.metadata_["ingestion"]["trigger_type"] == "manual"

    # A connector wrote this one: there is no upload to run again.
    async with session_factory.begin() as session:
        synced = Item(
            id=uuid4(), tenant_id=editor.tenant_id, item_type="document",
            parent_item_id=workspace_id, parent_relation="child",
            document_type="confluence_page", title="Synced page",
            status="ready", index_status="ready",
        )
        session.add(synced)
    with pytest.raises(ControlPlaneConflictError, match="re-indexed by its source's sync"):
        await ingestions.start_document_ingestion(editor, synced.id)



@pytest.mark.asyncio
async def test_presigned_finalization_presents_updated_document_after_session_closes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    collection_id, editor, _, _ = await _collection_upload_contexts(session_factory)
    storage = _PresignedUploadStorage()
    workflows = _RecordingIndexWorkflow()
    uploads = _uploads(session_factory, storage, workflows)
    async with session_factory.begin() as session:
        document, created = await ItemService(session).create_or_get_collection_upload(
            editor.user_id,
            editor.tenant_id,
            collection_id,
            idempotency_key="presigned-finalization",
            file_name="policy.txt",
            mime_type="text/plain",
            size_bytes=15,
            document_type="text",
            metadata={"purpose": "knowledge"},
        )

    result = await uploads.finalize_document_content(editor, document.id)

    assert created is True
    # A workspace Collection's upload is managed ingestion, queued once.
    assert result["ingestion"]["mode"] == "managed"
    assert result["ingestion"]["status"] == "pending"
    assert result["document"]["id"] == document.id
    assert result["document"]["status"] == "available"
    assert isinstance(result["document"]["updated_at"], datetime)
    assert len(workflows.requests) == 1

@pytest.mark.asyncio
async def test_collection_upload_rejects_tenant_permission_and_collection_states(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    collection_id, _, viewer, outsider = await _collection_upload_contexts(
        session_factory
    )
    uploads = _uploads(session_factory, _UploadStorage())
    viewer_content = _AsyncUpload(b"viewer")
    outsider_content = _AsyncUpload(b"outsider")

    with pytest.raises(AuthorizationError, match="collection.update"):
        await uploads.upload_to_collection(
            viewer,
            collection_id,
            idempotency_key="viewer-upload",
            file_name="viewer.txt",
            content_type="text/plain",
            content=viewer_content,
        )
    with pytest.raises(DocumentNotFoundError):
        await uploads.upload_to_collection(
            outsider,
            collection_id,
            idempotency_key="outsider-upload",
            file_name="outsider.txt",
            content_type="text/plain",
            content=outsider_content,
        )
    with pytest.raises(DocumentNotFoundError):
        await uploads.upload_to_collection(
            viewer,
            uuid4(),
            idempotency_key="missing-upload",
            file_name="missing.txt",
            content_type="text/plain",
            content=_AsyncUpload(b"missing"),
        )
    assert viewer_content.read_count == 0
    assert outsider_content.read_count == 0

    async with session_factory.begin() as session:
        request = await ApprovalRequestService(session).create_request(
            viewer,
            requester_user_id=viewer.user_id,
            request_type="resource_access",
            target_id=str(collection_id),
            details={"role": COLLECTION_EDITOR_ROLE},
            reason="Upload files to this knowledge base",
        )
    assert request["status"] == "pending"
    assert request["requested_role"]["code"] == COLLECTION_EDITOR_ROLE

    async with session_factory.begin() as session:
        collection = await session.get(Item, collection_id)
        assert collection is not None and collection.created_by_user_id is not None
        owner = await session.get(User, collection.created_by_user_id)
        assert owner is not None
        assert collection.tenant_id is not None
        owner_context = await IdentityStoreService(session).get_context(
            owner.id, tenant_id=collection.tenant_id
        )
        with pytest.raises(ControlPlaneConflictError, match="equivalent approval request"):
            await ApprovalRequestService(session).create_request(
                viewer,
                requester_user_id=viewer.user_id,
                request_type="resource_access",
                target_id=str(collection_id),
                details={"role": COLLECTION_VIEWER_ROLE},
            )
        approved = await ApprovalRequestService(session).update_request(
            owner_context,
            UUID(request["id"]),
            status="approved",
        )
        assert approved["status"] == "approved"
        granted_role = await session.scalar(
            select(Role.code)
            .join(RoleAssignment, RoleAssignment.role_id == Role.id)
            .where(
                RoleAssignment.item_id == collection_id,
                RoleAssignment.user_id == viewer.user_id,
                RoleAssignment.deleted_at.is_(None),
            )
        )
        assert granted_role == COLLECTION_EDITOR_ROLE

    async with session_factory.begin() as session:
        collection = await session.get(Item, collection_id)
        assert collection is not None
        collection.status = "deleted"
        collection.deleted_at = datetime.now(UTC)
    with pytest.raises(DocumentNotFoundError):
        await uploads.upload_to_collection(
            viewer,
            collection_id,
            idempotency_key="archived-upload",
            file_name="archived.txt",
            content_type="text/plain",
            content=_AsyncUpload(b"archived"),
        )


@pytest.mark.asyncio
async def test_collection_upload_validates_type_size_and_storage_failures(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    collection_id, editor, _, _ = await _collection_upload_contexts(session_factory)
    uploads = _uploads(
        session_factory,
        _UploadStorage(),
        max_upload_bytes=8,
    )

    with pytest.raises(UploadValidationError, match="unsupported file type"):
        await uploads.upload_to_collection(
            editor,
            collection_id,
            idempotency_key="unsupported-upload",
            file_name="archive.exe",
            content_type="application/octet-stream",
            content=_AsyncUpload(b"binary"),
        )
    with pytest.raises(UploadTooLargeError):
        await uploads.upload_to_collection(
            editor,
            collection_id,
            idempotency_key="oversized-upload",
            file_name="large.txt",
            content_type="text/plain",
            content=_AsyncUpload(b"123456789"),
        )

    failing_uploads = _uploads(session_factory, _UploadStorage(fail=True))
    with pytest.raises(ObjectStorageError):
        await failing_uploads.upload_to_collection(
            editor,
            collection_id,
            idempotency_key="storage-failure",
            file_name="storage.txt",
            content_type="text/plain",
            content=_AsyncUpload(b"stored later"),
        )
    async with session_factory() as session:
        failed = await session.scalar(
            select(ItemUpload).where(ItemUpload.idempotency_key == "storage-failure")
        )
        assert failed is not None
        item = await session.get(Item, failed.item_id)
    assert failed.status == "failed"
    assert item is not None and item.status == "failed"


class InMemoryObjectStorage:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str | None]] = {}

    def put_bytes(
        self,
        data: bytes,
        key: str,
        *,
        content_type: str | None = None,
        content_encoding: str | None = None,
        cache_control: str | None = None,
    ) -> StoredObject:
        self.objects[key] = (data, content_type)
        return StoredObject(size_bytes=len(data), content_type=content_type)

    def presign_download(self, key: str, *, expires_seconds: int) -> PresignedRequest:
        return PresignedRequest(
            url=f"https://storage.test/{key}", method="GET", headers={}, expires_at=datetime.now(UTC)
        )

    async def read(self, key: str, *, max_bytes: int) -> bytes:
        if key not in self.objects:
            raise ObjectNotFoundError(f"object not found: {key}")
        return self.objects[key][0]


class StubUploads:
    """Stand in for ``DocumentService.upload_to_collection``.

    ``ArtifactService.publish`` only needs the shape of the result
    (``item.id``/``item.title``/``item.status`` and ``created``); the real
    upload/ingestion path is exercised by its own tests.
    """

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def upload_to_collection(
        self,
        access: AuthContext,
        collection_id: UUID,
        *,
        idempotency_key: str,
        file_name: str,
        content_type: str,
        content: Any,
    ) -> Any:
        data = await content.read()
        self.calls.append(
            {
                "access": access,
                "collection_id": collection_id,
                "idempotency_key": idempotency_key,
                "file_name": file_name,
                "content_type": content_type,
                "data": data,
            }
        )
        return SimpleNamespace(
            item=SimpleNamespace(id=uuid4(), title=file_name, status="ready"),
            created=True,
        )


@pytest.mark.asyncio
async def test_conversation_files_keep_every_revision_under_a_private_collection(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A produced file becomes a private, revisioned, downloadable document.

    Writing the same file name again is a new revision of the same document,
    reading a knowledge document back out is access-checked, and publishing
    into the Knowledge Base stays an explicit, separately authorized step.
    """

    storage = InMemoryObjectStorage()
    async with session_factory.begin() as session:
        auth = IdentityStoreService(session)
        tenant = await auth.create_tenant("artifacts", "Artifacts")
        writer = await auth.create_user("writer@example.com")
        reader = await auth.create_user("reader@example.com")
        for member in (writer, reader):
            await join_tenant(
                session, member, tenant.id,
                permission_codes=("knowledge.read", "access.manage"),
            )
        writer_context = await AccessSessionService(session).internal_user(
            user=writer, tenant_id=tenant.id
        )
        reader_context = await auth.get_context(reader.id, tenant_id=tenant.id)

        items = ItemService(session)
        # An ordinary Collection: no "template library" flag exists any more.
        # It is a valid publish destination
        # purely because the writer has editor access to it.
        library = await items.create_collection(
            tenant_id=tenant.id,
            title="Legal documents",
            created_by_user_id=writer.id,
        )
        await grant_collection_role(
            session, library.id, user=writer, role_code=COLLECTION_EDITOR_ROLE
        )
        source_document = await items.create_document(
            tenant_id=tenant.id,
            parent_item_id=library.id,
            title="NDA template",
            document_type="markdown",
            created_by_user_id=writer.id,
            mime_type="text/markdown",
            size_bytes=30,
            storage_key=f"tenants/{tenant.id}/items/source-document/raw",
            metadata={"file_name": "nda-template.md"},
            status="ready",
        )
        # A Collection the writer can only view, not edit — the real guard
        # publish() has left once the "template library" flag is gone.
        viewer_only = await items.create_collection(
            tenant_id=tenant.id,
            title="Reader's private notes",
            created_by_user_id=reader.id,
        )
        await grant_collection_role(
            session, viewer_only.id, user=writer, role_code=COLLECTION_VIEWER_ROLE
        )
        conversation = Conversation(
            tenant_id=tenant.id,
            owner_user_id=writer.id,
            created_by_session_id=writer_context.session_id,
            title="Draft",
        )
        session.add(conversation)
        await session.flush()
    storage.objects[source_document.storage_key] = (b"# NDA\n\nBetween [A] and [B].\n", "text/markdown")

    uploads = StubUploads()
    service = ArtifactService(
        session_factory,
        object_storage=lambda: storage,
        documents=lambda: uploads,
        max_content_bytes=1_000_000,
        download_url_seconds=60,
    )

    created = await service.record_generated(
        writer_context,
        conversation_id=conversation.id,
        request_id="req-1",
        file_name="Q3-memo.md",
        mime_type="text/markdown",
        data=b"# Q3 memo\n\nDate: 2026-09-01\n",
        summary="Produced Q3-memo.md",
    )
    artifact_id = UUID(created["id"])
    first_key = f"tenants/{tenant.id}/items/{artifact_id}/revisions/1/Q3-memo.md"
    assert created["revision"] == 1
    assert created["file_name"] == "Q3-memo.md"
    assert created["download_url"] == f"https://storage.test/{first_key}"
    assert storage.objects[first_key][0] == b"# Q3 memo\n\nDate: 2026-09-01\n"

    # The same file name again is the next revision of the same document, so
    # the user keeps one card with a history rather than two near-identical
    # files.
    edited = await service.record_generated(
        writer_context,
        conversation_id=conversation.id,
        request_id="req-2",
        file_name="/mnt/data/Q3-memo.md",
        mime_type="",
        data=b"# Q3 memo\n\nDate: 2026-09-06\n",
        summary="Produced Q3-memo.md",
    )
    second_key = f"tenants/{tenant.id}/items/{artifact_id}/revisions/2/Q3-memo.md"
    assert edited["id"] == created["id"]
    assert edited["revision"] == 2
    # A workspace path never becomes part of the document's identity.
    assert edited["file_name"] == "Q3-memo.md"
    # The content type is recovered from the extension when none was reported.
    assert edited["mime_type"] == "text/markdown"
    # A revision never overwrites the previous object.
    assert storage.objects[first_key][0] == b"# Q3 memo\n\nDate: 2026-09-01\n"
    assert storage.objects[second_key][0] == b"# Q3 memo\n\nDate: 2026-09-06\n"

    # A different file name is a different document in the same conversation.
    chart = await service.record_generated(
        writer_context,
        conversation_id=conversation.id,
        request_id="req-3",
        file_name="revenue.png",
        mime_type="",
        data=b"\x89PNG fake",
        summary="Produced revenue.png",
    )
    assert chart["id"] != created["id"]
    assert chart["mime_type"] == "image/png"

    with pytest.raises(ArtifactValidationError, match="empty"):
        await service.record_generated(
            writer_context,
            conversation_id=conversation.id,
            request_id="req-4",
            file_name="empty.txt",
            mime_type="text/plain",
            data=b"",
            summary="Produced empty.txt",
        )

    detail = await service.get(writer_context, artifact_id)
    assert [revision["revision"] for revision in detail["revisions"]] == [1, 2]
    assert detail["conversation_id"] == str(conversation.id)
    first_content = await service.content(writer_context, artifact_id, revision=1)
    assert "2026-09-01" in first_content["content"]
    # A binary revision is named, never decoded as text.
    binary = await service.content(writer_context, UUID(chart["id"]))
    assert binary["content"].startswith("(binary document: image/png")

    working = await service.conversation_artifacts(
        writer_context, conversation.id, content_characters=12
    )
    assert [artifact.file_name for artifact in working] == ["Q3-memo.md", "revenue.png"]
    assert working[0].revision == 2
    assert working[0].content_truncated is True
    assert working[0].content.startswith("# Q3 memo")

    # Rebuilding a workspace reads the current revision of each file back out.
    files = await service.conversation_files(writer_context, conversation.id)
    assert {(source.file_name, source.data) for source in files} == {
        ("Q3-memo.md", b"# Q3 memo\n\nDate: 2026-09-06\n"),
        ("revenue.png", b"\x89PNG fake"),
    }

    # Any readable document is a valid source to open into a workspace.
    opened = await service.source_file(writer_context, source_document.id)
    assert opened.title == "NDA template"
    assert opened.file_name == "nda-template.md"
    assert opened.data.startswith(b"# NDA")
    # A document outside the caller's Collections is not a source they can
    # open — and it is reported as missing, never as "exists but denied".
    with pytest.raises(DocumentNotFoundError):
        await service.source_file(reader_context, source_document.id)

    resolved = await service.resolve_access(
        AgentContext(user_id=str(writer.id), tenant_id=str(tenant.id), roles=[])
    )
    assert resolved.user_id == writer.id and resolved.tenant_id == tenant.id

    # The reader shares the tenant but not the writer's private collection.
    with pytest.raises(DocumentNotFoundError):
        await service.get(reader_context, artifact_id)

    # Publishing into the Knowledge Base is explicit and separately authorized;
    # nothing above wrote a conversation file into a Collection on its own.
    published = await service.publish(writer_context, artifact_id, collection_id=library.id)
    assert published["collection_id"] == str(library.id)
    assert published["created"] is True
    assert uploads.calls[0]["collection_id"] == library.id
    assert uploads.calls[0]["content_type"] == "text/markdown"
    assert uploads.calls[0]["data"] == storage.objects[second_key][0]

    # The real remaining guard is authorization: a Collection the caller can
    # only view, not edit, is not a valid publish destination.
    with pytest.raises(AuthorizationError):
        await service.publish(writer_context, artifact_id, collection_id=viewer_only.id)

    # Publishing into a document (not a Collection) is rejected too.
    with pytest.raises(ArtifactValidationError, match="must be a Collection"):
        await service.publish(writer_context, artifact_id, collection_id=source_document.id)

    async with session_factory() as session:
        item = await session.get(Item, artifact_id)
        assert item is not None
        assert item.parent_item_id == ItemService.artifact_collection_id(tenant.id, writer.id)
        assert item.storage_key == second_key
        assert item.metadata_["artifact"]["current_revision"] == 2
        revisions = list(
            await session.scalars(
                select(ArtifactRevision.revision_number)
                .where(ArtifactRevision.item_id == artifact_id)
                .order_by(ArtifactRevision.revision_number)
            )
        )
        assert revisions == [1, 2]
        actions = set(
            await session.scalars(
                select(AuditLog.action).where(AuditLog.resource_id == str(artifact_id))
            )
        )
        assert {"artifact.created", "artifact.revised", "artifact.published"} <= actions
