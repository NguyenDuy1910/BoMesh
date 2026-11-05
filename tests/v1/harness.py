"""The API test harness: real PostgreSQL and the real app, fakes for everything else.

``conftest.py`` creates ONE schema per test run (``Base.metadata.create_all`` +
``sync_catalog``) and empties it before every test, keeping the permission
catalog and predefined roles. Its fixtures:

- ``sessions``: ``async_sessionmaker`` bound to the schema;
- ``fakes``: the :class:`Fakes` the runtime uses (storage, index, workflows, ...);
- ``runtime``: :func:`build_runtime` — an ``AppRuntime`` with :func:`harness_config`;
- ``app``: ``create_app(runtime)``; ``client``: an anonymous :class:`ApiClient`;
- ``world``: the :class:`World` factories.

Fakes are injected by assigning ``AppRuntime``'s lazily-built private
attributes right after construction (``_session_factory``, ``_storage``,
``_index``, ...); the runtime then never builds the real client. This is the
only supported way to inject them.

Every :class:`World` factory commits its own transaction, so the
``Authorizer`` (which reads in its own short transactions) sees the result.
Tests act as a user through ``await client.as_(user)`` (a real access session
and bearer token) or, below the API, with ``Principal(user.id)`` and
``world.authorizer()``.
"""

from __future__ import annotations

import base64
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import httpx
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Contribution,
    Group,
    GroupMembership,
    Item,
    Role,
    Space,
    Tenant,
    TenantMembership,
    User,
)
from bomesh.document_index import ItemIndex
from bomesh.iam.authorizer import Authorizer, ItemRef, Principal, SpaceRef, WorkspaceRef
from bomesh.iam.policy import (
    PERSONAL_KIND,
    SPACE_LEAD,
    WORKSPACE_ADMIN,
    WORKSPACE_MEMBERS,
    PolicyResource,
    PolicyStore,
    role_name,
    set_platform_role,
)
from bomesh.iam.sync import replace_role_permissions
from bomesh.integrations.registry import ConnectionProviderRegistry
from bomesh.runtime import AppRuntime
from bomesh.services.identity.identity_store import IdentityStoreService
from config.env_config import (
    AppConfig,
    IdentityConfig,
    IntegrationConfig,
    IntegrationOAuthConfig,
    ModelConfig,
    OAuthClientConfig,
    RetrievalConfig,
    SandboxConfig,
)
from fakes import (
    ATLASSIAN_REDIRECT_URI,
    FakeEmbedder,
    FakeIndexBackend,
    FakeObjectStorage,
    FakeWorkflows,
    fake_connection_providers,
)
from native_responses import ScriptedResponsesTransport

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
JWT_SECRET = "v1-harness-jwt-secret-with-at-least-32-bytes"
ENCRYPTION_KEY = base64.urlsafe_b64encode(b"k" * 32).decode().rstrip("=")
OAUTH_STATE_SECRET = "v1-harness-oauth-state-secret"
CLIENT_ORIGIN = "https://app.example"

Sessions = async_sessionmaker[AsyncSession]
#: A policy principal: a user, a group, ``"workspaceMembers"`` or a raw member string.
Member = User | Group | str
#: Something a role can be granted on.
Scoped = Tenant | Item | Space | WorkspaceRef | ItemRef | SpaceRef


# -- Runtime -------------------------------------------------------------------


def harness_config() -> AppConfig:
    """Configuration with signing secrets set and every external feature off."""
    return AppConfig(
        identity=IdentityConfig(jwt_secret=JWT_SECRET),
        model=ModelConfig(
            chat_model="test-model",
            embedding_model="fake-embedding",
            contextualization_enabled=False,
        ),
        retrieval=RetrievalConfig(reranking_enabled=False),
        sandbox=SandboxConfig(enabled=False),
        integration=IntegrationConfig(
            credential_encryption_key=ENCRYPTION_KEY,
            oauth=IntegrationOAuthConfig(
                redirect_uri=ATLASSIAN_REDIRECT_URI,
                client_origin=CLIENT_ORIGIN,
                state_secret=OAUTH_STATE_SECRET,
                atlassian=OAuthClientConfig(client_id="client", client_secret="secret"),
            ),
        ),
    )


@dataclass(slots=True)
class Fakes:
    """The fakes a harness runtime is wired with; tests inspect or script them."""

    storage: FakeObjectStorage = field(default_factory=FakeObjectStorage)
    index_backend: FakeIndexBackend = field(default_factory=FakeIndexBackend)
    embedder: FakeEmbedder = field(default_factory=FakeEmbedder)
    workflows: FakeWorkflows = field(default_factory=FakeWorkflows)
    providers: ConnectionProviderRegistry = field(default_factory=fake_connection_providers)
    #: Replace before the first ``runtime.agent()`` call to script the model.
    agent: ScriptedResponsesTransport = field(
        default_factory=lambda: ScriptedResponsesTransport([])
    )


def build_runtime(sessions: Sessions, fakes: Fakes, config: AppConfig | None = None) -> AppRuntime:
    """An ``AppRuntime`` on ``sessions`` whose infrastructure is ``fakes``."""
    runtime = AppRuntime(config or harness_config())
    runtime._session_factory = sessions
    runtime._storage = fakes.storage
    runtime._index = ItemIndex(backend=fakes.index_backend, embedder=fakes.embedder)  # type: ignore[arg-type]
    runtime._workflows = fakes.workflows  # type: ignore[assignment]
    runtime._connection_providers = fakes.providers
    runtime._agent_transport = fakes.agent  # type: ignore[assignment]
    return runtime


# -- API client ----------------------------------------------------------------


class ApiClient:
    """``httpx`` against the ASGI app; :meth:`as_` returns a client acting as a user."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        runtime: AppRuntime,
        *,
        token: str | None = None,
        session_id: UUID | None = None,
        user_id: UUID | None = None,
    ) -> None:
        self.http = http
        self.runtime = runtime
        self.token = token
        #: The access session behind :attr:`token`.
        self.session_id = session_id
        self.user_id = user_id

    async def as_(self, user: User | UUID) -> ApiClient:
        """A client sending ``Authorization: Bearer`` for a new ACTIVE session of ``user``."""
        user_id = user if isinstance(user, UUID) else user.id
        async with transaction_scope(self.runtime.sessions()) as session:
            issued = await self.runtime.access_session_service(session).create(
                user_id, authentication_method="password"
            )
        return ApiClient(
            self.http,
            self.runtime,
            token=issued.access_token,
            session_id=issued.session.id,
            user_id=user_id,
        )

    def with_token(self, token: str) -> ApiClient:
        """A client sending an arbitrary bearer token (garbage, forged, stale)."""
        return ApiClient(self.http, self.runtime, token=token)

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", None) or {})
        if self.token is not None:
            headers.setdefault("Authorization", f"Bearer {self.token}")
        return await self.http.request(method, url, headers=headers, **kwargs)

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("POST", url, **kwargs)

    async def patch(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("PATCH", url, **kwargs)

    async def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("DELETE", url, **kwargs)


# -- Factories -----------------------------------------------------------------


def principal(user: User | UUID, session_id: UUID | None = None) -> Principal:
    return Principal(user if isinstance(user, UUID) else user.id, session_id)


def resource(scope: Scoped) -> PolicyResource:
    """The IAM resource reference of a workspace, collection or space row."""
    match scope:
        case WorkspaceRef() | ItemRef() | SpaceRef():
            return scope
        case Tenant():
            return WorkspaceRef(scope.id)
        case Item():
            return ItemRef(scope.tenant_id, scope.id)
        case Space():
            return SpaceRef(scope.tenant_id, scope.id)
    raise TypeError(f"cannot grant on {scope!r}")


def member_name(member: Member) -> str:
    """``user:{userId}``, ``group:{groupId}`` (the group's code), or a string unchanged."""
    match member:
        case User():
            return f"user:{member.id}"
        case Group():
            return f"group:{member.code}"
        case str():
            return member
    raise TypeError(f"not a principal: {member!r}")


class World:
    """Factories for the smallest valid world; each commits its own transaction."""

    def __init__(self, sessions: Sessions) -> None:
        self.sessions = sessions

    def authorizer(self) -> Authorizer:
        """A fresh request-scoped Authorizer (nothing memoized yet)."""
        return Authorizer(self.sessions)

    # -- People and workspaces ------------------------------------------------

    async def make_user(
        self, email: str | None = None, *, display_name: str | None = None
    ) -> User:
        async with self.sessions.begin() as session:
            return await IdentityStoreService(session).create_user(
                email or f"user-{uuid4().hex[:10]}@example.com", display_name=display_name
            )

    async def make_workspace(
        self, creator: User, *, code: str | None = None, name: str | None = None
    ) -> Tenant:
        """A workspace whose creator is an ACTIVE member holding ``roles/workspaceAdmin``."""
        code = code or f"ws-{uuid4().hex[:10]}"
        async with self.sessions.begin() as session:
            identities = IdentityStoreService(session)
            tenant = await identities.create_tenant(code, name or f"Workspace {code}")
            await identities.assign_membership(creator.id, tenant.id)
            await self._policies(session).add_binding(
                WorkspaceRef(tenant.id), WORKSPACE_ADMIN, member_name(creator)
            )
        return tenant

    async def add_member(
        self,
        workspace: Tenant,
        user: User | None = None,
        role: str | Role | None = "roles/workspaceMember",
    ) -> User:
        """Make ``user`` (a new one by default) an ACTIVE member holding ``role``."""
        user = user or await self.make_user()
        async with self.sessions.begin() as session:
            await IdentityStoreService(session).assign_membership(user.id, workspace.id)
            if role is not None:
                await self._policies(session).add_binding(
                    WorkspaceRef(workspace.id), _role(role), member_name(user)
                )
        return user

    async def suspend_member(self, workspace: Tenant, user: User) -> None:
        async with self.sessions.begin() as session:
            await session.execute(
                update(TenantMembership)
                .where(
                    TenantMembership.tenant_id == workspace.id,
                    TenantMembership.user_id == user.id,
                )
                .values(status="suspended")
            )

    async def activate_member(self, workspace: Tenant, user: User) -> None:
        """SUSPENDED → ACTIVE (ActivateMember); ``add_member`` never reactivates."""
        async with self.sessions.begin() as session:
            await session.execute(
                update(TenantMembership)
                .where(
                    TenantMembership.tenant_id == workspace.id,
                    TenantMembership.user_id == user.id,
                )
                .values(status="active")
            )

    async def suspend_user(self, user: User) -> None:
        async with self.sessions.begin() as session:
            await IdentityStoreService(session).set_user_status(user.id, "suspended")
        user.status = "suspended"

    async def make_group(
        self, workspace: Tenant, members: Iterable[User] = (), *, code: str | None = None
    ) -> Group:
        """A live group of the workspace with ACTIVE memberships for ``members``."""
        code = code or f"group-{uuid4().hex[:8]}"
        async with self.sessions.begin() as session:
            group = Group(tenant_id=workspace.id, code=code, display_name=code.title())
            session.add(group)
            await session.flush()
            for user in members:
                session.add(
                    GroupMembership(group_id=group.id, user_id=user.id, joined_at=_now())
                )
        return group

    async def leave_group(self, group: Group, user: User) -> None:
        async with self.sessions.begin() as session:
            await session.execute(
                update(GroupMembership)
                .where(GroupMembership.group_id == group.id, GroupMembership.user_id == user.id)
                .values(deleted_at=_now())
            )

    async def make_space(
        self,
        workspace: Tenant,
        lead: User,
        *,
        code: str | None = None,
        join_policy: str = "invite",
    ) -> Space:
        """A space whose ``lead`` holds ``roles/spaceLead``."""
        code = code or f"space-{uuid4().hex[:8]}"
        async with self.sessions.begin() as session:
            space = Space(
                tenant_id=workspace.id,
                code=code,
                display_name=code.title(),
                space_type="team",
                join_policy=join_policy,
                created_by_user_id=lead.id,
            )
            session.add(space)
            await session.flush()
            await self._policies(session).add_binding(
                SpaceRef(workspace.id, space.id), SPACE_LEAD, member_name(lead)
            )
        return space

    async def platform_admin(self, user: User) -> User:
        return await self._platform_role(user, "roles/platformAdmin")

    async def platform_operator(self, user: User) -> User:
        return await self._platform_role(user, "roles/platformOperator")

    # -- Roles and grants -----------------------------------------------------

    async def make_role(
        self, workspace: Tenant, code: str, permissions: Iterable[str]
    ) -> Role:
        """A custom (tenant-scoped) role of the workspace carrying ``permissions``."""
        async with self.sessions.begin() as session:
            role = Role(
                tenant_id=workspace.id,
                code=code,
                display_name=code.title(),
                scope_type="tenant",
                is_system=False,
            )
            session.add(role)
            await session.flush()
            await replace_role_permissions(session, role.id, permissions)
        return role

    async def set_role_permissions(self, role: Role, permissions: Iterable[str]) -> None:
        """Make a custom role carry exactly ``permissions`` (revoked ones are tombstoned)."""
        async with self.sessions.begin() as session:
            await replace_role_permissions(session, role.id, permissions)

    async def grant(self, member: Member, role: str | Role, *, on: Scoped) -> None:
        """Bind ``role`` to ``member`` on a workspace, collection or space."""
        async with self.sessions.begin() as session:
            await self._policies(session).add_binding(
                resource(on), _role(role), member_name(member)
            )

    async def revoke(self, member: Member, *, on: Scoped) -> int:
        """End every binding of ``member`` set directly on ``on``."""
        async with self.sessions.begin() as session:
            return await self._policies(session).remove_member(resource(on), member_name(member))

    # -- Items ----------------------------------------------------------------

    async def make_collection(
        self,
        workspace: Tenant,
        parent: Item | None = None,
        *,
        title: str | None = None,
        grants: Mapping[Member, str | Role] | None = None,
        inherit_access: bool | None = None,
        personal_for: User | None = None,
        creator: User | None = None,
    ) -> Item:
        """A live COLLECTION; roots are access boundaries (``inherit_access`` false).

        ``personal_for`` makes the owner's PERSONAL collection (``system_kind``
        ``personal_uploads``) carrying only the owner's ``roles/collectionOwner``.
        """
        grants = dict(grants or {})
        metadata: dict[str, Any] = {}
        if personal_for is not None:
            creator = personal_for
            metadata["system_kind"] = PERSONAL_KIND
            grants[personal_for] = "roles/collectionOwner"
        async with self.sessions.begin() as session:
            item = Item(
                tenant_id=workspace.id,
                item_type="collection",
                parent_item_id=parent.id if parent is not None else None,
                parent_relation="contains" if parent is not None else None,
                title=title or f"Collection {uuid4().hex[:6]}",
                metadata_=metadata,
                inherit_access=parent is not None if inherit_access is None else inherit_access,
                status="ready",
                created_by_user_id=creator.id if creator is not None else None,
            )
            session.add(item)
            await session.flush()
            policies = self._policies(session)
            for member, role in grants.items():
                await policies.add_binding(resource(item), _role(role), member_name(member))
        return item

    async def make_document(
        self,
        parent: Item,
        *,
        published: bool = True,
        title: str | None = None,
        document_type: str = "pdf",
        creator: User | None = None,
    ) -> Item:
        """A READY DOCUMENT in a collection (or a CHILD of a document), index pending."""
        async with self.sessions.begin() as session:
            item = Item(
                tenant_id=parent.tenant_id,
                item_type="document",
                parent_item_id=parent.id,
                parent_relation="contains" if parent.item_type == "collection" else "child",
                document_type=document_type,
                title=title or f"Document {uuid4().hex[:6]}",
                mime_type="application/pdf" if document_type == "pdf" else None,
                status="ready",
                publication_state="published" if published else "unpublished",
                index_status="pending",
                created_by_user_id=creator.id if creator is not None else None,
            )
            session.add(item)
        return item

    async def delete(self, item: Item) -> datetime:
        """Soft-delete the item and its live subtree with one cohort timestamp."""
        now = _now()
        async with self.sessions.begin() as session:
            await session.execute(
                text(
                    """
                    WITH RECURSIVE subtree(id) AS (
                      SELECT CAST(:item_id AS uuid)
                      UNION ALL
                      SELECT i.id FROM items i JOIN subtree s ON i.parent_item_id = s.id
                    )
                    UPDATE items SET deleted_at = :now
                    WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL
                    """
                ),
                {"item_id": item.id, "now": now},
            )
        item.deleted_at = now
        return now

    async def make_contribution(
        self,
        candidate: Item,
        *,
        contributor: User,
        target: Item | None = None,
        state: str = "in_review",
        suggestions: Mapping[str, Any] | None = None,
    ) -> Contribution:
        """A member's NEW_DOCUMENT contribution of ``candidate`` into ``target``."""
        async with self.sessions.begin() as session:
            contribution = Contribution(
                tenant_id=candidate.tenant_id,
                item_id=candidate.id,
                kind="new_document",
                origin="member",
                contributor_user_id=contributor.id,
                target_item_id=target.id if target is not None else None,
                state=state,
                suggestions=dict(suggestions or {}),
            )
            session.add(contribution)
        return contribution

    # -- Internals ------------------------------------------------------------

    def _policies(self, session: AsyncSession) -> PolicyStore:
        return PolicyStore(session, self.authorizer())

    async def _platform_role(self, user: User, role: str) -> User:
        async with self.sessions.begin() as session:
            await set_platform_role(session, user.id, role)
        return user


def _role(role: str | Role) -> str:
    return role if isinstance(role, str) else role_name(role)


def _now() -> datetime:
    return datetime.now(UTC)


__all__ = [
    "CLIENT_ORIGIN",
    "ENCRYPTION_KEY",
    "JWT_SECRET",
    "OAUTH_STATE_SECRET",
    "TEST_DATABASE_URL",
    "WORKSPACE_MEMBERS",
    "ApiClient",
    "Fakes",
    "Member",
    "Scoped",
    "Sessions",
    "World",
    "build_runtime",
    "harness_config",
    "member_name",
    "principal",
    "resource",
]
