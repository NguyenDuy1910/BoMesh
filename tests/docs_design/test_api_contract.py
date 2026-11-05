"""Design rules of the canonical API contract (backend/docs_design/openapi.yaml).

These checks enforce the API design rules in AGENTS.md and api_design.md §1
(Google AIP subset) and the Item-model invariants in item_model.md, so a
contract edit that breaks them fails before any code is written against it.
"""

from __future__ import annotations

import re
from functools import cache
from pathlib import Path
from typing import Any

import jsonschema
import pytest
import yaml

DESIGN = Path(__file__).resolve().parents[2] / "backend" / "docs_design"
METHODS = ("get", "post", "put", "patch", "delete")
TAGS = {"Identity", "Workspaces", "Library", "Knowledge", "Ingestion", "Assistant", "Collaboration", "Operations"}
STANDARD = ("Get", "List", "Create", "Update", "Delete")
IAM = re.compile(r"^(Get[A-Za-z]*IamPolicy|Set[A-Za-z]*IamPolicy|Test[A-Za-z]*IamPermissions)$")
CAMEL = re.compile(r"^[a-z][a-zA-Z0-9]*$")
SINGLETONS = ("content", "home", "settings", "assistant", "overview", "preferences")


@cache
def contract() -> dict[str, Any]:
    return yaml.safe_load((DESIGN / "openapi.yaml").read_text())


def resolve(ref: str) -> Any:
    node: Any = contract()
    for part in ref.removeprefix("#/").split("/"):
        node = node[part]
    return node


def unref(node: Any) -> Any:
    while isinstance(node, dict) and "$ref" in node:
        node = resolve(node["$ref"])
    return node


def properties(schema: Any) -> dict[str, Any]:
    schema = unref(schema)
    props = dict(schema.get("properties") or {})
    for part in schema.get("allOf") or []:
        props.update(properties(part))
    return props


def operations() -> list[tuple[str, str, dict[str, Any], dict[str, Any]]]:
    return [
        (path, method, op, item)
        for path, item in contract()["paths"].items()
        for method, op in item.items()
        if method in METHODS
    ]


def refs(node: Any) -> list[str]:
    found: list[str] = []
    stack = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if isinstance(current.get("$ref"), str):
                found.append(current["$ref"])
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return found


def test_document_is_openapi_31_with_resolvable_refs_and_valid_schemas() -> None:
    doc = contract()
    assert doc["openapi"].startswith("3.1")
    missing = [ref for ref in set(refs(doc)) if not _resolves(ref)]
    assert not missing, missing
    for schema in doc["components"]["schemas"].values():
        jsonschema.Draft202012Validator.check_schema(schema)


def _resolves(ref: str) -> bool:
    try:
        resolve(ref)
    except (KeyError, TypeError):
        return False
    return True


def test_every_component_is_used() -> None:
    doc = contract()
    used: set[str] = set()
    pending: list[Any] = [doc["paths"]]
    while pending:
        node = pending.pop()
        for ref in refs(node):
            if ref not in used:
                used.add(ref)
                pending.append(resolve(ref))
    unused = [
        f"{kind}.{key}"
        for kind in ("schemas", "parameters", "responses")
        for key in doc["components"].get(kind, {})
        if f"#/components/{kind}/{key}" not in used
    ]
    assert not unused, unused


def test_paths_are_resource_names() -> None:
    problems = []
    for path in contract()["paths"]:
        if not path.startswith(("/api/v1/", "/upload/api/v1/")):
            problems.append(f"{path}: outside /api/v1")
            continue
        segments = path.split("/api/v1/", 1)[1].split("/")
        for index, segment in enumerate(segments):
            literal, _, verb = segment.partition(":")
            if verb and (index != len(segments) - 1 or not CAMEL.match(verb)):
                problems.append(f"{path}: custom verb must be a camelCase last segment")
            if literal.startswith("{"):
                if not re.match(r"^\{[a-z][a-zA-Z0-9]*\}$", literal):
                    problems.append(f"{path}: bad path parameter {literal}")
            elif literal and not CAMEL.match(literal):
                problems.append(f"{path}: segment '{literal}' must be lowerCamelCase")
        collections = [s.partition(":")[0] for s in segments if s and not s.startswith("{")]
        if len(set(collections)) != len(collections):
            problems.append(f"{path}: collection identifier repeated")
    assert not problems, problems


def test_operations_follow_standard_and_custom_method_rules() -> None:
    problems: list[str] = []
    seen: dict[str, str] = {}
    for path, method, op, item in operations():
        label = f"{method.upper()} {path}"
        oid = op.get("operationId", "")
        if not re.match(r"^[A-Z][A-Za-z0-9]*$", oid) or oid in seen:
            problems.append(f"{label}: operationId '{oid}' missing, not UpperCamelCase or duplicated")
        seen[oid] = label
        if method == "put":
            problems.append(f"{label}: PUT is not allowed (AIP-134)")
            continue
        if not op.get("summary") or not op.get("tags") or set(op["tags"]) - TAGS:
            problems.append(f"{label}: needs a summary and an interface tag from {sorted(TAGS)}")
        params = [unref(p) for p in (item.get("parameters") or []) + (op.get("parameters") or [])]
        declared = {p["name"] for p in params if p.get("in") == "path"}
        if declared != set(re.findall(r"{([^}]+)}", path)):
            problems.append(f"{label}: path parameters do not match the template")
        query = {p["name"] for p in params if p.get("in") == "query"}
        problems += [f"{label}: query parameter '{q}' must be lowerCamelCase" for q in query if q != "alt" and not CAMEL.match(q)]
        segments = path.split("/api/v1/", 1)[1].split("/")
        if ":" in segments[-1]:
            if method not in ("get", "post"):
                problems.append(f"{label}: custom methods use GET or POST (AIP-136)")
            if oid.startswith(STANDARD) and not IAM.match(oid):
                problems.append(f"{label}: custom method must not use a standard verb")
            continue
        last = segments[-1]
        expected = {
            "get": "Get" if last.startswith("{") or last in SINGLETONS else "List",
            "post": "Create",
            "patch": "Update",
            "delete": "Delete",
        }[method]
        if not oid.startswith(expected):
            problems.append(f"{label}: standard method must be named {expected}…")
        if method == "patch" and "updateMask" not in query:
            problems.append(f"{label}: Update must accept updateMask (AIP-134)")
        if expected == "List":
            ok = unref((op.get("responses") or {}).get("200") or {})
            schema = ((ok.get("content") or {}).get("application/json") or {}).get("schema") or {}
            if not {"pageSize", "pageToken"} <= query or "nextPageToken" not in properties(schema):
                problems.append(f"{label}: List must paginate with pageSize/pageToken/nextPageToken (AIP-158)")
    assert not problems, problems


def test_every_protected_method_declares_permission_and_errors() -> None:
    problems = []
    for path, method, op, _ in operations():
        label = f"{method.upper()} {path}"
        if op.get("security") == []:
            continue
        if not {"401", "403"} <= set(op.get("responses") or {}):
            problems.append(f"{label}: must document 401 and 403")
        permission = op.get("x-permission")
        if permission == "none":
            if not op.get("x-authorization"):
                problems.append(f"{label}: x-permission none needs x-authorization")
        elif not (permission and re.match(r"^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$", permission)):
            problems.append(f"{label}: x-permission must be '<collection>.<method>'")
        ok = unref((op.get("responses") or {}).get("200") or {})
        schema = ((ok.get("content") or {}).get("application/json") or {}).get("schema") or {}
        if schema.get("$ref", "").endswith("/Operation") and not path.startswith("/api/v1/operations"):
            info = op.get("x-operation-info") or {}
            if not (isinstance(info.get("response"), dict) and isinstance(info.get("metadata"), dict)):
                problems.append(f"{label}: Operation results need x-operation-info (AIP-151)")
    assert not problems, problems


def test_schemas_use_the_proto3_json_mapping() -> None:
    problems: list[str] = []

    def walk(node: Any, where: str) -> None:
        if isinstance(node, dict):
            problems.extend(
                f"{where}: property '{prop}' must be lowerCamelCase"
                for prop in node.get("properties") or {}
                if prop != "@type" and not CAMEL.match(prop)
            )
            if node.get("type") == "string" and "enum" in node:
                problems.extend(
                    f"{where}: enum value '{value}' must be UPPER_SNAKE"
                    for value in node["enum"]
                    if not re.match(r"^[A-Z][A-Z0-9_]*$", str(value))
                )
            if node.get("format") == "int64" and node.get("type") != "string":
                problems.append(f"{where}: int64 must be a JSON string")
            for key, value in node.items():
                walk(value, f"{where}.{key}")
        elif isinstance(node, list):
            for value in node:
                walk(value, where)

    for name, schema in contract()["components"]["schemas"].items():
        if not re.match(r"^[A-Z][A-Za-z0-9]*$", name):
            problems.append(f"schema {name}: must be UpperCamelCase")
        walk(schema, f"schema {name}")
        props = properties(schema)
        if "state" in props and not (props["state"].get("readOnly") or unref(props["state"]).get("readOnly")):
            problems.append(f"schema {name}: state must be readOnly (AIP-216)")
        if name not in ("Error", "Status", "ErrorDetail", "Operation"):
            problems.extend(
                f"schema {name}: field '{bad}' — use name, *Uri or state"
                for bad in ("id", "url", "status")
                if bad in props
            )
    assert not problems, problems


def test_knowledge_is_one_item_resource() -> None:
    paths = list(contract()["paths"])
    for legacy in ("/documents", "/knowledgeBases", "/collections"):
        assert not any(legacy in path for path in paths), legacy
    item_ops = [
        op
        for path, _, op, _ in operations()
        if "/items" in path and "/links" not in path and "/readingLists/" not in path
    ]
    assert item_ops
    assert all(op["x-permission"].startswith("items.") for op in item_ops)


@pytest.mark.parametrize(
    ("item", "valid"),
    [
        ({"itemType": "COLLECTION", "displayName": "Database", "collection": {"description": "x"}}, True),
        ({"itemType": "DOCUMENT", "displayName": "PG", "parentItem": "workspaces/w/items/1", "document": {"fileName": "pg.pdf"}}, True),
        ({"displayName": "renamed"}, True),
        ({"itemType": "COLLECTION", "displayName": "x", "document": {"fileName": "a"}}, False),
        ({"itemType": "DOCUMENT", "displayName": "x", "collection": {"description": "a"}}, False),
        ({"itemType": "FOLDER", "displayName": "x"}, False),
    ],
)
def test_item_carries_exactly_the_facet_of_its_type(item: dict[str, Any], valid: bool) -> None:
    validator = jsonschema.Draft202012Validator(
        {"$ref": "#/components/schemas/Item", "components": contract()["components"]}
    )
    assert validator.is_valid(item) is valid


def test_item_links_target_documents_and_never_start_ingestion_on_approval() -> None:
    schemas = contract()["components"]["schemas"]
    assert "DOCUMENT" in schemas["ItemLink"]["properties"]["targetItem"]["description"]
    approve = contract()["paths"]["/api/v1/workspaces/{workspace}/contributions/{contribution}:approve"]["post"]
    assert "never starts an ingestion run" in approve["description"].lower()
    assert "APPROVAL" not in schemas["IngestionRun"]["properties"]["trigger"]["enum"]


def test_document_states_match_the_schema_design() -> None:
    dbml = (DESIGN / "design.dbml").read_text()
    schemas = contract()["components"]["schemas"]

    def values(column: str) -> set[str]:
        block = re.search(r"Table items \{(.*?)\n\}", dbml, re.S).group(1)
        line = next(row for row in block.splitlines() if row.strip().startswith(column + " "))
        note = re.search(r"note: '([^']*)'", line).group(1)
        run = re.search(r"[a-z_]+(?:\s*\|\s*[a-z_]+)+", note).group(0)
        return {v.strip() for v in run.split("|")}

    content = {"pending": "PENDING", "ready": "AVAILABLE", "failed": "FAILED"}
    assert {content[v] for v in values("status")} == set(schemas["ContentState"]["enum"])
    assert {v.upper() for v in values("publication_state")} == set(schemas["PublicationState"]["enum"])
    assert {v.upper() for v in values("item_type")} == set(schemas["ItemType"]["enum"])
