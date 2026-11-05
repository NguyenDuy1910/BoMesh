"""Dependencies every router uses; interface modules never need to edit this file.

- ``Runtime``: the :class:`~bomesh.runtime.AppRuntime` of the app.
- ``CurrentPrincipal``: the authenticated caller (401 without a valid bearer token).
- ``Context``: the request's :class:`~bomesh.services.kernel.context.RequestContext`
  with one :class:`~bomesh.iam.Authorizer` shared by the whole request.
- :func:`service`: a dependency building a service from the runtime::

      Items = Annotated[KnowledgeItemService, Depends(service(KnowledgeItemService.from_runtime))]

      @router.get("/workspaces/{workspace:id}/items/{item:id}", name="GetItem")
      async def get_item(workspace: UUID, item: UUID, ctx: Context, items: Items) -> ItemMessage:
          ...
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Request

from api.auth import current_principal, get_runtime
from bomesh.iam.authorizer import Principal
from bomesh.runtime import AppRuntime
from bomesh.services.kernel.context import RequestContext

Runtime = Annotated[AppRuntime, Depends(get_runtime)]
CurrentPrincipal = Annotated[Principal, Depends(current_principal)]


def get_context(request: Request, principal: CurrentPrincipal, runtime: Runtime) -> RequestContext:
    return RequestContext(
        principal=principal,
        authorizer=runtime.authorizer_factory(),
        request_id=request.headers.get("X-Request-Id"),
        ip_address=request.client.host if request.client is not None else None,
    )


Context = Annotated[RequestContext, Depends(get_context)]


def service[S](factory: Callable[[AppRuntime], S]) -> Callable[[AppRuntime], S]:
    """A FastAPI dependency calling ``factory(runtime)`` once per request."""

    def build(runtime: Runtime) -> S:
        return factory(runtime)

    return build


__all__ = ["Context", "CurrentPrincipal", "Runtime", "get_context", "service"]
