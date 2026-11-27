"""SQL statement budgets of the main list endpoints and set-based writes (regression guard).

Each case seeds the :data:`seed.SMALL` workspace (every guarded list holds more
rows than the largest page), warms the endpoint once, then counts the
statements of one call at ``pageSize`` 20 and 200 (request authentication
included). A list must:

- not grow with the page size (``growth``: at most 2 more statements at 200), and
- stay under a fixed ceiling (``ceiling``) whatever the workspace size.

Cases marked ``xfail(strict=True)`` fail today; the reason quotes what was
measured on the perf dataset (``tests/perf/load_api.py``). A fix that meets the
budget makes the case XPASS, which fails the run until the marker is removed.
The ceiling of ``ListItems``/``SearchItems`` is the remediation plan's
(``docs/performance-remediation-plan.md`` P2: "assert queries < 15").

``test_checkout_budget`` guards pool pressure: one read request checks the
pool out at most three times (authentication, the request Authorizer's kept
read connection, the service transaction), however many lookups it makes.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import event, text

from harness import ApiClient, Sessions
from seed import SMALL, Dataset, seed

pytestmark = pytest.mark.asyncio

#: The default ceiling: a list costs a fixed handful of statements.
CEILING = 15


@dataclass(frozen=True, slots=True)
class Budget:
    case: str
    path: Callable[[Dataset], str]
    method: str = "GET"
    params: dict[str, Any] = field(default_factory=dict)
    ceiling: int = CEILING
    growth: int = 2
    paged: bool = True
    #: Today's failure; the case is ``xfail(strict=True)`` while set.
    failing: str | None = None


def ws(ds: Dataset) -> str:
    return f"/api/v1/workspaces/{ds.workspace}"


def me(ds: Dataset) -> str:
    return f"{ws(ds)}/members/{ds.admin}"


def concepts(d: Dataset) -> str:
    return f"{ws(d)}/conceptSchemes/{d.concept_scheme}"


#: ImportConcepts with ``validateOnly``, as in ``load_api.py``: 100 rows update seeded
#: narrower concepts of the :data:`seed.SMALL` scheme, 100 create concepts under its tops.
IMPORT_CONCEPTS: dict[str, Any] = {
    "rows": [
        {"notation": f"area-{k // SMALL.concepts_per_top:02d}-{k % SMALL.concepts_per_top:02d}",
         "definition": f"Định nghĩa nhập {k}."}
        for k in range(100)
    ]
    + [
        {
            "notation": f"import-{k:03d}",
            "broader": f"area-{k % SMALL.concept_tops:02d}",
            "prefVi": f"Chủ đề nhập {k:03d}",
            "altVi": f"Nhập {k:03d}|Mục {k:03d}",
            "definition": f"Văn bản về chủ đề nhập {k:03d}.",
        }
        for k in range(100)
    ],
    "validateOnly": True,
}

BUDGETS = [
    # Flat in page size; 7 of these are authentication and workspace authorization,
    # 3 the collection sets (items.get, items.update, hidden), 2 the visibility query,
    # 2 the page's concept labels (item_concepts) and document profiles.
    Budget("ListItems", lambda d: f"{ws(d)}/items", ceiling=18),
    Budget("ListItems FULL", lambda d: f"{ws(d)}/items", params={"view": "FULL"}, ceiling=19),
    Budget("SearchItems browse", lambda d: f"{ws(d)}/items:search", method="POST", ceiling=18),
    Budget("ListContributions", lambda d: f"{ws(d)}/contributions",
           failing="28 statements at pageSize 20, 218 at 200: contribution_records checks "
                   "is_visible on each closed contribution's candidate (item_path + role_assignments)"),
    Budget("ListMembers", lambda d: f"{ws(d)}/members"),
    Budget("ListGroups", lambda d: f"{ws(d)}/groups"),
    Budget("ListAuditEvents", lambda d: f"{ws(d)}/auditEvents"),
    # Flat; 1 the page (template codes joined), then each working-copy table once for
    # the page's unpublishedChanges and 1 its published versions (cached once read).
    Budget("ListConceptSchemes", lambda d: f"{ws(d)}/conceptSchemes"),
    # Flat; 1 the visibility query, 5 the page's concept facts, 1 the document counts.
    Budget("ListConcepts", lambda d: f"{concepts(d)}/concepts", ceiling=17),
    Budget("ListConceptProposals", lambda d: f"{ws(d)}/conceptProposals"),
    Budget("ListIngestionRuns", lambda d: f"{ws(d)}/ingestionRuns"),
    Budget("ListIngestionTasks", lambda d: f"{ws(d)}/ingestionRuns/{d.big_run}/tasks"),
    Budget("ListSources", lambda d: f"{ws(d)}/sources"),
    Budget("ListConnections", lambda d: f"{ws(d)}/connections"),
    Budget("ListConversations", lambda d: f"{ws(d)}/conversations"),
    Budget("ListRequests", lambda d: f"{ws(d)}/requests"),
    Budget("ListSpaces", lambda d: f"{ws(d)}/spaces"),
    Budget("ListMaterials", lambda d: f"{ws(d)}/spaces/{d.spaces[0]}/materials", ceiling=17),
    Budget("ListSavedItems", lambda d: f"{me(d)}/savedItems"),
    Budget("ListRecentItems", lambda d: f"{me(d)}/recentItems"),
    Budget("ListOperations", lambda d: "/api/v1/operations"),
    Budget("ListArtifacts", lambda d: f"{ws(d)}/artifacts"),
    Budget("ListNotifications", lambda d: f"{me(d)}/notifications", ceiling=13),
    Budget("GetNotification", lambda d: f"{me(d)}/notifications/{d.notifications[0]}",
           paged=False, ceiling=13),
    Budget("GetMemberHome", lambda d: f"{me(d)}/home", paged=False, ceiling=40),
    # 200 rows: one statement set for the scheme index, then set-based writes in the savepoint.
    Budget("ImportConcepts validateOnly", lambda d: f"{concepts(d)}:importConcepts", method="POST",
           params=IMPORT_CONCEPTS, paged=False, ceiling=30),
]


@contextmanager
def counting(sessions: Sessions) -> Iterator[list[str]]:
    """Collect the SQL statements executed while the block runs."""
    engine = sessions.kw["bind"].sync_engine
    statements: list[str] = []

    def on_execute(conn: Any, cursor: Any, statement: str, *_: Any) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", on_execute)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", on_execute)


async def _call(api: ApiClient, budget: Budget, ds: Dataset, size: int | None) -> None:
    params = dict(budget.params)
    if size is not None:
        params["pageSize"] = size
    if budget.method == "POST":
        response = await api.post(budget.path(ds), json=params)
    else:
        response = await api.get(budget.path(ds), params=params)
    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "budget",
    [
        pytest.param(
            budget,
            id=budget.case,
            marks=[pytest.mark.xfail(strict=True, reason=budget.failing)] if budget.failing else [],
        )
        for budget in BUDGETS
    ],
)
async def test_statement_budget(budget: Budget, client: ApiClient, sessions: Sessions) -> None:
    ds = await seed(sessions.kw["bind"], SMALL, analyze=False)
    api = await client.as_(UUID(ds.admin))
    await _call(api, budget, ds, 20 if budget.paged else None)  # warm per-process caches
    measured: dict[int | None, int] = {}
    for size in (20, 200) if budget.paged else (None,):
        with counting(sessions) as statements:
            await _call(api, budget, ds, size)
        measured[size] = len(statements)
    if budget.paged:
        assert measured[200] <= measured[20] + budget.growth, f"grows with pageSize: {measured}"
    assert max(measured.values()) <= budget.ceiling, f"over the ceiling {budget.ceiling}: {measured}"


async def test_import_concepts_validate_only_locks_and_keeps_nothing(
    client: ApiClient, sessions: Sessions
) -> None:
    """A dry run locks no row and keeps nothing: the concepts it writes to compute the
    outcome live in a savepoint that is rolled back, and nothing is audited."""
    ds = await seed(sessions.kw["bind"], SMALL, analyze=False)
    api = await client.as_(UUID(ds.admin))
    with counting(sessions) as statements:
        response = await api.post(f"{concepts(ds)}:importConcepts", json=IMPORT_CONCEPTS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert (len(body["created"]), len(body["updated"])) == (100, 100)
    assert [statement for statement in statements if "FOR UPDATE" in statement] == []
    assert [statement for statement in statements if "SAVEPOINT" in statement][-1].startswith(
        "ROLLBACK TO SAVEPOINT"
    )
    assert not [statement for statement in statements if "RELEASE SAVEPOINT" in statement]
    async with sessions.kw["bind"].connect() as connection:
        kept = await connection.scalar(text(
            "SELECT count(*) FROM concepts WHERE notation LIKE 'import-%'"
            " OR definition LIKE 'Định nghĩa nhập%'"
        ))
        audited = await connection.scalar(text(
            "SELECT count(*) FROM audit_logs WHERE action = 'ImportConcepts'"
        ))
    assert (kept, audited) == (0, 0)


async def test_seeded_taxonomy_feeds_home_and_facets(client: ApiClient, sessions: Sessions) -> None:
    """The seeded classification scheme makes GetMemberHome's featuredConcepts and the
    ``document.concepts`` facet non-empty, so their budgets measure real work."""
    ds = await seed(sessions.kw["bind"], SMALL, analyze=False)
    api = await client.as_(UUID(ds.admin))
    home = await api.get(f"{me(ds)}/home")
    assert home.status_code == 200, home.text
    featured = home.json()["featuredConcepts"]
    assert featured and all(entry["topConcepts"] for entry in featured)
    search = await api.post(
        f"{ws(ds)}/items:search",
        json={"pageSize": 1, "facetSpecs": [{"field": "document.concepts"}]},
    )
    assert search.status_code == 200, search.text
    assert [facet["values"] for facet in search.json()["facets"] if facet["values"]]


#: Pool checkouts of one read request: authentication, the request Authorizer's
#: kept read connection, and the service's transaction.
CHECKOUTS = 3

CHECKOUT_CASES = [
    Budget("GetItem", lambda d: f"{ws(d)}/items/{d.documents[0]}"),
    Budget("GetItem FULL", lambda d: f"{ws(d)}/items/{d.documents[0]}", params={"view": "FULL"}),
    Budget("GetWorkspace", ws),
    Budget("GetWorkspaceSettings", lambda d: f"{ws(d)}/settings"),
    Budget("GetWorkspaceAssistant", lambda d: f"{ws(d)}/assistant"),
    Budget("ListMembers", lambda d: f"{ws(d)}/members"),
    Budget("ListItems", lambda d: f"{ws(d)}/items"),
    Budget("ListConcepts", lambda d: f"{concepts(d)}/concepts"),
    Budget("ListContributions", lambda d: f"{ws(d)}/contributions"),
    Budget("ListSavedItems", lambda d: f"{me(d)}/savedItems"),
]


async def test_checkout_budget(client: ApiClient, sessions: Sessions) -> None:
    """A read checks the pool out at most :data:`CHECKOUTS` times, however many lookups."""
    ds = await seed(sessions.kw["bind"], SMALL, analyze=False)
    api = await client.as_(UUID(ds.admin))
    pool = sessions.kw["bind"].sync_engine.pool
    checkouts: list[str] = []
    measured: dict[str, int] = {}

    def on_checkout(*_: Any) -> None:
        checkouts.append("")

    for budget in CHECKOUT_CASES:
        await _call(api, budget, ds, None)  # warm per-process caches
        checkouts.clear()
        event.listen(pool, "checkout", on_checkout)
        try:
            await _call(api, budget, ds, None)
        finally:
            event.remove(pool, "checkout", on_checkout)
        measured[budget.case] = len(checkouts)
    over = {case: count for case, count in measured.items() if count > CHECKOUTS}
    assert not over, f"over {CHECKOUTS} pool checkouts: {over} (all: {measured})"
