"""Shape durable Item records into the payloads knowledge callers consume."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from collections.abc import Mapping
from typing import Any, Callable

from bomesh.connector.protocol import (
    CitationInfo,
    SourceIdentity,
    SourceProvider,
)
from bomesh.services.preview import KnowledgePreview
from bomesh.services.item_ingestion import progress_from_phases
from bomesh.services.workflow import document_ingestion_id

log = logging.getLogger(__name__)

_PUBLIC_DOCUMENT_STATUS = {
    "pending_content": "pending_content",
    "pending": "pending_content",
    "available": "available",
    "processing": "available",
    "ready": "available",
    "failed": "failed",
    "unsupported": "failed",
}


def public_document_status(status: str | None) -> str:
    """Map internal Item lifecycle values to the public Document contract."""

    return _PUBLIC_DOCUMENT_STATUS.get(status or "", "pending_content")


#: An upload's internal index lifecycle, in the Ingestion contract's words.
_INGESTION_STATUS = {
    "pending": "pending",
    "processing": "running",
    "ready": "completed",
    "failed": "failed",
    "unsupported": "failed",
}


def document_ingestion(document: Any) -> dict[str, Any] | None:
    """The latest Ingestion of one uploaded Document, or ``None``.

    An upload's Ingestion is recorded on its Item when its bytes become
    available (or a retry opens a new one) and is kept current by the core as
    it runs — whether managed ingestion or a direct run processes it. A
    Document a connector wrote has none of its own: its Source's Ingestion
    indexed it. Content that never arrived has not started one either.
    """

    metadata = getattr(document, "metadata_", {}) or {}
    index_status = getattr(document, "index_status", None)
    record = metadata.get("ingestion")
    if not isinstance(record, dict):
        # Content availability is ``status == "ready"``; an index failure
        # leaves it there, while content that never arrived is ``failed``.
        if metadata.get("purpose") != "knowledge" or document.status != "ready":
            return None
        if index_status is None:
            return None
        # Uploaded before Ingestions were recorded: same identity, no times.
        record = {
            "id": str(document_ingestion_id(str(document.id))),
            "mode": "managed",
            "trigger_type": "upload",
            "created_at": document.created_at.isoformat(),
        }
    created_at = record.get("created_at") or document.created_at.isoformat()
    started_at = record.get("started_at")
    finished_at = record.get("finished_at")
    status = _INGESTION_STATUS.get(index_status or "", "pending")
    if record.get("cancelled") and status == "failed":
        status = "cancelled"
    duration_ms = None
    if started_at:
        end = datetime.fromisoformat(finished_at) if finished_at else datetime.now(UTC)
        duration_ms = max(0, round((end - datetime.fromisoformat(started_at)).total_seconds() * 1000))
    return {
        "id": record["id"],
        "kind": "document",
        "mode": record.get("mode", "managed"),
        "title": str(metadata.get("file_name") or document.title or "document"),
        "document_id": str(document.id),
        "collection_id": str(document.parent_item_id) if document.parent_item_id else None,
        "source_id": None,
        "connection_id": None,
        "connector_key": "file",
        "status": status,
        "trigger_type": record.get("trigger_type", "upload"),
        "retry_of_ingestion_id": None,
        "attempt": 1,
        "error": record.get("error") if status == "failed" else None,
        "progress": progress_from_phases(record.get("phases") or [], status=status),
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
        "created_at": created_at,
        "updated_at": finished_at or started_at or created_at,
    }


class DocumentPresenter:
    """Turn one Item into metadata, preview, and citation-ready payloads."""

    def __init__(
        self,
        *,
        object_storage: Callable[[], Any],
        preview: KnowledgePreview,
        citation_url_seconds: int,
        preview_url_seconds: int,
    ) -> None:
        self._object_storage = object_storage
        self._preview = preview
        self._citation_url_seconds = _bounded_seconds(citation_url_seconds)
        self._preview_url_seconds = _bounded_seconds(preview_url_seconds)

    def contract_document(self, document: Any) -> dict[str, Any]:
        """Map internal Item/upload state to the public Document contract."""

        upload = _loaded_upload(document)
        raw_status = getattr(document, "status", None)
        if upload is not None and upload.status == "available":
            public_status = "available"
        elif raw_status in {"failed", "unsupported"} or (
            upload is not None and upload.status == "failed"
        ):
            public_status = "failed"
        else:
            public_status = public_document_status(raw_status)
        metadata = getattr(document, "metadata_", {}) or {}
        return {
            "id": document.id,
            "collection_id": document.parent_item_id,
            "name": str(metadata.get("file_name") or document.title or "document"),
            "content_type": document.mime_type or "application/octet-stream",
            "size_bytes": document.size_bytes or 0,
            "purpose": metadata.get("purpose", "knowledge"),
            "status": public_status,
            "latest_ingestion": document_ingestion(document),
            "created_at": document.created_at,
            "updated_at": document.updated_at,
        }

    def presigned_url(self, document: Any) -> str | None:
        """Presign the stored original, degrading to no link on failure."""

        if not document.storage_key:
            return None
        try:
            return self._object_storage().presign_download(
                document.storage_key,
                expires_seconds=self._citation_url_seconds,
            ).url
        except Exception:
            log.exception("could not generate citation document URL")
            return None

    def preview_payload(self, document: Any) -> dict[str, Any] | None:
        """Resolve a renderable preview, degrading to none on failure."""

        upload = _loaded_upload(document)
        if upload is not None and getattr(upload, "status", None) != "available":
            return None
        if getattr(document, "status", None) == "deleted":
            return None
        try:
            preview = self._preview.resolve(
                document, expires_seconds=self._preview_url_seconds
            )
        except Exception:
            log.exception("could not resolve knowledge preview")
            return None
        return preview.model_dump(mode="json") if preview is not None else None

    @staticmethod
    def upload_target(target: Any | None) -> dict[str, Any] | None:
        """Describe the presigned destination a client should upload to."""

        if target is None:
            return None
        request = target.request
        return {
            "mode": target.mode,
            "url": request.url,
            "method": request.method,
            "headers": dict(request.headers),
            "expires_at": request.expires_at.isoformat(),
        }

    @staticmethod
    def source_identity(document: Any) -> SourceIdentity:
        """Recover the lineage of an Item, falling back to native upload."""

        metadata = getattr(document, "metadata_", None)
        if isinstance(metadata, Mapping):
            canonical = metadata.get("canonical_item")
            source_value = (
                canonical.get("source")
                if isinstance(canonical, Mapping)
                else metadata.get("source")
            )
            if isinstance(source_value, Mapping):
                try:
                    return SourceIdentity.model_validate(source_value)
                except ValueError:
                    pass
        return SourceIdentity(
            connector_id="upload",
            provider=SourceProvider.FILE,
            external_id=str(document.id),
            url=None,
        )


def viewer_elements(
    item_id: str,
    payloads: list[dict[str, Any]],
    citations: Mapping[str, CitationInfo],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Group indexed chunks into unambiguous viewer elements."""

    groups: dict[str, dict[str, Any] | None] = {}
    chunks_by_id: dict[str, dict[str, Any]] = {}
    for payload in payloads:
        chunk_index = int(payload.get("chunk_index") or 0)
        chunk_id = str(payload.get("chunk_id") or f"{item_id}:{chunk_index}")
        chunks_by_id[chunk_id] = payload
        chunks_by_id[f"{item_id}:{chunk_index}"] = payload
        _add_citation_content(
            groups,
            str(payload.get("chunk_text") or ""),
            citations.get(chunk_id, payload_citation(payload)),
        )
    return [value for value in groups.values() if value is not None], chunks_by_id


def payload_citation(payload: Mapping[str, Any]) -> CitationInfo:
    """Rebuild a citation from an indexed chunk payload."""

    raw_section_path = payload.get("section_path")
    section_path = tuple(
        value.strip()
        for value in raw_section_path or ()
        if isinstance(value, str) and value.strip()
    )
    return CitationInfo(
        section=section_path[-1] if section_path else None,
        section_path=section_path,
        anchor=_payload_text(payload, "citation_anchor"),
        page_start=_payload_int(payload, "page_start"),
        page_end=_payload_int(payload, "page_end"),
    )


def _add_citation_content(
    groups: dict[str, dict[str, Any] | None],
    content: str,
    citation: CitationInfo,
) -> None:
    if not content or len(citation.spans) != 1:
        return
    span = citation.spans[0]
    if (
        span.element_id is None
        or span.start_offset != 0
        or span.end_offset != len(content)
    ):
        return
    candidate = {
        "element_id": span.element_id,
        "text": content,
        "page": span.page,
        "section": citation.section,
        "section_path": list(citation.section_path),
        "anchor": citation.anchor,
        "bounding_box": span.bounding_box,
    }
    if span.element_id not in groups:
        groups[span.element_id] = candidate
    elif groups[span.element_id] != candidate:
        groups[span.element_id] = None


def _payload_text(metadata: Mapping[str, Any], key: str) -> str | None:
    value = metadata.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _payload_int(payload: Mapping[str, Any], key: str) -> int | None:
    value = payload.get(key)
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value)
    return None


def _bounded_seconds(value: int) -> int:
    """Keep presigned lifetimes inside the range the routes always applied."""

    return max(1, min(600, value))


def _loaded_upload(document: Any) -> Any | None:
    """Read upload relation without triggering async lazy IO after query scope."""

    values = getattr(document, "__dict__", None)
    if isinstance(values, dict):
        return values.get("upload")
    return getattr(document, "upload", None)


__all__ = [
    "DocumentPresenter",
    "document_ingestion",
    "payload_citation",
    "public_document_status",
    "viewer_elements",
]
