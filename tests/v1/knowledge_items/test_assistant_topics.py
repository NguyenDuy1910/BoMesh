"""``document.assistantTopics`` and AIP-160 presence/wildcards on ListItems (``openapi.yaml``).

``item_topics.created_by_user_id`` NULL marks a tag the assistant applied; it is
output as ``document.assistantTopics`` (a subset of ``topics``) and filtered
like the hierarchical ``document.topics:``. ``field:*`` tests presence, and
``*`` is the case-insensitive wildcard of string fields.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest
import pytest_asyncio

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemTopic, Tenant, Topic, User
from harness import ApiClient, World
from knowledge_support import Knowledge, item_name, item_url, ws_url

pytestmark = pytest.mark.asyncio


@dataclass(frozen=True, slots=True)
class Scene:
    workspace: Tenant
    admin: User
    viewer: User
    assisted: Item  # hiring by the assistant, the people domain by a person
    personal: Item  # hiring by a person
    leave: Item  # leave (under people) by the assistant
    untagged: Item  # no topics (a Word document)
    hidden: Item  # untagged, in a collection the viewer cannot read

    def topic(self, code: str) -> str:
        return f"workspaces/{self.workspace.id}/topics/{code}"


@pytest_asyncio.fixture
async def scene(world: World, knowledge: Knowledge) -> Scene:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    viewer = await world.add_member(workspace)
    handbook = await world.make_collection(
        workspace, item_name="Handbook", grants={viewer: "roles/collectionViewer"}
    )
    secret = await world.make_collection(workspace, item_name="Secret")
    assisted = await world.make_document(handbook, item_name="Hiring Guide")
    personal = await world.make_document(handbook, item_name="Plan a_b")
    leave = await world.make_document(handbook, item_name="Plan axb")
    untagged = await world.make_document(handbook, item_name="Untagged", mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    hidden = await world.make_document(secret, item_name="Hidden guide")
    async with transaction_scope(knowledge.sessions) as session:
        people = Topic(tenant_id=workspace.id, code="people", kind="domain", topic_name="People")
        session.add(people)
        await session.flush()
        hiring, leave_topic = (
            Topic(
                tenant_id=workspace.id,
                code=code,
                kind="topic",
                topic_name=code.title(),
                parent_topic_id=people.id,
            )
            for code in ("hiring", "leave")
        )
        session.add_all([hiring, leave_topic])
        await session.flush()
        session.add_all(
            [
                ItemTopic(item_id=assisted.id, topic_id=hiring.id),
                ItemTopic(item_id=assisted.id, topic_id=people.id, created_by_user_id=admin.id),
                ItemTopic(item_id=personal.id, topic_id=hiring.id, created_by_user_id=admin.id),
                ItemTopic(item_id=leave.id, topic_id=leave_topic.id),
            ]
        )
    return Scene(workspace, admin, viewer, assisted, personal, leave, untagged, hidden)


async def _listed(api: ApiClient, scene: Scene, filter_text: str) -> set[str]:
    response = await api.get(
        f"{ws_url(scene.workspace)}/items",
        params={"filter": f"itemKind = DOCUMENT AND ({filter_text})", "pageSize": 100},
    )
    assert response.status_code == 200, response.text
    return {item["name"] for item in response.json()["items"]}


def _names(*items: Item) -> set[str]:
    return {item_name(item) for item in items}


async def test_get_and_list_show_assistant_topics_as_a_subset_of_topics(
    client, scene: Scene
) -> None:
    api = await client.as_(scene.viewer)

    shown = (await api.get(item_url(scene.assisted))).json()["document"]
    personal = (await api.get(item_url(scene.personal))).json()["document"]
    untagged = (await api.get(item_url(scene.untagged))).json()["document"]
    listed = await api.get(
        f"{ws_url(scene.workspace)}/items",
        params={"filter": "itemKind = DOCUMENT", "pageSize": 100},
    )

    assert shown["topics"] == [scene.topic("hiring"), scene.topic("people")]
    assert shown["assistantTopics"] == [scene.topic("hiring")]
    assert personal["topics"] == [scene.topic("hiring")]
    assert personal.get("assistantTopics", []) == []
    assert untagged.get("topics", []) == untagged.get("assistantTopics", []) == []
    assert listed.status_code == 200, listed.text
    by_name = {item["name"]: item["document"] for item in listed.json()["items"]}
    assert by_name[item_name(scene.assisted)]["assistantTopics"] == [scene.topic("hiring")]
    assert by_name[item_name(scene.leave)]["assistantTopics"] == [scene.topic("leave")]
    assert by_name[item_name(scene.personal)].get("assistantTopics", []) == []


async def test_topic_presence_filters(client, scene: Scene) -> None:
    api = await client.as_(scene.viewer)

    tagged = await _listed(api, scene, "document.topics:*")
    without = await _listed(api, scene, "NOT document.topics:*")
    assistant = await _listed(api, scene, "document.assistantTopics:*")
    no_assistant = await _listed(api, scene, "-document.assistantTopics:*")

    assert tagged == _names(scene.assisted, scene.personal, scene.leave)
    # Only readable documents: the hidden untagged one stays absent.
    assert without == _names(scene.untagged)
    assert assistant == _names(scene.assisted, scene.leave)
    assert no_assistant == _names(scene.personal, scene.untagged)


async def test_assistant_topics_filter_is_hierarchical_over_assistant_tags(
    client, scene: Scene
) -> None:
    api = await client.as_(scene.viewer)

    by_domain = await _listed(api, scene, f'document.assistantTopics:"{scene.topic("people")}"')
    by_topic = await _listed(api, scene, f'document.assistantTopics:"{scene.topic("hiring")}"')
    all_hiring = await _listed(api, scene, f'document.topics:"{scene.topic("hiring")}"')

    # People matches the assistant's tags under it; `assisted` carries the domain
    # itself only as a person's tag, but its hiring tag is the assistant's.
    assert by_domain == _names(scene.assisted, scene.leave)
    assert by_topic == _names(scene.assisted)
    assert all_hiring == _names(scene.assisted, scene.personal)


@pytest.mark.parametrize("field", ["document.topics", "document.assistantTopics"])
async def test_unknown_and_malformed_topics_behave_like_document_topics(
    client, scene: Scene, field: str
) -> None:
    api = await client.as_(scene.viewer)
    url = f"{ws_url(scene.workspace)}/items"

    unknown = await api.get(url, params={"filter": f'{field}:"{scene.topic("missing")}"'})
    foreign = await api.get(url, params={"filter": f'{field}:"workspaces/other/topics/x"'})
    compared = await api.get(url, params={"filter": f'{field} = "{scene.topic("hiring")}"'})

    assert unknown.status_code == 200, unknown.text
    assert unknown.json().get("items", []) == []
    assert foreign.status_code == 400
    assert compared.status_code == 400


async def test_presence_on_scalars_and_reference_fields_names_no_item(
    client, scene: Scene
) -> None:
    api = await client.as_(scene.viewer)

    typed = await _listed(api, scene, "document.mimeType:*")
    untyped = await _listed(api, scene, "NOT document.mimeType:*")
    # Neither names an item, so neither is authorized as a reference.
    parented = await _listed(api, scene, "parentItem:*")
    nested = await _listed(api, scene, "ancestors:*")
    roots = await _listed(api, scene, "NOT ancestors:*")

    # Every document with content has a type (its current revision's).
    assert typed == _names(scene.assisted, scene.personal, scene.leave, scene.untagged)
    assert untyped == set()
    assert parented == nested == _names(
        scene.assisted, scene.personal, scene.leave, scene.untagged
    )
    assert roots == set()


async def test_display_name_wildcard_is_case_insensitive_and_literal_otherwise(
    client, scene: Scene
) -> None:
    api = await client.as_(scene.viewer)

    substring = await _listed(api, scene, 'displayName = "*GUIDE*"')
    unquoted = await _listed(api, scene, "displayName = hiring*")
    underscore = await _listed(api, scene, 'displayName = "*a_b*"')
    exact = await _listed(api, scene, 'displayName = "plan a_b"')
    negated = await _listed(api, scene, 'displayName != "plan*"')

    assert substring == _names(scene.assisted)
    assert unquoted == _names(scene.assisted)
    # `_` (and `%`) are literal: "Plan axb" does not match.
    assert underscore == _names(scene.personal)
    # Without `*` the comparison stays exact (case-sensitive).
    assert exact == set()
    assert negated == _names(scene.assisted, scene.untagged)


async def test_assistant_topics_are_output_only(client, scene: Scene) -> None:
    api = await client.as_(scene.admin)

    response = await api.patch(
        item_url(scene.untagged),
        params={"updateMask": "document.assistantTopics"},
        json={"document": {"assistantTopics": [scene.topic("hiring")]}},
    )

    assert response.status_code == 400
