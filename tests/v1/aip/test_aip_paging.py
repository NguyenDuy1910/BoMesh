"""Page sizes and opaque page tokens bound to the query (AIP-158)."""

from __future__ import annotations

import base64
import json

import pytest
from aip_docs import Doc
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.aip.paging import PageRequest, query_fingerprint
from bomesh.errors import InvalidArgument

FINGERPRINT = query_fingerprint(
    parent="workspaces/acme", filter='state = "ACTIVE"', order_by="createTime desc"
)


def _list_ids(
    session: Session, page_size: int | None, page_token: str | None
) -> tuple[list[int], str]:
    request = PageRequest.from_params(page_size, page_token, FINGERPRINT)
    rows = session.scalars(
        select(Doc.id)
        .order_by(Doc.id)
        .offset(request.offset)
        .limit(request.fetch_limit)
    ).all()
    page = request.page(rows)
    return page.items, page.next_page_token


def test_tokens_walk_every_row_exactly_once(session: Session) -> None:
    seen: list[int] = []
    token: str | None = None
    pages = 0
    while True:
        ids, token = _list_ids(session, 2, token)
        seen.extend(ids)
        pages += 1
        if not token:
            break

    assert seen == [1, 2, 3, 4, 5]
    assert pages == 3


def test_last_full_page_has_no_next_token(session: Session) -> None:
    ids, token = _list_ids(session, 5, None)

    assert ids == [1, 2, 3, 4, 5]
    assert token == ""


@pytest.mark.parametrize(
    ("requested", "effective"),
    [(None, 50), (0, 50), (7, 7), (1000, 1000), (5000, 1000)],
)
def test_page_size_defaults_and_is_coerced(
    requested: int | None, effective: int
) -> None:
    assert PageRequest.from_params(requested, None, FINGERPRINT).page_size == effective


def test_negative_page_size_is_invalid() -> None:
    with pytest.raises(InvalidArgument) as raised:
        PageRequest.from_params(-1, None, FINGERPRINT)

    assert raised.value.field_violations[0].field == "pageSize"


def test_token_from_another_query_is_rejected(session: Session) -> None:
    _, token = _list_ids(session, 2, None)
    other = query_fingerprint(
        parent="workspaces/acme", filter='state = "DRAFT"', order_by="createTime desc"
    )

    with pytest.raises(InvalidArgument) as raised:
        PageRequest.from_params(2, token, other)

    assert raised.value.field_violations[0].field == "pageToken"


def test_token_survives_a_page_size_change(session: Session) -> None:
    _, token = _list_ids(session, 2, None)

    ids, _ = _list_ids(session, 10, token)

    assert ids == [3, 4, 5]


def _forge(payload: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()


@pytest.mark.parametrize(
    "token",
    [
        "garbage!!",
        "%%%",
        _forge([1, 2]),
        _forge({"v": 1, "o": -2, "f": FINGERPRINT}),
        _forge({"v": 1, "o": "2", "f": FINGERPRINT}),
        _forge({"v": 1, "o": True, "f": FINGERPRINT}),
        _forge({"v": 2, "o": 2, "f": FINGERPRINT}),
        _forge({"v": 1, "o": 2}),
        _forge({"v": 1, "o": 2, "f": "0" * 32}),
    ],
)
def test_tampered_or_garbage_tokens_are_invalid(token: str) -> None:
    with pytest.raises(InvalidArgument):
        PageRequest.from_params(2, token, FINGERPRINT)


def test_fingerprint_covers_parent_filter_order_and_extras() -> None:
    base = {"parent": "workspaces/a", "filter": "x = 1", "order_by": "createTime"}

    assert query_fingerprint(**base) == query_fingerprint(**base)
    assert query_fingerprint(**base) != query_fingerprint(
        **{**base, "parent": "workspaces/b"}
    )
    assert query_fingerprint(**base) != query_fingerprint(
        **{**base, "order_by": "createTime desc"}
    )
    assert query_fingerprint(**base) != query_fingerprint(**base, show_deleted=True)
