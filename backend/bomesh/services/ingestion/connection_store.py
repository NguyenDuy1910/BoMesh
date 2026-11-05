"""Connection engine: credentials, provider resolution and runtimes of one Connection.

A Connection answers *whose access is this and is it still good*. It never
knows which documents are indexed, and it carries no provider branch: anything
specific to Google or Atlassian lives behind the ``ConnectionProvider`` this
engine resolves — with the platform's OAuth client — from the registry.

The engine works inside the caller's session and authorizes nothing; the
Connection API (``bomesh.services.ingestion.connections``) and the source
sync are its callers.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, NoReturn
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.connector import ConnectorDefinition
from bomesh.connector.base import BaseSourceConnector
from bomesh.connector.registry import ConnectorRegistry
from bomesh.db.models import IntegrationConnection, PlatformConnectorSettings
from bomesh.errors import FailedPrecondition, InvalidArgument, Unavailable
from bomesh.integrations import (
    AuthorizationGrant,
    ConnectionProvider,
    IntegrationAuthorizationError,
    IntegrationError,
    ProviderCredentials,
    ProviderResource,
)
from bomesh.integrations.registry import ConnectionProviderRegistry
from bomesh.services import (
    CONNECTION_ACTIVE,
    CONNECTION_NEEDS_AUTHORIZATION,
    CONNECTION_REAUTHORIZATION_REQUIRED,
    ConnectionAuthorizationRequiredError,
)
from bomesh.services.ingestion.credentials import (
    IntegrationCredentialService,
    open_client_secret,
)

_SECRET_KEY_TERMS = {
    "access_key",
    "api_key",
    "authorization",
    "password",
    "secret",
    "token",
}
_OAUTH_GRANT = "oauth_grant"
_API_TOKEN = "api_token"
#: Refresh this far ahead of expiry so a long sync does not start on a token
#: that dies mid-run.
_REFRESH_MARGIN = timedelta(minutes=5)


class IntegrationConnectionService:
    """Credentials, health and runtimes of Connections, inside one session."""

    def __init__(
        self,
        session: AsyncSession,
        *,
        providers: ConnectionProviderRegistry,
        credential_encryption_key: str | None,
        connectors: ConnectorRegistry | None = None,
    ) -> None:
        self._session = session
        self._providers = providers
        self._connectors = connectors or ConnectorRegistry.default()
        self._encryption_key = credential_encryption_key

    # -- Providers -----------------------------------------------------------

    async def provider(self, connector_key: str) -> ConnectionProvider | None:
        """The provider authorizing ``connector_key``, with the platform OAuth client.

        The client ID and secret stored in ``platform_connector_settings`` win;
        a value not stored there comes from the deployment environment.
        """

        provider = self._providers.for_connector(connector_key)
        if provider is None:
            return None
        settings = await self._session.get(PlatformConnectorSettings, connector_key)
        if settings is None:
            return provider
        sealed = settings.oauth_client_secret_encrypted
        secret = (
            open_client_secret(self._key(), connector_key, sealed)
            if sealed is not None
            else None
        )
        return provider.with_client(settings.oauth_client_id, secret)

    async def connection_provider(
        self, connection: IntegrationConnection
    ) -> ConnectionProvider | None:
        """The provider that authorized ``connection``; ``None`` for a token or keyless one.

        A connector reached through a provider can also be connected with an API
        token: such a connection never asks the provider (no refresh, no
        provider listing, no provider runtime endpoints).
        """

        if connection.provider_account_id is None:
            return None
        return await self.provider(connection.connector_key)

    # -- Credentials ---------------------------------------------------------

    async def stored_credentials(
        self, connection: IntegrationConnection
    ) -> ProviderCredentials | None:
        """The connection's decrypted credentials, or ``None`` when none are stored."""

        try:
            values = await self._credentials().resolve(connection.id)
        except LookupError:
            return None
        return ProviderCredentials(values=values, expires_at=connection.expires_at)

    async def store_api_token(self, connection: IntegrationConnection, token: str) -> None:
        await self._credentials().store(
            connection.id, credential_type=_API_TOKEN, payload={"api_token": token}
        )

    async def store_oauth_credentials(
        self, connection: IntegrationConnection, credentials: ProviderCredentials
    ) -> None:
        """Keep rotated grant credentials; the connection is ACTIVE again."""

        await self._credentials().store(
            connection.id,
            credential_type=_OAUTH_GRANT,
            payload=credentials.values,
            expires_at=credentials.expires_at,
        )
        connection.expires_at = credentials.expires_at
        connection.status = CONNECTION_ACTIVE
        connection.status_detail = None
        await self._session.flush()

    async def record_grant(
        self, connection: IntegrationConnection, grant: AuthorizationGrant
    ) -> None:
        """Bind a completed authorization to ``connection`` and make it ACTIVE."""

        now = datetime.now(UTC)
        connection.provider_account_id = grant.account.account_id
        connection.provider_account_label = grant.account.label
        connection.provider_resource_id = grant.account.resource_id
        connection.provider_resource_label = grant.account.resource_label
        connection.scopes = list(grant.scopes)
        connection.config = self.non_secret_config(
            {**dict(connection.config or {}), **dict(grant.config)}
        )
        connection.connected_at = now
        connection.last_checked_at = now
        await self.store_oauth_credentials(connection, grant.credentials)

    async def clear_credentials(self, connection: IntegrationConnection) -> None:
        """Destroy the connection's secret (the credential record stays)."""

        await self._credentials().clear(connection.id)
        connection.expires_at = None
        await self._session.flush()

    # -- Runtime (sources and syncs) -----------------------------------------

    async def runtime_for(
        self,
        connection: IntegrationConnection,
        *,
        source_config: Mapping[str, Any],
    ) -> BaseSourceConnector:
        """Build the connector runtime for one connection and one source."""

        definition = self._definition(connection.connector_key)
        if definition.factory is None:
            raise FailedPrecondition(f"Connector '{definition.key}' is not supported.")
        provider = await self.connection_provider(connection)
        credentials = await self._usable_credentials(connection, provider)
        runtime_config = {
            **dict(connection.config),
            **(
                dict(provider.connector_runtime_config(connection.connector_key))
                if provider is not None
                else {}
            ),
            "_tenant_id": str(connection.tenant_id),
            "_integration_connection_id": str(connection.id),
            "connector_id": str(connection.id),
        }
        try:
            return definition.factory(
                runtime_config, source_config, dict(credentials.values)
            )
        except ValueError as exc:
            raise InvalidArgument.for_field("config", str(exc)) from exc

    async def persist_rotated_credentials(
        self, integration_connection_id: UUID, values: Mapping[str, Any]
    ) -> None:
        """Write back credentials a connector rotated while it was running.

        Without this a refresh token Google rotated mid-sync would be lost and
        the connection would need a person the next time it ran.
        """

        connection = await self._session.get(
            IntegrationConnection, integration_connection_id
        )
        if connection is None or connection.deleted_at is not None:
            return
        expires_at = _parse_timestamp(values.get("expires_at"))
        await self._credentials().store(
            connection.id,
            credential_type=_OAUTH_GRANT,
            payload=values,
            expires_at=expires_at,
        )
        connection.expires_at = expires_at
        await self._session.flush()

    async def record_health(
        self,
        integration_connection_id: UUID,
        *,
        status: str,
        detail: str,
    ) -> None:
        """Write down what a failed attempt discovered about a connection.

        Called from a transaction of its own after the one that failed rolled
        back, so clients can offer a reconnect instead of rediscovering the
        same failure on every read.
        """

        connection = await self._session.get(
            IntegrationConnection, integration_connection_id
        )
        if connection is None or connection.deleted_at is not None:
            return
        connection.status = status
        connection.status_detail = detail[:1_000]
        connection.last_checked_at = datetime.now(UTC)
        await self._session.flush()

    async def resource_source_config(
        self,
        connection: IntegrationConnection,
        *,
        resource_type: str,
        external_resource_id: str,
    ) -> dict[str, Any]:
        """Translate a selected resource into the config its source runs on."""

        provider = self._providers.for_connector(connection.connector_key)
        if provider is None:
            return {}
        return dict(
            provider.source_config(
                ProviderResource(
                    capability=connection.connector_key,
                    resource_type=resource_type,
                    external_id=external_resource_id,
                    name=external_resource_id,
                )
            )
        )

    @staticmethod
    def non_secret_config(values: Mapping[str, Any]) -> dict[str, Any]:
        """``values`` unchanged; INVALID_ARGUMENT if any key names a secret."""

        result = dict(values)
        for key, value in result.items():
            if any(term in str(key).casefold() for term in _SECRET_KEY_TERMS):
                raise InvalidArgument.for_field(
                    "config", "Secret values belong to the connection's credentials, not config."
                )
            if isinstance(value, Mapping):
                IntegrationConnectionService.non_secret_config(value)
        return result

    # -- Internals -----------------------------------------------------------

    async def _usable_credentials(
        self, connection: IntegrationConnection, provider: ConnectionProvider | None
    ) -> ProviderCredentials:
        """Credentials that will still work, refreshed when the grant is about to expire."""

        if self._definition(connection.connector_key).authentication_type == "none":
            return ProviderCredentials(values={})
        if connection.status in CONNECTION_NEEDS_AUTHORIZATION:
            raise ConnectionAuthorizationRequiredError(
                f"{connection.display_name} must be connected again: "
                f"{connection.status_detail or connection.status}"
            )
        stored = await self.stored_credentials(connection)
        if stored is None:
            _require_reauthorization(connection, "no credential is stored for this connection")
        if provider is None:
            return stored
        try:
            refreshed = await refresh_if_expiring(provider, connection, stored)
        except IntegrationAuthorizationError as exc:
            _require_reauthorization(connection, str(exc))
        except IntegrationError as exc:
            raise Unavailable(str(exc)) from exc
        if refreshed is None:
            return stored
        await self.store_oauth_credentials(connection, refreshed)
        return refreshed

    def _definition(self, key: str) -> ConnectorDefinition:
        try:
            return self._connectors.get(key)
        except LookupError as exc:
            raise FailedPrecondition(f"Connector '{key}' is not in the catalog.") from exc

    def _key(self) -> str:
        if not self._encryption_key:
            raise Unavailable("BOMESH_INTEGRATION_ENCRYPTION_KEY is not configured.")
        return self._encryption_key

    def _credentials(self) -> IntegrationCredentialService:
        return IntegrationCredentialService(self._session, self._key())


async def connector_is_active(session: AsyncSession, connector_key: str) -> bool:
    """Whether ``connector_key`` is an ACTIVE catalog connector (new connections and syncs allowed)."""
    try:
        definition = ConnectorRegistry.default().get(connector_key)
    except LookupError:
        return False
    if not definition.supported:
        return False
    available = await session.scalar(
        select(PlatformConnectorSettings.available).where(
            PlatformConnectorSettings.connector_key == connector_key
        )
    )
    return available is not False


async def refresh_if_expiring(
    provider: ConnectionProvider,
    connection: IntegrationConnection,
    credentials: ProviderCredentials,
) -> ProviderCredentials | None:
    """Rotated credentials when the connection's grant expires soon, else ``None``.

    Only a provider-authorized connection is refreshed; provider I/O, so call
    it outside a transaction where possible. Raises the provider's
    :class:`IntegrationError`.
    """

    expires_at = connection.expires_at
    if (
        connection.provider_account_id is None
        or expires_at is None
        or expires_at > datetime.now(UTC) + _REFRESH_MARGIN
    ):
        return None
    return await provider.refresh(credentials)


def _require_reauthorization(connection: IntegrationConnection, detail: str) -> NoReturn:
    raise ConnectionAuthorizationRequiredError(
        f"{connection.display_name} must be connected again: {detail}",
        status=CONNECTION_REAUTHORIZATION_REQUIRED,
        detail=detail,
    )


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


__all__ = ["IntegrationConnectionService", "connector_is_active", "refresh_if_expiring"]
