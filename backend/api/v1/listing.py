"""AIP list parameters → :class:`~bomesh.services.kernel.listing.ListQuery` plus the page builder.

A List route takes ``params: Annotated[ListParams, Depends()]``, builds the
query with the resource's ``FilterSchema``/``OrderSchema`` and turns the
application's rows into a page::

    query, paging = list_query(params, parent=parent, filters=FILTERS, order=ORDER)
    rows = await items.list(ctx, workspace_id, query)
    page = paging.page(rows)          # Page(items, next_page_token)
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Query

from api.aip.filtering import FilterSchema
from api.aip.ordering import OrderSchema
from api.aip.paging import PageRequest, query_fingerprint
from bomesh.services.kernel.listing import ListQuery


class ListParams:
    """``pageSize``, ``pageToken``, ``filter``, ``orderBy`` and ``showDeleted`` query parameters."""

    def __init__(
        self,
        page_size: Annotated[int | None, Query(alias="pageSize")] = None,
        page_token: Annotated[str | None, Query(alias="pageToken")] = None,
        filter: Annotated[str | None, Query()] = None,
        order_by: Annotated[str | None, Query(alias="orderBy")] = None,
        show_deleted: Annotated[bool, Query(alias="showDeleted")] = False,
    ) -> None:
        self.page_size = page_size
        self.page_token = page_token
        self.filter = filter
        self.order_by = order_by
        self.show_deleted = show_deleted


def list_query(
    params: ListParams,
    *,
    parent: str,
    filters: FilterSchema,
    order: OrderSchema,
    **extra: object,
) -> tuple[ListQuery, PageRequest]:
    """Validate the list parameters and bind the page token to this exact query.

    ``extra`` carries method inputs that shape the result set (``view`` when
    it filters, a search ``query``); they join the page-token fingerprint.
    """
    fingerprint = query_fingerprint(
        parent=parent,
        filter=params.filter or "",
        order_by=params.order_by or "",
        show_deleted=params.show_deleted,
        **extra,
    )
    paging = PageRequest.from_params(params.page_size, params.page_token, fingerprint)
    query = ListQuery(
        where=filters.compile(params.filter),
        order_by=tuple(order.compile(params.order_by)),
        offset=paging.offset,
        limit=paging.fetch_limit,
        show_deleted=params.show_deleted,
    )
    return query, paging


__all__ = ["ListParams", "list_query"]
