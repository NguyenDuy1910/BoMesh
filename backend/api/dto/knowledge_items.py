"""Knowledge item messages (``openapi.yaml`` tag Knowledge, Item part) and their field maps."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal, get_args
from uuid import UUID

from pydantic import Field
from sqlalchemy import select

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
    stored_enum,
    string,
    timestamp,
)
from api.aip.messages import Int64, ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh import etag as etags
from bomesh.db.models import Item, ItemShortcut, Space
from bomesh.document_structure import ContentNode as StructureNode
from bomesh.document_structure import Highlight
from bomesh.errors import InvalidArgument
from bomesh.services.collaboration.records import space_name
from bomesh.services.collaboration.support import parse_space_name
from bomesh.services.ingestion.common import run_name
from bomesh.services.ingestion.names import parse_source, source_name
from bomesh.services.knowledge_curation.records import (
    contribution_name,
    parse_topic,
    topic_name,
)
from bomesh.services.knowledge_items import queries
from bomesh.services.knowledge_items.names import (
    item_name,
    shortcut_name,
    parse_item,
    revision_name,
)
from bomesh.services.knowledge_items.records import (
    CollectionImportResult,
    CollectionImportRow,
    ContentRecord,
    Cover,
    ItemRecord,
    ShortcutRecord,
    NewCollection,
    NewDocument,
    NewItem,
    PolicyRecord,
    PreviewRecord,
    RevisionRecord,
    SearchPage,
    SearchReference,
)
from bomesh.services.knowledge_items.support import SHORTCUT_TARGET
from bomesh.services.workspaces.records import member_name, parse_member_name

ItemKind = Literal["COLLECTION", "DOCUMENT"]
#: ``Item.itemType`` (output only): a collection's type or a document's file class.
ItemType = Literal[
    "STANDARD",
    "PERSONAL",
    "PDF",
    "WORD",
    "PRESENTATION",
    "SPREADSHEET",
    "MARKDOWN",
    "HTML",
    "PLAIN_TEXT",
    "DATA",
    "IMAGE",
    "AUDIO",
    "VIDEO",
    "ARCHIVE",
    "OTHER",
]
View = Literal["BASIC", "FULL"]
Purpose = Literal["KNOWLEDGE", "CONVERSATION_ATTACHMENT"]

# -- Item -----------------------------------------------------------------------


class ItemAncestor(ProtoMessage):
    name: str | None = None
    display_name: str | None = None


class CollectionFacet(ProtoMessage):
    owner: str | None = None
    owner_summary: str | None = None
    description: str | None = None
    inherit_access: bool | None = None
    discoverable: bool | None = None
    accepts_contributions: bool | None = None
    child_count: int | None = None
    document_count: int | None = None
    shortcut_count: int | None = None


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


class DocumentCover(ProtoMessage):
    kind: Literal["PAGE", "SLIDE", "SHEET", "TEXT", "IMAGE"]
    image_uri: str | None = None
    width_pixels: int | None = None
    height_pixels: int | None = None
    title: str | None = None
    lines: list[str] | None = None
    cells: list[list[str]] | None = None


def cover_message(cover: Cover | None) -> DocumentCover | None:
    """``DocumentCover`` of a projected cover; empty text fields are omitted."""
    if cover is None:
        return None
    return DocumentCover(
        kind=cover.kind,  # type: ignore[arg-type]
        image_uri=cover.image_uri,
        width_pixels=cover.width_pixels,
        height_pixels=cover.height_pixels,
        title=cover.title,
        lines=list(cover.lines) or None,
        cells=[list(row) for row in cover.cells] or None,
    )


class DocumentFacet(ProtoMessage):
    file_name: str | None = None
    mime_type: str | None = None
    size_bytes: Int64 | None = None
    purpose: Purpose | None = None
    topics: list[str] | None = None
    #: Output only: the subset of ``topics`` the assistant applied.
    assistant_topics: list[str] | None = None
    summary: str | None = None
    language_code: str | None = None
    owner: str | None = None
    content_state: Literal["PENDING", "AVAILABLE", "FAILED"] | None = None
    publication_state: Literal["PUBLISHED", "UNPUBLISHED"] | None = None
    #: Output only: PERSONAL in a member's My files, STANDARD in shared collections.
    collection_kind: Literal["STANDARD", "PERSONAL"] | None = None
    indexing_state: (
        Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "OUTDATED", "UNSUPPORTED"] | None
    ) = None
    indexing_error: dict[str, Any] | None = None
    last_ingestion_run: str | None = None
    revision: str | None = None
    indexed_revision: str | None = None
    verification: ItemVerification | None = None
    origin: ItemOrigin | None = None
    quality_issues: list[ItemQualityIssue] | None = None
    cover: DocumentCover | None = None
    upload_uri: str | None = None


class ItemMessage(ProtoMessage):
    """``Item``: one collection or document. Output-only fields sent on input are ignored."""

    name: str | None = None
    item_kind: ItemKind | None = None
    #: Output only.
    item_type: ItemType | None = None
    display_name: str | None = Field(default=None, max_length=512)
    parent_item: str | None = None
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
            item_kind="COLLECTION",
            item_type=record.item_type,  # type: ignore[arg-type]
            display_name=record.display_name,
            access="LOCKED",
            collection=CollectionFacet(
                description=record.collection.description,
                owner_summary=record.collection.owner_summary,
            ),
        )
    return ItemMessage(
        name=name,
        item_kind=record.item_kind,  # type: ignore[arg-type]
        item_type=record.item_type,  # type: ignore[arg-type]
        display_name=record.display_name,
        parent_item=item_name(ws, record.parent_id) if record.parent_id else "",
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
        owner=member_name(ws, facet.owner_id) if facet.owner_id else None,
        owner_summary=facet.owner_summary,
        description=facet.description,
        inherit_access=facet.inherit_access,
        discoverable=facet.discoverable,
        accepts_contributions=facet.accepts_contributions,
        child_count=facet.child_count,
        document_count=facet.document_count,
        shortcut_count=facet.shortcut_count,
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
        topics=[topic_name(ws, code) for code in facet.topics],
        assistant_topics=[topic_name(ws, code) for code in facet.assistant_topics],
        summary=facet.summary,
        language_code=facet.language_code,
        owner=member_name(ws, facet.owner_id) if facet.owner_id else None,
        content_state=facet.content_state,  # type: ignore[arg-type]
        publication_state=facet.publication_state,  # type: ignore[arg-type]
        collection_kind=facet.collection_kind,  # type: ignore[arg-type]
        indexing_state=facet.indexing_state,  # type: ignore[arg-type]
        indexing_error=dict(facet.indexing_error) if facet.indexing_error is not None else None,
        last_ingestion_run=run_name(ws, facet.last_run_id) if facet.last_run_id else None,
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
        quality_issues=[] if facet.editor else None,
        cover=cover_message(facet.cover),
        upload_uri=facet.upload_uri,
    )


def new_item(message: ItemMessage, workspace_id: UUID, *, field: str = "") -> NewItem:
    """CreateItem input: names resolved to IDs of ``workspace_id``."""
    prefix = f"{field}." if field else ""
    if message.item_kind is None:
        raise InvalidArgument.for_field(f"{prefix}itemKind", "itemKind is required.")
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
        item_kind=message.item_kind.lower(),
        display_name=message.display_name,
        parent_id=parent,
        collection=(
            NewCollection(
                description=collection.description,
                discoverable=collection.discoverable,
                accepts_contributions=collection.accepts_contributions,
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


# -- Folder import -----------------------------------------------------------------

#: ImportCollections ``rows`` bound (``openapi.yaml``).
MAX_COLLECTION_IMPORT_ROWS = 1000


class CollectionImportRowMessage(ProtoMessage):
    path: list[str] = Field(min_length=1)
    description: str | None = Field(default=None, max_length=2000)


class ImportCollectionsRequest(ProtoMessage):
    rows: list[CollectionImportRowMessage] = Field(min_length=1)
    validate_only: bool = False


class CollectionImportChangeMessage(ProtoMessage):
    item: str | None = None
    path: list[str]
    row: int | None = None


class CollectionImportSkippedRowMessage(ProtoMessage):
    row: int
    reason: str


class ImportCollectionsResponse(ProtoMessage):
    created: list[CollectionImportChangeMessage]
    unchanged_count: int
    skipped_rows: list[CollectionImportSkippedRowMessage]


def collection_import_rows(request: ImportCollectionsRequest) -> tuple[CollectionImportRow, ...]:
    if len(request.rows) > MAX_COLLECTION_IMPORT_ROWS:
        raise InvalidArgument.for_field(
            "rows", f"At most {MAX_COLLECTION_IMPORT_ROWS} rows are allowed."
        )
    return tuple(
        CollectionImportRow(path=tuple(row.path), description=row.description)
        for row in request.rows
    )


def collection_import_response(
    workspace_id: UUID, result: CollectionImportResult
) -> ImportCollectionsResponse:
    return ImportCollectionsResponse(
        created=[
            CollectionImportChangeMessage(
                item=item_name(workspace_id, change.item_id) if change.item_id else None,
                path=list(change.path),
                row=change.row,
            )
            for change in result.created
        ],
        unchanged_count=result.unchanged_count,
        skipped_rows=[
            CollectionImportSkippedRowMessage(row=row, reason=reason)
            for row, reason in result.skipped
        ],
    )


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


# -- Preview and content -------------------------------------------------------------


class ItemRepresentation(ProtoMessage):
    kind: Literal["PDF", "IMAGE", "TABLE", "TEXT", "MEDIA", "ARCHIVE"] | None = None
    uri: str | None = None
    mime_type: str | None = None
    size_bytes: Int64 | None = None
    expire_time: Timestamp | None = None
    text_format: Literal["MARKDOWN", "PLAIN"] | None = None
    language: str | None = None
    media_type: Literal["VIDEO", "AUDIO"] | None = None
    truncated: bool | None = None


class ItemPreviewFile(ProtoMessage):
    uri: str | None = None
    mime_type: str | None = None
    size_bytes: Int64 | None = None
    expire_time: Timestamp | None = None


class ItemPreview(ProtoMessage):
    name: str | None = None
    revision: str | None = None
    state: Literal["READY", "PREPARING", "UNAVAILABLE"] | None = None
    unavailable_reason: (
        Literal["FORMAT_NOT_SUPPORTED", "TOO_LARGE", "CONVERSION_FAILED"] | None
    ) = None
    representation: ItemRepresentation | None = None
    original: ItemPreviewFile | None = None


def preview_message(record: PreviewRecord) -> ItemPreview:
    ws, item_id = record.workspace_id, record.item_id
    representation, original = record.representation, record.original
    return ItemPreview(
        name=f"{item_name(ws, item_id)}/preview",
        revision=revision_name(ws, item_id, record.revision),
        state=record.state,  # type: ignore[arg-type]
        unavailable_reason=record.unavailable_reason,  # type: ignore[arg-type]
        representation=(
            ItemRepresentation(
                kind=representation.kind,  # type: ignore[arg-type]
                uri=representation.uri,
                mime_type=representation.mime_type,
                size_bytes=representation.size_bytes,
                expire_time=representation.expire_time,
                text_format=representation.text_format,  # type: ignore[arg-type]
                language=representation.language,
                media_type=representation.media_type,  # type: ignore[arg-type]
                truncated=representation.truncated,
            )
            if representation is not None
            else None
        ),
        original=ItemPreviewFile(
            uri=original.uri,
            mime_type=original.mime_type,
            size_bytes=original.size_bytes,
            expire_time=original.expire_time,
        ),
    )


class ContentRun(ProtoMessage):
    text: str
    bold: bool | None = None
    italic: bool | None = None
    uri: str | None = None


class ContentCell(ProtoMessage):
    text: str
    row_span: int | None = None
    col_span: int | None = None
    header: bool | None = None


class ContentRow(ProtoMessage):
    cells: list[ContentCell]


class ContentImage(ProtoMessage):
    uri: str
    mime_type: str
    width_pixels: int
    height_pixels: int
    expire_time: Timestamp


class ContentNode(ProtoMessage):
    ref: str
    kind: Literal[
        "HEADING", "PARAGRAPH", "LIST", "LIST_ITEM", "TABLE", "CODE", "FORMULA", "PICTURE"
    ]
    runs: list[ContentRun] | None = None
    level: int | None = None
    marker: str | None = None
    ordered: bool | None = None
    children: list[ContentNode] | None = None
    rows: list[ContentRow] | None = None
    total_rows: int | None = None
    caption: str | None = None
    image: ContentImage | None = None
    language: str | None = None
    sheet: str | None = None
    page_number: int | None = None


class ItemContent(ProtoMessage):
    name: str
    revision: str
    structure_version: str
    total_nodes: int
    start_index: int
    nodes: list[ContentNode]
    previous_page_token: str | None = None
    next_page_token: str | None = None


def content_message(record: ContentRecord) -> ItemContent:
    ws, item_id = record.workspace_id, record.item_id
    return ItemContent(
        name=f"{item_name(ws, item_id)}/content",
        revision=revision_name(ws, item_id, record.revision),
        structure_version=record.structure_version,
        total_nodes=record.total_nodes,
        start_index=record.start_index,
        nodes=[_content_node(node, record) for node in record.nodes],
        previous_page_token=record.previous_page_token,
        next_page_token=record.next_page_token,
    )


def _content_node(node: StructureNode, record: ContentRecord) -> ContentNode:
    picture = record.pictures.get(node.image.name) if node.image is not None else None
    return ContentNode(
        ref=node.id,
        kind=node.kind.value,  # type: ignore[arg-type]
        runs=[
            ContentRun(
                text=run.text, bold=run.bold or None, italic=run.italic or None, uri=run.uri
            )
            for run in node.runs
        ]
        or None,
        level=node.level,
        marker=node.marker,
        ordered=node.ordered,
        children=[_content_node(child, record) for child in node.children] or None,
        rows=[
            ContentRow(
                cells=[
                    ContentCell(
                        text=cell.text,
                        row_span=cell.row_span if cell.row_span > 1 else None,
                        col_span=cell.col_span if cell.col_span > 1 else None,
                        header=cell.header or None,
                    )
                    for cell in row
                ]
            )
            for row in node.rows
        ]
        or None,
        total_rows=node.total_rows,
        caption=node.caption,
        image=(
            ContentImage(
                uri=picture.uri,
                mime_type=node.image.mime_type,
                width_pixels=node.image.width,
                height_pixels=node.image.height,
                expire_time=picture.expire_time,
            )
            if node.image is not None and picture is not None
            else None
        ),
        language=node.language,
        sheet=node.sheet,
        page_number=node.page if record.page_numbers else None,
    )


# -- Shortcuts ----------------------------------------------------------------------


class ItemShortcutMessage(ProtoMessage):
    name: str | None = None
    target_item: str | None = None
    target_display_name: str | None = None
    creator: str | None = None
    create_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    etag: str | None = None


class ListItemShortcutsResponse(ProtoMessage):
    shortcuts: list[ItemShortcutMessage]
    next_page_token: str | None = None


def shortcut_message(record: ShortcutRecord) -> ItemShortcutMessage:
    ws = record.workspace_id
    name = shortcut_name(ws, record.collection_id, record.target_id)
    return ItemShortcutMessage(
        name=name,
        target_item=item_name(ws, record.target_id),
        target_display_name=record.target_display_name,
        creator=member_name(ws, record.creator_id) if record.creator_id else None,
        create_time=record.create_time,
        delete_time=record.delete_time,
        etag=etags.compute(name, record.update_time),
    )


SHORTCUT_ORDER = OrderSchema(
    {"targetDisplayName": SHORTCUT_TARGET.item_name, "createTime": ItemShortcut.created_at},
    tie_breaker=[ItemShortcut.id],
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


class SearchItemsInterval(ProtoMessage):
    minimum: Timestamp | None = None
    maximum: Timestamp | None = None


class SearchItemsFacetSpec(ProtoMessage):
    field: str
    limit: int | None = None
    intervals: list[SearchItemsInterval] | None = None
    excluded_from_filter: bool = True


class SearchItemsContentSearchSpec(ProtoMessage):
    snippets: bool | None = None
    references: int | None = Field(default=None, ge=0)


class SearchItemsRequest(ProtoMessage):
    query: str | None = None
    filter: str | None = None
    facet_specs: list[SearchItemsFacetSpec] | None = None
    order_by: str | None = None
    related_item: str | None = None
    content_search_spec: SearchItemsContentSearchSpec | None = None
    page_size: int | None = None
    page_token: str | None = None


class HighlightBoxMessage(ProtoMessage):
    """The contract ``HighlightBox``: page fractions from the top-left corner."""

    left: float
    top: float
    right: float
    bottom: float


class HighlightMessage(ProtoMessage):
    """The contract ``Highlight``: a PDF page with boxes, or a sheet cell range."""

    page_number: int | None = None
    boxes: list[HighlightBoxMessage] | None = None
    sheet: str | None = None
    cell_range: str | None = None


def highlight_messages(highlights: Sequence[Highlight]) -> list[HighlightMessage]:
    return [
        HighlightMessage(
            page_number=highlight.page,
            boxes=[
                HighlightBoxMessage(left=left, top=top, right=right, bottom=bottom)
                for left, top, right, bottom in highlight.boxes
            ],
        )
        if highlight.page is not None
        else HighlightMessage(sheet=highlight.sheet, cell_range=highlight.range)
        for highlight in highlights
    ]


class ContentReference(ProtoMessage):
    item: str
    revision: str
    structure_version: str
    refs: list[str]
    quote: str
    location: str
    highlights: list[HighlightMessage]


def content_reference_message(workspace_id: UUID, reference: SearchReference) -> ContentReference:
    target = reference.target
    return ContentReference(
        item=item_name(workspace_id, target.item_id),
        revision=revision_name(workspace_id, target.item_id, target.revision_number),
        structure_version=target.structure_version,
        refs=list(target.refs),
        quote=target.quote,
        location=target.location,
        highlights=highlight_messages(target.highlights),
    )


class SearchItemsResult(ProtoMessage):
    item: ItemMessage | None = None
    snippets: list[str] | None = None
    references: list[ContentReference] | None = None
    score: float | None = None


class SearchItemsFacetValue(ProtoMessage):
    value: str | None = None
    interval: SearchItemsInterval | None = None
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
                references=[
                    content_reference_message(result.item.workspace_id, reference)
                    for reference in result.references
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
                        value=facet_value_name(workspace_id, facet.field, value.value)
                        if value.value is not None
                        else None,
                        interval=SearchItemsInterval(
                            minimum=value.interval.minimum, maximum=value.interval.maximum
                        )
                        if value.interval is not None
                        else None,
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
        case "document.topics" | "document.assistantTopics":
            return topic_name(workspace_id, value)
        case "document.owner":
            return member_name(workspace_id, UUID(value))
        case "spaces":
            return space_name(workspace_id, value)
        case "document.origin.source":
            return source_name(workspace_id, value)
    return value


# -- Filters and orderings ---------------------------------------------------------

#: Filter fields naming items the caller must be able to read (``name`` is not one:
#: a batch read by name simply omits unreadable or missing items).
REFERENCE_FIELDS = ("parentItem", "ancestors")


def item_filters(
    workspace_id: UUID, processing_version: str, *, field: str = "filter"
) -> FilterSchema:
    """The AIP-160 fields of ListItems and SearchItems (and of ingestion selectors).

    ``field`` names the request field in INVALID_ARGUMENT errors.
    """

    def item_reference(name: str) -> UUID | None:
        return parse_item(name, workspace_id, field=field) if name else None

    def topic_reference(name: str) -> str:
        return parse_topic(name, workspace_id, field=field)

    def space_reference(name: str) -> Any:
        code = parse_space_name(name, workspace_id, field=field)
        return (
            select(Space.id)
            .where(Space.tenant_id == workspace_id, Space.code == code, Space.deleted_at.is_(None))
            .scalar_subquery()
        )

    return FilterSchema(
        {
            "name": resource_name(Item.id, item_reference),
            "parentItem": resource_name(Item.parent_item_id, item_reference),
            "ancestors": repeated(
                resource_name(Item.id, item_reference),
                has=queries.has_ancestor,
                present=Item.parent_item_id.is_not(None),
            ),
            "itemKind": stored_enum(Item.item_kind, get_args(ItemKind)),
            "itemType": stored_enum(Item.item_type, get_args(ItemType)),
            "displayName": string(Item.item_name),
            "document.mimeType": string(queries.MIME_TYPE),
            "document.languageCode": string(queries.LANGUAGE),
            "spaces": repeated(resource_name(Item.id, space_reference), has=queries.in_space),
            "document.purpose": stored_enum(
                Item.purpose, ("KNOWLEDGE", "CONVERSATION_ATTACHMENT")
            ),
            "document.topics": repeated(
                resource_name(Item.id, topic_reference),
                has=queries.has_topic,
                present=queries.HAS_TOPICS,
            ),
            "document.assistantTopics": repeated(
                resource_name(Item.id, topic_reference),
                has=queries.has_assistant_topic,
                present=queries.HAS_ASSISTANT_TOPICS,
            ),
            "document.owner": resource_name(
                queries.OWNER_ID,
                lambda name: str(parse_member_name(name, workspace_id, field=field)),
            ),
            "document.summary": string(queries.SUMMARY),
            "document.publicationState": enum(queries.PUBLICATION_STATE, ("PUBLISHED", "UNPUBLISHED")),
            "document.collectionKind": enum(
                queries.collection_kind(workspace_id), ("STANDARD", "PERSONAL")
            ),
            "document.contentState": enum(queries.CONTENT_STATE, ("PENDING", "AVAILABLE", "FAILED")),
            "document.indexingState": enum(
                queries.indexing_state(processing_version),
                ("PENDING", "RUNNING", "SUCCEEDED", "FAILED", "OUTDATED", "UNSUPPORTED"),
                conditions=queries.indexing_state_conditions(processing_version),
            ),
            "document.origin.source": resource_name(
                queries.SOURCE_CODE, lambda name: parse_source(name, workspace_id, field=field)
            ),
            "document.verification.state": enum(
                queries.VERIFICATION_STATE, ("VERIFIED", "REVIEW_DUE", "UNVERIFIED")
            ),
            "updateTime": timestamp(Item.updated_at),
        },
        field=field,
    )


ITEM_ORDER = OrderSchema(
    {
        "displayName": Item.item_name,
        "updateTime": Item.updated_at,
        "createTime": Item.created_at,
        "itemKind": Item.item_kind,
    },
    tie_breaker=[Item.id],
    default="displayName",
)

#: SearchItems facet field → the filter field its disjunctive count ignores.
FACET_FILTER_FIELDS = {
    "ancestors": "ancestors",
    "itemType": "itemType",
    "document.topics": "document.topics",
    "document.assistantTopics": "document.assistantTopics",
    "document.owner": "document.owner",
    "document.origin.source": "document.origin.source",
    "document.mimeType": "document.mimeType",
    "document.languageCode": "document.languageCode",
    "spaces": "spaces",
    "document.verification.state": "document.verification.state",
    "updateTime": "updateTime",
}


def referenced_items(filter_text: str | None, workspace_id: UUID) -> frozenset[UUID]:
    """Items a filter names (``parentItem``, ``ancestors``): the caller must read them."""
    ids: set[UUID] = set()
    for restriction in restrictions(parse(filter_text)):
        if (
            restriction.field in REFERENCE_FIELDS
            and restriction.value.text
            and not restriction.is_presence
        ):
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
    "SHORTCUT_ORDER",
    "BindingMessage",
    "ContentNode",
    "ContentReference",
    "DocumentFacet",
    "EtagRequest",
    "GetIamPolicyRequest",
    "ImportCollectionsRequest",
    "ImportCollectionsResponse",
    "ItemShortcutMessage",
    "ItemMessage",
    "ItemContent",
    "ItemPreview",
    "ItemPreviewFile",
    "ItemRepresentation",
    "ItemRevisionMessage",
    "ListItemShortcutsResponse",
    "ListItemRevisionsResponse",
    "ListItemsResponse",
    "MergeItemRequest",
    "MoveItemRequest",
    "PolicyMessage",
    "SearchItemsFacetSpec",
    "SearchItemsRequest",
    "SearchItemsResponse",
    "SetIamPolicyRequest",
    "TestIamPermissionsRequest",
    "TestIamPermissionsResponse",
    "View",
    "collection_import_response",
    "collection_import_rows",
    "facet_value_name",
    "content_message",
    "item_changes",
    "item_filters",
    "item_message",
    "shortcut_message",
    "new_item",
    "policy_message",
    "preview_message",
    "referenced_items",
    "revision_message",
    "search_response",
    "without_field",
]
