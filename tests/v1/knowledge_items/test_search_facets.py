"""SearchItems facets: `updateTime` intervals and hierarchical topics (``api_design.md`` §Items).

One response carries every facet of a catalog view; counts are disjunctive and
only ever count documents the caller can see.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemTopic, TenantMembership, Topic
from harness import World
from knowledge_support import Knowledge, item_name, ws_url

pytestmark = pytest.mark.asyncio


def _rfc3339(value: datetime) -> str:
    return value.astimezone(UTC).replace(tzinfo=None).isoformat() + "Z"


async def _search(api, workspace, **body):
    response = await api.post(f"{ws_url(workspace)}/items:search", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _facet(body, field: str) -> list[dict]:
    return next(facet["values"] for facet in body["facets"] if facet["field"] == field)


async def _world(world: World):
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    viewer = await world.add_member(workspace)
    editor = await world.add_member(workspace)
    handbook = await world.make_collection(
        workspace,
        item_name="Handbook",
        grants={viewer: "roles/collectionViewer", editor: "roles/collectionEditor"},
    )
    secret = await world.make_collection(workspace, item_name="Secret")
    return workspace, viewer, editor, handbook, secret


async def test_update_time_intervals_are_disjunctive_and_visible_only(
    client, world: World, knowledge: Knowledge
) -> None:
    workspace, viewer, editor, handbook, secret = await _world(world)
    now = datetime.now(UTC)
    ages = {
        await world.make_document(handbook, item_name="Fresh"): 2,
        await world.make_document(handbook, item_name="Recent"): 20,
        await world.make_document(handbook, item_name="Old"): 200,
        await world.make_document(handbook, item_name="Ancient"): 500,
        await world.make_document(handbook, item_name="Draft", published=False): 2,
        await world.make_document(secret, item_name="Hidden"): 2,
    }
    async with transaction_scope(knowledge.sessions) as session:
        for document, days in ages.items():
            await session.execute(
                update(Item).where(Item.id == document.id).values(updated_at=now - timedelta(days=days))
            )
    windows = [now - timedelta(days=days) for days in (7, 30, 365)]
    spec = {"field": "updateTime", "intervals": [{"minimum": _rfc3339(w)} for w in windows]}
    month = f'updateTime >= "{_rfc3339(windows[1])}"'

    as_viewer = await _search(await client.as_(viewer), workspace, filter=month, facetSpecs=[spec])
    as_editor = await _search(await client.as_(editor), workspace, filter=month, facetSpecs=[spec])
    narrowed = await _search(
        await client.as_(viewer), workspace, filter=month, facetSpecs=[{**spec, "excludedFromFilter": False}]
    )

    assert as_viewer["totalSize"] == 2
    values = _facet(as_viewer, "updateTime")
    # Disjunctive: the month filter does not narrow the Updated counts; drafts and
    # unreadable collections are never counted.
    assert [datetime.fromisoformat(value["interval"]["minimum"]) for value in values] == windows
    assert all("value" not in value for value in values)
    assert [value["documentCount"] for value in _facet(as_editor, "updateTime")] == [2, 3, 4]
    assert [value["documentCount"] for value in _facet(narrowed, "updateTime")] == [1, 2, 2]


async def test_topic_facet_rolls_domains_up_like_the_filter(
    client, world: World, knowledge: Knowledge
) -> None:
    workspace, viewer, _, handbook, secret = await _world(world)
    hiring_doc = await world.make_document(handbook, item_name="Hiring guide")
    leave_doc = await world.make_document(handbook, item_name="Leave policy")
    both = await world.make_document(handbook, item_name="People handbook")
    await world.make_document(handbook, item_name="Untagged")
    draft = await world.make_document(handbook, item_name="Draft", published=False)
    hidden = await world.make_document(secret, item_name="Payroll")
    async with transaction_scope(knowledge.sessions) as session:
        people = Topic(tenant_id=workspace.id, code="people", kind="domain", topic_name="People")
        finance = Topic(tenant_id=workspace.id, code="finance", kind="domain", topic_name="Finance")
        session.add_all([people, finance])
        await session.flush()
        hiring = Topic(
            tenant_id=workspace.id, code="hiring", kind="topic", topic_name="Hiring", parent_topic_id=people.id
        )
        leave = Topic(
            tenant_id=workspace.id, code="leave", kind="topic", topic_name="Leave", parent_topic_id=people.id
        )
        session.add_all([hiring, leave])
        await session.flush()
        session.add_all(
            [
                ItemTopic(item_id=hiring_doc.id, topic_id=hiring.id),
                ItemTopic(item_id=leave_doc.id, topic_id=leave.id),
                ItemTopic(item_id=both.id, topic_id=people.id),
                ItemTopic(item_id=both.id, topic_id=hiring.id),
                ItemTopic(item_id=draft.id, topic_id=leave.id),
                ItemTopic(item_id=hidden.id, topic_id=hiring.id),
                ItemTopic(item_id=hidden.id, topic_id=finance.id),
            ]
        )
    api = await client.as_(viewer)
    topic = f"workspaces/{workspace.id}/topics"
    spec = {"field": "document.topics", "limit": 100}

    unfiltered = await _search(api, workspace, facetSpecs=[spec])
    by_domain = await _search(api, workspace, filter=f'document.topics:"{topic}/people"', facetSpecs=[spec])
    by_topic = await _search(api, workspace, filter=f'document.topics:"{topic}/hiring"')
    listed = await api.get(
        f"{ws_url(workspace)}/items",
        params={"filter": f'itemKind = DOCUMENT AND document.topics:"{topic}/people"'},
    )

    counts = {value["value"]: value["documentCount"] for value in _facet(unfiltered, "document.topics")}
    # The domain counts each of its documents once (`both` carries the domain and a
    # topic); drafts and unreadable documents are never counted, so Finance is absent.
    assert counts == {f"{topic}/people": 3, f"{topic}/hiring": 2, f"{topic}/leave": 1}
    assert by_domain["totalSize"] == 3
    assert {r["item"]["name"] for r in by_domain["results"]} == {
        item_name(hiring_doc),
        item_name(leave_doc),
        item_name(both),
    }
    assert {value["value"]: value["documentCount"] for value in _facet(by_domain, "document.topics")} == counts
    assert {r["item"]["name"] for r in by_topic["results"]} == {item_name(hiring_doc), item_name(both)}
    assert listed.status_code == 200, listed.text
    assert {item["name"] for item in listed.json()["items"]} == {
        item_name(hiring_doc),
        item_name(leave_doc),
        item_name(both),
    }


async def test_owner_facet_carries_member_display_names(client, world: World, knowledge: Knowledge) -> None:
    workspace, viewer, _, handbook, _secret = await _world(world)
    ana = await world.add_member(workspace, await world.make_user(display_name="Ana Tran"))
    bao = await world.add_member(workspace, await world.make_user("bao@example.com"))
    gone = await world.add_member(workspace, await world.make_user(display_name="Former Owner"))
    owners = {
        await world.make_document(handbook, item_name="Policy"): ana,
        await world.make_document(handbook, item_name="Guide"): ana,
        await world.make_document(handbook, item_name="Notes"): bao,
        await world.make_document(handbook, item_name="Archive"): gone,
    }
    async with transaction_scope(knowledge.sessions) as session:
        for document, owner in owners.items():
            row = await session.get(Item, document.id)
            row.owner_user_id = owner.id
        await session.execute(
            update(TenantMembership)
            .where(TenantMembership.user_id == gone.id, TenantMembership.tenant_id == workspace.id)
            .values(deleted_at=datetime.now(UTC))
        )

    body = await _search(await client.as_(viewer), workspace, facetSpecs=[{"field": "document.owner"}])

    member = lambda user: f"workspaces/{workspace.id}/members/{user.id}"  # noqa: E731
    # One label per owner straight from the search: display name, else email; none for an ex-member.
    assert _facet(body, "document.owner") == [
        {"value": member(ana), "displayName": "Ana Tran", "documentCount": 2},
        *sorted(
            [
                {"value": member(bao), "displayName": "bao@example.com", "documentCount": 1},
                {"value": member(gone), "documentCount": 1},
            ],
            key=lambda value: value["value"],
        ),
    ]


async def _catalog(world: World, knowledge: Knowledge):
    """Four readable published documents with distinct facet values, a draft and a hidden one."""
    workspace, viewer, editor, handbook, secret = await _world(world)
    ana = await world.add_member(workspace, await world.make_user(display_name="Ana Tran"))
    bao = await world.add_member(workspace, await world.make_user("bao@example.com"))
    policy = await world.make_document(handbook, item_name="Policy", mime_type="application/pdf")
    guide = await world.make_document(handbook, item_name="Guide", mime_type="text/markdown")
    notes = await world.make_document(handbook, item_name="Notes", mime_type="text/markdown")
    sheet = await world.make_document(handbook, item_name="Sheet", mime_type="application/pdf")
    await world.make_document(handbook, item_name="Draft", mime_type="text/markdown", published=False)
    await world.make_document(secret, item_name="Hidden", mime_type="text/markdown")
    facts = {policy: ("vi", ana, True), guide: ("en", ana, False), notes: ("en", bao, False), sheet: (None, bao, False)}
    async with transaction_scope(knowledge.sessions) as session:
        for document, (language, owner, verified) in facts.items():
            row = await session.get(Item, document.id)
            row.language_code = language
            row.owner_user_id = owner.id
            if verified:
                row.verified_at = datetime.now(UTC)
                row.verified_by_user_id = owner.id
        topic = Topic(tenant_id=workspace.id, code="guides", kind="domain", topic_name="Guides")
        session.add(topic)
        await session.flush()
        session.add(ItemTopic(item_id=guide.id, topic_id=topic.id))
    return workspace, viewer, handbook, ana, bao


def _specs() -> list[dict]:
    # excludedFromFilter defaults to true (disjunctive); the second itemType facet narrows.
    return [
        {"field": "itemType"},
        {"field": "itemType", "limit": 1, "excludedFromFilter": False},
        {"field": "document.mimeType", "excludedFromFilter": False},
        {"field": "document.languageCode"},
        {"field": "document.owner"},
        {"field": "document.verification.state", "excludedFromFilter": False},
        {"field": "document.origin.source"},
        {
            "field": "updateTime",
            "intervals": [{"minimum": "2000-01-01T00:00:00Z"}, {"maximum": "2999-01-01T00:00:00Z"}],
            "excludedFromFilter": False,
        },
        {"field": "ancestors"},
        {"field": "document.topics", "excludedFromFilter": False},
    ]


async def test_facets_of_one_request_count_as_each_alone(
    client, world: World, knowledge: Knowledge
) -> None:
    workspace, viewer, handbook, ana, bao = await _catalog(world, knowledge)
    api = await client.as_(viewer)
    markdown = "itemType = MARKDOWN"

    together = await _search(api, workspace, filter=markdown, facetSpecs=_specs())

    assert together["totalSize"] == 2
    for position, spec in enumerate(_specs()):
        alone = await _search(api, workspace, filter=markdown, facetSpecs=[spec])
        assert together["facets"][position] == alone["facets"][0], spec
    member = lambda user: f"workspaces/{workspace.id}/members/{user.id}"  # noqa: E731
    counts = [
        [(value.get("value"), value.get("displayName"), value["documentCount"]) for value in facet["values"]]
        for facet in together["facets"]
    ]
    # Disjunctive itemType ignores its own clause (ties by value); the second keeps its limit.
    assert counts[0] == [("MARKDOWN", None, 2), ("PDF", None, 2)]
    assert counts[1] == [("MARKDOWN", None, 2)]
    assert counts[2] == [("text/markdown", None, 2)]
    assert counts[3] == [("en", None, 2)]
    assert counts[4] == sorted(
        [(member(ana), "Ana Tran", 1), (member(bao), "bao@example.com", 1)], key=lambda value: value[0]
    )
    assert counts[5] == [("UNVERIFIED", None, 2)]
    assert counts[6] == []
    assert counts[7] == [(None, None, 2), (None, None, 2)]
    assert counts[8] == [(item_name(handbook), "Handbook", 2)]
    assert counts[9] == [(f"workspaces/{workspace.id}/topics/guides", "Guides", 1)]
    every = await _search(api, workspace, facetSpecs=_specs())
    assert [value["documentCount"] for value in every["facets"][7]["values"]] == [4, 4]
    assert {value["value"]: value["documentCount"] for value in every["facets"][5]["values"]} == {
        "UNVERIFIED": 3,
        "VERIFIED": 1,
    }


async def test_a_search_matching_nothing_has_empty_facets(
    client, world: World, knowledge: Knowledge
) -> None:
    workspace, viewer, *_ = await _catalog(world, knowledge)
    api = await client.as_(viewer)

    nothing = await _search(api, workspace, filter='displayName = "Missing"', facetSpecs=_specs())
    no_images = await _search(api, workspace, filter="itemType = IMAGE", facetSpecs=_specs())

    assert (nothing["totalSize"], no_images["totalSize"]) == (0, 0)
    assert "results" not in nothing or nothing["results"] == []
    intervals = [{"documentCount": 0}, {"documentCount": 0}]
    for body in (nothing, no_images):
        assert [facet["field"] for facet in body["facets"]] == [spec["field"] for spec in _specs()]
        assert [
            [{"documentCount": value["documentCount"]} for value in facet["values"]]
            for facet in body["facets"]
            if facet["field"] == "updateTime"
        ] == [intervals]
    assert all(facet["values"] in ([], None) or facet["field"] == "updateTime" for facet in nothing["facets"])
    # A facet that ignores the clause that matched nothing still offers the other values.
    assert [(v["value"], v["documentCount"]) for v in no_images["facets"][0]["values"]] == [
        ("MARKDOWN", 2),
        ("PDF", 2),
    ]
    assert [
        facet for facet in no_images["facets"][1:] if facet["field"] != "updateTime" and facet.get("values")
    ] == []


async def test_facet_intervals_are_validated(client, world: World) -> None:
    workspace, viewer, *_ = await _world(world)
    api = await client.as_(viewer)
    url = f"{ws_url(workspace)}/items:search"
    bad = [
        [{"field": "updateTime"}],
        [{"field": "document.topics", "intervals": [{"minimum": "2026-01-01T00:00:00Z"}]}],
        [{"field": "updateTime", "intervals": [{}]}],
        [
            {
                "field": "updateTime",
                "intervals": [{"minimum": "2026-02-01T00:00:00Z", "maximum": "2026-01-01T00:00:00Z"}],
            }
        ],
    ]

    statuses = [(await api.post(url, json={"facetSpecs": specs})).status_code for specs in bad]

    assert statuses == [400, 400, 400, 400]
