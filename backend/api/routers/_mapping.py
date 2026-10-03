"""Map internal service payloads to public contract resource names."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def connection_payload(value: dict[str, Any]) -> dict[str, Any]:
    owner_type = value.get("owner_type", "user")
    account = value.get("account") or {}
    return {
        "id": value["id"],
        "connector_key": value.get("connector_key", ""),
        "display_name": value.get("display_name", ""),
        "owner_type": "workspace" if owner_type == "tenant" else owner_type,
        "owner_user_id": value.get("owner_user_id"),
        "status": value.get("status", "error"),
        "source_count": value.get("source_count", 0),
        "config": value.get("config", {}),
        # Only labels are public; the provider's own account and resource ids
        # stay internal.
        "account": {
            "label": account.get("label"),
            "resource_label": account.get("resource_label"),
        },
        "browsable": bool(value.get("browsable")),
        "status_detail": value.get("status_detail"),
        "connected_at": value.get("connected_at"),
        "last_checked_at": value.get("last_checked_at"),
        "created_at": value["created_at"],
        "updated_at": value["updated_at"],
    }


def source_payload(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": value["id"],
        "connection_id": value.get("integration_connection_id"),
        "collection_id": value.get("target_item_id"),
        "display_name": value.get("display_name"),
        "resource_type": value.get("resource_type"),
        "external_resource_id": value.get("external_resource_id"),
        "sync_mode": value.get("sync_mode", "manual"),
        "status": value.get("status", "failed"),
        "schedule": value.get("schedule"),
    }


def workspace_payload(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": value["id"],
        "code": value.get("code", ""),
        "name": value.get("name", ""),
        "status": value.get("status", "active"),
        "settings": value.get("settings", {}),
    }


def user_payload(value: dict[str, Any]) -> dict[str, Any]:
    status = value.get("status", "active")
    if isinstance(status, bool):
        status = "active" if status else "inactive"
    membership = value.get("membership") or {}
    return {
        "id": value["id"],
        "email": value["email"],
        "display_name": value.get("display_name"),
        "status": status,
        "roles": membership.get("roles", value.get("roles", [])),
        "groups": value.get("groups", []),
    }


def role_payload(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": value["id"],
        "code": value.get("code", ""),
        "display_name": value.get("display_name", ""),
        "status": value.get("status", "active"),
        "permission_codes": value.get("permission_codes", []),
        "tenant_id": value.get("tenant_id"),
        "scope_type": value["scope_type"],
        "is_system": value["is_system"],
        "member_count": value["member_count"],
    }


def approval_request_payload(value: dict[str, Any]) -> dict[str, Any]:
    return {
        **value,
        "created_at": value.get("created_at") or datetime.now(UTC),
    }


__all__ = [
    "approval_request_payload",
    "connection_payload",
    "role_payload",
    "source_payload",
    "user_payload",
    "workspace_payload",
]
