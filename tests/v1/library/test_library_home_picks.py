"""GetMemberHome: starter prompts by role, recommended reasons, featured concepts, Getting started facts."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import update

from bomesh.db.models import (
    AccessSession,
    ConceptLabel,
    Conversation,
    Item,
    ItemRevision,
    Message,
    RecentItem,
    SpaceMaterial,
    Tenant,
    User,
)
from bomesh.services.taxonomy.normalize import normalize_label
from harness import ApiClient, Sessions, World
from library_support import item_ref, me
from taxonomy_support import C, Published, label, publish_scheme

pytestmark = pytest.mark.asyncio


async def _prompts(admin: ApiClient, workspace: Tenant, prompts: list[dict[str, Any]]) -> None:
    configured = await admin.patch(
        f"/api/v1/workspaces/{workspace.id}/assistant",
        params={"updateMask": "starterPrompts"},
        json={"starterPrompts": prompts},
    )
    assert configured.status_code == 200, configured.text


async def _home(client: ApiClient, user: User, workspace: Tenant) -> dict[str, Any]:
    response = await (await client.as_(user)).get(f"{me(workspace)}/home")
    assert response.status_code == 200, response.text
    return response.json()


async def _people(sessions: Sessions, workspace: Tenant, owner: User) -> Published:
    """Classification scheme ``domain``: People with Leave and Parking."""
    return await publish_scheme(
        sessions,
        workspace.id,
        owner.id,
        "domain",
        [
            C("people", "People"),
            C("leave", "Leave", broader=("people",)),
            C("parking", "Parking", broader=("people",)),
        ],
    )


async def _tag(sessions: Sessions, scheme: Published, notation: str, *documents: Item) -> None:
    for document in documents:
        await label(sessions, document.id, scheme, notation)


async def _describe(sessions: Sessions, document: Item, summary: str) -> None:
    async with sessions.begin() as session:
        await session.execute(update(Item).where(Item.id == document.id).values(description=summary))


async def _view(sessions: Sessions, workspace: Tenant, user: User, *documents: Item) -> None:
    async with sessions.begin() as session:
        session.add_all(
            RecentItem(tenant_id=workspace.id, user_id=user.id, item_id=d.id, viewed_at=datetime.now(UTC))
            for d in documents
        )


async def test_starter_prompts_are_the_roles_else_everyones(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    admin = await client.as_(owner)
    await _prompts(
        admin,
        workspace,
        [
            {"title": "Start", "prompt": "Where do I start?"},
            {"title": "Settings", "prompt": "Who changed settings?", "roles": ["roles/workspaceAdmin"]},
        ],
    )
    assert (await _home(client, member, workspace))["starterPrompts"] == [
        {"title": "Start", "prompt": "Where do I start?"}
    ]
    assert (await _home(client, owner, workspace))["starterPrompts"] == [
        {"title": "Settings", "prompt": "Who changed settings?"}
    ]

    tutor = await world.make_role(workspace, "tutor", [])
    await world.grant(member, tutor, on=workspace)
    tutors = f"workspaces/{workspace.id}/roles/tutor"
    await _prompts(
        admin,
        workspace,
        [
            {"title": "Start", "prompt": "Where do I start?"},
            *({"title": f"M{n}", "prompt": f"Member {n}?", "roles": ["roles/workspaceMember"]} for n in range(3)),
            *({"title": f"T{n}", "prompt": f"Tutor {n}?", "roles": [tutors]} for n in range(3)),
        ],
    )
    starters = (await _home(client, member, workspace))["starterPrompts"]
    assert [s["title"] for s in starters] == ["M0", "M1", "M2", "T0"]


async def test_recommended_reasons_and_labels(client: ApiClient, world: World, sessions: Sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    colleague = await world.add_member(workspace)
    shared = await world.make_collection(
        workspace, grants={reader: "roles/collectionViewer", colleague: "roles/collectionViewer"}
    )
    hidden = await world.make_collection(workspace, grants={colleague: "roles/collectionViewer"})
    tuition = await world.make_document(shared, item_name="Học phí học kỳ 2025")
    await _describe(sessions, tuition, "Mức học phí và hạn nộp cho sinh viên")
    timetable = await world.make_document(shared, item_name="Lịch học")
    secret_tuition = await world.make_document(hidden, item_name="Học phí nội bộ")
    in_space = await world.make_document(shared, item_name="Team charter")
    hidden_material = await world.make_document(hidden, item_name="Board minutes")
    read = await world.make_document(shared, item_name="Leave policy")
    related = await world.make_document(shared, item_name="Leave calendar")
    secret_related = await world.make_document(hidden, item_name="Payroll leave")
    popular = await world.make_document(shared, item_name="Parking")
    draft = await world.make_document(shared, item_name="Học phí draft", published=False)

    domain = await _people(sessions, workspace, owner)
    await _tag(sessions, domain, "leave", read, related, secret_related)
    await _tag(sessions, domain, "parking", popular)

    space = await world.make_space(workspace, reader, code="mentors")
    async with sessions.begin() as session:
        session.add_all(
            SpaceMaterial(space_id=space.id, item_id=d.id, added_by_user_id=reader.id)
            for d in (in_space, hidden_material)
        )
    await _view(sessions, workspace, colleague, popular, secret_tuition, secret_related)
    await _view(sessions, workspace, reader, read)

    await _prompts(
        await client.as_(owner),
        workspace,
        [
            {"title": "Tuition", "prompt": "Học phí năm nay là bao nhiêu?"},
            {"title": "Questions", "prompt": "What did students ask this week?"},
        ],
    )
    home = await _home(client, reader, workspace)
    picks = [(r["item"]["item"], r["reason"]) for r in home["recommended"]]
    assert picks == [
        (item_ref(tuition), {"kind": "STARTER_PROMPT", "label": "Tuition"}),
        (item_ref(in_space), {"kind": "FROM_YOUR_SPACE", "label": "Mentors"}),
        (item_ref(related), {"kind": "BECAUSE_YOU_READ", "label": "Leave"}),
        (item_ref(popular), {"kind": "POPULAR"}),
    ]
    shown = {item for item, _ in picks}
    for never in (read, secret_tuition, hidden_material, secret_related, draft, timetable):
        assert item_ref(never) not in shown


async def test_popular_stays_workspace_wide_without_other_reasons(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    shared = await world.make_collection(workspace, grants={reader: "roles/collectionViewer"})
    first = await world.make_document(shared, item_name="Parking")
    second = await world.make_document(shared, item_name="Canteen")
    await _view(sessions, workspace, owner, first, second)
    await _view(sessions, workspace, await world.add_member(workspace), first)
    home = await _home(client, reader, workspace)
    assert [(r["item"]["item"], r["reason"]) for r in home["recommended"]] == [
        (item_ref(first), {"kind": "POPULAR"}),
        (item_ref(second), {"kind": "POPULAR"}),
    ]


async def test_featured_concepts_count_readable_documents_once_and_the_last_30_days(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    shared = await world.make_collection(workspace, grants={reader: "roles/collectionViewer"})
    hidden = await world.make_collection(workspace)
    fresh = await world.make_document(shared)
    recent = await world.make_document(shared)
    stale = await world.make_document(shared)
    payrolled = await world.make_document(shared)
    mixed = await world.make_document(shared)
    suggested = await world.make_document(shared)
    unpublished = await world.make_document(shared, published=False)
    secret = await world.make_document(hidden)
    domain = await publish_scheme(
        sessions,
        workspace.id,
        owner.id,
        "domain",
        [
            C("people", "People", color="#3366ff", icon="users", definition="All about people"),
            C("finance", "Tài chính", pref_en="Finance", color="#22aa55", icon="coins"),
            C("empty", "Empty", color="#999999"),
            C("leave", "Leave", broader=("people",)),
            C("annual-leave", "Annual leave", broader=("leave",)),
            C("parking", "Parking", broader=("people",)),
            C("budget", "Budget", broader=("finance",)),
            # Poly-hierarchy: under both top concepts.
            C("payroll", "Payroll", broader=("people", "finance")),
        ],
    )
    await label(sessions, fresh.id, domain, "people")
    await label(sessions, recent.id, domain, "leave")
    await label(sessions, stale.id, domain, "leave", "annual-leave")
    await label(sessions, payrolled.id, domain, "payroll")
    await label(sessions, mixed.id, domain, "payroll", "budget")
    await label(sessions, suggested.id, domain, "leave", state="suggested")
    await label(sessions, unpublished.id, domain, "leave")
    await label(sessions, secret.id, domain, "leave", "budget", "payroll")
    now = datetime.now(UTC)
    async with sessions.begin() as session:
        for document, age in ((recent, timedelta(days=29)), (stale, timedelta(days=31))):
            await session.execute(
                update(ItemRevision)
                .where(ItemRevision.item_id == document.id)
                .values(created_at=now - age)
            )
        # Members read the current name, not the published snapshot's.
        await session.execute(
            update(ConceptLabel)
            .where(ConceptLabel.concept_id == domain["people"], ConceptLabel.kind == "pref")
            .values(label_text="Con người", normalized=normalize_label("Con người"))
        )

    def name(notation: str) -> str:
        return f"workspaces/{workspace.id}/conceptSchemes/domain/concepts/{notation}"

    # Empty and Parking hold nothing the reader can see: both are left out; suggested,
    # unpublished and hidden documents never count, a document counts once per concept.
    assert (await _home(client, reader, workspace))["featuredConcepts"] == [
        {
            "concept": name("people"),
            "displayName": "Con người",
            "description": "All about people",
            "icon": "users",
            "color": "#3366ff",
            "documentCount": 5,
            "newDocumentCount": 4,
            "topConcepts": [
                {"concept": name("leave"), "displayName": "Leave", "documentCount": 2},
                {"concept": name("payroll"), "displayName": "Payroll", "documentCount": 2},
            ],
        },
        {
            "concept": name("finance"),
            "displayName": "Tài chính",
            "description": "Tài chính",
            "icon": "coins",
            "color": "#22aa55",
            "documentCount": 2,
            "newDocumentCount": 2,
            "topConcepts": [
                {"concept": name("payroll"), "displayName": "Payroll", "documentCount": 2},
                {"concept": name("budget"), "displayName": "Budget", "documentCount": 1},
            ],
        },
    ]


async def test_featured_concepts_come_from_the_lowest_classification_scheme(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    shared = await world.make_collection(workspace, grants={reader: "roles/collectionViewer"})
    document = await world.make_document(shared)
    assert (await _home(client, reader, workspace))["featuredConcepts"] == []

    later = await publish_scheme(
        sessions, workspace.id, owner.id, "domain", [C("people", "People")], position=2
    )
    first = await publish_scheme(
        sessions, workspace.id, owner.id, "audience", [C("students", "Students")], position=1
    )
    await publish_scheme(
        sessions, workspace.id, owner.id, "org-unit", [C("it", "IT faculty")], purpose="authority"
    )
    await label(sessions, document.id, later, "people")
    await label(sessions, document.id, first, "students")
    featured = (await _home(client, reader, workspace))["featuredConcepts"]
    assert [entry["concept"] for entry in featured] == [
        f"workspaces/{workspace.id}/conceptSchemes/audience/concepts/students"
    ]
    assert featured[0]["topConcepts"] == []


async def test_join_time_and_conversations_with_messages(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    other = await world.make_workspace(member)

    async def conversation(user: User, tenant: Tenant, *, messages: int, deleted: bool = False) -> None:
        async with sessions.begin() as session:
            access = AccessSession(
                user_id=user.id,
                authentication_method="password",
                expires_at=datetime.now(UTC) + timedelta(days=1),
            )
            session.add(access)
            await session.flush()
            row = Conversation(
                tenant_id=tenant.id,
                code=f"c-{uuid4().hex[:10]}",
                owner_user_id=user.id,
                created_by_session_id=access.id,
                deleted_at=datetime.now(UTC) if deleted else None,
            )
            session.add(row)
            await session.flush()
            session.add_all(
                Message(conversation_id=row.id, role="user", content="Hi", sequence_number=n + 1)
                for n in range(messages)
            )

    await conversation(member, workspace, messages=2)
    await conversation(member, workspace, messages=1)
    await conversation(member, workspace, messages=0)
    await conversation(member, workspace, messages=1, deleted=True)
    await conversation(owner, workspace, messages=1)
    await conversation(member, other, messages=1)

    home = await _home(client, member, workspace)
    assert home["counts"]["conversationCount"] == 2
    joined = datetime.fromisoformat(home["joinTime"].replace("Z", "+00:00"))
    assert abs(datetime.now(UTC) - joined) < timedelta(minutes=5)
