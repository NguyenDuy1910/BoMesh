"""Connections (``workspaces/{workspace}/connections/{connection}``) and their OAuth completion.

Visibility: a workspace-owned connection needs ``connections.<method>`` on the
workspace; a personal connection (``owner`` set) is reachable by its owner
only — to anyone else it answers as if absent. Every method therefore first
requires an ACTIVE membership (or the method permission), then applies the
owner/permission rule to the row: without the permission a workspace-owned
connection is PERMISSION_DENIED; NOT_FOUND only for a caller holding it.

OAuth connections are created AUTHORIZING. Their ``authorizationUri`` is
computed on every read from the connector's OAuth client and a sealed state
(workspace, reader, connection, PKCE verifier); nothing is stored until the
provider redirects to ``GET /oauth/callback`` and
:meth:`ConnectionService.complete_authorization` records the grant. A
connection created with an ``apiToken`` (and the connector's non-secret
``config``, immutable afterwards) is ACTIVE at once.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import and_, exists, false, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.connector import ConnectorDefinition
from bomesh.connector.registry import ConnectorRegistry
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import IngestionSource, IntegrationConnection
from bomesh.errors import (
    AlreadyExists,
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
    Unavailable,
)
from bomesh.iam.authorizer import Authorizer, Principal, WorkspaceRef, permission_denied
from bomesh.integrations import (
    ConnectionProvider,
    IntegrationAuthorizationError,
    IntegrationConfigurationError,
    IntegrationError,
    ProviderCredentials,
    ProviderResource,
)
from bomesh.integrations.registry import ConnectionProviderRegistry
from bomesh.services import (
    CONNECTION_ACTIVE,
    CONNECTION_AUTHORIZING,
    CONNECTION_FAILED,
    CONNECTION_REAUTHORIZATION_REQUIRED,
    ConnectionAuthorizationRequiredError,
)
from bomesh.services.ingestion.common import connector_name
from bomesh.services.ingestion.connection_store import (
    IntegrationConnectionService,
    connector_is_active,
    refresh_if_expiring,
)
from bomesh.services.ingestion.names import connection_name
from bomesh.services.ingestion.oauth_flow import IntegrationAuthorizationService
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import (
    WorkspaceResolver,
    require_usable,
    workspace_name,
)

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: Client-chosen connection IDs (AIP-122): lowercase letters, digits and hyphens.
CONNECTION_ID = re.compile(r"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$")
#: ErrorInfo reason of TestConnection on a connection that is not ACTIVE.
CONNECTION_NOT_ACTIVE = "CONNECTION_NOT_ACTIVE"
_MAX_DISPLAY_NAME = 255
_NAME_ATTEMPTS = 20


@dataclass(frozen=True, slots=True)
class NewConnection:
    """The body of CreateConnection; ``owner_user_id`` set = personal connection."""

    connector_key: str
    display_name: str | None = None
    owner_user_id: UUID | None = None
    api_token: str | None = None
    config: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ConnectionView:
    """A connection as one caller reads it."""

    connection: IntegrationConnection
    authorization_uri: str | None
    etag: str | None

    @property
    def name(self) -> str:
        return connection_name(self.connection.tenant_id, self.connection.code)


@dataclass(frozen=True, slots=True)
class ConnectionTest:
    """``TestConnectionResponse``."""

    ok: bool
    message: str
    connection: ConnectionView


@dataclass(frozen=True, slots=True)
class BrowsedResource:
    """``ConnectionResource``: ``path`` lists this resource's children."""

    resource_id: str
    display_name: str
    type: str
    path: str
    has_children: bool


@dataclass(frozen=True, slots=True)
class _Loaded:
    connection: IntegrationConnection
    provider: ConnectionProvider | None
    credentials: ProviderCredentials | None


class ConnectionService:
    """The Connection resource of the Ingestion interface."""

    def __init__(
        self,
        sessions: SessionFactory,
        *,
        providers: ConnectionProviderRegistry,
        credential_encryption_key: str | None,
        authorization: IntegrationAuthorizationService,
        request_hash_secret: bytes,
        connectors: ConnectorRegistry | None = None,
    ) -> None:
        self._sessions = sessions
        self._providers = providers
        self._encryption_key = credential_encryption_key
        self._authorization = authorization
        self._secret = request_hash_secret
        self._connectors = connectors or ConnectorRegistry.default()
        self._workspaces = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> ConnectionService:
        return cls(
            runtime.sessions(),
            providers=runtime.connection_providers(),
            credential_encryption_key=runtime.config.integration.credential_encryption_key,
            authorization=runtime.integration_authorization_service(),
            request_hash_secret=runtime.request_hash_secret(),
        )

    # -- Standard methods ----------------------------------------------------

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        new: NewConnection,
        *,
        connection_id: str | None,
        request_id: UUID | None,
        validate_only: bool,
    ) -> ConnectionView:
        held = await self._open(ctx, workspace_id, "connections.create", write=True)
        if new.owner_user_id is None and not held:
            raise permission_denied("connections.create", WorkspaceRef(workspace_id))
        if new.owner_user_id is not None and new.owner_user_id != ctx.user_id:
            raise PermissionDenied("A personal connection can only be created for oneself.")
        if connection_id is not None and not CONNECTION_ID.match(connection_id):
            raise InvalidArgument.for_field(
                "connectionId",
                "connectionId must be 1-63 lowercase letters, digits or hyphens, "
                "starting with a letter.",
            )
        definition = self._definition(new.connector_key)
        config = _check_credentials(definition, new.api_token, new.config)
        oauth = _authorized_by_oauth(definition, new.api_token)
        display_name = _display_name(new.display_name) if new.display_name is not None else None
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = (
                idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateConnection",
                    parent=workspace_name(workspace_id),
                    request={
                        "connectionId": connection_id,
                        "connector": new.connector_key,
                        "displayName": new.display_name,
                        "owner": str(new.owner_user_id or ""),
                        "apiToken": new.api_token,
                        "config": config,
                    },
                )
                if request_id is not None and not validate_only
                else None
            )
            replayed = await idempotency.replay(key) if key is not None else None
            if replayed is None:
                if not await connector_is_active(session, definition.key):
                    raise FailedPrecondition(f"Connector '{connector_name(definition.key)}' is not ACTIVE.")
                engine = self._engine(session)
                if oauth:
                    provider = await engine.provider(definition.key)
                    if provider is None or not provider.configured:
                        raise FailedPrecondition(
                            f"OAuth is not configured for connector '{definition.key}'."
                        )
                code = connection_id or str(uuid4())
                if await _code_taken(session, workspace_id, code):
                    raise AlreadyExists(
                        f"Connection '{connection_name(workspace_id, code)}' already exists."
                    )
                if display_name is not None and await _name_taken(session, workspace_id, display_name):
                    raise AlreadyExists(f"A connection named '{display_name}' already exists.")
                connection = IntegrationConnection(
                    id=uuid4(),
                    tenant_id=workspace_id,
                    code=code,
                    connector_key=definition.key,
                    owner_user_id=new.owner_user_id,
                    display_name=display_name
                    or await _available_name(session, workspace_id, definition.display_name),
                    config=config,
                    scopes=[],
                    status=CONNECTION_AUTHORIZING if oauth else CONNECTION_ACTIVE,
                    created_by_user_id=ctx.user_id,
                )
                if validate_only:
                    return ConnectionView(connection, authorization_uri=None, etag=None)
                session.add(connection)
                await session.flush()
                if new.api_token is not None:
                    await engine.store_api_token(connection, new.api_token)
                    connection.connected_at = datetime.now(UTC)
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="sources",
                    action="CreateConnection",
                    target=connection_name(workspace_id, code),
                    details={"connector": definition.key, "personal": new.owner_user_id is not None},
                )
                if key is not None:
                    await idempotency.remember(key, connection_name(workspace_id, code))
            else:
                code = replayed.rsplit("/", 1)[-1]
        return await self.get(ctx, workspace_id, code)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> tuple[list[ConnectionView], int]:
        """Workspace-owned connections (with ``connections.get``) and the caller's own."""
        await self._open(ctx, workspace_id, "connections.list", write=False)
        readable = await self._held(ctx, workspace_id, "connections.get")
        statement = select(IntegrationConnection).where(
            IntegrationConnection.tenant_id == workspace_id,
            IntegrationConnection.deleted_at.is_(None),
            or_(
                IntegrationConnection.owner_user_id == ctx.user_id,
                and_(
                    IntegrationConnection.owner_user_id.is_(None),
                    true() if readable else false(),
                ),
            ),
        )
        async with transaction_scope(self._sessions) as session:
            total = int(await session.scalar(query.count(statement)) or 0)
            rows = list(await session.scalars(query.apply(statement)))
            return await self._views(session, ctx, rows), total

    async def get(self, ctx: RequestContext, workspace_id: UUID, code: str) -> ConnectionView:
        held = await self._open(ctx, workspace_id, "connections.get", write=False)
        async with transaction_scope(self._sessions) as session:
            connection = await self._visible(session, ctx, workspace_id, code, "connections.get", held)
            return (await self._views(session, ctx, [connection]))[0]

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        display_name: str | None,
        etag: str | None,
    ) -> ConnectionView:
        """Rename; ``display_name`` None leaves the name as is (empty mask)."""
        held = await self._open(ctx, workspace_id, "connections.update", write=True)
        async with transaction_scope(self._sessions) as session:
            connection = await self._visible(
                session, ctx, workspace_id, code, "connections.update", held, for_update=True
            )
            etags.check(etag, _etag(connection))
            if display_name is not None:
                name = _display_name(display_name)
                if name != connection.display_name:
                    if await _name_taken(session, workspace_id, name):
                        raise AlreadyExists(f"A connection named '{name}' already exists.")
                    connection.display_name = name
                    await session.flush()
                    await Audit(session).record(
                        ctx,
                        workspace_id=workspace_id,
                        category="sources",
                        action="UpdateConnection",
                        target=connection_name(workspace_id, code),
                    )
        return await self.get(ctx, workspace_id, code)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None
    ) -> None:
        """Revoke the grant (best effort), destroy the secret and tombstone the connection."""
        held = await self._open(ctx, workspace_id, "connections.delete", write=True)
        async with transaction_scope(self._sessions) as session:
            connection = await self._visible(session, ctx, workspace_id, code, "connections.delete", held)
            etags.check(etag, _etag(connection))
            await _require_unused(session, connection)
            loaded = await self._load_credentials(session, connection)
        if loaded.provider is not None and loaded.credentials is not None:
            try:
                await loaded.provider.revoke(loaded.credentials)
            except IntegrationError:
                pass  # the grant may already be gone; forgetting the secret still happens
        async with transaction_scope(self._sessions) as session:
            connection = await self._visible(
                session, ctx, workspace_id, code, "connections.delete", held, for_update=True
            )
            await _require_unused(session, connection)
            await self._engine(session).clear_credentials(connection)
            connection.deleted_at = datetime.now(UTC)
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="sources",
                action="DeleteConnection",
                target=connection_name(workspace_id, code),
            )

    # -- Custom methods ------------------------------------------------------

    async def reauthorize(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None
    ) -> ConnectionView:
        """Back to AUTHORIZING with a fresh ``authorizationUri``; OAuth connectors only."""
        held = await self._open(ctx, workspace_id, "connections.reauthorize", write=True)
        async with transaction_scope(self._sessions) as session:
            connection = await self._visible(
                session, ctx, workspace_id, code, "connections.reauthorize", held, for_update=True
            )
            etags.check(etag, _etag(connection))
            definition = self._definition(connection.connector_key)
            if definition.authentication_type != "oauth":
                raise FailedPrecondition(
                    f"Connector '{definition.key}' is not authorized with OAuth."
                )
            await self._require_authorizable(session, connection.connector_key)
            connection.status = CONNECTION_AUTHORIZING
            connection.status_detail = None
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="sources",
                action="ReauthorizeConnection",
                target=connection_name(workspace_id, code),
            )
        return await self.get(ctx, workspace_id, code)

    async def test(self, ctx: RequestContext, workspace_id: UUID, code: str) -> ConnectionTest:
        """Check the credentials of an ACTIVE connection against the provider and record it."""
        held = await self._open(ctx, workspace_id, "connections.test", write=True)
        async with transaction_scope(self._sessions) as session:
            connection = await self._visible(session, ctx, workspace_id, code, "connections.test", held)
            if connection.status != CONNECTION_ACTIVE:
                raise FailedPrecondition(
                    f"The connection is {connection.status.upper()}, not ACTIVE.",
                    reason=CONNECTION_NOT_ACTIVE,
                )
            loaded = await self._load_credentials(session, connection)
        status, message, refreshed = await _probe(loaded)
        async with transaction_scope(self._sessions) as session:
            connection = await self._visible(
                session, ctx, workspace_id, code, "connections.test", held, for_update=True
            )
            engine = self._engine(session)
            if refreshed is not None:
                await engine.store_oauth_credentials(connection, refreshed)
            await engine.record_health(
                connection.id, status=status, detail="" if status == CONNECTION_ACTIVE else message
            )
            if status == CONNECTION_ACTIVE:
                connection.status_detail = None
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="sources",
                action="TestConnection",
                target=connection_name(workspace_id, code),
                outcome="succeeded" if status == CONNECTION_ACTIVE else "failed",
            )
            await session.refresh(connection)
            view = (await self._views(session, ctx, [connection]))[0]
        return ConnectionTest(ok=status == CONNECTION_ACTIVE, message=message, connection=view)

    async def browse(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, path: str | None
    ) -> list[BrowsedResource]:
        """What the connection's account can reach under ``path`` (provider parent ID)."""
        held = await self._open(ctx, workspace_id, "connections.browseResources", write=False)
        async with transaction_scope(self._sessions) as session:
            connection = await self._visible(
                session, ctx, workspace_id, code, "connections.browseResources", held
            )
            if connection.status != CONNECTION_ACTIVE:
                raise FailedPrecondition(
                    f"The connection is {connection.status.upper()}, not ACTIVE."
                )
            loaded = await self._load_credentials(session, connection)
        if loaded.provider is None:
            return await self._browse_with_connector(connection, path)
        if loaded.credentials is None:
            raise FailedPrecondition("No credential is stored; reauthorize the connection.")
        try:
            refreshed = await refresh_if_expiring(loaded.provider, connection, loaded.credentials)
            resources = await loaded.provider.list_resources(
                refreshed or loaded.credentials,
                connector_key=connection.connector_key,
                parent_id=path or None,
            )
        except IntegrationAuthorizationError as exc:
            await self._record_health(connection.id, CONNECTION_REAUTHORIZATION_REQUIRED, str(exc))
            raise FailedPrecondition(
                "The provider refused this connection; it must be reauthorized."
            ) from exc
        except IntegrationError as exc:
            raise Unavailable(str(exc)) from exc
        if refreshed is not None:
            async with transaction_scope(self._sessions) as session:
                live = await session.get(IntegrationConnection, connection.id, with_for_update=True)
                if live is not None and live.deleted_at is None:
                    await self._engine(session).store_oauth_credentials(live, refreshed)
        return [_browsed(resource) for resource in resources]

    async def _browse_with_connector(
        self, connection: IntegrationConnection, path: str | None
    ) -> list[BrowsedResource]:
        """A token connection lists through its connector runtime, with its own credential."""
        try:
            async with transaction_scope(self._sessions) as session:
                runtime = await self._engine(session).runtime_for(connection, source_config={})
        except ConnectionAuthorizationRequiredError as exc:
            raise FailedPrecondition(str(exc)) from exc
        lister = getattr(runtime, "list_resources", None)
        if lister is None:
            raise FailedPrecondition("This connection cannot browse its resources.")
        try:
            listed = await lister(parent_id=path or None)
        except NotImplementedError as exc:
            raise FailedPrecondition("This connection cannot browse its resources.") from exc
        except Exception as exc:  # noqa: BLE001 - any client-library failure of the site
            if _http_status(exc) in {401, 403}:
                await self._record_health(
                    connection.id,
                    CONNECTION_REAUTHORIZATION_REQUIRED,
                    "The site refused the connection's credentials.",
                )
                raise FailedPrecondition(
                    "The site refused this connection's credentials; it must be reauthorized."
                ) from exc
            raise Unavailable("The site could not list its resources.") from exc
        return [_listed(entry) for entry in listed]

    # -- OAuth completion ----------------------------------------------------

    @property
    def client_origin(self) -> str:
        """The web origin the callback page posts its result to."""
        return self._authorization.client_origin

    def authorization_nonce(self, state: str) -> str:
        """The nonce sealed in ``state``; INVALID_ARGUMENT for a forged or expired state."""
        return self._authorization.read_state(state).nonce

    async def complete_authorization(self, state: str, code: str) -> IntegrationConnection:
        """Exchange the provider's code and make the state's connection ACTIVE.

        The sealed state is the authority: its user must still be an ACTIVE
        member and still allowed (the owner of a personal connection;
        ``connections.create`` or ``.reauthorize`` for a workspace-owned one).
        Authorizing an account that an existing connection of the same owner
        already holds completes that connection instead; the new, never
        authorized one is withdrawn.
        """
        pending = self._authorization.read_state(state)
        workspace_id, user_id = UUID(pending.tenant_id), UUID(pending.user_id)
        connection_id = UUID(pending.connection_id)
        ctx = RequestContext(principal=Principal(user_id), authorizer=Authorizer(self._sessions))
        require_usable(await self._workspaces.get(workspace_id), write=True)
        async with transaction_scope(self._sessions) as session:
            connection = await _live(session, workspace_id, connection_id)
            await _require_completer(ctx, connection)
            provider = await self._require_authorizable(session, connection.connector_key)
        grant = await self._authorization.exchange(provider, pending, code=code)
        async with transaction_scope(self._sessions) as session:
            connection = await _live(session, workspace_id, connection_id, for_update=True)
            existing = await _holder_of(session, connection, grant.account.account_id, grant.account.resource_id)
            if existing is not None:
                if connection.provider_account_id is not None:
                    raise FailedPrecondition(
                        f"This account is already connected as '{existing.display_name}'."
                    )
                connection.deleted_at = datetime.now(UTC)
                await session.flush()
                connection = existing
            await self._engine(session).record_grant(connection, grant)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="sources",
                action="CompleteConnectionAuthorization",
                target=connection_name(workspace_id, connection.code),
                details={"connector": connection.connector_key},
            )
            await session.refresh(connection)
            return connection

    # -- Internals -----------------------------------------------------------

    async def _open(
        self, ctx: RequestContext, workspace_id: UUID, permission: str, *, write: bool
    ) -> bool:
        """Gate the workspace; whether the caller holds ``permission`` there.

        A caller without the permission passes as an ACTIVE member (personal
        connections need nothing else).
        """
        ref = WorkspaceRef(workspace_id)
        if await self._held(ctx, workspace_id, permission):
            await self._workspaces.open(ctx, ref, permission, write=write)
            return True
        if not await ctx.authorizer.is_active_member(ctx.principal, workspace_id):
            raise permission_denied(permission, ref)
        require_usable(await self._workspaces.get(workspace_id), write=write)
        return False

    @staticmethod
    async def _held(ctx: RequestContext, workspace_id: UUID, permission: str) -> bool:
        return permission in await ctx.authorizer.permissions(
            ctx.principal, WorkspaceRef(workspace_id)
        )

    async def _visible(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        permission: str,
        held: bool,
        *,
        for_update: bool = False,
    ) -> IntegrationConnection:
        statement = select(IntegrationConnection).where(
            IntegrationConnection.tenant_id == workspace_id,
            IntegrationConnection.code == code,
            IntegrationConnection.deleted_at.is_(None),
        )
        if for_update:
            statement = statement.with_for_update().execution_options(populate_existing=True)
        connection = await session.scalar(statement)
        if connection is not None and (
            connection.owner_user_id == ctx.user_id
            or connection.owner_user_id is None
            and held
        ):
            return connection
        name = connection_name(workspace_id, code)
        if held:
            raise NotFound(f"Connection '{name}' does not exist.")
        raise PermissionDenied(
            f"Permission '{permission}' denied on resource '{name}' (or it might not exist)",
            metadata={"permission": permission, "resource": name},
        )

    async def _views(
        self, session: AsyncSession, ctx: RequestContext, connections: Sequence[IntegrationConnection]
    ) -> list[ConnectionView]:
        providers: dict[str, ConnectionProvider | None] = {}
        views = []
        for connection in connections:
            uri = None
            if connection.status == CONNECTION_AUTHORIZING:
                key = connection.connector_key
                if key not in providers:
                    providers[key] = await self._authorizing_provider(session, key)
                uri = self._authorization_uri(providers[key], ctx, connection)
            views.append(ConnectionView(connection, authorization_uri=uri, etag=_etag(connection)))
        return views

    async def _authorizing_provider(
        self, session: AsyncSession, connector_key: str
    ) -> ConnectionProvider | None:
        if not await connector_is_active(session, connector_key):
            return None
        provider = await self._engine(session).provider(connector_key)
        return provider if provider is not None and provider.configured else None

    def _authorization_uri(
        self, provider: ConnectionProvider | None, ctx: RequestContext, connection: IntegrationConnection
    ) -> str | None:
        if provider is None:
            return None
        try:
            return self._authorization.authorization_uri(
                provider,
                workspace_id=connection.tenant_id,
                user_id=ctx.user_id,
                connection_id=connection.id,
                connector_key=connection.connector_key,
            )
        except IntegrationConfigurationError:
            return None

    async def _require_authorizable(
        self, session: AsyncSession, connector_key: str
    ) -> ConnectionProvider:
        """The connector's configured OAuth provider; FAILED_PRECONDITION otherwise."""
        if not await connector_is_active(session, connector_key):
            raise FailedPrecondition(f"Connector '{connector_name(connector_key)}' is not ACTIVE.")
        provider = await self._authorizing_provider(session, connector_key)
        if provider is None:
            raise FailedPrecondition(f"OAuth is not configured for connector '{connector_key}'.")
        return provider

    async def _load_credentials(
        self, session: AsyncSession, connection: IntegrationConnection
    ) -> _Loaded:
        engine = self._engine(session)
        return _Loaded(
            connection=connection,
            provider=await engine.connection_provider(connection),
            credentials=await engine.stored_credentials(connection),
        )

    async def _record_health(self, connection_id: UUID, status: str, detail: str) -> None:
        async with transaction_scope(self._sessions) as session:
            await self._engine(session).record_health(connection_id, status=status, detail=detail)

    def _definition(self, connector_key: str) -> ConnectorDefinition:
        try:
            return self._connectors.get(connector_key)
        except LookupError:
            raise InvalidArgument.for_field(
                "connector", f"'{connector_name(connector_key)}' is not a connector."
            ) from None

    def _engine(self, session: AsyncSession) -> IntegrationConnectionService:
        return IntegrationConnectionService(
            session,
            providers=self._providers,
            credential_encryption_key=self._encryption_key,
            connectors=self._connectors,
        )


async def _probe(
    loaded: _Loaded,
) -> tuple[str, str, ProviderCredentials | None]:
    """``(status, message, refreshed credentials)`` of one credential check."""
    if loaded.credentials is None:
        return CONNECTION_REAUTHORIZATION_REQUIRED, "No credential is stored for this connection.", None
    if loaded.provider is None:
        return CONNECTION_ACTIVE, "The connection's credentials are stored.", None
    connection = loaded.connection
    try:
        refreshed = await refresh_if_expiring(loaded.provider, connection, loaded.credentials)
        await loaded.provider.list_resources(
            refreshed or loaded.credentials, connector_key=connection.connector_key
        )
    except IntegrationAuthorizationError as exc:
        return CONNECTION_REAUTHORIZATION_REQUIRED, str(exc), None
    except IntegrationError as exc:
        return CONNECTION_FAILED, str(exc), None
    return CONNECTION_ACTIVE, "The provider accepted the connection's credentials.", refreshed


def _check_credentials(
    definition: ConnectorDefinition, api_token: str | None, config: Mapping[str, str]
) -> dict[str, str]:
    """Validate ``apiToken`` and ``config`` for the connector; the config to store.

    An API token is accepted only by connectors that take one and is required by
    ``api_token`` connectors. ``config`` is the connector's non-secret settings
    of a token or unauthenticated connection; an OAuth grant writes its own.
    """
    if api_token is not None and not api_token.strip():
        raise InvalidArgument.for_field("apiToken", "apiToken must not be empty.")
    if api_token is not None and not definition.takes_api_token:
        raise InvalidArgument.for_field(
            "apiToken", f"Connector '{definition.key}' does not take an apiToken."
        )
    if definition.authentication_type == "api_token" and api_token is None:
        raise InvalidArgument.for_field(
            "apiToken", f"Connector '{definition.key}' needs an apiToken."
        )
    if _authorized_by_oauth(definition, api_token):
        if config:
            raise InvalidArgument.for_field(
                "config",
                f"An OAuth connection of '{definition.key}' takes its configuration "
                "from the authorization; set config only with an apiToken.",
            )
        return {}
    unknown = sorted(set(config) - definition.config_keys)
    if unknown:
        allowed = ", ".join(sorted(definition.config_keys)) or "none"
        raise InvalidArgument.for_field(
            "config", f"Unknown config keys {unknown} for '{definition.key}'; allowed: {allowed}."
        )
    values = {key: value.strip() for key, value in config.items()}
    missing = sorted(key for key in definition.required_config_keys if not values.get(key))
    if missing:
        raise InvalidArgument.for_field(
            "config", f"Connector '{definition.key}' needs config keys {missing}."
        )
    return IntegrationConnectionService.non_secret_config(values)


def _authorized_by_oauth(definition: ConnectorDefinition, api_token: str | None) -> bool:
    """Whether a new connection waits for a provider grant (AUTHORIZING)."""
    return definition.authentication_type == "oauth" and api_token is None


def _display_name(value: str) -> str:
    name = value.strip()
    if not name or len(name) > _MAX_DISPLAY_NAME:
        raise InvalidArgument.for_field(
            "displayName", f"displayName must be 1-{_MAX_DISPLAY_NAME} characters."
        )
    return name


async def _code_taken(session: AsyncSession, workspace_id: UUID, code: str) -> bool:
    """IDs stay reserved after deletion (``(tenant_id, code)`` is unique)."""
    return bool(
        await session.scalar(
            select(
                exists().where(
                    IntegrationConnection.tenant_id == workspace_id,
                    IntegrationConnection.code == code,
                )
            )
        )
    )


async def _name_taken(session: AsyncSession, workspace_id: UUID, name: str) -> bool:
    """Display names are unique per workspace, deleted connections included."""
    return bool(
        await session.scalar(
            select(
                exists().where(
                    IntegrationConnection.tenant_id == workspace_id,
                    IntegrationConnection.display_name == name,
                )
            )
        )
    )


async def _available_name(session: AsyncSession, workspace_id: UUID, base: str) -> str:
    """``base``, or ``base (n)`` for the first free n: a generated name never conflicts."""
    for attempt in range(1, _NAME_ATTEMPTS + 1):
        candidate = base if attempt == 1 else f"{base[: _MAX_DISPLAY_NAME - 8]} ({attempt})"
        if not await _name_taken(session, workspace_id, candidate):
            return candidate
    return f"{base[: _MAX_DISPLAY_NAME - 33]} ({uuid4().hex})"


async def _require_unused(session: AsyncSession, connection: IntegrationConnection) -> None:
    used = await session.scalar(
        select(
            exists().where(
                IngestionSource.integration_connection_id == connection.id,
                IngestionSource.deleted_at.is_(None),
            )
        )
    )
    if used:
        raise FailedPrecondition("Sources still use this connection; delete them first.")


async def _live(
    session: AsyncSession, workspace_id: UUID, connection_id: UUID, *, for_update: bool = False
) -> IntegrationConnection:
    statement = select(IntegrationConnection).where(
        IntegrationConnection.id == connection_id,
        IntegrationConnection.tenant_id == workspace_id,
        IntegrationConnection.deleted_at.is_(None),
    )
    if for_update:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    connection = await session.scalar(statement)
    if connection is None:
        raise NotFound("The connection being authorized no longer exists.")
    return connection


async def _require_completer(ctx: RequestContext, connection: IntegrationConnection) -> None:
    workspace_id = connection.tenant_id
    if not await ctx.authorizer.is_active_member(ctx.principal, workspace_id):
        raise PermissionDenied("Only an active workspace member can complete an authorization.")
    if connection.owner_user_id is not None:
        if connection.owner_user_id != ctx.user_id:
            raise PermissionDenied("A personal connection is authorized by its owner only.")
        return
    held = await ctx.authorizer.permissions(ctx.principal, WorkspaceRef(workspace_id))
    if not held & {"connections.create", "connections.reauthorize"}:
        raise permission_denied("connections.reauthorize", WorkspaceRef(workspace_id))


async def _holder_of(
    session: AsyncSession,
    connection: IntegrationConnection,
    account_id: str,
    resource_id: str | None,
) -> IntegrationConnection | None:
    """Another live connection of the same owner already bound to this provider account."""
    owner = IntegrationConnection.owner_user_id
    return await session.scalar(
        select(IntegrationConnection)
        .where(
            IntegrationConnection.tenant_id == connection.tenant_id,
            IntegrationConnection.connector_key == connection.connector_key,
            owner.is_(None) if connection.owner_user_id is None else owner == connection.owner_user_id,
            IntegrationConnection.provider_account_id == account_id,
            IntegrationConnection.provider_resource_id.is_not_distinct_from(resource_id),
            IntegrationConnection.deleted_at.is_(None),
            IntegrationConnection.id != connection.id,
        )
        .with_for_update()
    )


def _browsed(resource: ProviderResource) -> BrowsedResource:
    return BrowsedResource(
        resource_id=resource.external_id,
        display_name=resource.name,
        type=resource.resource_type,
        path=resource.external_id,
        has_children=resource.has_children,
    )


def _listed(entry: Mapping[str, Any]) -> BrowsedResource:
    """One resource a connector runtime listed (``resource_type``, ``external_id``, ...)."""
    external_id = str(entry["external_id"])
    return BrowsedResource(
        resource_id=external_id,
        display_name=str(entry.get("name") or external_id),
        type=str(entry["resource_type"]),
        path=external_id,
        has_children=bool(entry.get("has_children")),
    )


def _http_status(exc: BaseException) -> int | None:
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status if isinstance(status, int) else None



def _etag(connection: IntegrationConnection) -> str:
    return etags.compute(
        connection_name(connection.tenant_id, connection.code), connection.updated_at
    )


__all__ = [
    "CONNECTION_ID",
    "BrowsedResource",
    "ConnectionService",
    "ConnectionTest",
    "ConnectionView",
    "NewConnection",
]
