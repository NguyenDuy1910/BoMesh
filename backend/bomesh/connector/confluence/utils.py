from __future__ import annotations

import logging
import tempfile
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from typing import Any
from pathlib import Path
from urllib.parse import parse_qs
from urllib.parse import quote
from urllib.parse import urljoin
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel

from ..file import FinxFileExtensions
from bomesh.connector.originals import store_original
from bomesh.connector.protocol import RawObjectStore, StorageObject

log = logging.getLogger(__name__)

CONFLUENCE_OAUTH_TOKEN_URL = "https://auth.atlassian.com/oauth/token"

_ATTACHMENT_SIZE_THRESHOLD = 10 * 1024 * 1024


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    scope: str


def get_file_ext(filename: str) -> str:
    # Extract lowercase file extension from a filename.
    return "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def validate_attachment_filetype(
    attachment: dict[str, Any],
) -> bool:
    # Only files the knowledge pipeline reads; images are not knowledge.
    return get_file_ext(attachment.get("title", "")) in FinxFileExtensions.KNOWLEDGE_EXTENSIONS


class AttachmentDownload(BaseModel):
    """One attachment's stored original, or why it was skipped."""

    original: StorageObject | None = None
    error: str | None = None


def _safe_storage_part(value: str) -> str:
    cleaned = "".join(
        character if character.isalnum() or character in "-_." else "_"
        for character in value
    )
    return cleaned.strip("._") or "unnamed"


def _make_attachment_link(
    confluence_client: Any,
    attachment: dict[str, Any],
    parent_content_id: str | None = None,
) -> str | None:
    base_url = confluence_client.base_url
    host = urlparse(base_url).hostname or ""
    is_cloud = bool(confluence_client.config.get("is_cloud")) or host.endswith(
        "atlassian.net"
    ) or host == "api.atlassian.com"

    if is_cloud:
        attachment_id = attachment.get("id")
        if not parent_content_id or not attachment_id:
            log.warning(
                "parent_content_id and attachment.id are required to download attachments from Confluence Cloud!"
            )
            return None

        download_link = (
            base_url
            + f"/rest/api/content/{parent_content_id}/child/attachment/{attachment_id}/download"
        )
    else:
        download_link = base_url + attachment["_links"]["download"]

    return download_link


def download_attachment(
    confluence_client: Any,
    attachment: dict[str, Any],
    parent_content_id: str | None,
    *,
    storage: RawObjectStore | None,
    storage_key: str,
) -> AttachmentDownload:
    """Download one attachment and store it, unread, as its Document's original."""

    try:
        media_type: str = attachment.get("metadata", {}).get("mediaType", "")
        if not validate_attachment_filetype(attachment):
            return AttachmentDownload(error=f"Unsupported file type: {media_type}")

        attachment_link = _make_attachment_link(
            confluence_client, attachment, parent_content_id
        )
        if not attachment_link:
            return AttachmentDownload(error="Failed to make attachment link")

        attachment_size = int(attachment.get("extensions", {}).get("fileSize") or 0)
        if attachment_size > _ATTACHMENT_SIZE_THRESHOLD:
            log.warning(
                "Skipping %s due to size. size=%d threshold=%d",
                attachment_link,
                attachment_size,
                _ATTACHMENT_SIZE_THRESHOLD,
            )
            return AttachmentDownload(
                error=f"Attachment too large: {attachment_size} bytes"
            )

        log.info(
            "Downloading attachment: title=%s length=%d link=%s",
            attachment["title"],
            attachment_size,
            attachment_link,
        )

        resp = confluence_client.confluence_client._session.get(
            attachment_link,
            timeout=getattr(confluence_client, "timeout_seconds", 30),
            stream=True,
        )
        try:
            if resp.status_code != 200:
                log.warning(
                    "Failed to fetch %s with status code %d",
                    attachment_link,
                    resp.status_code,
                )
                return AttachmentDownload(
                    error=f"Attachment download status code is {resp.status_code}"
                )
            content_length = int((getattr(resp, "headers", {}) or {}).get("content-length") or 0)
            if content_length > _ATTACHMENT_SIZE_THRESHOLD:
                return AttachmentDownload(
                    error=f"Attachment too large: {content_length} bytes"
                )

            attachment_title = attachment["title"]
            with tempfile.TemporaryDirectory(prefix="bomesh-confluence-") as directory:
                path = Path(directory) / _safe_storage_part(attachment_title)
                downloaded_size = 0
                with path.open("wb") as target:
                    for block in resp.iter_content(chunk_size=1024 * 1024):
                        if not block:
                            continue
                        downloaded_size += len(block)
                        if downloaded_size > _ATTACHMENT_SIZE_THRESHOLD:
                            return AttachmentDownload(
                                error=f"Attachment too large: {downloaded_size} bytes"
                            )
                        target.write(block)
                if downloaded_size == 0:
                    return AttachmentDownload(error="attachment content is empty")
                original = store_original(
                    storage,
                    key=storage_key,
                    file_name=attachment_title,
                    content_type=media_type or "application/octet-stream",
                    path=path,
                )
            log.info("Stored attachment: key=%s size=%d", storage_key, downloaded_size)
            return AttachmentDownload(original=original)
        finally:
            close = getattr(resp, "close", None)
            if callable(close):
                close()
    except Exception as e:
        return AttachmentDownload(error=f"Failed to download attachment: {e}")


def store_attachment(
    confluence_client: Any,
    attachment: dict[str, Any],
    page_id: str,
    *,
    storage: RawObjectStore | None,
    storage_key: str,
) -> StorageObject | None:
    """Store one knowledge attachment's original; ``None`` when it is skipped."""

    media_type = attachment.get("metadata", {}).get("mediaType", "")
    if media_type.startswith("video/") or media_type == "application/gliffy+json":
        log.warning(
            "Skipping unsupported attachment type: '%s' for %s",
            media_type,
            attachment["title"],
        )
        return None

    result = download_attachment(
        confluence_client,
        attachment,
        page_id,
        storage=storage,
        storage_key=storage_key,
    )
    if result.error is not None:
        log.warning(
            "Attachment %s encountered error: %s",
            attachment["title"],
            result.error,
        )
        return None
    return result.original


def build_confluence_document_id(
    base_url: str, content_url: str, is_cloud: bool
) -> str:
    # Construct a canonical document ID URL from Confluence base URL and content path.
    final_url = base_url.rstrip("/") + "/"
    if is_cloud and not final_url.endswith("/wiki/"):
        final_url = urljoin(final_url, "wiki") + "/"
    final_url = urljoin(final_url, content_url.lstrip("/"))
    return final_url


def datetime_from_string(datetime_string: str) -> datetime:
    # Parse an ISO datetime string to a UTC-aware datetime object.
    datetime_object = datetime.fromisoformat(datetime_string)

    if datetime_object.tzinfo is None:
        datetime_object = datetime_object.replace(tzinfo=timezone.utc)
    else:
        datetime_object = datetime_object.astimezone(timezone.utc)

    return datetime_object


def confluence_refresh_tokens(
    client_id: str, client_secret: str, cloud_id: str, refresh_token: str
) -> dict[str, Any]:
    # Refresh Confluence Cloud OAuth tokens and return updated credentials.
    response = httpx.post(
        CONFLUENCE_OAUTH_TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type": "refresh_token",
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
        },
        timeout=30,
    )

    response.raise_for_status()

    try:
        token_response = TokenResponse.model_validate_json(response.text)
    except Exception:
        raise RuntimeError("Confluence Cloud token refresh failed.")

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=token_response.expires_in)

    new_credentials: dict[str, Any] = {}
    new_credentials["confluence_access_token"] = token_response.access_token
    new_credentials["confluence_refresh_token"] = token_response.refresh_token
    new_credentials["created_at"] = now.isoformat()
    new_credentials["expires_at"] = expires_at.isoformat()
    new_credentials["expires_in"] = token_response.expires_in
    new_credentials["scope"] = token_response.scope
    new_credentials["cloud_id"] = cloud_id
    return new_credentials


def get_single_param_from_url(url: str, param: str) -> str | None:
    parsed_url = urlparse(url)
    return parse_qs(parsed_url.query).get(param, [None])[0]


def get_start_param_from_url(url: str) -> int:
    start_str = get_single_param_from_url(url, "start")
    return int(start_str) if start_str else 0


def update_param_in_path(path: str, param: str, value: str) -> str:
    parsed_url = urlparse(path)
    query_params = parse_qs(parsed_url.query)
    query_params[param] = [value]
    return (
        path.split("?")[0]
        + "?"
        + "&".join(f"{k}={quote(v[0])}" for k, v in query_params.items())
    )
