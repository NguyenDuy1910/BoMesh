"""Etags for optimistic concurrency (AIP-154)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from bomesh import etag
from bomesh.errors import Aborted

NAME = "workspaces/w/items/i"
UPDATED = datetime(2026, 11, 4, 8, 0, 0, 123456, tzinfo=UTC)


def test_etag_is_stable_for_the_same_instant_in_any_zone() -> None:
    same_instant = UPDATED.astimezone(timezone(timedelta(hours=7)))

    assert etag.compute(NAME, UPDATED) == etag.compute(NAME, same_instant)
    assert etag.compute(NAME, UPDATED) == etag.compute(
        NAME, UPDATED.replace(tzinfo=None)
    )


def test_etag_changes_with_the_update_time_and_the_resource() -> None:
    current = etag.compute(NAME, UPDATED)

    assert etag.compute(NAME, UPDATED + timedelta(microseconds=1)) != current
    assert etag.compute("workspaces/w/items/j", UPDATED) != current


def test_check_passes_for_a_matching_or_missing_etag() -> None:
    current = etag.compute(NAME, UPDATED)

    etag.check(current, current)
    etag.check(None, current)
    etag.check("", current)


def test_stale_etag_is_aborted_with_etag_mismatch() -> None:
    stale = etag.compute(NAME, UPDATED)
    current = etag.compute(NAME, UPDATED + timedelta(seconds=1))

    with pytest.raises(Aborted) as raised:
        etag.check(stale, current)

    assert raised.value.reason == "ETAG_MISMATCH"
