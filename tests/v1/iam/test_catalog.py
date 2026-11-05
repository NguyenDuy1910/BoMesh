"""The IAM catalog against the contract (``openapi.yaml``, ``item_model.md`` §8).

Every expectation is read from the design documents; the catalog may hold
more than they state, never less, and never a permission they do not use.
"""

from __future__ import annotations

import re
from collections import defaultdict
from functools import cache
from pathlib import Path
from typing import Any

import pytest
import yaml

from bomesh.iam import (
    PERMISSIONS,
    PREDEFINED_ROLES,
    Scope,
    conferred_permissions,
    get_permission,
    get_predefined_role,
    permissions_at_scope,
)

DOCS = Path(__file__).resolve().parents[3] / "backend" / "docs_design"
WORKSPACE_CHILD = re.compile(r"^(/upload)?/api/v1/workspaces/\{workspace\}/")
WORKSPACE_RESOURCE = re.compile(r"^(/upload)?/api/v1/workspaces/\{workspace\}")
HTTP_METHODS = {"get", "post", "patch", "delete", "put"}
CATALOG = {permission.name: permission for permission in PERMISSIONS}
ROLES = {role.name: role for role in PREDEFINED_ROLES}
PLATFORM_ROLES = [role for role in PREDEFINED_ROLES if role.scope is Scope.PLATFORM]


@cache
def _openapi() -> dict[str, Any]:
    return yaml.safe_load((DOCS / "openapi.yaml").read_text())


@cache
def _operations() -> tuple[tuple[str, str, dict[str, Any]], ...]:
    """``(http_method, path, operation)`` for every operation."""
    return tuple(
        (method, path, operation)
        for path, item in _openapi()["paths"].items()
        for method, operation in item.items()
        if method in HTTP_METHODS
    )


def _operations_by_permission() -> dict[str, list[tuple[str, str, dict[str, Any]]]]:
    grouped: dict[str, list[tuple[str, str, dict[str, Any]]]] = defaultdict(list)
    for method, path, operation in _operations():
        grouped[operation["x-permission"]].append((method, path, operation))
    grouped.pop("none", None)
    return grouped


def _text(operation: dict[str, Any]) -> str:
    return f"{operation.get('description', '')} {operation.get('x-authorization', '')}"


def _role(role_id: str) -> frozenset[str]:
    return ROLES[f"roles/{role_id}"].permissions


def _backticked(text: str) -> list[str]:
    return re.findall(r"`([^`]+)`", text)


def test_every_operation_declares_a_permission() -> None:
    missing = [
        operation["operationId"]
        for _, _, operation in _operations()
        if "x-permission" not in operation
    ]
    assert missing == []


def _auxiliary_permissions() -> set[str]:
    """Permissions the contract checks inside a method's rules, not as its x-permission.

    They are named in backticks in an operation's description or x-authorization
    (e.g. `readingLists.publish` for a WORKSPACE-audience reading list) and belong
    to a collection whose methods the contract already guards.
    """
    collections = {name.split(".")[0] for name in _operations_by_permission()}
    return {
        token
        for _, _, operation in _operations()
        for token in _backticked(_text(operation))
        if re.fullmatch(r"[a-z][A-Za-z]*\.[a-z][A-Za-z]*", token)
        and token.split(".")[0] in collections
    }


def test_catalog_is_exactly_the_contract_permissions() -> None:
    guarded = set(_operations_by_permission())
    assert sorted(guarded - CATALOG.keys()) == [], "x-permission values missing from the catalog"
    assert sorted(CATALOG.keys() - guarded - _auxiliary_permissions()) == [], (
        "catalog permissions the contract never checks"
    )
    assert len(PERMISSIONS) == len(CATALOG), "duplicate permission names"


def test_rule_permissions_named_by_the_contract_exist() -> None:
    referenced = {name for name in _auxiliary_permissions() if name.endswith(".publish")}
    assert "readingLists.publish" in referenced
    assert referenced <= CATALOG.keys()


def test_permission_names_follow_collection_dot_method() -> None:
    for name in CATALOG:
        assert re.fullmatch(r"[a-z][A-Za-z]*\.[a-z][A-Za-z]*", name), name


def test_every_permission_is_described_and_grantable() -> None:
    for permission in PERMISSIONS:
        assert permission.title and permission.description, permission.name
        assert permission.scopes, permission.name
        # Custom roles are workspace roles: platform-only permissions cannot be in one.
        assert permission.custom_roles_supported is (
            permission.scopes != {Scope.PLATFORM}
        ), permission.name


def test_predefined_roles_are_those_the_contract_lists() -> None:
    description = _openapi()["paths"]["/api/v1/roles"]["get"]["description"]
    listed = {name for name in _backticked(description) if name.startswith("roles/")}
    assert set(ROLES) == listed


@pytest.mark.parametrize("role", PREDEFINED_ROLES, ids=lambda role: role.name)
def test_role_permissions_are_valid_for_its_scope(role) -> None:
    invalid = sorted(
        name for name in role.permissions if role.scope not in CATALOG[name].scopes
    )
    assert invalid == []
    assert role.title and role.description


def test_collection_roles_are_nested() -> None:
    assert (
        _role("collectionViewer") < _role("collectionEditor") < _role("collectionOwner")
    )


def test_space_roles_are_nested() -> None:
    assert _role("spaceMember") < _role("spaceStaff") < _role("spaceLead")


def test_platform_operator_is_within_platform_admin() -> None:
    assert _role("platformOperator") < _role("platformAdmin")


def test_workspace_admin_holds_everything_in_a_workspace() -> None:
    admin = _role("workspaceAdmin")
    assert sorted(permissions_at_scope(Scope.WORKSPACE) - admin) == []
    under_workspace = {
        operation["x-permission"]
        for _, path, operation in _operations()
        if WORKSPACE_CHILD.match(path) and operation["x-permission"] != "none"
    }
    assert sorted(under_workspace - admin) == []
    for role in PREDEFINED_ROLES:
        if role.scope is not Scope.PLATFORM:
            assert role.permissions <= admin, role.name


def test_platform_resources_are_grantable_on_the_platform() -> None:
    for name, operations in _operations_by_permission().items():
        if not any(WORKSPACE_RESOURCE.match(path) for _, path, _ in operations):
            assert Scope.PLATFORM in CATALOG[name].scopes, name


def _content_reads() -> set[str]:
    """Permissions that read workspace content: reads below a workspace that the
    contract never opens to platform callers (no platform, ``workspaces/-`` or
    connector rule in their description)."""
    reads: set[str] = set()
    platform_readable: set[str] = set()
    for name, operations in _operations_by_permission().items():
        for method, path, operation in operations:
            is_read = method == "get" or name.split(".")[1] in {
                "get",
                "list",
                "search",
                "export",
            }
            if not (is_read and WORKSPACE_CHILD.match(path)):
                continue
            reads.add(name)
            if re.search(
                r"platform|workspaces/-|connector", _text(operation), re.IGNORECASE
            ):
                platform_readable.add(name)
    return reads - platform_readable


def test_platform_roles_never_read_workspace_content() -> None:
    content = _content_reads()
    assert {
        "items.get",
        "items.search",
        "messages.get",
        "conversations.get",
        "artifacts.get",
    } <= content
    for role in PLATFORM_ROLES:
        assert sorted(role.permissions & content) == [], role.name


_SELF_SERVICE = re.compile(
    r"^(self\b|owner\b|contributor\b|requester only|lists only the caller's own|"
    r"any (active )?workspace member|held by every workspace member|granted to every|any caller who can see)",
    re.IGNORECASE,
)


def test_self_service_methods_belong_to_workspace_member() -> None:
    member = _role("workspaceMember")
    expected = {
        operation["x-permission"]
        for _, path, operation in _operations()
        if WORKSPACE_CHILD.match(path)
        and _SELF_SERVICE.match(operation.get("x-authorization", ""))
    }
    expected |= {
        operation["x-permission"]
        for _, _, operation in _operations()
        if re.match(
            r"granted to every (authenticated user|member)",
            operation.get("x-authorization", ""),
            re.IGNORECASE,
        )
    }
    assert sorted(expected - member) == []


def test_platform_only_methods_belong_to_both_platform_roles() -> None:
    for _, _, operation in _operations():
        if operation.get("x-authorization", "").startswith("platform roles only"):
            for role in PLATFORM_ROLES:
                assert operation["x-permission"] in role.permissions, (
                    role.name,
                    operation["operationId"],
                )


def test_list_predefined_roles_item_permissions() -> None:
    description = _openapi()["paths"]["/api/v1/roles"]["get"]["description"]
    for role_id, clause in re.findall(
        r"(collection\w+) (?:holds|adds) (.*?)(?:;|\. )", description
    ):
        stated = {name for name in _backticked(clause) if "." in name}
        assert stated, role_id
        assert sorted(stated - _role(role_id)) == [], role_id
    every_member = re.search(
        r"((?:`[\w.]+`(?:, | and )?)+) are also held by every workspace member",
        description,
    )
    assert every_member is not None
    assert set(_backticked(every_member.group(1))) <= _role("workspaceMember")
    assert "items.create" in _role("workspaceAdmin")


# Requests decided by a role are named in the request methods' descriptions
# ("Granted by `roles/spaceLead` and `roles/spaceStaff` on spaces, …"). AnswerRequest
# accepts QUESTION and SERVICE requests only, whose decision resource is a space.
_SPACE_DECISIONS_ONLY = {"requests.answer"}


def test_request_deciders_named_by_the_contract() -> None:
    checked = 0
    for name, operations in _operations_by_permission().items():
        for _, _, operation in operations:
            description = operation.get("description", "")
            match = re.search(r"Granted by (.*?)\.", description)
            if not match or f"`{name}` is checked on" not in description:
                continue
            for role_id in re.findall(r"`roles/(\w+)`", match.group(1)):
                if (
                    name in _SPACE_DECISIONS_ONLY
                    and ROLES[f"roles/{role_id}"].scope is not Scope.SPACE
                ):
                    assert name not in _role(role_id), (role_id, name)
                    continue
                assert name in _role(role_id), (role_id, name)
                checked += 1
    assert checked


_HOLDERS = {
    "viewer": "collectionViewer",
    "editor": "collectionEditor",
    "owner": "collectionOwner",
    "workspace admin": "workspaceAdmin",
    "workspace member": "workspaceMember",
}


def _expand(token: str) -> set[str]:
    collection, _, methods = token.partition(".")
    if methods == "*":
        return {name for name in CATALOG if name.startswith(f"{collection}.")}
    return {f"{collection}.{method}" for method in methods.split("/")}


def test_legacy_mapping_of_item_model() -> None:
    text = (DOCS / "item_model.md").read_text()
    table = text.split("| Legacy code | Permissions | Held by |", 1)[1].split(
        "\n\n", 1
    )[0]
    rows = re.findall(r"^\s*\| `([\w.]+)` \| (.+?) \| (.+?) \|$", table, re.MULTILINE)
    assert rows
    for legacy, permissions, holders in rows:
        expected = set().union(*(_expand(token) for token in _backticked(permissions)))
        assert expected <= CATALOG.keys(), legacy
        for holder in (part.strip() for part in holders.split(",")):
            assert sorted(expected - _role(_HOLDERS[holder])) == [], (legacy, holder)


def test_lookups() -> None:
    assert get_permission("items.get").resource_name == "permissions/items.get"
    assert get_predefined_role("roles/collectionEditor").role_id == "collectionEditor"
    with pytest.raises(KeyError):
        get_permission("items.read")
    with pytest.raises(KeyError):
        get_predefined_role("collectionEditor")
    assert "items.get" in permissions_at_scope(Scope.COLLECTION)
    assert "spaces.get" not in permissions_at_scope(Scope.COLLECTION)
    admin = _role("workspaceAdmin")
    at_collection = conferred_permissions(admin, Scope.COLLECTION)
    assert "items.setIamPolicy" in at_collection
    assert "members.create" not in at_collection
