"""Member.affiliation: ImportMemberAffiliations, UpdateMember, who reads it, and its end."""

from __future__ import annotations

from uuid import UUID

import httpx
import pytest
from sqlalchemy import select

from bomesh.db.models import MemberAffiliation, Tenant
from harness import ApiClient, World
from taxonomy_support import C, Published, affiliate, publish_scheme
from workspaces_support import audit_actions, member_path, ws_path

pytestmark = pytest.mark.asyncio


def _concept(workspace: Tenant, scheme: str, notation: str) -> str:
    return f"workspaces/{workspace.id}/conceptSchemes/{scheme}/concepts/{notation}"


def _violations(response: httpx.Response) -> set[str]:
    return {
        violation["field"]
        for detail in response.json()["error"].get("details", [])
        for violation in detail.get("fieldViolations", ())
    }


async def _authority(world: World, sessions, owner, workspace: Tenant) -> dict[str, Published]:
    units = await publish_scheme(
        sessions,
        workspace.id,
        owner.id,
        "org-unit",
        [C("khoa-cntt", "Khoa Công nghệ Thông tin"), C("khoa-co-khi", "Khoa Cơ khí")],
        purpose="authority",
    )
    programs = await publish_scheme(
        sessions,
        workspace.id,
        owner.id,
        "program",
        [
            C(
                "cong-nghe-thong-tin",
                "Công nghệ thông tin",
                mappings=(("org-unit", "khoa-cntt", "broad"), ("moet-program", "7480201", "exact")),
            ),
            C("ky-thuat-co-khi", "Kỹ thuật cơ khí", mappings=(("org-unit", "khoa-co-khi", "broad"),)),
        ],
        purpose="authority",
    )
    domains = await publish_scheme(
        sessions, workspace.id, owner.id, "domain", [C("dao-tao", "Đào tạo")]
    )
    return {"org-unit": units, "program": programs, "domain": domains}


async def _rows(sessions, workspace: Tenant, user_id: UUID | None = None) -> list[MemberAffiliation]:
    async with sessions.begin() as session:
        statement = select(MemberAffiliation).where(MemberAffiliation.tenant_id == workspace.id)
        if user_id is not None:
            statement = statement.where(MemberAffiliation.user_id == user_id)
        return list(await session.scalars(statement))


def _import_path(workspace: Tenant) -> str:
    return f"{ws_path(workspace)}/members:importAffiliations"


async def test_import_by_notation_name_and_moet_code(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    schemes = await _authority(world, sessions, owner, workspace)
    first = await world.add_member(workspace)
    second = await world.add_member(workspace)
    third = await world.add_member(workspace)
    api = await client.as_(owner)

    response = await api.post(
        _import_path(workspace),
        json={
            "rows": [
                {"email": first.email, "program": "cong-nghe-thong-tin", "cohort": 2022},
                {"email": first.email, "unit": "khoa-cntt"},
                {
                    "email": second.email,
                    "program": _concept(workspace, "program", "ky-thuat-co-khi"),
                    "unit": _concept(workspace, "org-unit", "khoa-co-khi"),
                },
                {"email": f" {third.email.upper()} ", "program": "7480201", "cohort": 2023},
            ]
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["skippedMembers"] == []
    by_name = {member["name"]: member for member in body["members"]}
    assert list(by_name) == [
        f"workspaces/{workspace.id}/members/{user.id}" for user in (first, second, third)
    ]
    assert by_name[f"workspaces/{workspace.id}/members/{first.id}"]["affiliation"] == {
        "units": [_concept(workspace, "org-unit", "khoa-cntt")],
        "programs": [_concept(workspace, "program", "cong-nghe-thong-tin")],
        "cohort": 2022,
        "source": "DIRECTORY",
    }
    assert by_name[f"workspaces/{workspace.id}/members/{third.id}"]["affiliation"]["programs"] == [
        _concept(workspace, "program", "cong-nghe-thong-tin")
    ]
    rows = await _rows(sessions, workspace)
    assert {(row.user_id, row.concept_id, row.cohort, row.source) for row in rows} == {
        (first.id, schemes["program"]["cong-nghe-thong-tin"], 2022, "directory"),
        (first.id, schemes["org-unit"]["khoa-cntt"], 2022, "directory"),
        (second.id, schemes["program"]["ky-thuat-co-khi"], None, "directory"),
        (second.id, schemes["org-unit"]["khoa-co-khi"], None, "directory"),
        (third.id, schemes["program"]["cong-nghe-thong-tin"], 2023, "directory"),
    }
    assert all(row.updated_by_user_id == owner.id for row in rows)
    assert "ImportMemberAffiliations" in await audit_actions(sessions, workspace)


async def test_import_validate_only_writes_nothing(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await _authority(world, sessions, owner, workspace)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    response = await api.post(
        _import_path(workspace),
        json={
            "rows": [{"email": member.email, "program": "7480201", "cohort": 2024}],
            "validateOnly": True,
        },
    )

    assert response.status_code == 200, response.text
    [preview] = response.json()["members"]
    assert preview["affiliation"]["programs"] == [
        _concept(workspace, "program", "cong-nghe-thong-tin")
    ]
    assert preview["affiliation"]["cohort"] == 2024
    assert await _rows(sessions, workspace) == []
    assert "ImportMemberAffiliations" not in await audit_actions(sessions, workspace)


async def test_import_rejects_invalid_rows_atomically(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await _authority(world, sessions, owner, workspace)
    member = await world.add_member(workspace)
    outsider = await world.make_user()
    api = await client.as_(owner)

    response = await api.post(
        _import_path(workspace),
        json={
            "rows": [
                {"email": "nobody@example.com", "program": "cong-nghe-thong-tin"},
                {"email": outsider.email, "program": "cong-nghe-thong-tin"},
                {"email": member.email, "program": _concept(workspace, "domain", "dao-tao")},
                {"email": member.email, "program": "dao-tao"},
                {"email": member.email, "unit": "khoa-khong-co"},
                {"email": member.email, "unit": "cong-nghe-thong-tin"},
                {"email": member.email, "cohort": 2022},
                {"email": member.email, "program": "ky-thuat-co-khi", "cohort": 1800},
                {"email": member.email, "program": "cong-nghe-thong-tin", "cohort": 2022},
                {"email": member.email, "unit": "khoa-cntt", "cohort": 2023},
            ]
        },
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert _violations(response) == {
        "rows[0].email",
        "rows[1].email",
        "rows[2].program",
        "rows[3].program",
        "rows[4].unit",
        "rows[5].unit",
        "rows[6].program",
        "rows[7].cohort",
        "rows[9].cohort",
    }
    assert await _rows(sessions, workspace) == []

    too_many = await api.post(
        _import_path(workspace),
        json={"rows": [{"email": member.email, "unit": "khoa-cntt"}] * 5001},
    )
    assert too_many.status_code == 400
    assert _violations(too_many) == {"rows"}


async def test_reimport_replaces_directory_rows_and_skips_admin_edits(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    schemes = await _authority(world, sessions, owner, workspace)
    student = await world.add_member(workspace)
    edited = await world.add_member(workspace)
    await affiliate(
        sessions, workspace.id, edited.id, [schemes["org-unit"]["khoa-co-khi"]], source="admin"
    )
    api = await client.as_(owner)

    first = await api.post(
        _import_path(workspace),
        json={"rows": [{"email": student.email, "program": "cong-nghe-thong-tin", "cohort": 2022}]},
    )
    assert first.status_code == 200, first.text

    second = await api.post(
        _import_path(workspace),
        json={
            "rows": [
                {"email": student.email, "unit": "khoa-cntt"},
                {"email": edited.email, "unit": "khoa-cntt", "cohort": 2020},
            ]
        },
    )

    assert second.status_code == 200, second.text
    body = second.json()
    assert body["skippedMembers"] == [f"workspaces/{workspace.id}/members/{edited.id}"]
    assert [member["name"] for member in body["members"]] == [
        f"workspaces/{workspace.id}/members/{student.id}"
    ]
    assert [(row.concept_id, row.cohort) for row in await _rows(sessions, workspace, student.id)] == [
        (schemes["org-unit"]["khoa-cntt"], None)
    ]
    kept = await _rows(sessions, workspace, edited.id)
    assert [(row.concept_id, row.source) for row in kept] == [
        (schemes["org-unit"]["khoa-co-khi"], "admin")
    ]


async def test_update_member_affiliation_by_admin(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    schemes = await _authority(world, sessions, owner, workspace)
    student = await world.add_member(workspace)
    await affiliate(sessions, workspace.id, student.id, [schemes["org-unit"]["khoa-co-khi"]])
    api = await client.as_(owner)
    url = member_path(workspace, student)

    response = await api.patch(
        url,
        params={"updateMask": "affiliation"},
        json={
            "affiliation": {
                "units": [_concept(workspace, "org-unit", "khoa-cntt")],
                "programs": [_concept(workspace, "program", "cong-nghe-thong-tin")],
                "cohort": 2021,
            }
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["affiliation"] == {
        "units": [_concept(workspace, "org-unit", "khoa-cntt")],
        "programs": [_concept(workspace, "program", "cong-nghe-thong-tin")],
        "cohort": 2021,
        "source": "ADMIN",
    }
    rows = await _rows(sessions, workspace, student.id)
    assert {(row.concept_id, row.cohort, row.source, row.updated_by_user_id) for row in rows} == {
        (schemes["org-unit"]["khoa-cntt"], 2021, "admin", owner.id),
        (schemes["program"]["cong-nghe-thong-tin"], 2021, "admin", owner.id),
    }
    assert "UpdateMember" in await audit_actions(sessions, workspace)

    wrong_scheme = await api.patch(
        url,
        params={"updateMask": "affiliation"},
        json={"affiliation": {"units": [_concept(workspace, "program", "cong-nghe-thong-tin")]}},
    )
    assert wrong_scheme.status_code == 400
    assert _violations(wrong_scheme) == {"affiliation.units[0]"}

    classification = await api.patch(
        url,
        params={"updateMask": "affiliation"},
        json={"affiliation": {"programs": [_concept(workspace, "domain", "dao-tao")]}},
    )
    assert _violations(classification) == {"affiliation.programs[0]"}

    lone_cohort = await api.patch(
        url, params={"updateMask": "affiliation"}, json={"affiliation": {"cohort": 2022}}
    )
    assert _violations(lone_cohort) == {"affiliation.cohort"}

    out_of_range = await api.patch(
        url,
        params={"updateMask": "affiliation"},
        json={"affiliation": {"units": [_concept(workspace, "org-unit", "khoa-cntt")], "cohort": 1800}},
    )
    assert _violations(out_of_range) == {"affiliation.cohort"}

    bad_mask = await api.patch(url, params={"updateMask": "displayName"}, json={"displayName": "x"})
    assert bad_mask.status_code == 400

    gone = await api.patch(
        member_path(workspace, await world.make_user()),
        params={"updateMask": "affiliation"},
        json={"affiliation": {}},
    )
    assert gone.status_code == 404

    cleared = await api.patch(url, params={"updateMask": "affiliation"}, json={"affiliation": {}})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["affiliation"] == {"units": [], "programs": []}
    assert await _rows(sessions, workspace, student.id) == []


async def test_members_cannot_write_affiliations(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await _authority(world, sessions, owner, workspace)
    member = await world.add_member(workspace)
    other = await world.add_member(workspace)
    api = await client.as_(member)
    body = {"affiliation": {"units": [_concept(workspace, "org-unit", "khoa-cntt")]}}

    for target in ("me", member, other):
        response = await api.patch(
            member_path(workspace, target), params={"updateMask": "affiliation"}, json=body
        )
        assert response.status_code == 403, response.text

    imported = await api.post(
        _import_path(workspace), json={"rows": [{"email": member.email, "unit": "khoa-cntt"}]}
    )
    assert imported.status_code == 403

    created = await (await client.as_(owner)).post(
        f"{ws_path(workspace)}/members",
        json={"user": f"users/{(await world.make_user()).id}", **body},
    )
    assert created.status_code == 400
    assert await _rows(sessions, workspace) == []


async def test_affiliation_is_shown_to_self_and_admins_only(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    schemes = await _authority(world, sessions, owner, workspace)
    member = await world.add_member(workspace)
    other = await world.add_member(workspace)
    await affiliate(
        sessions, workspace.id, member.id, [schemes["program"]["cong-nghe-thong-tin"]], cohort=2022
    )
    await affiliate(sessions, workspace.id, other.id, [schemes["org-unit"]["khoa-co-khi"]])
    own = {
        "units": [],
        "programs": [_concept(workspace, "program", "cong-nghe-thong-tin")],
        "cohort": 2022,
        "source": "DIRECTORY",
    }
    api = await client.as_(member)

    me = await api.get(member_path(workspace, "me"))
    assert me.json()["affiliation"] == own
    assert (await api.get(member_path(workspace, member))).json()["affiliation"] == own
    assert "affiliation" not in (await api.get(member_path(workspace, other))).json()
    listed = (await api.get(f"{ws_path(workspace)}/members")).json()["members"]
    for row in listed:
        if row["name"].endswith(str(member.id)):
            assert row["affiliation"] == own
        else:
            assert "affiliation" not in row

    admin = await client.as_(owner)
    assert (await admin.get(member_path(workspace, other))).json()["affiliation"]["units"] == [
        _concept(workspace, "org-unit", "khoa-co-khi")
    ]
    everyone = (await admin.get(f"{ws_path(workspace)}/members")).json()["members"]
    assert len(everyone) == 3 and all("affiliation" in row for row in everyone)


async def test_ending_membership_removes_affiliation(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    schemes = await _authority(world, sessions, owner, workspace)
    removed = await world.add_member(workspace)
    leaving = await world.add_member(workspace)
    for user in (removed, leaving):
        await affiliate(sessions, workspace.id, user.id, [schemes["org-unit"]["khoa-cntt"]])

    deleted = await (await client.as_(owner)).delete(member_path(workspace, removed))
    assert deleted.status_code == 200, deleted.text
    left = await (await client.as_(leaving)).post(f"{ws_path(workspace)}:leave", json={})
    assert left.status_code == 200, left.text

    assert await _rows(sessions, workspace) == []
