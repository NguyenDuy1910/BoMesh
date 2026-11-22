"""GetMemberHome: starter prompts by role, recommended reasons, domain freshness, Getting started facts."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import update

from bomesh.db.models import (
    AccessSession,
    Conversation,
    Item,
    ItemRevision,
    ItemTopic,
    Message,
    RecentItem,
    SpaceMaterial,
    Tenant,
    Topic,
    User,
)
from harness import ApiClient, Sessions, World
from library_support import item_ref, me

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


async def _domain(sessions: Sessions, workspace: Tenant, code: str, *topics: str) -> dict[str, Topic]:
    """A live domain ``code`` (with an icon and colour) and its topics, by code."""
    async with sessions.begin() as session:
        domain = Topic(
            tenant_id=workspace.id,
            code=code,
            kind="domain",
            topic_name=code.title(),
            description=f"All about {code}",
            icon="users",
            color="#3366FF",
        )
        session.add(domain)
        await session.flush()
        made = {code: domain}
        for topic in topics:
            made[topic] = Topic(
                tenant_id=workspace.id,
                code=topic,
                kind="topic",
                topic_name=topic.title(),
                parent_topic_id=domain.id,
            )
            session.add(made[topic])
        await session.flush()
    return made


async def _tag(sessions: Sessions, topic: Topic, *documents: Item) -> None:
    async with sessions.begin() as session:
        session.add_all(ItemTopic(item_id=document.id, topic_id=topic.id) for document in documents)


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

    topics = await _domain(sessions, workspace, "people", "leave", "parking")
    await _tag(sessions, topics["leave"], read, related, secret_related)
    await _tag(sessions, topics["parking"], popular)

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


async def test_domains_hold_readable_documents_and_count_the_last_30_days(
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
    unpublished = await world.make_document(shared, published=False)
    secret = await world.make_document(hidden)
    topics = await _domain(sessions, workspace, "people", "leave", "parking")
    finance = await _domain(sessions, workspace, "finance", "budget")
    await _tag(sessions, topics["people"], fresh)
    await _tag(sessions, topics["leave"], recent, stale, unpublished, secret)
    await _tag(sessions, finance["budget"], secret)
    now = datetime.now(UTC)
    async with sessions.begin() as session:
        for document, age in ((recent, timedelta(days=29)), (stale, timedelta(days=31))):
            await session.execute(
                update(ItemRevision)
                .where(ItemRevision.item_id == document.id)
                .values(created_at=now - age)
            )

    # Finance holds nothing the reader can see and Parking nothing at all: both are left out.
    [people] = (await _home(client, reader, workspace))["topicDomains"]
    assert people == {
        "topic": f"workspaces/{workspace.id}/topics/people",
        "displayName": "People",
        "description": "All about people",
        "icon": "users",
        "color": "#3366FF",
        "documentCount": 3,
        "newDocumentCount": 2,
        "topTopics": [
            {"topic": f"workspaces/{workspace.id}/topics/leave", "displayName": "Leave", "documentCount": 2}
        ],
    }


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
