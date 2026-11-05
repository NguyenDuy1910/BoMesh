"""IngestionPolicy: the one deployment policy, created from configuration on first read."""

from __future__ import annotations

import pytest

from harness import ApiClient, World

pytestmark = pytest.mark.asyncio

URL = "/api/v1/ingestionPolicies"
DEFAULT = f"{URL}/default"


async def _admin(client: ApiClient, world: World) -> ApiClient:
    return await client.as_(await world.platform_admin(await world.make_user()))


async def _operator(client: ApiClient, world: World) -> ApiClient:
    return await client.as_(await world.platform_operator(await world.make_user()))


async def test_the_default_policy_comes_from_configuration(
    client: ApiClient, world: World
) -> None:
    operator = await _operator(client, world)

    body = (await operator.get(DEFAULT)).json()

    assert body["name"] == "ingestionPolicies/default"
    assert body["maxFileSizeBytes"] == str(100 * 1024 * 1024)
    assert "application/pdf" in body["allowedMimeTypes"]
    assert body["ocrScannedPdfs"] is True
    assert body["parseSpreadsheets"] is True
    assert body["contributionReviewRequired"] is True
    assert body["rejectedRetentionDuration"] == "2592000s"
    assert body["etag"]


async def test_list_holds_only_the_default_policy(client: ApiClient, world: World) -> None:
    operator = await _operator(client, world)

    body = (await operator.get(URL)).json()

    assert [policy["name"] for policy in body["ingestionPolicies"]] == ["ingestionPolicies/default"]
    assert body["totalSize"] == 1
    assert "nextPageToken" not in body
    assert (await operator.get(URL, params={"pageSize": -1})).status_code == 400


async def test_only_the_default_policy_exists(client: ApiClient, world: World) -> None:
    operator = await _operator(client, world)
    missing = await operator.get(f"{URL}/strict")
    assert missing.status_code == 404
    assert missing.json()["error"]["status"] == "NOT_FOUND"


async def test_workspace_members_cannot_read_the_policy(client: ApiClient, world: World) -> None:
    admin_of_workspace = await world.make_user()
    await world.make_workspace(admin_of_workspace)
    member = await client.as_(admin_of_workspace)
    assert (await member.get(URL)).status_code == 403
    assert (await member.get(DEFAULT)).status_code == 403
    assert (await member.get(f"{URL}/strict")).status_code == 403


async def test_update_changes_the_masked_fields(client: ApiClient, world: World) -> None:
    admin = await _admin(client, world)
    etag = (await admin.get(DEFAULT)).json()["etag"]

    response = await admin.patch(
        DEFAULT,
        params={"updateMask": "maxFileSizeBytes,rejectedRetentionDuration,allowedMimeTypes"},
        json={
            "maxFileSizeBytes": "1048576",
            "rejectedRetentionDuration": "3600.5s",
            "allowedMimeTypes": ["application/pdf"],
            "ocrScannedPdfs": False,
            "etag": etag,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["maxFileSizeBytes"] == "1048576"
    assert body["rejectedRetentionDuration"] == "3600.5s"
    assert body["allowedMimeTypes"] == ["application/pdf"]
    assert body["ocrScannedPdfs"] is True  # not in the mask
    assert body["contributionReviewRequired"] is True
    assert body["etag"] != etag
    assert (await admin.get(DEFAULT)).json()["maxFileSizeBytes"] == "1048576"
    stale = await admin.patch(DEFAULT, json={"parseSpreadsheets": False, "etag": etag})
    assert stale.status_code == 409
    assert stale.json()["error"]["status"] == "ABORTED"
    implicit = await admin.patch(DEFAULT, json={"parseSpreadsheets": False})
    assert implicit.json()["parseSpreadsheets"] is False


@pytest.mark.parametrize(
    ("mask", "body"),
    [
        ("maxFileSizeBytes", {"maxFileSizeBytes": "0"}),
        ("rejectedRetentionDuration", {"rejectedRetentionDuration": "1h"}),
        ("rejectedRetentionDuration", {}),
        ("contributionReviewRequired", {"contributionReviewRequired": False}),
    ],
)
async def test_update_rejects_invalid_values_and_paths(
    client: ApiClient, world: World, mask: str, body: dict
) -> None:
    admin = await _admin(client, world)
    response = await admin.patch(DEFAULT, params={"updateMask": mask}, json=body)
    assert response.status_code == 400
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"


async def test_only_platform_admins_update(client: ApiClient, world: World) -> None:
    operator = await _operator(client, world)
    assert (await operator.patch(DEFAULT, json={"ocrScannedPdfs": False})).status_code == 403
    admin = await _admin(client, world)
    assert (await admin.patch(f"{URL}/strict", json={"ocrScannedPdfs": False})).status_code == 404
