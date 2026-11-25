"""The reader view of a document: its preview and its content (GetItemContent).

GetItemPreview is PostgreSQL plus signed storage URLs only (``document_viewer.md``):
the preview engine answers from the revision's stored representation and
never converts; a missing one is asked of the ingestion worker
(``bomesh_preview``). GetItemContent reads a window of a revision's Structured
Document (``derived/…/structure-v1/{fingerprint}.json.gz``) through the
process-wide :class:`~bomesh.services.knowledge_items.structure_store.StructureStore`
cache; PostgreSQL authorizes first and the object is immutable, so a citation
(revision + structure version + refs) always opens the nodes it names.
Conversation artifacts are hidden from the items API; their content is
authorized as the artifact (``artifacts.get``), like their other reads.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.document_structure import (
    ContentNode,
    ContentWindow,
    StructureManifest,
    StructureRef,
)
from bomesh.document_structure.identity import FINGERPRINT_PATTERN, NODE_REF_PATTERN
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound, PermissionDenied
from bomesh.iam.authorizer import ItemRef, WorkspaceRef, not_found
from bomesh.services.artifacts.support import open_artifact, withheld
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.file_types import processed_as_pdf
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.knowledge_items.records import (
    ContentRecord,
    PreviewRecord,
    SignedPicture,
)
from bomesh.services.knowledge_items.structure_store import StructureUnavailable
from bomesh.services.knowledge_items.support import (
    KnowledgeDeps,
    is_hidden_item,
    load_content_source,
)

#: Blocks of one content window: the default and the most a request gets.
DEFAULT_CONTENT_PAGE_SIZE = 40
MAX_CONTENT_PAGE_SIZE = 200
CONTENT_NOT_PROCESSED = "CONTENT_NOT_PROCESSED"
CONTENT_VERSION_UNAVAILABLE = "CONTENT_VERSION_UNAVAILABLE"

ContentView = Literal["FULL", "OUTLINE"]
_TOKEN_VERSION = 1


class ItemContentService:
    """GetItemPreview and GetItemContent."""

    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ItemContentService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    async def get_preview(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, revision: int | None
    ) -> PreviewRecord:
        """How to show the current (or the given) revision's own file; never needs processing."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_content_source(
                session, ctx, workspace_id, item_id, reviewer_exception=True
            )
            if item.item_kind != "document":
                raise InvalidArgument("A COLLECTION has no preview.")
            if item.content_state != "available":
                raise FailedPrecondition(
                    "The document's content is not available yet.", reason="CONTENT_NOT_AVAILABLE"
                )
            items = ItemService(session)
            stored = (
                await items.revision(item_id, revision)
                if revision is not None
                else await items.current_revision(item_id)
            )
            if stored is None:
                if revision is not None:
                    raise NotFound(
                        f"Revision {revision} of '{item_name(workspace_id, item_id)}' was not found."
                    )
                raise FailedPrecondition(
                    "The document's content is not available yet.", reason="CONTENT_NOT_AVAILABLE"
                )
            view = await self._deps.previews.read(session, item, stored)
            return PreviewRecord(
                workspace_id=workspace_id,
                item_id=item_id,
                revision=stored.revision_number,
                state=view.state,
                unavailable_reason=view.unavailable_reason,
                representation=view.representation,
                original=view.original,
            )

    async def get_content(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        *,
        revision: int | None,
        version: str | None,
        anchor: str | None,
        view: str,
        page_size: int | None,
        page_token: str | None,
    ) -> ContentRecord:
        """A window (or the outline) of a revision's Structured Document.

        The revision defaults to ``indexedRevision`` (else the current one
        when it has a Structured Document) and the version to that revision's
        ``exports.structure``. A page token pins both, so paging stays on the
        version it started on.
        """
        mode = _view(view)
        size = _page_size(page_size)
        if anchor is not None and page_token is not None:
            raise InvalidArgument.for_field("anchor", "anchor and pageToken cannot both be set.")
        if anchor is not None and not NODE_REF_PATTERN.match(anchor):
            raise InvalidArgument.for_field("anchor", f"'{anchor}' is not a content node.")
        if version is not None and not FINGERPRINT_PATTERN.match(version):
            raise InvalidArgument.for_field("version", f"'{version}' is not a content version.")
        token = _decode_token(page_token) if page_token is not None else None
        if token is not None:
            if mode == "OUTLINE":
                raise InvalidArgument.for_field("pageToken", "An OUTLINE has no pages.")
            if (revision is not None and revision != token.revision) or (
                version is not None and version != token.version
            ):
                raise _invalid_token(
                    "pageToken does not belong to this request; keep revision and version unchanged"
                )
            revision, version = token.revision, token.version

        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item = await self._readable_document(session, ctx, workspace_id, item_id)
            stored = await _revision(ItemService(session), item, revision)
            if stored is None:
                if revision is not None:
                    raise NotFound(
                        f"Revision {revision} of '{item_name(workspace_id, item_id)}' was not found."
                    )
                raise _not_processed()
        manifest = StructureManifest.parse(stored.exports)
        if version is None:
            if manifest is None:
                raise _not_processed()
            version = manifest.fingerprint
        ref = StructureRef(item.tenant_id, stored.content_id, version)
        try:
            structure = await self._deps.structures.view(ref)
        except StructureUnavailable:
            raise FailedPrecondition(
                f"Version {version} of revision {stored.revision_number} is no longer available.",
                reason=CONTENT_VERSION_UNAVAILABLE,
            ) from None

        previous_token = next_token = None
        if mode == "OUTLINE":
            start, nodes = 0, structure.outline()
        else:
            if anchor is not None:
                window = structure.window_around(anchor, size=size)
                if window is None:
                    raise InvalidArgument.for_field(
                        "anchor", f"'{anchor}' is not a node of this content version."
                    )
            else:
                start = token.start if token is not None else 0
                if start > structure.total:
                    raise _invalid_token("pageToken is not a valid page token")
                window = structure.window(start=start, size=size)
            start, nodes = window.start, window.nodes
            previous_token, next_token = _tokens(window, size, stored.revision_number, version)
        return ContentRecord(
            workspace_id=workspace_id,
            item_id=item_id,
            revision=stored.revision_number,
            structure_version=version,
            total_nodes=structure.total,
            start_index=start,
            nodes=nodes,
            pictures=self._sign_pictures(ref, nodes),
            page_numbers=item.item_type == "pdf"
            or processed_as_pdf(stored.file_name or "", stored.mime_type),
            previous_page_token=previous_token,
            next_page_token=next_token,
            etag=_etag(stored.content_id, version, start, size, mode),
        )

    async def _readable_document(
        self, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, item_id: UUID
    ) -> Item:
        """The document whose content the caller may read (an artifact as the artifact)."""
        if await is_hidden_item(ctx, item_id):
            await ctx.authorizer.require(ctx.principal, "artifacts.get", WorkspaceRef(workspace_id))
            item, artifact = await open_artifact(
                session, ctx, workspace_id, item_id, "artifacts.get", owner_only=False
            )
            if item.deleted_at is not None:
                raise not_found(ItemRef(workspace_id, item_id))
            if artifact.kind != "evidence_review" and await withheld(
                session, ctx, workspace_id, artifact, None
            ):
                raise PermissionDenied(
                    "The artifact contains content from sources you cannot read now."
                )
            return item
        item = await load_content_source(
            session, ctx, workspace_id, item_id, reviewer_exception=True
        )
        if item.item_kind != "document":
            raise InvalidArgument("A COLLECTION has no content.")
        return item

    def _sign_pictures(
        self, ref: StructureRef, nodes: tuple[ContentNode, ...]
    ) -> dict[str, SignedPicture]:
        """Signed URLs of the pictures stored beside the document, in a stable window."""
        signed: dict[str, SignedPicture] = {}
        for node in _walk(nodes):
            if node.image is None or node.image.name in signed:
                continue
            request = self._deps.storage.presign_download(
                ref.picture_key(node.image.name),
                expires_seconds=self._deps.download_url_seconds,
                stable=True,
            )
            signed[node.image.name] = SignedPicture(uri=request.url, expire_time=request.expires_at)
        return signed


async def _revision(items: ItemService, item: Item, number: int | None) -> ItemRevision | None:
    """The requested revision, else the indexed one, else the current one if it has a structure."""
    if number is not None:
        return await items.revision(item.id, number)
    if item.indexed_revision_number is not None:
        return await items.revision(item.id, item.indexed_revision_number)
    current = await items.current_revision(item.id)
    if current is None or StructureManifest.parse(current.exports) is None:
        return None
    return current


def _walk(nodes: tuple[ContentNode, ...]) -> Iterator[ContentNode]:
    for node in nodes:
        yield node
        yield from _walk(node.children)


def _view(value: str) -> ContentView:
    if value not in ("FULL", "OUTLINE"):
        raise InvalidArgument.for_field("view", f"'{value}' is not FULL or OUTLINE.")
    return value  # type: ignore[return-value]


def _page_size(value: int | None) -> int:
    if value is not None and value < 0:
        raise InvalidArgument.for_field("pageSize", "pageSize must not be negative")
    return min(value or DEFAULT_CONTENT_PAGE_SIZE, MAX_CONTENT_PAGE_SIZE)


def _not_processed() -> FailedPrecondition:
    return FailedPrecondition(
        "The document has not been processed yet.", reason=CONTENT_NOT_PROCESSED
    )


def _etag(content_id: UUID, version: str, start: int, size: int, view: str) -> str:
    material = f"{content_id}:{version}:{start}:{size}:{view}"
    return f'"{hashlib.sha256(material.encode()).hexdigest()[:32]}"'


# -- Page tokens ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Token:
    start: int
    revision: int
    version: str


def _tokens(
    window: ContentWindow, size: int, revision: int, version: str
) -> tuple[str | None, str | None]:
    previous = (
        _encode_token(max(0, window.start - size), revision, version) if window.start > 0 else None
    )
    following = (
        _encode_token(window.stop, revision, version) if window.stop < window.total else None
    )
    return previous, following


def _encode_token(start: int, revision: int, version: str) -> str:
    payload = json.dumps(
        {"v": _TOKEN_VERSION, "s": start, "r": revision, "f": version}, separators=(",", ":")
    )
    return base64.urlsafe_b64encode(payload.encode()).rstrip(b"=").decode()


def _decode_token(token: str) -> _Token:
    try:
        payload = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
        version, start, revision, fingerprint = payload["v"], payload["s"], payload["r"], payload["f"]
    except (binascii.Error, ValueError, TypeError, KeyError):
        raise _invalid_token("pageToken is not a valid page token") from None
    if (
        version != _TOKEN_VERSION
        or not _natural(start, minimum=0)
        or not _natural(revision, minimum=1)
        or not isinstance(fingerprint, str)
        or not FINGERPRINT_PATTERN.match(fingerprint)
    ):
        raise _invalid_token("pageToken is not a valid page token")
    return _Token(start=start, revision=revision, version=fingerprint)


def _natural(value: object, *, minimum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _invalid_token(description: str) -> InvalidArgument:
    return InvalidArgument.for_field("pageToken", description)


__all__ = [
    "CONTENT_NOT_PROCESSED",
    "CONTENT_VERSION_UNAVAILABLE",
    "DEFAULT_CONTENT_PAGE_SIZE",
    "MAX_CONTENT_PAGE_SIZE",
    "ItemContentService",
]
