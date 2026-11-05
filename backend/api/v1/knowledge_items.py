"""Knowledge interface — KnowledgeItems slice: Items (collections and documents): uploads, content, passages, revisions, rollback, move, publish, verify, merge, item IAM, item links and `items:search` (`item_model.md`).

Routes are mounted under ``/api/v1`` and ``upload_router`` under ``/upload/api/v1``
(media upload of CreateItem); ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import RedirectResponse
from pydantic import ValidationError

from api.aip.errors import validation_violations
from api.aip.fieldmask import MutableFields, apply
from api.aip.filtering import parse
from api.aip.paging import PageRequest, query_fingerprint
from api.dto.knowledge_items import (
    FACET_FILTER_FIELDS,
    ITEM_ORDER,
    LINK_ORDER,
    EtagRequest,
    GetIamPolicyRequest,
    ItemContent,
    ItemLinkMessage,
    ItemMessage,
    ItemPassage,
    ItemRevisionMessage,
    ListItemLinksResponse,
    ListItemRevisionsResponse,
    ListItemsResponse,
    ListPassagesResponse,
    MergeItemRequest,
    MoveItemRequest,
    PolicyMessage,
    SearchItemsRequest,
    SearchItemsResponse,
    SetIamPolicyRequest,
    TestIamPermissionsRequest,
    TestIamPermissionsResponse,
    View,
    content_message,
    item_changes,
    item_filters,
    item_message,
    link_message,
    new_item,
    passage_message,
    policy_message,
    referenced_items,
    revision_message,
    search_response,
    without_field,
)
from api.v1.deps import Context, Runtime, service
from api.v1.listing import ListParams, list_query
from bomesh.errors import InvalidArgument
from bomesh.services.kernel.workspaces import workspace_name
from bomesh.services.knowledge_items.content import ItemContentService
from bomesh.services.knowledge_items.iam import ItemIamService
from bomesh.services.knowledge_items.items import KnowledgeItemService
from bomesh.services.knowledge_items.links import ItemLinkService
from bomesh.services.knowledge_items.names import item_name, parse_item, parse_revision
from bomesh.services.knowledge_items.records import (
    FacetRequest,
    SearchRequest,
    UploadedFile,
)
from bomesh.services.knowledge_items.search import FACET_FIELDS, ItemSearchService

router = APIRouter(tags=["Knowledge"])
upload_router = APIRouter(tags=["Knowledge"])

Items = Annotated[KnowledgeItemService, Depends(service(KnowledgeItemService.from_runtime))]
Contents = Annotated[ItemContentService, Depends(service(ItemContentService.from_runtime))]
Links = Annotated[ItemLinkService, Depends(service(ItemLinkService.from_runtime))]
Policies = Annotated[ItemIamService, Depends(service(ItemIamService.from_runtime))]
Searches = Annotated[ItemSearchService, Depends(service(ItemSearchService.from_runtime))]

RequestId = Annotated[UUID | None, Query(alias="requestId")]
Etag = Annotated[str | None, Query()]

_ITEM_FIELDS = MutableFields(
    (
        "displayName",
        "collection.description",
        "collection.discoverable",
        "collection.acceptsContributions",
        "collection.space",
        "collection.inheritAccess",
        "document.documentType",
        "document.topics",
        "document.summary",
        "document.languageCode",
        "document.owner",
    )
)

_ITEM = "/workspaces/{workspace:id}/items/{item:id}"


# -- Items ------------------------------------------------------------------------


@router.post("/workspaces/{workspace:id}/items", name="CreateItem")
async def create_item(
    workspace: UUID, body: ItemMessage, ctx: Context, items: Items, request_id: RequestId = None
) -> ItemMessage:
    record = await items.create(ctx, workspace, new_item(body, workspace), request_id=request_id)
    return item_message(record)


@upload_router.post("/workspaces/{workspace:id}/items", name="CreateItemMedia")
async def create_item_media(
    workspace: UUID,
    ctx: Context,
    items: Items,
    metadata: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    request_id: RequestId = None,
) -> ItemMessage:
    try:
        message = ItemMessage.model_validate_json(metadata)
    except ValidationError as exc:
        raise InvalidArgument(
            "The metadata part is not a valid Item.",
            field_violations=validation_violations(exc.errors()),
        ) from None
    upload = UploadedFile(
        data=await file.read(), file_name=file.filename, content_type=file.content_type
    )
    record = await items.create_media(
        ctx, workspace, new_item(message, workspace, field="metadata"), upload, request_id=request_id
    )
    return item_message(record)


@router.get("/workspaces/{workspace:id}/items", name="ListItems")
async def list_items(
    workspace: UUID,
    params: Annotated[ListParams, Depends()],
    ctx: Context,
    items: Items,
    runtime: Runtime,
    view: Annotated[View, Query()] = "BASIC",
    show_locked: Annotated[bool, Query(alias="showLocked")] = False,
) -> ListItemsResponse:
    query, paging = list_query(
        params,
        parent=workspace_name(workspace),
        filters=item_filters(workspace, runtime.processing_version()),
        order=ITEM_ORDER,
        view=view,
        show_locked=show_locked,
    )
    result = await items.list(
        ctx,
        workspace,
        query,
        full=view == "FULL",
        show_locked=show_locked,
        referenced=referenced_items(params.filter, workspace),
    )
    page = paging.page(result.items)
    return ListItemsResponse(
        items=[item_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=result.total_size,
    )


@router.get(_ITEM, name="GetItem", response_model=ItemMessage)
async def get_item(
    workspace: UUID,
    item: UUID,
    ctx: Context,
    items: Items,
    view: Annotated[View, Query()] = "FULL",
    alt: Annotated[str, Query(pattern="^(json|media)$")] = "json",
) -> Any:
    if alt == "media":
        return RedirectResponse(await items.media_url(ctx, workspace, item), status_code=302)
    return item_message(await items.get(ctx, workspace, item, full=view == "FULL"))


@router.patch(_ITEM, name="UpdateItem")
async def update_item(
    workspace: UUID,
    item: UUID,
    body: ItemMessage,
    ctx: Context,
    items: Items,
    update_mask: Annotated[str | None, Query(alias="updateMask")] = None,
) -> ItemMessage:
    mask = _ITEM_FIELDS.parse(update_mask, body)
    changes = item_changes(apply(mask, body), workspace)
    record = await items.update(ctx, workspace, item, changes, etag=body.etag)
    return item_message(record)


@router.delete(_ITEM, name="DeleteItem")
async def delete_item(
    workspace: UUID,
    item: UUID,
    ctx: Context,
    items: Items,
    etag: Etag = None,
    force: Annotated[bool, Query()] = False,
) -> ItemMessage:
    return item_message(await items.delete(ctx, workspace, item, force=force, etag=etag))


@router.post(f"{_ITEM}:undelete", name="UndeleteItem")
async def undelete_item(
    workspace: UUID, item: UUID, body: EtagRequest, ctx: Context, items: Items
) -> ItemMessage:
    return item_message(await items.undelete(ctx, workspace, item, etag=body.etag))


@router.post(f"{_ITEM}:completeUpload", name="CompleteItemUpload")
async def complete_item_upload(
    workspace: UUID, item: UUID, body: EtagRequest, ctx: Context, items: Items
) -> ItemMessage:
    return item_message(await items.complete_upload(ctx, workspace, item, etag=body.etag))


@router.post(f"{_ITEM}:move", name="MoveItem")
async def move_item(
    workspace: UUID, item: UUID, body: MoveItemRequest, ctx: Context, items: Items
) -> ItemMessage:
    destination = (
        None
        if body.destination_parent == workspace_name(workspace)
        else parse_item(body.destination_parent, workspace, field="destinationParent")
    )
    return item_message(await items.move(ctx, workspace, item, destination, etag=body.etag))


@router.post(f"{_ITEM}:publish", name="PublishItem")
async def publish_item(
    workspace: UUID, item: UUID, body: EtagRequest, ctx: Context, items: Items
) -> ItemMessage:
    return item_message(await items.publish(ctx, workspace, item, etag=body.etag))


@router.post(f"{_ITEM}:unpublish", name="UnpublishItem")
async def unpublish_item(
    workspace: UUID, item: UUID, body: EtagRequest, ctx: Context, items: Items
) -> ItemMessage:
    return item_message(await items.unpublish(ctx, workspace, item, etag=body.etag))


@router.post(f"{_ITEM}:verify", name="VerifyItem")
async def verify_item(
    workspace: UUID, item: UUID, body: EtagRequest, ctx: Context, items: Items
) -> ItemMessage:
    return item_message(await items.verify(ctx, workspace, item, etag=body.etag))


@router.post(f"{_ITEM}:merge", name="MergeItem")
async def merge_item(
    workspace: UUID, item: UUID, body: MergeItemRequest, ctx: Context, items: Items
) -> ItemMessage:
    target = parse_item(body.target_item, workspace, field="targetItem")
    return item_message(await items.merge(ctx, workspace, item, target, etag=body.etag))


# -- Content, passages and revisions ---------------------------------------------------


@router.get(f"{_ITEM}/content", name="GetItemContent")
async def get_item_content(
    workspace: UUID,
    item: UUID,
    ctx: Context,
    contents: Contents,
    revision: Annotated[str | None, Query()] = None,
) -> ItemContent:
    number = parse_revision(revision, workspace, item, field="revision") if revision else None
    return content_message(await contents.get_content(ctx, workspace, item, revision=number))


@router.get(f"{_ITEM}/passages", name="ListPassages")
async def list_passages(
    workspace: UUID,
    item: UUID,
    ctx: Context,
    contents: Contents,
    page_size: Annotated[int | None, Query(alias="pageSize")] = None,
    page_token: Annotated[str | None, Query(alias="pageToken")] = None,
) -> ListPassagesResponse:
    paging = PageRequest.from_params(
        page_size, page_token, query_fingerprint(parent=item_name(workspace, item))
    )
    rows = await contents.list_passages(
        ctx, workspace, item, offset=paging.offset, limit=paging.fetch_limit
    )
    page = paging.page(rows)
    return ListPassagesResponse(
        passages=[passage_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(f"{_ITEM}/passages/{{passage}}", name="GetPassage")
async def get_passage(
    workspace: UUID, item: UUID, passage: str, ctx: Context, contents: Contents
) -> ItemPassage:
    return passage_message(await contents.get_passage(ctx, workspace, item, passage))


@router.get(f"{_ITEM}/revisions", name="ListItemRevisions")
async def list_item_revisions(
    workspace: UUID,
    item: UUID,
    ctx: Context,
    items: Items,
    page_size: Annotated[int | None, Query(alias="pageSize")] = None,
    page_token: Annotated[str | None, Query(alias="pageToken")] = None,
) -> ListItemRevisionsResponse:
    paging = PageRequest.from_params(
        page_size, page_token, query_fingerprint(parent=item_name(workspace, item))
    )
    rows = await items.list_revisions(
        ctx, workspace, item, offset=paging.offset, limit=paging.fetch_limit
    )
    page = paging.page(rows)
    return ListItemRevisionsResponse(
        revisions=[revision_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(f"{_ITEM}/revisions/{{revision:id}}", name="GetItemRevision")
async def get_item_revision(
    workspace: UUID, item: UUID, revision: str, ctx: Context, items: Items
) -> ItemRevisionMessage:
    number = parse_revision(revision, workspace, item, field="revision")
    return revision_message(await items.get_revision(ctx, workspace, item, number))


@router.post(f"{_ITEM}/revisions/{{revision:id}}:rollback", name="RollbackItem")
async def rollback_item(
    workspace: UUID, item: UUID, revision: str, body: EtagRequest, ctx: Context, items: Items
) -> ItemMessage:
    number = parse_revision(revision, workspace, item, field="revision")
    return item_message(await items.rollback(ctx, workspace, item, number, etag=body.etag))


# -- IAM ---------------------------------------------------------------------------


@router.post(f"{_ITEM}:getIamPolicy", name="GetItemIamPolicy")
async def get_item_iam_policy(
    workspace: UUID, item: UUID, body: GetIamPolicyRequest, ctx: Context, policies: Policies
) -> PolicyMessage:
    return policy_message(await policies.get_policy(ctx, workspace, item))


@router.post(f"{_ITEM}:setIamPolicy", name="SetItemIamPolicy")
async def set_item_iam_policy(
    workspace: UUID, item: UUID, body: SetIamPolicyRequest, ctx: Context, policies: Policies
) -> PolicyMessage:
    if body.update_mask and set(body.update_mask.split(",")) - {"bindings", "etag"}:
        raise InvalidArgument.for_field("updateMask", "Only bindings and etag can be set.")
    record = await policies.set_policy(
        ctx,
        workspace,
        item,
        [(binding.role, binding.members) for binding in body.policy.bindings or ()],
        etag=body.policy.etag,
    )
    return policy_message(record)


@router.post(f"{_ITEM}:testIamPermissions", name="TestItemIamPermissions")
async def test_item_iam_permissions(
    workspace: UUID, item: UUID, body: TestIamPermissionsRequest, ctx: Context, policies: Policies
) -> TestIamPermissionsResponse:
    held = await policies.test_permissions(ctx, workspace, item, body.permissions)
    return TestIamPermissionsResponse(permissions=held)


# -- Links -------------------------------------------------------------------------


@router.post(f"{_ITEM}/links", name="CreateItemLink")
async def create_item_link(
    workspace: UUID,
    item: UUID,
    body: ItemLinkMessage,
    ctx: Context,
    links: Links,
    request_id: RequestId = None,
) -> ItemLinkMessage:
    if not body.target_item:
        raise InvalidArgument.for_field("targetItem", "targetItem is required.")
    target = parse_item(body.target_item, workspace, field="targetItem")
    return link_message(await links.create(ctx, workspace, item, target, request_id=request_id))


@router.get(f"{_ITEM}/links", name="ListItemLinks")
async def list_item_links(
    workspace: UUID,
    item: UUID,
    ctx: Context,
    links: Links,
    page_size: Annotated[int | None, Query(alias="pageSize")] = None,
    page_token: Annotated[str | None, Query(alias="pageToken")] = None,
    order_by: Annotated[str | None, Query(alias="orderBy")] = None,
) -> ListItemLinksResponse:
    paging = PageRequest.from_params(
        page_size,
        page_token,
        query_fingerprint(parent=item_name(workspace, item), order_by=order_by or ""),
    )
    rows = await links.list(
        ctx,
        workspace,
        item,
        order_by=LINK_ORDER.compile(order_by),
        offset=paging.offset,
        limit=paging.fetch_limit,
    )
    page = paging.page(rows)
    return ListItemLinksResponse(
        links=[link_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(f"{_ITEM}/links/{{link:id}}", name="GetItemLink")
async def get_item_link(
    workspace: UUID, item: UUID, link: UUID, ctx: Context, links: Links
) -> ItemLinkMessage:
    return link_message(await links.get(ctx, workspace, item, link))


@router.delete(f"{_ITEM}/links/{{link:id}}", name="DeleteItemLink")
async def delete_item_link(
    workspace: UUID, item: UUID, link: UUID, ctx: Context, links: Links, etag: Etag = None
) -> ItemLinkMessage:
    return link_message(await links.delete(ctx, workspace, item, link, etag=etag))


# -- Search ------------------------------------------------------------------------


@router.post("/workspaces/{workspace:id}/items:search", name="SearchItems")
async def search_items(
    workspace: UUID, body: SearchItemsRequest, ctx: Context, searches: Searches, runtime: Runtime
) -> SearchItemsResponse:
    filters = item_filters(workspace, runtime.processing_version())
    node = parse(body.filter)
    facet_specs = body.facet_specs or []
    for spec in facet_specs:
        if spec.field not in FACET_FIELDS:
            raise InvalidArgument.for_field("facetSpecs.field", f"Unknown facet field {spec.field!r}.")
    paging = PageRequest.from_params(
        body.page_size,
        body.page_token,
        query_fingerprint(
            parent=workspace_name(workspace),
            filter=body.filter or "",
            order_by=body.order_by or "",
            query=body.query or "",
            related_item=body.related_item or "",
        ),
    )
    page = await searches.search(
        ctx,
        workspace,
        SearchRequest(
            query=body.query or "",
            where=filters.compile(node),
            order_by=tuple(ITEM_ORDER.compile(body.order_by)) if body.order_by else (),
            offset=paging.offset,
            limit=paging.fetch_limit,
            facets=[
                FacetRequest(
                    field=spec.field,
                    where=filters.compile(
                        without_field(node, FACET_FILTER_FIELDS[spec.field])
                        if spec.excluded_from_filter
                        else node
                    ),
                    limit=spec.limit or 0,
                )
                for spec in facet_specs
            ],
            related_item_id=(
                parse_item(body.related_item, workspace, field="relatedItem")
                if body.related_item
                else None
            ),
            snippets=bool(body.content_search_spec and body.content_search_spec.snippets),
            passages=(body.content_search_spec.passages or 0) if body.content_search_spec else 0,
            referenced_items=referenced_items(body.filter, workspace),
        ),
    )
    window = paging.page(page.results)
    return search_response(workspace, page, window.items, window.next_page_token)
