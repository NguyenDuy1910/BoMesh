"""Resource names of the taxonomy (AIP-122): the one builder and parser per name.

A workspace scheme is ``workspaces/{workspace}/conceptSchemes/{scheme}``; a
platform template is ``conceptSchemes/{scheme}`` (``workspace_id`` None).
Scheme, concept (notation), group and rule IDs follow :data:`CODE_PATTERN`.
"""

from __future__ import annotations

import re
from uuid import UUID

from bomesh.db.models.taxonomy import CODE_PATTERN
from bomesh.errors import InvalidArgument

_CODE = re.compile(CODE_PATTERN)


def is_code(value: str) -> bool:
    return bool(_CODE.match(value))


def scheme_parent(workspace_id: UUID | None) -> str:
    """``workspaces/{workspace}`` or ``""`` (platform templates)."""
    return "" if workspace_id is None else f"workspaces/{workspace_id}"


def scheme_name(workspace_id: UUID | None, code: str) -> str:
    prefix = scheme_parent(workspace_id)
    return f"{prefix}/conceptSchemes/{code}" if prefix else f"conceptSchemes/{code}"


def concept_name(workspace_id: UUID | None, scheme_code: str, notation: str) -> str:
    return f"{scheme_name(workspace_id, scheme_code)}/concepts/{notation}"


def group_name(workspace_id: UUID | None, scheme_code: str, code: str) -> str:
    return f"{scheme_name(workspace_id, scheme_code)}/groups/{code}"


def version_name(workspace_id: UUID | None, scheme_code: str, version: int) -> str:
    return f"{scheme_name(workspace_id, scheme_code)}/versions/{version}"


def rule_name(workspace_id: UUID, code: str) -> str:
    return f"workspaces/{workspace_id}/conceptRules/{code}"


def proposal_name(workspace_id: UUID, proposal_id: UUID) -> str:
    return f"workspaces/{workspace_id}/conceptProposals/{proposal_id}"


def _scheme_parts(name: str, workspace_id: UUID | None) -> list[str] | None:
    """The segments after the scheme's parent, or None when the parent differs."""
    parts = name.split("/")
    if workspace_id is None:
        return parts
    if len(parts) >= 2 and parts[0] == "workspaces" and parts[1] == str(workspace_id):
        return parts[2:]
    return None


def parse_scheme(name: str, workspace_id: UUID | None, *, field: str) -> str:
    """The scheme code of :func:`scheme_name` under this parent; INVALID_ARGUMENT otherwise."""
    parts = _scheme_parts(name, workspace_id)
    if parts is not None and len(parts) == 2 and parts[0] == "conceptSchemes" and is_code(parts[1]):
        return parts[1]
    raise InvalidArgument.for_field(field, f"'{name}' is not a concept scheme name here.")


def parse_template(name: str, *, field: str) -> str:
    """The code of a platform template ``conceptSchemes/{scheme}``."""
    return parse_scheme(name, None, field=field)


def parse_concept(name: str, workspace_id: UUID | None, *, field: str) -> tuple[str, str]:
    """``(scheme_code, notation)`` of :func:`concept_name` under this parent."""
    parts = _scheme_parts(name, workspace_id)
    if (
        parts is not None
        and len(parts) == 4
        and parts[0] == "conceptSchemes"
        and parts[2] == "concepts"
        and is_code(parts[1])
        and is_code(parts[3])
    ):
        return parts[1], parts[3]
    raise InvalidArgument.for_field(field, f"'{name}' is not a concept name here.")


def parse_group(name: str, workspace_id: UUID | None, *, field: str) -> tuple[str, str]:
    """``(scheme_code, group_code)`` of :func:`group_name` under this parent."""
    parts = _scheme_parts(name, workspace_id)
    if (
        parts is not None
        and len(parts) == 4
        and parts[0] == "conceptSchemes"
        and parts[2] == "groups"
        and is_code(parts[1])
        and is_code(parts[3])
    ):
        return parts[1], parts[3]
    raise InvalidArgument.for_field(field, f"'{name}' is not a concept group name here.")


def parse_rule(name: str, workspace_id: UUID, *, field: str) -> str:
    parts = name.split("/")
    if (
        len(parts) == 4
        and parts[0] == "workspaces"
        and parts[1] == str(workspace_id)
        and parts[2] == "conceptRules"
        and is_code(parts[3])
    ):
        return parts[3]
    raise InvalidArgument.for_field(field, f"'{name}' is not a concept rule name here.")


__all__ = [
    "concept_name",
    "group_name",
    "is_code",
    "parse_concept",
    "parse_group",
    "parse_rule",
    "parse_scheme",
    "parse_template",
    "proposal_name",
    "rule_name",
    "scheme_name",
    "scheme_parent",
    "version_name",
]
