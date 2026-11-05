"""An API-token Confluence connection end to end: create, browse, create a source, sync.

Only the Confluence site is faked (the ``FinxConfluence`` client the connector
builds from the connection's config and token); the API, the connection, source
and sync engines, object storage and PostgreSQL are the harness's.
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

from bomesh.connector.confluence import connector as confluence_module
from bomesh.db.models import ExternalResource, Item, Tenant, User
from bomesh.runtime import AppRuntime
from connections_support import CONFLUENCE, connection_row, connection_url, connections_url
from harness import ApiClient, Sessions, World
from sources_support import code_of, source_row, sources_url, syncs_of

pytestmark = pytest.mark.asyncio

SITE = {"wiki_base": "https://team.atlassian.net/wiki", "username": "kb@team.example"}
PAGE = {
    "id": "42",
    "title": "Risk policy",
    "_links": {"webui": "/spaces/ENG/pages/42"},
    "body": {"storage": {"value": "<h1>Risk</h1><p>Policy</p>"}},
    "space": {"key": "ENG", "name": "Engineering"},
    "version": {"number": 2, "when": "2026-08-10T00:00:00Z"},
    "history": {},
    "ancestors": [],
}


class _Refused(RuntimeError):
    """What the client library raises for an HTTP error answer."""

    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.response = SimpleNamespace(status_code=status)


class FakeSite:
    """The Confluence site behind the connection; records how it was reached."""

    def __init__(self) -> None:
        self.spaces = [{"key": "ENG", "name": "Engineering"}, {"key": "HR", "name": "People"}]
        self.clients: list[tuple[str, dict[str, Any]]] = []
        self.refusing: int | None = None

    def client(self, config: dict[str, Any], url: str) -> Any:
        self.clients.append((url, dict(config)))
        site = self

        def spaces(**_: Any) -> Iterator[dict[str, Any]]:
            if site.refusing is not None:
                raise _Refused(site.refusing)
            return iter(site.spaces)

        return SimpleNamespace(
            base_url=url,
            config=config,
            timeout_seconds=30,
            confluence_client=SimpleNamespace(username=config.get("username")),
            retrieve_confluence_spaces=spaces,
            space_root_pages=lambda _space: iter(()),
            child_pages=lambda _page: iter(()),
            paginated_page_retrieval=lambda **_: iter([PAGE]),
            paginated_cql_retrieval=lambda **_: iter(()),
            get_page_restrictions=lambda _page_id: {"results": []},
            get_page_owner_and_contributors=lambda _page_id: {},
        )


@pytest.fixture
def site(monkeypatch: pytest.MonkeyPatch) -> FakeSite:
    fake = FakeSite()
    monkeypatch.setattr(confluence_module, "FinxConfluence", fake.client)
    return fake


async def _connected(client: ApiClient, world: World) -> tuple[User, Tenant, ApiClient]:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    api = await client.as_(admin)
    created = await api.post(
        connections_url(workspace),
        params={"connectionId": "site"},
        json={"connector": CONFLUENCE, "apiToken": "token-1", "config": SITE},
    )
    assert created.status_code == 200, created.text
    assert created.json()["state"] == "ACTIVE"
    return admin, workspace, api


async def test_an_api_token_connection_browses_its_site(
    client: ApiClient, world: World, site: FakeSite
) -> None:
    _, workspace, api = await _connected(client, world)

    response = await api.get(connection_url(workspace, "site", "browseResources"))

    assert response.status_code == 200, response.text
    assert response.json()["resources"] == [
        {"resourceId": "ENG", "displayName": "Engineering", "type": "space", "path": "ENG", "hasChildren": True},
        {"resourceId": "HR", "displayName": "People", "type": "space", "path": "HR", "hasChildren": True},
    ]
    # The site is read with the token and account name, never through the Atlassian gateway.
    url, config = site.clients[-1]
    assert url == SITE["wiki_base"]
    assert (config["username"], config["api_token"]) == (SITE["username"], "token-1")
    assert config["access_token"] is None


async def test_a_refused_token_requires_reauthorization(
    client: ApiClient, world: World, sessions: Sessions, site: FakeSite
) -> None:
    _, workspace, api = await _connected(client, world)
    site.refusing = 401

    response = await api.get(connection_url(workspace, "site", "browseResources"))

    assert response.status_code == 400
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert (await connection_row(sessions, workspace, "site")).status == "reauthorization_required"


async def test_an_api_token_connection_feeds_a_source_sync(
    client: ApiClient, world: World, sessions: Sessions, runtime: AppRuntime, site: FakeSite
) -> None:
    _, workspace, api = await _connected(client, world)
    handbook = await world.make_collection(workspace, title="Handbook")
    spaces = (await api.get(connection_url(workspace, "site", "browseResources"))).json()
    space = spaces["resources"][0]

    created = await api.post(
        sources_url(workspace),
        json={
            "connection": f"workspaces/{workspace.id}/connections/site",
            "targetCollection": f"workspaces/{workspace.id}/items/{handbook.id}",
            "externalResource": {
                "type": space["type"],
                "resourceId": space["resourceId"],
                "displayName": space["displayName"],
            },
        },
    )
    assert created.status_code == 200, created.text
    source = await source_row(sessions, workspace, code_of(created.json()["name"]))
    assert source.config["space"] == "ENG"
    (creation,) = await syncs_of(sessions, source.id)

    await runtime.source_sync_service().sync(creation.id)

    synced = (await api.get(f"/api/v1/{created.json()['name']}")).json()
    assert synced["lastSync"]["state"] == "SUCCEEDED", synced
    assert synced["lastSync"]["addedCount"] == 1
    async with sessions() as session:
        documents = list(
            await session.scalars(
                select(Item)
                .join(ExternalResource, ExternalResource.item_id == Item.id)
                .where(ExternalResource.ingestion_source_id == source.id, Item.item_type == "document")
            )
        )
    assert [document.title for document in documents] == ["Risk policy"]
    assert documents[0].parent_item_id == handbook.id
    assert documents[0].storage_key is not None

    # The document names its source by the source's code, and that name resolves.
    source_name = created.json()["name"]
    assert documents[0].metadata_["source"]["source_code"] == source.code
    item = (
        await api.get(f"/api/v1/workspaces/{workspace.id}/items/{documents[0].id}")
    ).json()
    assert item["document"]["origin"]["source"] == source_name
    assert (await api.get(f"/api/v1/{source_name}")).status_code == 200
    filtered = await api.get(
        f"/api/v1/workspaces/{workspace.id}/items",
        params={"filter": f'document.origin.source = "{source_name}"'},
    )
    assert filtered.status_code == 200, filtered.text
    assert [entry["name"] for entry in filtered.json()["items"]] == [item["name"]]
