"""The ``/api/v1`` HTTP boundary: one router module per interface slice.

Routers parse, call one service method and map the result to a message
(``api/dto/<interface>.py``). ``name`` of every route is its
``operationId``. Path variables use the ``id`` convertor
(``/workspaces/{workspace:id}/items/{item:id}:publish``): it matches one name
segment without ``:``, so ``{item}`` never swallows a custom-method verb and
route order does not matter.
"""

from __future__ import annotations

from starlette.convertors import StringConvertor, register_url_convertor


class IdConvertor(StringConvertor):
    """A resource ID: one path segment, never containing the ``:verb`` separator."""

    regex = "[^/:]+"


register_url_convertor("id", IdConvertor())
