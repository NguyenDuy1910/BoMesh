"""SearchItems and agent retrieval: Qdrant pre-filters, PostgreSQL decides (``item_model.md`` §4.10).

Several tests make the index payload deliberately stale (a write applied in
PostgreSQL only) to prove that no text reaches the caller without the
PostgreSQL re-check.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from sqlalchemy import update

from bomesh.agent.models import AgentContext
from bomesh.document_index.index import ItemIndex
from bomesh.runtime import AppRuntime
from bomesh.services.knowledge_items.search import retrieve_passages
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from bomesh.services import ARTIFACT_COLLECTION_TYPE
from bomesh.services.knowledge_items.item_store import ItemService, artifact_collection_id
from bomesh.iam.authorizer import Authorizer, Principal, WorkspaceAccess
from fakes import FakeEmbedder
from harness import Fakes, World
from knowledge_support import Knowledge, error_reason, item_name, ws_url

pytestmark = pytest.mark.asyncio


async def _search(api, workspace, **body):
    return await api.post(f"{ws_url(workspace)}/items:search", json=body)


def _names(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [result["item"]["name"] for result in response.json()["results"]]


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
    return admin, workspace, viewer, editor, handbook


async def _set(knowledge: Knowledge, item: Item, **values) -> None:
    """Change a row in PostgreSQL only: the index payload stays stale."""
    async with transaction_scope(knowledge.sessions) as session:
        await session.execute(update(Item).where(Item.id == item.id).values(**values))


async def test_search_finds_published_documents_for_readers_and_unpublished_for_editors(
    client, world: World, knowledge: Knowledge
) -> None:
    _, workspace, viewer, editor, handbook = await _world(world)
    published = await world.make_document(handbook, item_name="Leave policy")
    draft = await world.make_document(handbook, item_name="Leave draft", published=False)
    await knowledge.index(published, ["annual leave carries over"])
    await knowledge.index(draft, ["annual leave draft rules"])

    as_viewer = _names(await _search(await client.as_(viewer), workspace, query="annual leave"))
    as_editor = _names(await _search(await client.as_(editor), workspace, query="annual leave"))

    assert as_viewer == [item_name(published)]
    assert set(as_editor) == {item_name(published), item_name(draft)}
    assert knowledge.payload(draft)["published"] is False


async def test_every_hit_is_rechecked_in_postgresql(
    client, world: World, knowledge: Knowledge
) -> None:
    _, workspace, viewer, _, handbook = await _world(world)
    secret = await world.make_collection(workspace, item_name="Secret")
    unpublished = await world.make_document(handbook, item_name="Withdrawn")
    moved = await world.make_document(handbook, item_name="Moved away")
    deleted = await world.make_document(handbook, item_name="Deleted")
    kept = await world.make_document(handbook, item_name="Kept")
    for document in (unpublished, moved, deleted, kept):
        await knowledge.index(document, ["expense reimbursement rules"])
    await _set(knowledge, unpublished, is_published=False)
    await _set(knowledge, moved, parent_item_id=secret.id)
    await world.delete(deleted)

    names = _names(await _search(await client.as_(viewer), workspace, query="expense rules"))

    assert names == [item_name(kept)]
    assert knowledge.payload(unpublished)["published"] is True  # stale on purpose


async def test_hidden_artifact_documents_never_reach_search(
    client, world: World, knowledge: Knowledge
) -> None:
    admin, workspace, *_ = await _world(world)
    async with transaction_scope(knowledge.sessions) as session:
        artifacts_id = await ItemService(session).ensure_system_collection(
            workspace.id,
            admin.id,
            collection_id=artifact_collection_id(workspace.id, admin.id),
            item_name="Artifacts",
            item_type=ARTIFACT_COLLECTION_TYPE,
        )
        artifacts = await session.get(Item, artifacts_id)
    artifact = await world.make_document(artifacts, item_name="Generated report")
    await knowledge.index(artifact, ["quarterly revenue summary"])

    assert _names(await _search(await client.as_(admin), workspace, query="quarterly revenue")) == []


async def test_search_filters_facets_paging_and_snippets(
    client, world: World, knowledge: Knowledge
) -> None:
    admin, workspace, viewer, _, handbook = await _world(world)
    nested = await world.make_collection(workspace, handbook, item_name="Travel")
    policy = await world.make_document(handbook, item_name="Travel policy", mime_type="application/pdf")
    guide = await world.make_document(nested, item_name="Travel guide", mime_type="text/markdown")
    await knowledge.index(policy, ["travel booking rules"], page=3)
    await knowledge.index(guide, ["travel booking guide"])
    api = await client.as_(viewer)

    scoped = await _search(api, workspace, query="travel booking", filter=f'ancestors:"{item_name(nested)}"')
    assert _names(scoped) == [item_name(guide)]

    faceted = await _search(
        api,
        workspace,
        query="travel booking",
        filter="itemType = PDF",
        facetSpecs=[{"field": "itemType"}, {"field": "ancestors"}],
        contentSearchSpec={"snippets": True, "references": 1},
        pageSize=1,
    )
    body = faceted.json()
    assert _names(faceted) == [item_name(policy)]
    assert body["totalSize"] == 1
    result = body["results"][0]
    assert result["snippets"] == ["travel booking rules"]
    (reference,) = result["references"]
    assert reference == {
        "item": item_name(policy),
        "revision": f"{item_name(policy)}/revisions/1",
        "structureVersion": knowledge.payload(policy)["structure_version"],
        "refs": ["texts/0"],
        "quote": "travel booking rules",
        "location": "",
        "pageNumber": 3,
    }
    facets = {facet["field"]: facet["values"] for facet in body["facets"]}
    # Disjunctive: the itemType facet ignores its own clause.
    assert {value["value"]: value["documentCount"] for value in facets["itemType"]} == {
        "PDF": 1,
        "MARKDOWN": 1,
    }
    assert {value["value"] for value in facets["ancestors"]} == {item_name(handbook)}

    first = await _search(api, workspace, orderBy="displayName", pageSize=1)
    assert _names(first) == [item_name(guide)]
    token = first.json()["nextPageToken"]
    second = await _search(api, workspace, orderBy="displayName", pageSize=1, pageToken=token)
    assert _names(second) == [item_name(policy)]
    assert "nextPageToken" not in second.json()


async def test_search_rejects_unreadable_references_and_bad_input(
    client, world: World, knowledge: Knowledge
) -> None:
    _, workspace, viewer, _, _ = await _world(world)
    secret = await world.make_collection(workspace, item_name="Secret")
    hidden = await world.make_document(secret)
    api = await client.as_(viewer)

    related = await _search(api, workspace, relatedItem=item_name(hidden))
    scoped = await _search(api, workspace, filter=f'ancestors:"{item_name(secret)}"')
    bad = await _search(api, workspace, filter="nonsense = 1")
    facet = await _search(api, workspace, facetSpecs=[{"field": "document.size"}])

    assert related.status_code == 403
    assert scoped.status_code == 403
    assert (bad.status_code, facet.status_code) == (400, 400)


async def test_related_items_exclude_the_item_itself(
    client, world: World, knowledge: Knowledge
) -> None:
    _, workspace, viewer, _, handbook = await _world(world)
    source = await world.make_document(handbook, item_name="Onboarding checklist")
    related = await world.make_document(handbook, item_name="Onboarding buddy")
    await knowledge.index(source, ["onboarding checklist steps"])
    await knowledge.index(related, ["onboarding buddy program"])

    names = _names(await _search(await client.as_(viewer), workspace, relatedItem=item_name(source)))

    assert names == [item_name(related)]


async def test_agent_retriever_rechecks_hits_and_scopes_subtrees(
    runtime, world: World, knowledge: Knowledge
) -> None:
    _, workspace, viewer, _, handbook = await _world(world)
    nested = await world.make_collection(workspace, handbook, item_name="Benefits")
    visible = await world.make_document(nested, item_name="Benefits")
    withdrawn = await world.make_document(nested, item_name="Old benefits")
    await knowledge.index(visible, ["dental benefits coverage"])
    await knowledge.index(withdrawn, ["dental benefits coverage old"])
    await _set(knowledge, withdrawn, is_published=False)
    retriever = runtime.knowledge_retriever()
    context = AgentContext(
        user_id=str(viewer.id),
        tenant_id=str(workspace.id),
        collection_item_ids=(str(handbook.id),),
    )

    evidence = await retriever.search(["dental benefits"], limit=5, ctx=context)

    assert {item.item_id for item in evidence} == {str(visible.id)}
    # What the found-document card shows comes with the same re-check: the parent collection and the item's facts.
    facts = evidence[0].document
    assert facts is not None
    assert (facts.collection_title, facts.mime_type, facts.updated_at) == ("Benefits", visible.mime_type, visible.updated_at)


async def test_retrieve_passages_applies_the_callers_visibility(
    runtime, world: World, knowledge: Knowledge
) -> None:
    _, workspace, viewer, _, handbook = await _world(world)
    secret = await world.make_collection(workspace, item_name="Secret")
    readable = await world.make_document(handbook, item_name="Holidays")
    private = await world.make_document(secret, item_name="Board minutes")
    await knowledge.index(readable, ["public holidays list"])
    await knowledge.index(private, ["public holidays board decision"])
    access = WorkspaceAccess(Principal(viewer.id), workspace.id, Authorizer(knowledge.sessions))

    everywhere = await retrieve_passages(
        runtime.knowledge_retriever(), access, ["public holidays"], None, limit=5
    )
    nowhere = await retrieve_passages(
        runtime.knowledge_retriever(), access, ["public holidays"], (secret.id,), limit=5
    )

    assert [item.item_id for item in everywhere] == [str(readable.id)]
    assert nowhere == []


async def test_search_requires_items_search(client, world: World) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    outsider = await world.make_user()

    response = await _search(await client.as_(outsider), workspace, query="anything")

    assert response.status_code == 403
    assert error_reason(response) is None


class _SlowEmbedder(FakeEmbedder):
    """An embedding provider that answers long after the search deadline."""

    async def embed_query(self, query: str) -> list[float]:
        await asyncio.sleep(30)
        return await super().embed_query(query)


async def test_a_late_index_answers_unavailable_within_the_deadline(
    client, world: World, knowledge: Knowledge, runtime: AppRuntime, fakes: Fakes
) -> None:
    _, workspace, viewer, _, handbook = await _world(world)
    await knowledge.index(await world.make_document(handbook), ["annual leave"])
    runtime._index = ItemIndex(  # type: ignore[assignment]
        backend=fakes.index_backend, embedder=_SlowEmbedder(), search_deadline_seconds=0.2
    )
    api = await client.as_(viewer)

    started = time.perf_counter()
    response = await _search(api, workspace, query="annual leave")
    browse = await _search(api, workspace)

    assert time.perf_counter() - started < 5
    assert response.status_code == 503, response.text
    assert response.json()["error"]["status"] == "UNAVAILABLE"
    assert error_reason(response) == "SEARCH_UNAVAILABLE"
    # Browsing without query text never waits for the index.
    assert browse.status_code == 200, browse.text
