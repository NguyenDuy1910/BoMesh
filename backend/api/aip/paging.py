"""Pagination (AIP-158): page sizes and opaque offset tokens bound to the query."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass

from bomesh.errors import InvalidArgument

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 1000

_TOKEN_VERSION = 1


def query_fingerprint(
    *, parent: str = "", filter: str = "", order_by: str = "", **extra: object
) -> str:
    """A digest of everything that must stay fixed across pages of one listing.

    ``extra`` carries method-specific inputs that shape the result set
    (``showDeleted``, ``view`` where it filters, a search ``query``).
    """
    material = json.dumps(
        {
            "parent": parent,
            "filter": filter,
            "orderBy": order_by,
            **{k: str(v) for k, v in extra.items()},
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(material.encode()).hexdigest()[:32]


@dataclass(frozen=True, slots=True)
class Page[T]:
    items: list[T]
    next_page_token: str = ""
    total_size: int | None = None


@dataclass(frozen=True, slots=True)
class PageRequest:
    offset: int
    page_size: int
    fingerprint: str

    @classmethod
    def from_params(
        cls, page_size: int | None, page_token: str | None, fingerprint: str
    ) -> PageRequest:
        """Validate ``pageSize``/``pageToken``; the token must come from the same query."""
        if page_size is not None and page_size < 0:
            raise InvalidArgument.for_field("pageSize", "pageSize must not be negative")
        size = min(page_size or DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
        offset = _decode(page_token, fingerprint) if page_token else 0
        return cls(offset=offset, page_size=size, fingerprint=fingerprint)

    @property
    def fetch_limit(self) -> int:
        """Rows to fetch: one beyond the page reveals whether another page exists."""
        return self.page_size + 1

    def page[T](self, rows: Sequence[T], *, total_size: int | None = None) -> Page[T]:
        """The page for rows fetched with ``offset`` and ``fetch_limit``."""
        has_more = len(rows) > self.page_size
        token = (
            _encode(self.offset + self.page_size, self.fingerprint) if has_more else ""
        )
        return Page(
            items=list(rows[: self.page_size]),
            next_page_token=token,
            total_size=total_size,
        )


def _encode(offset: int, fingerprint: str) -> str:
    payload = json.dumps(
        {"v": _TOKEN_VERSION, "o": offset, "f": fingerprint}, separators=(",", ":")
    )
    return base64.urlsafe_b64encode(payload.encode()).rstrip(b"=").decode()


def _decode(token: str, fingerprint: str) -> int:
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        payload = json.loads(raw)
        version, offset, bound = payload["v"], payload["o"], payload["f"]
    except (binascii.Error, ValueError, TypeError, KeyError):
        raise _invalid_token("pageToken is not a valid page token") from None
    if (
        version != _TOKEN_VERSION
        or not isinstance(offset, int)
        or isinstance(offset, bool)
        or offset < 0
    ):
        raise _invalid_token("pageToken is not a valid page token")
    if bound != fingerprint:
        raise _invalid_token(
            "pageToken does not belong to this request; keep every other parameter unchanged"
        )
    return offset


def _invalid_token(description: str) -> InvalidArgument:
    return InvalidArgument.for_field("pageToken", description)
