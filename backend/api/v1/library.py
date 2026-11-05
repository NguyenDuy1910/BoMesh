"""Library interface — Library slice: A member's library: Home, notifications, saved and recent items and saved searches.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query

from api.aip import fieldmask
from api.aip.filtering import parse
from api.aip.messages import ProtoMessage
from api.dto.knowledge_items import ITEM_ORDER, item_filters, referenced_items
from api.dto.library import (
    NO_FILTERS,
    NOTIFICATION_FIELDS,
    NOTIFICATION_FILTERS,
    NOTIFICATION_ORDER,
    RECENT_ITEM_FIELDS,
    RECENT_ITEM_ORDER,
    SAVED_ITEM_ORDER,
    SAVED_SEARCH_FIELDS,
    SAVED_SEARCH_ORDER,
    ClearRecentItemsRequest,
    ListNotificationsResponse,
    ListRecentItemsResponse,
    ListSavedItemsResponse,
    ListSavedSearchesResponse,
    MarkNotificationsReadRequest,
    MarkNotificationsReadResponse,
    MemberHome,
    NotificationMessage,
    RecentItemMessage,
    SavedItemMessage,
    SavedSearchMessage,
    UndeleteNotificationRequest,
    member_home_message,
    notification_message,
    recent_item_message,
    saved_item_message,
    saved_search_message,
)
from api.v1.deps import Context, Runtime, service
from api.v1.listing import ListParams, list_query
from bomesh.errors import InvalidArgument
from bomesh.runtime import AppRuntime
from bomesh.services.library.home import MemberHomeService
from bomesh.services.library.items import RecentItemService, SavedItemService
from bomesh.services.library.notifications import NotificationService
from bomesh.services.library.searches import SavedSearchService

router = APIRouter(tags=["Library"])

Home = Annotated[MemberHomeService, Depends(service(MemberHomeService.from_runtime))]
Notifications = Annotated[NotificationService, Depends(service(NotificationService.from_runtime))]
SavedItems = Annotated[SavedItemService, Depends(service(SavedItemService.from_runtime))]
RecentItems = Annotated[RecentItemService, Depends(service(RecentItemService.from_runtime))]
SavedSearches = Annotated[SavedSearchService, Depends(service(SavedSearchService.from_runtime))]
Listing = Annotated[ListParams, Depends()]

RequestId = Annotated[UUID | None, Query(alias="requestId")]
UpdateMask = Annotated[str | None, Query(alias="updateMask")]
AllowMissing = Annotated[bool, Query(alias="allowMissing")]
RecentItemId = Annotated[str, Path(alias="recentItem")]
SavedItemId = Annotated[str, Path(alias="savedItem")]
SavedSearchId = Annotated[str, Path(alias="savedSearch")]

MEMBER = "/workspaces/{workspace:id}/members/{member:id}"


def _parent(workspace: UUID, member: str) -> str:
    return f"workspaces/{workspace}/members/{member}"


def _changes(fields: fieldmask.MutableFields, update_mask: str | None, body: ProtoMessage) -> dict[str, Any]:
    return fieldmask.apply(fields.parse(update_mask, body), body)


# -- Home -----------------------------------------------------------------------


@router.get(f"{MEMBER}/home", name="GetMemberHome")
async def get_member_home(workspace: UUID, member: str, ctx: Context, home: Home) -> MemberHome:
    return member_home_message(await home.get(ctx, workspace, member))


# -- Notifications --------------------------------------------------------------


@router.get(f"{MEMBER}/notifications", name="ListNotifications")
async def list_notifications(
    workspace: UUID, member: str, params: Listing, ctx: Context, notifications: Notifications
) -> ListNotificationsResponse:
    query, paging = list_query(
        params,
        parent=_parent(workspace, member),
        filters=NOTIFICATION_FILTERS,
        order=NOTIFICATION_ORDER,
    )
    rows, total = await notifications.list(ctx, workspace, member, query)
    page = paging.page(rows)
    return ListNotificationsResponse(
        notifications=[notification_message(record) for record in page.items],
        next_page_token=page.next_page_token,
        total_size=total,
    )


@router.get(f"{MEMBER}/notifications/{{notification:id}}", name="GetNotification")
async def get_notification(
    workspace: UUID, member: str, notification: str, ctx: Context, notifications: Notifications
) -> NotificationMessage:
    return notification_message(await notifications.get(ctx, workspace, member, notification))


@router.patch(f"{MEMBER}/notifications/{{notification:id}}", name="UpdateNotification")
async def update_notification(
    workspace: UUID,
    member: str,
    notification: str,
    body: NotificationMessage,
    ctx: Context,
    notifications: Notifications,
    update_mask: UpdateMask = None,
) -> NotificationMessage:
    changes = _changes(NOTIFICATION_FIELDS, update_mask, body)
    if "read" not in changes:
        record = await notifications.get(ctx, workspace, member, notification)
    else:
        record = await notifications.set_read(
            ctx, workspace, member, notification, bool(changes["read"])
        )
    return notification_message(record)


@router.delete(f"{MEMBER}/notifications/{{notification:id}}", name="DeleteNotification")
async def delete_notification(
    workspace: UUID, member: str, notification: str, ctx: Context, notifications: Notifications
) -> NotificationMessage:
    return notification_message(await notifications.dismiss(ctx, workspace, member, notification))


@router.post(f"{MEMBER}/notifications/{{notification:id}}:undelete", name="UndeleteNotification")
async def undelete_notification(
    workspace: UUID,
    member: str,
    notification: str,
    body: UndeleteNotificationRequest,
    ctx: Context,
    notifications: Notifications,
) -> NotificationMessage:
    return notification_message(
        await notifications.undelete(ctx, workspace, member, notification)
    )


@router.post(f"{MEMBER}/notifications:markRead", name="MarkNotificationsRead")
async def mark_notifications_read(
    workspace: UUID,
    member: str,
    body: MarkNotificationsReadRequest,
    ctx: Context,
    notifications: Notifications,
) -> MarkNotificationsReadResponse:
    where = NOTIFICATION_FILTERS.compile(body.filter)
    count = await notifications.mark_read(ctx, workspace, member, where)
    return MarkNotificationsReadResponse(updated_count=count)


# -- Recent items ---------------------------------------------------------------


@router.get(f"{MEMBER}/recentItems", name="ListRecentItems")
async def list_recent_items(
    workspace: UUID, member: str, params: Listing, ctx: Context, recent: RecentItems
) -> ListRecentItemsResponse:
    query, paging = list_query(
        params, parent=_parent(workspace, member), filters=NO_FILTERS, order=RECENT_ITEM_ORDER
    )
    page = paging.page(await recent.list(ctx, workspace, member, query))
    return ListRecentItemsResponse(
        recent_items=[recent_item_message(record) for record in page.items],
        next_page_token=page.next_page_token,
    )


@router.get(f"{MEMBER}/recentItems/{{recentItem:id}}", name="GetRecentItem")
async def get_recent_item(
    workspace: UUID, member: str, recent_item: RecentItemId, ctx: Context, recent: RecentItems
) -> RecentItemMessage:
    return recent_item_message(await recent.get(ctx, workspace, member, recent_item))


@router.patch(f"{MEMBER}/recentItems/{{recentItem:id}}", name="UpdateRecentItem")
async def update_recent_item(
    workspace: UUID,
    member: str,
    recent_item: RecentItemId,
    body: RecentItemMessage,
    ctx: Context,
    recent: RecentItems,
    update_mask: UpdateMask = None,
    allow_missing: AllowMissing = False,
) -> RecentItemMessage:
    changes = _changes(RECENT_ITEM_FIELDS, update_mask, body)
    record = await recent.record_view(
        ctx,
        workspace,
        member,
        recent_item,
        item=body.item,
        view_time=changes.get("viewTime"),
        allow_missing=allow_missing,
    )
    return recent_item_message(record)


@router.delete(f"{MEMBER}/recentItems/{{recentItem:id}}", name="DeleteRecentItem")
async def delete_recent_item(
    workspace: UUID, member: str, recent_item: RecentItemId, ctx: Context, recent: RecentItems
) -> dict[str, object]:
    await recent.delete(ctx, workspace, member, recent_item)
    return {}


@router.post(f"{MEMBER}/recentItems:clear", name="ClearRecentItems")
async def clear_recent_items(
    workspace: UUID, member: str, body: ClearRecentItemsRequest, ctx: Context, recent: RecentItems
) -> dict[str, object]:
    await recent.clear(ctx, workspace, member)
    return {}


# -- Saved items ----------------------------------------------------------------


@router.get(f"{MEMBER}/savedItems", name="ListSavedItems")
async def list_saved_items(
    workspace: UUID, member: str, params: Listing, ctx: Context, saved: SavedItems
) -> ListSavedItemsResponse:
    query, paging = list_query(
        params, parent=_parent(workspace, member), filters=NO_FILTERS, order=SAVED_ITEM_ORDER
    )
    page = paging.page(await saved.list(ctx, workspace, member, query))
    return ListSavedItemsResponse(
        saved_items=[saved_item_message(record) for record in page.items],
        next_page_token=page.next_page_token,
    )


@router.post(f"{MEMBER}/savedItems", name="CreateSavedItem")
async def create_saved_item(
    workspace: UUID,
    member: str,
    body: SavedItemMessage,
    ctx: Context,
    saved: SavedItems,
    saved_item_id: Annotated[str, Query(alias="savedItemId")],
    request_id: RequestId = None,
) -> SavedItemMessage:
    if not body.item:
        raise InvalidArgument.for_field("item", "item is required.")
    record = await saved.create(
        ctx,
        workspace,
        member,
        saved_item_id=saved_item_id,
        item=body.item,
        request_id=request_id,
    )
    return saved_item_message(record)


@router.get(f"{MEMBER}/savedItems/{{savedItem:id}}", name="GetSavedItem")
async def get_saved_item(
    workspace: UUID, member: str, saved_item: SavedItemId, ctx: Context, saved: SavedItems
) -> SavedItemMessage:
    return saved_item_message(await saved.get(ctx, workspace, member, saved_item))


@router.delete(f"{MEMBER}/savedItems/{{savedItem:id}}", name="DeleteSavedItem")
async def delete_saved_item(
    workspace: UUID, member: str, saved_item: SavedItemId, ctx: Context, saved: SavedItems
) -> dict[str, object]:
    await saved.delete(ctx, workspace, member, saved_item)
    return {}


# -- Saved searches -------------------------------------------------------------


def _search_references(
    runtime: AppRuntime, workspace: UUID, changes: dict[str, Any]
) -> frozenset[UUID]:
    """Validate ``filter``/``orderBy`` as SearchItems would; the items the filter names."""
    filter_text = changes.get("filter")
    if filter_text:
        item_filters(workspace, runtime.processing_version()).compile(parse(filter_text))
    if changes.get("orderBy"):
        ITEM_ORDER.compile(changes["orderBy"])
    return referenced_items(filter_text, workspace) if filter_text else frozenset()


@router.get(f"{MEMBER}/savedSearches", name="ListSavedSearches")
async def list_saved_searches(
    workspace: UUID, member: str, params: Listing, ctx: Context, searches: SavedSearches
) -> ListSavedSearchesResponse:
    query, paging = list_query(
        params, parent=_parent(workspace, member), filters=NO_FILTERS, order=SAVED_SEARCH_ORDER
    )
    page = paging.page(await searches.list(ctx, workspace, member, query))
    return ListSavedSearchesResponse(
        saved_searches=[saved_search_message(record) for record in page.items],
        next_page_token=page.next_page_token,
    )


@router.post(f"{MEMBER}/savedSearches", name="CreateSavedSearch")
async def create_saved_search(
    workspace: UUID,
    member: str,
    body: SavedSearchMessage,
    ctx: Context,
    searches: SavedSearches,
    runtime: Runtime,
    request_id: RequestId = None,
) -> SavedSearchMessage:
    fields = _changes(SAVED_SEARCH_FIELDS, None, body)
    record = await searches.create(
        ctx,
        workspace,
        member,
        fields,
        referenced=_search_references(runtime, workspace, fields),
        request_id=request_id,
    )
    return saved_search_message(record)


@router.get(f"{MEMBER}/savedSearches/{{savedSearch:id}}", name="GetSavedSearch")
async def get_saved_search(
    workspace: UUID, member: str, saved_search: SavedSearchId, ctx: Context, searches: SavedSearches
) -> SavedSearchMessage:
    return saved_search_message(await searches.get(ctx, workspace, member, saved_search))


@router.patch(f"{MEMBER}/savedSearches/{{savedSearch:id}}", name="UpdateSavedSearch")
async def update_saved_search(
    workspace: UUID,
    member: str,
    saved_search: SavedSearchId,
    body: SavedSearchMessage,
    ctx: Context,
    searches: SavedSearches,
    runtime: Runtime,
    update_mask: UpdateMask = None,
) -> SavedSearchMessage:
    changes = _changes(SAVED_SEARCH_FIELDS, update_mask, body)
    record = await searches.update(
        ctx,
        workspace,
        member,
        saved_search,
        changes,
        referenced=_search_references(runtime, workspace, changes),
    )
    return saved_search_message(record)


@router.delete(f"{MEMBER}/savedSearches/{{savedSearch:id}}", name="DeleteSavedSearch")
async def delete_saved_search(
    workspace: UUID, member: str, saved_search: SavedSearchId, ctx: Context, searches: SavedSearches
) -> dict[str, object]:
    await searches.delete(ctx, workspace, member, saved_search)
    return {}


__all__ = ["router"]
