"""Knowledge item messages (``openapi.yaml`` tag Knowledge, Item part) and their field maps."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import Field

from api.aip.filtering import (
    And,
    FilterSchema,
    Node,
    Not,
    Or,
    Restriction,
    enum,
    parse,
    repeated,
    resource_name,
    restrictions,
    string,
    timestamp,
)
from api.aip.messages import Int64, ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh import etag as etags
from bomesh.db.models import Item, ItemLink
from bomesh.errors import InvalidArgument
from bomesh.services.ingestion.names import parse_source, source_name
from bomesh.services.knowledge_curation.records import (
    contribution_name,
    parse_topic,
    topic_name,
)
from bomesh.services.knowledge_items import queries
from bomesh.services.knowledge_items.names import (
    item_name,
    link_name,
    parse_item,
    passage_name,
    revision_name,
)
from bomesh.services.knowledge_items.records import (
    ContentRecord,
    ItemRecord,
    LinkRecord,
    NewCollection,
    NewDocument,
    NewItem,
    PageAsset,
    PassageRecord,
    PolicyRecord,
    Rendition,
    RevisionRecord,
    SearchPage,
)
from bomesh.services.knowledge_items.support import LINK_TARGET_TITLE
from bomesh.services.workspaces.records import member_name, parse_member_name

ItemType = Literal["COLLECTION", "DOCUMENT"]
View = Literal["BASIC", "FULL"]
Purpose = Literal["KNOWLEDGE", "CONVERSATION_ATTACHMENT"]

# -- Item -----------------------------------------------------------------------


class ItemAncestor(ProtoMessage):
    name: str | None = None
    display_name: str | None = None


class CollectionFacet(ProtoMessage):
    kind: Literal["STANDARD", "PERSONAL"] | None = None
    owner: str | None = None
    owner_summary: str | None = None
    description: str | None = None
    inherit_access: bool | None = None
    discoverable: bool | None = None
    accepts_contributions: bool | None = None
    space: str | None = None
    child_count: int | None = None
    document_count: int | None = None
    link_count: int | None = None


class ItemVerification(ProtoMessage):
    state: Literal["VERIFIED", "REVIEW_DUE", "UNVERIFIED"] | None = None
    verifier: str | None = None
    verify_time: Timestamp | None = None
    next_review_time: Timestamp | None = None


class ItemOrigin(ProtoMessage):
    source: str | None = None
    external_uri: str | None = None
    path: str | None = None
    source_update_time: Timestamp | None = None


class ItemQualityIssue(ProtoMessage):
    kind: Literal["REVIEW_DUE", "MISSING_DETAILS", "POSSIBLE_DUPLICATE", "CHANGED_AT_SOURCE"] | None = None
    related_item: str | None = None


class DocumentFacet(ProtoMessage):
    file_name: str | None = None
    mime_type: str | None = None
    size_bytes: Int64 | None = None
    purpose: Purpose | None = None
    document_type: str | None = None
    topics: list[str] | None = None
    summary: str | None = None
    language_code: str | None = None
    owner: str | None = None
    content_state: Literal["PENDING", "AVAILABLE", "FAILED"] | None = None
    publication_state: Literal["PUBLISHED", "UNPUBLISHED"] | None = None
    indexing_state: (
        Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "OUTDATED", "UNSUPPORTED"] | None
    ) = None
    indexing_error: dict[str, Any] | None = None
    last_ingestion_run: str | None = None
    revision: str | None = None
    indexed_revision: str | None = None
    verification: ItemVerification | None = None
    origin: ItemOrigin | None = None
    merged_into: str | None = None
    quality_issues: list[ItemQualityIssue] | None = None
    thumbnail_uri: str | None = None
    upload_uri: str | None = None


class ItemMessage(ProtoMessage):
    """``Item``: one collection or document. Output-only fields sent on input are ignored."""

    name: str | None = None
    item_type: ItemType | None = None
    display_name: str | None = Field(default=None, max_length=512)
    parent_item: str | None = None
    parent_relation: Literal["CONTAINS", "CHILD", "ATTACHMENT"] | None = None
    ancestors: list[ItemAncestor] | None = None
    access: Literal["READER", "EDITOR", "OWNER", "LOCKED"] | None = None
    state: Literal["ACTIVE", "DELETED"] | None = None
    creator: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    purge_time: Timestamp | None = None
    etag: str | None = None
    collection: CollectionFacet | None = None
    document: DocumentFacet | None = None


class ListItemsResponse(ProtoMessage):
    items: list[ItemMessage]
    next_page_token: str | None = None
    total_size: int | None = None


def item_message(record: ItemRecord) -> ItemMessage:
    ws = record.workspace_id
    name = item_name(ws, record.item_id)
    if record.access == "LOCKED":
        assert record.collection is not None
        return ItemMessage(
            name=name,
            item_type="COLLECTION",
            display_name=record.display_name,
            access="LOCKED",
            collection=CollectionFacet(
                description=record.collection.description,
                owner_summary=record.collection.owner_summary,
            ),
        )
    return ItemMessage(
        name=name,
        item_type=record.item_type,  # type: ignore[arg-type]
        display_name=record.display_name,
        parent_item=item_name(ws, record.parent_id) if record.parent_id else "",
        parent_relation=record.parent_relation,  # type: ignore[arg-type]
        ancestors=(
            [
                ItemAncestor(name=item_name(ws, ancestor.item_id), display_name=ancestor.display_name)
                for ancestor in record.ancestors
            ]
            if record.ancestors is not None
            else None
        ),
        access=record.access,  # type: ignore[arg-type]
        state=record.state,  # type: ignore[arg-type]
        creator=member_name(ws, record.creator_id) if record.creator_id else None,
        create_time=record.create_time,
        update_time=record.update_time,
        delete_time=record.delete_time,
        purge_time=record.purge_time,
        etag=etags.compute(name, record.update_time),
        collection=_collection(record) if record.collection is not None else None,
        document=_document(record) if record.document is not None else None,
    )


def _collection(record: ItemRecord) -> CollectionFacet:
    facet = record.collection
    assert facet is not None
    ws = record.workspace_id
    return CollectionFacet(
        kind=facet.kind,  # type: ignore[arg-type]
        owner=member_name(ws, facet.owner_id) if facet.owner_id else None,
        owner_summary=facet.owner_summary,
        description=facet.description,
        inherit_access=facet.inherit_access,
        discoverable=facet.discoverable,
        accepts_contributions=facet.accepts_contributions,
        space=facet.space,
        child_count=facet.child_count,
        document_count=facet.document_count,
        link_count=facet.link_count,
    )


def _document(record: ItemRecord) -> DocumentFacet:
    facet = record.document
    assert facet is not None
    ws, item_id = record.workspace_id, record.item_id
    verification = facet.verification
    origin = facet.origin
    return DocumentFacet(
        file_name=facet.file_name,
        mime_type=facet.mime_type,
        size_bytes=facet.size_bytes,
        purpose=facet.purpose,  # type: ignore[arg-type]
        document_type=facet.document_type,
        topics=[topic_name(ws, code) for code in facet.topics],
        summary=facet.summary,
        language_code=facet.language_code,
        owner=member_name(ws, facet.owner_id) if facet.owner_id else None,
        content_state=facet.content_state,  # type: ignore[arg-type]
        publication_state=facet.publication_state,  # type: ignore[arg-type]
        indexing_state=facet.indexing_state,  # type: ignore[arg-type]
        revision=revision_name(ws, item_id, facet.revision) if facet.revision else None,
        indexed_revision=(
            revision_name(ws, item_id, facet.indexed_revision) if facet.indexed_revision else None
        ),
        verification=ItemVerification(
            state=verification.state,  # type: ignore[arg-type]
            verifier=member_name(ws, verification.verifier_id) if verification.verifier_id else None,
            verify_time=verification.verify_time,
            next_review_time=verification.next_review_time,
        ),
        origin=(
            ItemOrigin(
                source=source_name(ws, origin.source_code) if origin.source_code else None,
                external_uri=origin.external_uri,
                path=origin.path,
                source_update_time=origin.source_update_time,
            )
            if origin is not None
            else None
        ),
        merged_into=item_name(ws, facet.merged_into) if facet.merged_into else None,
        quality_issues=[] if facet.editor else None,
        thumbnail_uri=facet.thumbnail_uri,
        upload_uri=facet.upload_uri,
    )


def new_item(message: ItemMessage, workspace_id: UUID, *, field: str = "") -> NewItem:
    """CreateItem input: names resolved to IDs of ``workspace_id``."""
    prefix = f"{field}." if field else ""
    if message.item_type is None:
        raise InvalidArgument.for_field(f"{prefix}itemType", "itemType is required.")
    if not message.display_name or not message.display_name.strip():
        raise InvalidArgument.for_field(f"{prefix}displayName", "displayName is required.")
    parent = (
        parse_item(message.parent_item, workspace_id, field=f"{prefix}parentItem")
        if message.parent_item
        else None
    )
    collection = message.collection
    document = message.document
    return NewItem(
        item_type=message.item_type.lower(),
        display_name=message.display_name,
        parent_id=parent,
        collection=(
            NewCollection(
                description=collection.description,
                discoverable=collection.discoverable,
                accepts_contributions=collection.accepts_contributions,
                space=collection.space or None,
                inherit_access=collection.inherit_access,
            )
            if collection is not None
            else None
        ),
        document=(
            NewDocument(
                mime_type=document.mime_type,
                file_name=document.file_name,
                size_bytes=document.size_bytes,
                purpose=(document.purpose or "KNOWLEDGE").lower(),
                document_type=document.document_type,
                summary=document.summary,
                language_code=document.language_code,
                owner_id=(
                    parse_member_name(
                        document.owner, workspace_id, field=f"{prefix}document.owner"
                    )
                    if document.owner
                    else None
                ),
                topics=topic_codes(document.topics or (), workspace_id, field=f"{prefix}document.topics"),
            )
            if document is not None
            else None
        ),
    )


def topic_codes(names: Any, workspace_id: UUID, *, field: str) -> tuple[str, ...]:
    return tuple(parse_topic(name, workspace_id, field=field) for name in names)


def item_changes(changes: dict[str, Any], workspace_id: UUID) -> dict[str, Any]:
    """UpdateItem changes with references resolved: owner → member ID, topics → codes."""
    resolved = dict(changes)
    if resolved.get("document.owner"):
        resolved["document.owner"] = parse_member_name(
            resolved["document.owner"], workspace_id, field="document.owner"
        )
    elif "document.owner" in resolved:
        resolved["document.owner"] = None
    if "document.topics" in resolved:
        resolved["document.topics"] = topic_codes(
            resolved["document.topics"] or (), workspace_id, field="document.topics"
        )
    return resolved


# -- Lifecycle requests ------------------------------------------------------------


class EtagRequest(ProtoMessage):
    """Body of the state-transition custom methods: an optional etag."""

    etag: str | None = None


class MoveItemRequest(ProtoMessage):
    destination_parent: str
    etag: str | None = None


class MergeItemRequest(ProtoMessage):
    target_item: str
    etag: str | None = None


# -- Revisions ---------------------------------------------------------------------


class ItemRevisionMessage(ProtoMessage):
    name: str | None = None
    create_time: Timestamp | None = None
    mime_type: str | None = None
    size_bytes: Int64 | None = None
    change_summary: str | None = None
    contribution: str | None = None
    creator: str | None = None
    external_version: str | None = None
    restored_from: str | None = None


class ListItemRevisionsResponse(ProtoMessage):
    revisions: list[ItemRevisionMessage]
    next_page_token: str | None = None


def revision_message(record: RevisionRecord) -> ItemRevisionMessage:
    ws, item_id = record.workspace_id, record.item_id
    return ItemRevisionMessage(
        name=revision_name(ws, item_id, record.number),
        create_time=record.create_time,
        mime_type=record.mime_type,
        size_bytes=record.size_bytes,
        change_summary=record.change_summary,
        contribution=contribution_name(ws, record.contribution_id) if record.contribution_id else None,
        creator=member_name(ws, record.creator_id) if record.creator_id else None,
        external_version=record.external_version,
        restored_from=(
            revision_name(ws, item_id, record.restored_from) if record.restored_from else None
        ),
    )


# -- Content and passages ------------------------------------------------------------


class ItemContentElement(ProtoMessage):
    element_id: str | None = None
    kind: Literal["HEADING", "PARAGRAPH", "LIST", "TABLE", "IMAGE", "CODE"] | None = None
    text: str | None = None
    level: int | None = None
    page_number: int | None = None
    passage: str | None = None


class ItemPageAsset(ProtoMessage):
    page_number: int | None = None
    image_uri: str | None = None
    width_pixels: int | None = None
    height_pixels: int | None = None


class ItemRendition(ProtoMessage):
    uri: str | None = None
    version: int | None = None
    size_bytes: Int64 | None = None
    block_count: int | None = None
    truncated: bool | None = None


class ItemContent(ProtoMessage):
    name: str | None = None
    revision: str | None = None
    elements: list[ItemContentElement] | None = None
    page_assets: list[ItemPageAsset] | None = None
    rendition: ItemRendition | None = None


def content_message(record: ContentRecord) -> ItemContent:
    ws, item_id = record.workspace_id, record.item_id
    rendition = record.rendition
    return ItemContent(
        name=f"{item_name(ws, item_id)}/content",
        revision=revision_name(ws, item_id, record.revision),
        elements=[
            ItemContentElement(
                element_id=element.element_id,
                kind=element.kind,  # type: ignore[arg-type]
                text=element.text,
                level=element.level,
                page_number=element.page_number,
                passage=passage_name(ws, item_id, element.chunk_id) if element.chunk_id else None,
            )
            for element in record.elements
        ],
        page_assets=[page_asset_message(asset) for asset in record.page_assets],
        rendition=rendition_message(rendition) if rendition is not None else None,
    )


def page_asset_message(asset: PageAsset) -> ItemPageAsset:
    return ItemPageAsset(
        page_number=asset.page_number,
        image_uri=asset.image_uri,
        width_pixels=asset.width_pixels,
        height_pixels=asset.height_pixels,
    )


def rendition_message(rendition: Rendition) -> ItemRendition:
    return ItemRendition(
        uri=rendition.uri,
        version=rendition.version,
        size_bytes=rendition.size_bytes,
        block_count=rendition.block_count,
        truncated=rendition.truncated,
    )


class ItemPassageBoundingBox(ProtoMessage):
    page_number: int | None = None
    left: float | None = None
    top: float | None = None
    width: float | None = None
    height: float | None = None


class ItemPassage(ProtoMessage):
    name: str | None = None
    text: str | None = None
    page_number: int | None = None
    bounding_boxes: list[ItemPassageBoundingBox] | None = None
    element_ids: list[str] | None = None
    page_asset_uri: str | None = None
    revision: str | None = None


class ListPassagesResponse(ProtoMessage):
    passages: list[ItemPassage]
    next_page_token: str | None = None


def passage_message(record: PassageRecord) -> ItemPassage:
    ws, item_id = record.workspace_id, record.item_id
    return ItemPassage(
        name=passage_name(ws, item_id, record.chunk_id),
        text=record.text,
        page_number=record.page_number,
        bounding_boxes=[
            ItemPassageBoundingBox(
                page_number=box.page_number,
                left=box.left,
                top=box.top,
                width=box.width,
                height=box.height,
            )
            for box in record.bounding_boxes
        ],
        element_ids=list(record.element_ids),
        page_asset_uri=record.page_asset_uri,
        revision=revision_name(ws, item_id, record.revision) if record.revision else None,
    )


# -- Links -------------------------------------------------------------------------


class ItemLinkMessage(ProtoMessage):
    name: str | None = None
    target_item: str | None = None
    merged_from: str | None = None
    target_display_name: str | None = None
    creator: str | None = None
    create_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    etag: str | None = None


class ListItemLinksResponse(ProtoMessage):
    links: list[ItemLinkMessage]
    next_page_token: str | None = None


def link_message(record: LinkRecord) -> ItemLinkMessage:
    ws = record.workspace_id
    name = link_name(ws, record.collection_id, record.target_id)
    return ItemLinkMessage(
        name=name,
        target_item=item_name(ws, record.resolved_target_id),
        merged_from=item_name(ws, record.merged_from) if record.merged_from else None,
        target_display_name=record.target_display_name,
        creator=member_name(ws, record.creator_id) if record.creator_id else None,
        create_time=record.create_time,
        delete_time=record.delete_time,
        etag=etags.compute(name, record.update_time),
    )


LINK_ORDER = OrderSchema(
    {"targetDisplayName": LINK_TARGET_TITLE, "createTime": ItemLink.created_at},
    tie_breaker=[ItemLink.id],
    default="createTime",
)

# -- IAM ---------------------------------------------------------------------------


class BindingMessage(ProtoMessage):
    role: str
    members: list[str]


class PolicyMessage(ProtoMessage):
    version: int | None = None
    bindings: list[BindingMessage] | None = None
    etag: str | None = None


class GetPolicyOptions(ProtoMessage):
    requested_policy_version: int | None = None


class GetIamPolicyRequest(ProtoMessage):
    options: GetPolicyOptions | None = None


class SetIamPolicyRequest(ProtoMessage):
    policy: PolicyMessage
    update_mask: str | None = None


class TestIamPermissionsRequest(ProtoMessage):
    permissions: list[str]


class TestIamPermissionsResponse(ProtoMessage):
    permissions: list[str]


def policy_message(record: PolicyRecord) -> PolicyMessage:
    return PolicyMessage(
        version=record.version,
        bindings=[BindingMessage(role=role, members=list(members)) for role, members in record.bindings],
        etag=record.etag,
    )


# -- Search ------------------------------------------------------------------------


class SearchItemsFacetSpec(ProtoMessage):
    field: str
    limit: int | None = None
    excluded_from_filter: bool = True


class SearchItemsContentSearchSpec(ProtoMessage):
    snippets: bool | None = None
    passages: int | None = Field(default=None, ge=0)


class SearchItemsRequest(ProtoMessage):
    query: str | None = None
    filter: str | None = None
    facet_specs: list[SearchItemsFacetSpec] | None = None
    order_by: str | None = None
    related_item: str | None = None
    content_search_spec: SearchItemsContentSearchSpec | None = None
    page_size: int | None = None
    page_token: str | None = None


class SearchItemsPassage(ProtoMessage):
    passage: str | None = None
    text: str | None = None
    page_number: int | None = None
    score: float | None = None


class SearchItemsResult(ProtoMessage):
    item: ItemMessage | None = None
    snippets: list[str] | None = None
    passages: list[SearchItemsPassage] | None = None
    score: float | None = None


class SearchItemsFacetValue(ProtoMessage):
    value: str | None = None
    display_name: str | None = None
    document_count: int | None = None


class SearchItemsFacet(ProtoMessage):
    field: str | None = None
    values: list[SearchItemsFacetValue] | None = None


class SearchItemsResponse(ProtoMessage):
    results: list[SearchItemsResult]
    facets: list[SearchItemsFacet] | None = None
    total_size: int | None = None
    next_page_token: str | None = None


def search_response(
    workspace_id: UUID, page: SearchPage, results: list[Any], next_page_token: str
) -> SearchItemsResponse:
    return SearchItemsResponse(
        results=[
            SearchItemsResult(
                item=item_message(result.item),
                snippets=list(result.snippets) or None,
                passages=[
                    SearchItemsPassage(
                        passage=passage_name(result.item.workspace_id, result.item.item_id, passage.chunk_id),
                        text=passage.text,
                        page_number=passage.page_number,
                        score=passage.score,
                    )
                    for passage in result.passages
                ]
                or None,
                score=result.score,
            )
            for result in results
        ],
        facets=[
            SearchItemsFacet(
                field=facet.field,
                values=[
                    SearchItemsFacetValue(
                        value=facet_value_name(workspace_id, facet.field, value.value),
                        display_name=value.display_name,
                        document_count=value.document_count,
                    )
                    for value in facet.values
                ],
            )
            for facet in page.facets
        ]
        or None,
        total_size=page.total_size,
        next_page_token=next_page_token or None,
    )


def facet_value_name(workspace_id: UUID, field: str, value: str) -> str:
    """A facet value as a resource name where the field is a reference."""
    match field:
        case "ancestors":
            return item_name(workspace_id, UUID(value))
        case "document.topics":
            return topic_name(workspace_id, value)
        case "document.owner":
            return member_name(workspace_id, UUID(value))
        case "document.origin.source":
            return source_name(workspace_id, value)
    return value


# -- Filters and orderings ---------------------------------------------------------

REFERENCE_FIELDS = ("parentItem", "ancestors")


def item_filters(workspace_id: UUID, processing_version: str) -> FilterSchema:
    """The AIP-160 fields of ListItems and SearchItems."""

    def item_reference(name: str) -> UUID | None:
        return parse_item(name, workspace_id, field="filter") if name else None

    return FilterSchema(
        {
            "parentItem": resource_name(Item.parent_item_id, item_reference),
            "ancestors": repeated(
                resource_name(Item.id, item_reference), has=queries.has_ancestor
            ),
            "itemType": enum(queries.ITEM_TYPE, ("COLLECTION", "DOCUMENT")),
            "displayName": string(Item.title),
            "document.mimeType": string(Item.mime_type),
            "document.documentType": string(Item.document_type),
            "document.purpose": enum(queries.PURPOSE, ("KNOWLEDGE", "CONVERSATION_ATTACHMENT")),
            "document.topics": repeated(
                resource_name(Item.id, lambda name: parse_topic(name, workspace_id, field="filter")),
                has=queries.has_topic,
            ),
            "document.owner": resource_name(
                queries.OWNER_ID,
                lambda name: str(parse_member_name(name, workspace_id, field="filter")),
            ),
            "document.publicationState": enum(queries.PUBLICATION_STATE, ("PUBLISHED", "UNPUBLISHED")),
            "document.contentState": enum(queries.CONTENT_STATE, ("PENDING", "AVAILABLE", "FAILED")),
            "document.indexingState": enum(
                queries.indexing_state(processing_version),
                ("PENDING", "RUNNING", "SUCCEEDED", "FAILED", "OUTDATED", "UNSUPPORTED"),
            ),
            "document.origin.source": resource_name(
                queries.SOURCE_CODE, lambda name: parse_source(name, workspace_id, field="filter")
            ),
            "document.verification.state": enum(
                queries.VERIFICATION_STATE, ("VERIFIED", "REVIEW_DUE", "UNVERIFIED")
            ),
            "updateTime": timestamp(Item.updated_at),
        }
    )


ITEM_ORDER = OrderSchema(
    {
        "displayName": Item.title,
        "updateTime": Item.updated_at,
        "createTime": Item.created_at,
        "itemType": Item.item_type,
    },
    tie_breaker=[Item.id],
    default="displayName",
)

#: SearchItems facet field → the filter field its disjunctive count ignores.
FACET_FILTER_FIELDS = {
    "ancestors": "ancestors",
    "document.documentType": "document.documentType",
    "document.topics": "document.topics",
    "document.owner": "document.owner",
    "document.origin.source": "document.origin.source",
    "document.mimeType": "document.mimeType",
    "document.languageCode": "document.languageCode",
    "document.verification.state": "document.verification.state",
}


def referenced_items(filter_text: str | None, workspace_id: UUID) -> frozenset[UUID]:
    """Items a filter names (``parentItem``, ``ancestors``): the caller must read them."""
    ids: set[UUID] = set()
    for restriction in restrictions(parse(filter_text)):
        if restriction.field in REFERENCE_FIELDS and restriction.value.text:
            ids.add(parse_item(restriction.value.text, workspace_id, field="filter"))
    return frozenset(ids)


def without_field(node: Node | None, field: str) -> Node | None:
    """``node`` with the restrictions on ``field`` dropped (disjunctive facet counts)."""
    if node is None:
        return None
    if isinstance(node, Restriction):
        return None if node.field == field else node
    if isinstance(node, Not):
        operand = without_field(node.operand, field)
        return Not(operand) if operand is not None else None
    operands = tuple(
        kept for operand in node.operands if (kept := without_field(operand, field)) is not None
    )
    if not operands:
        return None
    if len(operands) == 1:
        return operands[0]
    return And(operands) if isinstance(node, And) else Or(operands)


__all__ = [
    "FACET_FILTER_FIELDS",
    "ITEM_ORDER",
    "LINK_ORDER",
    "BindingMessage",
    "DocumentFacet",
    "EtagRequest",
    "GetIamPolicyRequest",
    "ItemContent",
    "ItemPageAsset",
    "ItemRendition",
    "ItemLinkMessage",
    "ItemMessage",
    "ItemPassage",
    "ItemRevisionMessage",
    "ListItemLinksResponse",
    "ListItemRevisionsResponse",
    "ListItemsResponse",
    "ListPassagesResponse",
    "MergeItemRequest",
    "MoveItemRequest",
    "PolicyMessage",
    "SearchItemsRequest",
    "SearchItemsResponse",
    "SetIamPolicyRequest",
    "TestIamPermissionsRequest",
    "TestIamPermissionsResponse",
    "View",
    "content_message",
    "facet_value_name",
    "item_changes",
    "item_filters",
    "item_message",
    "link_message",
    "new_item",
    "page_asset_message",
    "passage_message",
    "policy_message",
    "referenced_items",
    "rendition_message",
    "revision_message",
    "search_response",
    "without_field",
]
