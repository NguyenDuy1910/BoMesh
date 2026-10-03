"""Authentication, tenancy, and resource-access service implementations.

Shared cross-service contracts remain in :mod:`bomesh.services`; concrete
services are imported from their owning module in this package.
"""

from __future__ import annotations

from typing import Any

from bomesh.db.models import Tenant
from bomesh.services import timestamp


def tenant_payload(tenant: Tenant) -> dict[str, Any]:
    """Serialize the shared tenant resource representation."""

    return {
        "id": str(tenant.id),
        "code": tenant.code,
        "name": tenant.name,
        "status": tenant.status,
        "settings": dict(tenant.settings),
        "created_at": timestamp(tenant.created_at),
        "updated_at": timestamp(tenant.updated_at),
    }
