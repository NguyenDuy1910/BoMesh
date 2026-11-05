"""Bearer authentication: ``Authorization: Bearer <token>`` → :class:`~bomesh.iam.Principal`.

The token must resolve to an ACTIVE, unexpired access session of an ACTIVE
user at the token's version; anything else, or no token, is UNAUTHENTICATED
(``auth_contract.md``). Identity is never taken from any other header or body
field. Public methods simply do not depend on :func:`current_principal`.
Resolving the token is the Identity use case
:meth:`~bomesh.services.identity.sessions.SessionService.authenticate`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from bomesh.errors import Unauthenticated
from bomesh.iam.authorizer import Principal
from bomesh.runtime import AppRuntime
from bomesh.services.identity.sessions import SessionService

bearer = HTTPBearer(auto_error=False, bearerFormat="JWT")


def get_runtime(request: Request) -> AppRuntime:
    """The application's composition root (``create_app(runtime)``)."""
    return request.app.state.runtime


async def current_principal(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> Principal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise Unauthenticated("A bearer access token is required.")
    return await SessionService.from_runtime(runtime).authenticate(credentials.credentials)


__all__ = ["bearer", "current_principal", "get_runtime"]
