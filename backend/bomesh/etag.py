"""Entity tags for optimistic concurrency (AIP-154)."""

from __future__ import annotations

import base64
import hashlib
from datetime import UTC, datetime

from bomesh.errors import Aborted

ETAG_MISMATCH = "ETAG_MISMATCH"


def compute(name: str, updated_at: datetime) -> str:
    """A deterministic etag: changes whenever the resource's ``updated_at`` does."""
    moment = (
        updated_at.replace(tzinfo=UTC)
        if updated_at.tzinfo is None
        else updated_at.astimezone(UTC)
    )
    digest = hashlib.sha256(f"{name}\n{moment.isoformat()}".encode()).digest()
    return base64.urlsafe_b64encode(digest[:12]).decode()


def check(expected: str | None, current: str) -> None:
    """Fail with ABORTED unless ``expected`` is empty or equals ``current``."""
    if expected and expected != current:
        raise Aborted(
            "The resource changed since it was read; fetch it again and retry.",
            reason=ETAG_MISMATCH,
        )
