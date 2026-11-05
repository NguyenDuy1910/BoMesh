"""Identity and access management for the API.

- :mod:`bomesh.iam.catalog`: every permission and predefined role (pure data).
- :mod:`bomesh.iam.sync`: writes the catalog into PostgreSQL.
- :mod:`bomesh.iam.authorizer`: :class:`Principal`, resource references and the
  request-scoped :class:`Authorizer` (effective permissions, AIP-211 checks).
- :mod:`bomesh.iam.visibility`: the Item visibility rule.
- :mod:`bomesh.iam.policy`: IAM policies on workspaces, collections and spaces.
"""

from bomesh.iam.authorizer import (
    Authorizer,
    ItemRef,
    PlatformRef,
    Principal,
    Resource,
    SpaceRef,
    WorkspaceAccess,
    WorkspaceRef,
)
from bomesh.iam.catalog import (
    PERMISSIONS,
    PERMISSIONS_BY_NAME,
    PREDEFINED_ROLES,
    PREDEFINED_ROLES_BY_NAME,
    Permission,
    PredefinedRole,
    Scope,
    conferred_permissions,
    get_permission,
    get_predefined_role,
    permissions_at_scope,
)

__all__ = [
    "PERMISSIONS",
    "PERMISSIONS_BY_NAME",
    "PREDEFINED_ROLES",
    "PREDEFINED_ROLES_BY_NAME",
    "Authorizer",
    "ItemRef",
    "Permission",
    "PlatformRef",
    "PredefinedRole",
    "Principal",
    "Resource",
    "Scope",
    "SpaceRef",
    "WorkspaceAccess",
    "WorkspaceRef",
    "conferred_permissions",
    "get_permission",
    "get_predefined_role",
    "permissions_at_scope",
]
