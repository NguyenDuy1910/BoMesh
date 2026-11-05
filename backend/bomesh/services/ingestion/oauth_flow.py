"""The OAuth lifecycle of a connection authorization.

Connecting an account and choosing what to read from it are two different
decisions, and this engine owns only the first: it builds the consent URI for
one Connection, proves the callback belongs to the person who started it, and
trades the provider's code for a grant. It never stores anything — the pending
authorization travels sealed inside the ``state`` parameter — and it never
lets a provider's secret reach the browser.
"""

from __future__ import annotations

import secrets
from urllib.parse import urlparse
from uuid import UUID

from bomesh.errors import InvalidArgument, Unavailable
from bomesh.integrations import (
    AuthorizationGrant,
    ConnectionProvider,
    IntegrationAuthorizationError,
    IntegrationConfigurationError,
    IntegrationError,
    PendingAuthorization,
    pkce_pair,
)
from bomesh.integrations.oauth_state import OAuthStateCodec


class IntegrationAuthorizationService:
    """Start and complete a provider authorization without a session cookie."""

    def __init__(self, *, state: OAuthStateCodec, client_origin: str | None) -> None:
        self._state = state
        self._client_origin = (client_origin or "").strip().rstrip("/")

    @property
    def client_origin(self) -> str:
        """The single origin the callback page is allowed to talk back to."""

        parsed = urlparse(self._client_origin)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise Unavailable(
                "BOMESH_INTEGRATION_OAUTH_CLIENT_ORIGIN must be an absolute origin."
            )
        return f"{parsed.scheme}://{parsed.netloc}"

    def authorization_uri(
        self,
        provider: ConnectionProvider,
        *,
        workspace_id: UUID,
        user_id: UUID,
        connection_id: UUID,
        connector_key: str,
    ) -> str:
        """The consent URI completing ``connection_id`` as ``user_id``.

        Raises :class:`IntegrationConfigurationError` when the provider or the
        state secret is not configured.
        """

        verifier, challenge = pkce_pair()
        state = self._state.issue(
            PendingAuthorization(
                tenant_id=str(workspace_id),
                user_id=str(user_id),
                provider_key=provider.definition.key,
                connector_key=connector_key,
                connection_id=str(connection_id),
                code_verifier=verifier,
                nonce=secrets.token_urlsafe(16),
            )
        )
        return provider.authorization_url(state=state, code_challenge=challenge)

    def read_state(self, state: str) -> PendingAuthorization:
        """The pending authorization sealed in ``state``; INVALID_ARGUMENT if forged or expired."""

        try:
            pending = self._state.read(state)
            UUID(pending.tenant_id), UUID(pending.user_id), UUID(pending.connection_id)
        except IntegrationConfigurationError as exc:
            raise Unavailable(str(exc)) from exc
        except (IntegrationAuthorizationError, ValueError) as exc:
            raise InvalidArgument.for_field("state", "The authorization state is invalid or expired.") from exc
        return pending

    async def exchange(
        self, provider: ConnectionProvider, pending: PendingAuthorization, *, code: str
    ) -> AuthorizationGrant:
        """Trade the provider's one-time code for a grant."""

        if provider.definition.key != pending.provider_key:
            raise InvalidArgument.for_field(
                "state", "The authorization state does not match its provider."
            )
        try:
            return await provider.exchange(code=code, code_verifier=pending.code_verifier)
        except IntegrationConfigurationError as exc:
            raise Unavailable(str(exc)) from exc
        except IntegrationAuthorizationError as exc:
            raise InvalidArgument.for_field("code", str(exc)) from exc
        except IntegrationError as exc:
            raise Unavailable(str(exc)) from exc


__all__ = ["IntegrationAuthorizationService"]
