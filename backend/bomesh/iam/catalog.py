"""The IAM catalog: every permission and every predefined role.

This module is the authoritative list (``api_design.md`` §1). Each permission
is one ``x-permission`` value of ``openapi.yaml`` (``<collection>.<method>``);
``tests/v1/iam`` keeps the two in step. Role bindings, inheritance and the
ownership rules of ``x-authorization`` live in the authorization service; this
module is pure data.

A grant at scope S confers only the permissions of its role whose ``scopes``
contain S; a workspace grant also reaches every collection and space of the
workspace (``design.dbml``: ``permissions.scope_types``).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class Scope(StrEnum):
    """Where a role is granted. Values are the ``scope_type`` strings of ``design.dbml``."""

    PLATFORM = "platform"
    WORKSPACE = "tenant"
    COLLECTION = "collection"
    SPACE = "space"


@dataclass(frozen=True, slots=True)
class Permission:
    """One ``x-permission`` value: ``name`` is the permission ID, e.g. ``items.get``."""

    name: str
    title: str
    description: str
    scopes: frozenset[Scope]
    custom_roles_supported: bool

    @property
    def resource_name(self) -> str:
        """API resource name, ``permissions/{permission}``."""
        return f"permissions/{self.name}"


@dataclass(frozen=True, slots=True)
class PredefinedRole:
    """A platform-defined role: ``name`` is its resource name, e.g. ``roles/collectionEditor``."""

    name: str
    title: str
    description: str
    scope: Scope
    permissions: frozenset[str]

    @property
    def role_id(self) -> str:
        """The ``{role}`` segment, stored as ``roles.code``."""
        return self.name.removeprefix("roles/")


_P = frozenset({Scope.PLATFORM})
_W = frozenset({Scope.WORKSPACE})
_WP = frozenset({Scope.WORKSPACE, Scope.PLATFORM})
_WC = frozenset({Scope.WORKSPACE, Scope.COLLECTION})
_WS = frozenset({Scope.WORKSPACE, Scope.SPACE})
_WCP = frozenset({Scope.WORKSPACE, Scope.COLLECTION, Scope.PLATFORM})
#: Request deciders: checked on the request's decision resource (space,
#: collection or connector).
_DECISION = frozenset({Scope.WORKSPACE, Scope.COLLECTION, Scope.SPACE, Scope.PLATFORM})


def _permission(
    name: str, title: str, description: str, scopes: frozenset[Scope]
) -> Permission:
    # Custom roles are workspace roles, so a platform-only permission cannot be in one.
    return Permission(
        name, title, description, scopes, custom_roles_supported=scopes != _P
    )


PERMISSIONS: tuple[Permission, ...] = (
    # Identity: accounts (platform).
    _permission(
        "users.get",
        "Get accounts",
        "Read any account; every caller reads their own without it.",
        _P,
    ),
    _permission(
        "users.list", "List accounts", "List every account on the platform.", _P
    ),
    _permission(
        "users.update",
        "Update accounts",
        "Change an account's platform role; callers update their own name and username without it.",
        _P,
    ),
    _permission(
        "users.activate", "Reactivate accounts", "Reactivate a suspended account.", _P
    ),
    _permission(
        "users.suspend",
        "Suspend accounts",
        "Suspend an account and end its sessions.",
        _P,
    ),
    # Workspaces.
    _permission(
        "workspaces.create",
        "Create workspaces",
        "Provision a workspace and its first admin.",
        _P,
    ),
    _permission(
        "workspaces.list",
        "List all workspaces",
        "List every workspace; members list their own without it.",
        _P,
    ),
    _permission(
        "workspaces.get",
        "Get workspaces",
        "Read a workspace (platform callers read it as metadata).",
        _WP,
    ),
    _permission(
        "workspaces.update",
        "Update workspaces",
        "Change a workspace's name and web address.",
        _W,
    ),
    _permission("workspaces.suspend", "Suspend workspaces", "Suspend a workspace.", _P),
    _permission(
        "workspaces.activate",
        "Activate workspaces",
        "Reactivate a suspended or archived workspace.",
        _P,
    ),
    _permission(
        "workspaces.archive", "Archive workspaces", "Archive a workspace.", _WP
    ),
    _permission(
        "workspaces.pauseIngestion",
        "Pause workspace ingestion",
        "Stop every ingestion run and source sync of a workspace from starting.",
        _P,
    ),
    _permission(
        "workspaces.resumeIngestion",
        "Resume workspace ingestion",
        "Let ingestion runs and source syncs of a workspace start again.",
        _P,
    ),
    _permission(
        "workspaces.summarizeUsage",
        "Summarize workspace usage",
        "Read per-workspace usage counts.",
        _P,
    ),
    _permission(
        "workspaces.exportUsage",
        "Export workspace usage",
        "Export per-workspace usage as CSV.",
        _P,
    ),
    _permission(
        "workspaces.getAssistant",
        "Get the assistant configuration",
        "Read the workspace assistant's instructions and starter prompts.",
        _W,
    ),
    _permission(
        "workspaces.updateAssistant",
        "Update the assistant configuration",
        "Change the workspace assistant's instructions and starter prompts.",
        _W,
    ),
    _permission(
        "workspaces.getSettings",
        "Get workspace settings",
        "Read workspace settings and modules.",
        _W,
    ),
    _permission(
        "workspaces.updateSettings",
        "Update workspace settings",
        "Change workspace settings, modules and branding.",
        _W,
    ),
    _permission(
        "workspaces.getOverview",
        "Get the workspace overview",
        "Read the workspace's attention items, KPIs and usage.",
        _W,
    ),
    _permission(
        "workspaces.getIamPolicy",
        "Get the workspace IAM policy",
        "Read the workspace's role bindings.",
        _W,
    ),
    _permission(
        "workspaces.setIamPolicy",
        "Set the workspace IAM policy",
        "Change the workspace's role bindings.",
        _W,
    ),
    _permission(
        "workspaces.testIamPermissions",
        "Test workspace permissions",
        "Check which permissions the caller holds on the workspace.",
        _W,
    ),
    _permission(
        "workspaces.analyzeIamPolicy",
        "Analyze effective access",
        "Read a principal's effective roles on the workspace, its collections and spaces.",
        _W,
    ),
    # Permissions and roles.
    _permission(
        "permissions.get", "Get permissions", "Read a permission of the catalog.", _WP
    ),
    _permission(
        "permissions.list", "List permissions", "List the permission catalog.", _WP
    ),
    _permission("roles.get", "Get roles", "Read a predefined or custom role.", _W),
    _permission("roles.list", "List roles", "List predefined and custom roles.", _W),
    _permission("roles.create", "Create custom roles", "Define a custom role.", _W),
    _permission(
        "roles.update", "Update custom roles", "Change a custom role's permissions.", _W
    ),
    _permission(
        "roles.delete", "Delete custom roles", "Soft-delete a custom role.", _W
    ),
    _permission(
        "roles.undelete", "Restore custom roles", "Restore a deleted custom role.", _W
    ),
    # People.
    _permission(
        "members.create",
        "Add members",
        "Add an account to the workspace with roles, and look accounts up by email.",
        _W,
    ),
    _permission("members.get", "Get members", "Read a workspace member.", _W),
    _permission("members.list", "List members", "List workspace members.", _W),
    _permission("members.delete", "Remove members", "End a workspace membership.", _W),
    _permission(
        "members.suspend", "Suspend members", "Suspend a workspace member.", _W
    ),
    _permission(
        "members.activate",
        "Reactivate members",
        "Reactivate a suspended workspace member.",
        _W,
    ),
    _permission("members.getHome", "Get Home", "Read one's own Home.", _W),
    _permission("groups.create", "Create groups", "Create a group.", _W),
    _permission("groups.get", "Get groups", "Read a group.", _W),
    _permission("groups.list", "List groups", "List groups.", _W),
    _permission(
        "groups.update", "Update groups", "Change a group's name and description.", _W
    ),
    _permission(
        "groups.delete",
        "Delete groups",
        "Delete a group, its memberships and bindings.",
        _W,
    ),
    _permission(
        "memberships.create", "Add group members", "Add a member to a group.", _W
    ),
    _permission(
        "memberships.get", "Get group memberships", "Read a group membership.", _W
    ),
    _permission(
        "memberships.list", "List group memberships", "List the members of a group.", _W
    ),
    _permission(
        "memberships.delete",
        "Remove group members",
        "Remove a member from a group.",
        _W,
    ),
    # Audit and knowledge gaps.
    _permission(
        "auditEvents.get",
        "Get audit events",
        "Read an audit event (platform callers read it without target and description).",
        _WP,
    ),
    _permission(
        "auditEvents.list",
        "List audit events",
        "List audit events (platform callers list them without target and description).",
        _WP,
    ),
    _permission(
        "auditEvents.export", "Export audit events", "Export audit events as CSV.", _WP
    ),
    _permission(
        "auditEvents.summarize",
        "Summarize audit events",
        "Read audit event counts for activity charts.",
        _W,
    ),
    _permission("knowledgeGaps.get", "Get knowledge gaps", "Read a knowledge gap.", _W),
    _permission(
        "knowledgeGaps.list", "List knowledge gaps", "List knowledge gaps.", _W
    ),
    _permission(
        "knowledgeGaps.dismiss",
        "Dismiss knowledge gaps",
        "Dismiss an open knowledge gap.",
        _W,
    ),
    _permission(
        "knowledgeGaps.reopen",
        "Reopen knowledge gaps",
        "Reopen a dismissed or resolved knowledge gap.",
        _W,
    ),
    # Member library (self only).
    _permission(
        "notifications.get", "Get notifications", "Read one's own notifications.", _W
    ),
    _permission(
        "notifications.list", "List notifications", "List one's own notifications.", _W
    ),
    _permission(
        "notifications.update",
        "Update notifications",
        "Mark one's own notification read or unread.",
        _W,
    ),
    _permission(
        "notifications.delete",
        "Dismiss notifications",
        "Dismiss one's own notification.",
        _W,
    ),
    _permission(
        "notifications.undelete",
        "Restore notifications",
        "Restore one's own dismissed notification.",
        _W,
    ),
    _permission(
        "notifications.markRead",
        "Mark notifications read",
        "Mark many of one's own notifications read.",
        _W,
    ),
    _permission(
        "recentItems.get",
        "Get recent items",
        "Read one's own recently viewed items.",
        _W,
    ),
    _permission(
        "recentItems.list",
        "List recent items",
        "List one's own recently viewed items.",
        _W,
    ),
    _permission(
        "recentItems.update",
        "Record views",
        "Record a view of an item one can read.",
        _W,
    ),
    _permission(
        "recentItems.delete",
        "Remove recent items",
        "Remove one of one's own recent items.",
        _W,
    ),
    _permission(
        "recentItems.clear",
        "Clear recent items",
        "Remove all of one's own recent items.",
        _W,
    ),
    _permission(
        "savedItems.create",
        "Save items",
        "Save an item one can read to one's library.",
        _W,
    ),
    _permission("savedItems.get", "Get saved items", "Read one's own saved items.", _W),
    _permission(
        "savedItems.list", "List saved items", "List one's own saved items.", _W
    ),
    _permission(
        "savedItems.delete", "Unsave items", "Remove an item from one's library.", _W
    ),
    _permission(
        "savedSearches.create",
        "Create saved searches",
        "Save a search to one's library.",
        _W,
    ),
    _permission(
        "savedSearches.get", "Get saved searches", "Read one's own saved searches.", _W
    ),
    _permission(
        "savedSearches.list",
        "List saved searches",
        "List one's own saved searches.",
        _W,
    ),
    _permission(
        "savedSearches.update",
        "Update saved searches",
        "Change one's own saved search.",
        _W,
    ),
    _permission(
        "savedSearches.delete",
        "Delete saved searches",
        "Delete one's own saved search.",
        _W,
    ),
    # Knowledge: items.
    _permission(
        "items.create",
        "Create items",
        "Create collections and documents under a collection (on the workspace: root collections).",
        _WC,
    ),
    _permission(
        "items.get",
        "Read items",
        "Read items, document content, passages and revisions.",
        _WC,
    ),
    _permission("items.list", "List items", "List the items the caller can see.", _WC),
    _permission(
        "items.search",
        "Search documents",
        "Search the documents the caller can see.",
        _WC,
    ),
    _permission(
        "items.update",
        "Update items",
        "Change item metadata and see unpublished documents.",
        _WC,
    ),
    _permission(
        "items.move", "Move items", "Move an item under another collection.", _WC
    ),
    _permission(
        "items.publish",
        "Publish documents",
        "Publish, unpublish and roll back documents.",
        _WC,
    ),
    _permission(
        "items.verify", "Verify documents", "Mark a published document verified.", _WC
    ),
    _permission(
        "items.delete",
        "Delete items",
        "Soft-delete items and merge duplicate documents.",
        _WC,
    ),
    _permission(
        "items.undelete", "Restore items", "Restore deleted items and see them.", _WC
    ),
    _permission(
        "items.getIamPolicy",
        "Get collection access",
        "Read a collection's role bindings.",
        _WC,
    ),
    _permission(
        "items.setIamPolicy",
        "Share collections",
        "Change a collection's role bindings.",
        _WC,
    ),
    _permission(
        "items.testIamPermissions",
        "Test item permissions",
        "Check which permissions the caller holds on an item.",
        _WC,
    ),
    _permission(
        "itemLinks.create",
        "Link documents",
        "Link an existing document into a collection.",
        _WC,
    ),
    _permission("itemLinks.get", "Get links", "Read a link in a collection.", _WC),
    _permission("itemLinks.list", "List links", "List the links in a collection.", _WC),
    _permission(
        "itemLinks.delete", "Remove links", "Remove a link from a collection.", _WC
    ),
    # Knowledge: contributions.
    _permission(
        "contributions.create",
        "Contribute documents",
        "Submit one's own document for review.",
        _W,
    ),
    _permission(
        "contributions.get",
        "Get contributions",
        "Read contributions one made or may review.",
        _W,
    ),
    _permission(
        "contributions.list",
        "List contributions",
        "List contributions one made or may review.",
        _W,
    ),
    _permission(
        "contributions.delete",
        "Delete contributions",
        "Delete one's own closed contribution.",
        _W,
    ),
    _permission(
        "contributions.resubmit",
        "Resubmit contributions",
        "Resubmit one's own contribution after changes were requested.",
        _W,
    ),
    _permission(
        "contributions.withdraw",
        "Withdraw contributions",
        "Withdraw one's own contribution.",
        _W,
    ),
    _permission(
        "contributions.review",
        "Review contributions",
        "Approve, reject or request changes to contributions for a collection.",
        _WC,
    ),
    # Knowledge: reading lists and topics.
    _permission(
        "readingLists.create",
        "Create reading lists",
        "Create or duplicate a reading list.",
        _W,
    ),
    _permission(
        "readingLists.get",
        "Get reading lists",
        "Read a visible reading list and its entries.",
        _W,
    ),
    _permission(
        "readingLists.list", "List reading lists", "List visible reading lists.", _W
    ),
    _permission(
        "readingLists.update",
        "Update reading lists",
        "Change a reading list and its entries.",
        _W,
    ),
    _permission(
        "readingLists.delete", "Delete reading lists", "Soft-delete a reading list.", _W
    ),
    _permission(
        "readingLists.undelete",
        "Restore reading lists",
        "Restore a deleted reading list.",
        _W,
    ),
    _permission(
        "readingLists.publish",
        "Publish reading lists",
        "Share a reading list with the whole workspace or set the featured list.",
        _W,
    ),
    _permission(
        "topics.get",
        "Get topics",
        "Read a topic (proposed ones need topics.accept).",
        _W,
    ),
    _permission(
        "topics.list",
        "List topics",
        "List topics (proposed ones need topics.accept).",
        _W,
    ),
    _permission("topics.create", "Create topics", "Create a topic or domain.", _W),
    _permission("topics.update", "Update topics", "Change or merge a topic.", _W),
    _permission("topics.delete", "Delete topics", "Soft-delete an unused topic.", _W),
    _permission("topics.undelete", "Restore topics", "Restore a deleted topic.", _W),
    _permission(
        "topics.accept",
        "Accept topics",
        "Accept a proposed topic and see proposed topics.",
        _W,
    ),
    _permission("topics.reject", "Reject topics", "Reject a proposed topic.", _W),
    # Ingestion.
    _permission(
        "connectors.get",
        "Get connectors",
        "Read a connector (members read active ones only).",
        _WP,
    ),
    _permission(
        "connectors.list",
        "List connectors",
        "List the connector catalog (members see active ones only).",
        _WP,
    ),
    _permission(
        "connectors.update",
        "Update connectors",
        "Change a connector and its OAuth client.",
        _P,
    ),
    _permission(
        "connectors.enable", "Enable connectors", "Enable a disabled connector.", _P
    ),
    _permission("connectors.disable", "Disable connectors", "Disable a connector.", _P),
    _permission(
        "ingestionPolicies.get",
        "Get ingestion policies",
        "Read the platform ingestion policy.",
        _P,
    ),
    _permission(
        "ingestionPolicies.list",
        "List ingestion policies",
        "List the platform ingestion policies.",
        _P,
    ),
    _permission(
        "ingestionPolicies.update",
        "Update ingestion policies",
        "Change the platform ingestion policy.",
        _P,
    ),
    _permission(
        "connections.create",
        "Create workspace connections",
        "Connect a workspace-owned account; personal connections need no permission.",
        _W,
    ),
    _permission(
        "connections.get",
        "Get connections",
        "Read workspace-owned connections; owners read their personal ones.",
        _W,
    ),
    _permission(
        "connections.list",
        "List connections",
        "List workspace-owned connections one may read plus one's personal connections.",
        _W,
    ),
    _permission(
        "connections.update",
        "Update connections",
        "Rename a workspace-owned connection.",
        _W,
    ),
    _permission(
        "connections.delete",
        "Delete connections",
        "Delete a workspace-owned connection.",
        _W,
    ),
    _permission(
        "connections.test",
        "Test connections",
        "Check a workspace-owned connection's credentials.",
        _W,
    ),
    _permission(
        "connections.reauthorize",
        "Reauthorize connections",
        "Restart authorization of a workspace-owned connection.",
        _W,
    ),
    _permission(
        "connections.browseResources",
        "Browse connection resources",
        "Browse what a workspace-owned connection can reach.",
        _W,
    ),
    _permission(
        "sources.create",
        "Create sources",
        "Create a source that syncs into a collection.",
        _W,
    ),
    _permission("sources.get", "Get sources", "Read a source.", _W),
    _permission("sources.list", "List sources", "List sources.", _W),
    _permission(
        "sources.update",
        "Update sources",
        "Change a source's name, configuration and schedule.",
        _W,
    ),
    _permission("sources.delete", "Delete sources", "Delete a source.", _W),
    _permission(
        "sources.pause", "Pause sources", "Pause a source's scheduled syncs.", _W
    ),
    _permission("sources.resume", "Resume sources", "Resume a paused source.", _W),
    _permission("syncs.create", "Sync sources", "Start a manual sync.", _W),
    _permission("syncs.get", "Get syncs", "Read a sync.", _W),
    _permission("syncs.list", "List syncs", "List the sync history.", _W),
    _permission(
        "ingestionRuns.create",
        "Process documents",
        "Start or retry processing for documents of the collections where it is held.",
        _WCP,
    ),
    _permission(
        "ingestionRuns.get",
        "Get ingestion runs",
        "Read an ingestion run (platform callers read it as metadata).",
        _WP,
    ),
    _permission(
        "ingestionRuns.list",
        "List ingestion runs",
        "List ingestion runs (platform callers list them as metadata).",
        _WP,
    ),
    _permission(
        "ingestionRuns.cancel",
        "Cancel ingestion runs",
        "Cancel a queued or running ingestion run.",
        _W,
    ),
    _permission(
        "ingestionRuns.summarize",
        "Summarize ingestion health",
        "Read queue, throughput and failure counts.",
        _WP,
    ),
    _permission(
        "tasks.get",
        "Get ingestion tasks",
        "Read the ingestion task of a visible document (platform callers read it as metadata).",
        _WCP,
    ),
    _permission(
        "tasks.list",
        "List ingestion tasks",
        "List the ingestion tasks of visible documents (platform callers list them as metadata).",
        _WCP,
    ),
    # Assistant (owner-private).
    _permission(
        "conversations.create",
        "Create conversations",
        "Start a conversation one owns.",
        _W,
    ),
    _permission(
        "conversations.get", "Get conversations", "Read one's own conversations.", _W
    ),
    _permission(
        "conversations.list", "List conversations", "List one's own conversations.", _W
    ),
    _permission(
        "conversations.update",
        "Update conversations",
        "Rename, pin or rescope one's own conversation.",
        _W,
    ),
    _permission(
        "conversations.delete",
        "Delete conversations",
        "Soft-delete one's own conversation.",
        _W,
    ),
    _permission(
        "conversations.undelete",
        "Restore conversations",
        "Restore one's own deleted conversation.",
        _W,
    ),
    _permission(
        "conversations.converse", "Chat", "Send a turn in one's own conversation.", _W
    ),
    _permission(
        "messages.get", "Get messages", "Read a message of one's own conversation.", _W
    ),
    _permission(
        "messages.list",
        "List messages",
        "List the messages of one's own conversation.",
        _W,
    ),
    _permission(
        "messages.submitFeedback",
        "Rate answers",
        "Rate an assistant message of one's own conversation.",
        _W,
    ),
    _permission(
        "shares.create", "Share conversations", "Share one's own conversation.", _W
    ),
    _permission(
        "shares.get",
        "Read shared conversations",
        "Read a conversation shared with one.",
        _W,
    ),
    _permission(
        "shares.list", "List shares", "List the shares of one's own conversation.", _W
    ),
    _permission(
        "shares.delete",
        "Revoke shares",
        "Revoke a share of one's own conversation.",
        _W,
    ),
    _permission(
        "artifacts.create", "Create artifacts", "Generate an artifact one owns.", _W
    ),
    _permission(
        "artifacts.get",
        "Get artifacts",
        "Read one's own or one's spaces' artifacts.",
        _W,
    ),
    _permission(
        "artifacts.list",
        "List artifacts",
        "List one's own or one's spaces' artifacts.",
        _W,
    ),
    _permission(
        "artifacts.update", "Update artifacts", "Change one's own artifact.", _W
    ),
    _permission(
        "artifacts.delete", "Delete artifacts", "Soft-delete one's own artifact.", _W
    ),
    _permission(
        "artifacts.undelete",
        "Restore artifacts",
        "Restore one's own deleted artifact.",
        _W,
    ),
    _permission(
        "artifacts.revise",
        "Revise artifacts",
        "Ask the assistant to revise one's own artifact.",
        _W,
    ),
    _permission(
        "artifacts.commit",
        "Edit artifacts",
        "Save an edit of one's own artifact as a revision.",
        _W,
    ),
    _permission(
        "artifacts.export",
        "Export artifacts",
        "Download a readable artifact in another format.",
        _W,
    ),
    _permission(
        "artifacts.publish",
        "Publish artifacts",
        "Publish one's own artifact as a document (also needs items.create there).",
        _W,
    ),
    _permission(
        "artifactRevisions.get",
        "Get artifact revisions",
        "Read a revision of one's own artifact.",
        _W,
    ),
    _permission(
        "artifactRevisions.list",
        "List artifact revisions",
        "List the revisions of one's own artifact.",
        _W,
    ),
    _permission(
        "artifactRevisions.delete",
        "Delete artifact revisions",
        "Delete one's newest edit of one's own artifact.",
        _W,
    ),
    _permission(
        "artifactRevisions.rollback",
        "Roll back artifacts",
        "Roll one's own artifact back to a revision.",
        _W,
    ),
    # Collaboration: spaces.
    _permission("spaces.create", "Create spaces", "Create a space and lead it.", _W),
    _permission("spaces.get", "Get spaces", "Read a space.", _WS),
    _permission("spaces.list", "List spaces", "List spaces.", _W),
    _permission("spaces.update", "Update spaces", "Change a space.", _WS),
    _permission("spaces.delete", "Delete spaces", "Soft-delete a space.", _WS),
    _permission("spaces.undelete", "Restore spaces", "Restore a deleted space.", _WS),
    _permission("spaces.join", "Join spaces", "Join an open space.", _W),
    _permission("spaces.leave", "Leave spaces", "Leave a space one belongs to.", _WS),
    _permission(
        "spaces.getIamPolicy", "Get space roles", "Read a space's role bindings.", _WS
    ),
    _permission(
        "spaces.setIamPolicy", "Set space roles", "Change a space's role bindings.", _WS
    ),
    _permission(
        "spaces.testIamPermissions",
        "Test space permissions",
        "Check which permissions the caller holds on a space.",
        _WS,
    ),
    _permission(
        "spaceMembers.create",
        "Add space members",
        "Add a workspace member to a space.",
        _WS,
    ),
    _permission("spaceMembers.get", "Get space members", "Read a space member.", _WS),
    _permission("spaceMembers.list", "List space members", "List space members.", _WS),
    _permission(
        "spaceMembers.delete",
        "Remove space members",
        "Remove a person from a space.",
        _WS,
    ),
    _permission(
        "announcements.create",
        "Post announcements",
        "Post an announcement in a space.",
        _WS,
    ),
    _permission(
        "announcements.get", "Get announcements", "Read a space announcement.", _WS
    ),
    _permission(
        "announcements.list", "List announcements", "List space announcements.", _WS
    ),
    _permission(
        "announcements.update",
        "Update announcements",
        "Change a space announcement.",
        _WS,
    ),
    _permission(
        "announcements.delete",
        "Delete announcements",
        "Delete a space announcement.",
        _WS,
    ),
    _permission(
        "events.create", "Create space events", "Schedule an event in a space.", _WS
    ),
    _permission("events.get", "Get space events", "Read a space event.", _WS),
    _permission("events.list", "List space events", "List space events.", _WS),
    _permission("events.update", "Update space events", "Change a space event.", _WS),
    _permission("events.delete", "Delete space events", "Delete a space event.", _WS),
    _permission(
        "materials.create", "Pin materials", "Pin a readable document to a space.", _WS
    ),
    _permission("materials.get", "Get materials", "Read a space material.", _WS),
    _permission("materials.list", "List materials", "List space materials.", _WS),
    _permission(
        "materials.delete", "Remove materials", "Remove a space material.", _WS
    ),
    _permission(
        "requestTypes.create",
        "Create request types",
        "Define a request type of a space.",
        _WS,
    ),
    _permission("requestTypes.get", "Get request types", "Read a request type.", _WS),
    _permission(
        "requestTypes.list", "List request types", "List a space's request types.", _WS
    ),
    _permission(
        "requestTypes.update", "Update request types", "Change a request type.", _WS
    ),
    _permission(
        "requestTypes.delete",
        "Delete request types",
        "Soft-delete a request type.",
        _WS,
    ),
    _permission(
        "requestTypes.undelete",
        "Restore request types",
        "Restore a deleted request type.",
        _WS,
    ),
    # Collaboration: requests.
    _permission("requests.create", "File requests", "File a request.", _W),
    _permission(
        "requests.list",
        "List requests",
        "List requests one filed or may decide.",
        _W,
    ),
    _permission(
        "requests.withdraw",
        "Withdraw requests",
        "Withdraw one's own request.",
        _W,
    ),
    _permission(
        "requests.get",
        "Get requests",
        "Read requests and internal messages of a decision resource.",
        _DECISION,
    ),
    _permission(
        "requests.update",
        "Assign requests",
        "Assign and edit requests of a decision resource.",
        _DECISION,
    ),
    _permission(
        "requests.approve",
        "Approve requests",
        "Approve requests of a decision resource, granting what they ask.",
        _DECISION,
    ),
    _permission(
        "requests.deny",
        "Deny requests",
        "Deny requests of a decision resource.",
        _DECISION,
    ),
    _permission(
        "requests.sendBack",
        "Send requests back",
        "Ask a requester for more information.",
        _DECISION,
    ),
    _permission(
        "requests.close",
        "Close requests",
        "Close requests of a decision resource.",
        _DECISION,
    ),
    _permission(
        "requests.answer",
        "Answer requests",
        "Answer the questions and service requests of a space.",
        _WS,
    ),
    _permission(
        "requestMessages.create",
        "Post request messages",
        "Post on requests of a decision resource; requesters post on their own without it.",
        _DECISION,
    ),
    _permission(
        "requestMessages.get",
        "Get request messages",
        "Read messages of requests of a decision resource; requesters read their own without it.",
        _DECISION,
    ),
    _permission(
        "requestMessages.list",
        "List request messages",
        "List messages of requests of a decision resource; requesters list their own without it.",
        _DECISION,
    ),
    # Operations (platform).
    _permission(
        "components.get", "Get components", "Read a platform component's health.", _P
    ),
    _permission(
        "components.list",
        "List components",
        "List platform components and their health.",
        _P,
    ),
    _permission("incidents.get", "Get incidents", "Read a platform incident.", _P),
    _permission("incidents.list", "List incidents", "List platform incidents.", _P),
)

PERMISSIONS_BY_NAME: dict[str, Permission] = {
    permission.name: permission for permission in PERMISSIONS
}


def _workspace_permissions() -> frozenset[str]:
    return frozenset(p.name for p in PERMISSIONS if Scope.WORKSPACE in p.scopes)


# Collection roles, nested viewer ⊆ editor ⊆ owner (ListPredefinedRoles;
# item_model.md §8).
_COLLECTION_VIEWER = frozenset(
    {
        "items.get",
        "items.list",
        "items.search",
        "items.testIamPermissions",
        "itemLinks.get",
        "itemLinks.list",
        "tasks.get",
        "tasks.list",
    }
)
_COLLECTION_EDITOR = _COLLECTION_VIEWER | {
    "items.create",
    "items.update",
    "items.move",
    "items.publish",
    "items.verify",
    "itemLinks.create",
    "itemLinks.delete",
    "ingestionRuns.create",
}
#: Deciders of requests whose decision resource is a collection or connector.
_REQUEST_DECIDER = frozenset(
    {
        "requests.get",
        "requests.update",
        "requests.approve",
        "requests.deny",
        "requests.sendBack",
        "requests.close",
        "requestMessages.create",
        "requestMessages.get",
        "requestMessages.list",
    }
)
_COLLECTION_OWNER = (
    _COLLECTION_EDITOR
    | {
        "items.delete",
        "items.undelete",
        "items.getIamPolicy",
        "items.setIamPolicy",
        "contributions.review",
    }
    | _REQUEST_DECIDER
)

# Space roles, nested member ⊆ staff ⊆ lead: take part / work the queue and
# post / manage the space.
_SPACE_MEMBER = frozenset(
    {
        "spaces.get",
        "spaces.leave",
        "spaces.testIamPermissions",
        "spaceMembers.get",
        "spaceMembers.list",
        "announcements.get",
        "announcements.list",
        "events.get",
        "events.list",
        "materials.get",
        "materials.list",
        "requestTypes.get",
        "requestTypes.list",
    }
)
_SPACE_STAFF = (
    _SPACE_MEMBER
    | {
        "announcements.create",
        "announcements.update",
        "announcements.delete",
        "events.create",
        "events.update",
        "events.delete",
        "materials.create",
        "materials.delete",
        "requests.answer",
    }
    | _REQUEST_DECIDER
)
_SPACE_LEAD = _SPACE_STAFF | {
    "spaces.update",
    "spaces.delete",
    "spaces.undelete",
    "spaces.getIamPolicy",
    "spaces.setIamPolicy",
    "spaceMembers.create",
    "spaceMembers.delete",
    "requestTypes.create",
    "requestTypes.update",
    "requestTypes.delete",
    "requestTypes.undelete",
}

#: What every active member needs. Self-only and owner-only methods are here;
#: their ``x-authorization`` rule narrows them to the caller's own resources.
_WORKSPACE_MEMBER = frozenset(
    {
        "workspaces.get",
        "workspaces.getAssistant",
        "workspaces.getSettings",
        "workspaces.testIamPermissions",
        "permissions.get",
        "permissions.list",
        "roles.get",
        "roles.list",
        "members.get",
        "members.list",
        "members.getHome",
        "groups.get",
        "groups.list",
        # Knowledge: list/search apply the visibility rule (items.get comes from
        # collection grants, e.g. collectionViewer for workspaceMembers).
        "items.list",
        "items.search",
        "items.testIamPermissions",
        "contributions.create",
        "contributions.get",
        "contributions.list",
        "contributions.delete",
        "contributions.resubmit",
        "contributions.withdraw",
        "topics.get",
        "topics.list",
        "readingLists.create",
        "readingLists.get",
        "readingLists.list",
        "readingLists.update",
        "readingLists.delete",
        "readingLists.undelete",
        # Library.
        "notifications.get",
        "notifications.list",
        "notifications.update",
        "notifications.delete",
        "notifications.undelete",
        "notifications.markRead",
        "recentItems.get",
        "recentItems.list",
        "recentItems.update",
        "recentItems.delete",
        "recentItems.clear",
        "savedItems.create",
        "savedItems.get",
        "savedItems.list",
        "savedItems.delete",
        "savedSearches.create",
        "savedSearches.get",
        "savedSearches.list",
        "savedSearches.update",
        "savedSearches.delete",
        # Ingestion catalog and personal connections.
        "connectors.get",
        "connectors.list",
        "connections.list",
        # Assistant.
        "conversations.create",
        "conversations.get",
        "conversations.list",
        "conversations.update",
        "conversations.delete",
        "conversations.undelete",
        "conversations.converse",
        "messages.get",
        "messages.list",
        "messages.submitFeedback",
        "shares.create",
        "shares.get",
        "shares.list",
        "shares.delete",
        "artifacts.create",
        "artifacts.get",
        "artifacts.list",
        "artifacts.update",
        "artifacts.delete",
        "artifacts.undelete",
        "artifacts.revise",
        "artifacts.commit",
        "artifacts.export",
        "artifacts.publish",
        "artifactRevisions.get",
        "artifactRevisions.list",
        "artifactRevisions.delete",
        "artifactRevisions.rollback",
        # Spaces and requests.
        "spaces.get",
        "spaces.list",
        "spaces.join",
        "spaces.leave",
        "spaces.testIamPermissions",
        "requestTypes.get",
        "requestTypes.list",
        "requests.create",
        "requests.list",
        "requests.withdraw",
    }
)

#: Platform console: metadata across workspaces, never workspace content.
_PLATFORM_OPERATOR = frozenset(
    {
        "permissions.get",
        "permissions.list",
        "users.get",
        "users.list",
        "workspaces.get",
        "workspaces.list",
        "workspaces.pauseIngestion",
        "workspaces.resumeIngestion",
        "workspaces.summarizeUsage",
        "workspaces.exportUsage",
        "auditEvents.get",
        "auditEvents.list",
        "auditEvents.export",
        "connectors.get",
        "connectors.list",
        "ingestionPolicies.get",
        "ingestionPolicies.list",
        "ingestionRuns.create",
        "ingestionRuns.get",
        "ingestionRuns.list",
        "ingestionRuns.summarize",
        "tasks.get",
        "tasks.list",
        "components.get",
        "components.list",
        "incidents.get",
        "incidents.list",
    }
)
_PLATFORM_ADMIN = (
    _PLATFORM_OPERATOR
    | {
        "users.update",
        "users.activate",
        "users.suspend",
        "workspaces.create",
        "workspaces.suspend",
        "workspaces.activate",
        "workspaces.archive",
        "connectors.update",
        "connectors.enable",
        "connectors.disable",
        "ingestionPolicies.update",
    }
    # Deciders of CONNECTOR requests.
    | _REQUEST_DECIDER
)

PREDEFINED_ROLES: tuple[PredefinedRole, ...] = (
    PredefinedRole(
        "roles/workspaceAdmin",
        "Workspace Admin",
        "Everything in a workspace: knowledge, taxonomy, sources, settings and people.",
        Scope.WORKSPACE,
        _workspace_permissions(),
    ),
    PredefinedRole(
        "roles/workspaceMember",
        "Workspace Member",
        "Read the knowledge readable to them, contribute, chat, use their library, spaces and requests.",
        Scope.WORKSPACE,
        _WORKSPACE_MEMBER,
    ),
    PredefinedRole(
        "roles/collectionOwner",
        "Collection Owner",
        "Read, edit, move, publish, verify, delete and share items, review contributions and decide access requests.",
        Scope.COLLECTION,
        _COLLECTION_OWNER,
    ),
    PredefinedRole(
        "roles/collectionEditor",
        "Collection Editor",
        "Read, add, edit, move and publish items, link documents and start processing.",
        Scope.COLLECTION,
        _COLLECTION_EDITOR,
    ),
    PredefinedRole(
        "roles/collectionViewer",
        "Collection Viewer",
        "Read the published documents of a collection.",
        Scope.COLLECTION,
        _COLLECTION_VIEWER,
    ),
    PredefinedRole(
        "roles/spaceLead",
        "Space Lead",
        "Manage a space: its settings, members, roles and request types.",
        Scope.SPACE,
        _SPACE_LEAD,
    ),
    PredefinedRole(
        "roles/spaceStaff",
        "Space Staff",
        "Work a space's request queue and post announcements, events and materials.",
        Scope.SPACE,
        _SPACE_STAFF,
    ),
    PredefinedRole(
        "roles/spaceMember",
        "Space Member",
        "Take part in a space: read its members, announcements, events and materials.",
        Scope.SPACE,
        _SPACE_MEMBER,
    ),
    PredefinedRole(
        "roles/platformAdmin",
        "Platform Admin",
        "Platform console: accounts, workspaces, connectors, ingestion policy and health; "
        "connector requests. Never workspace content.",
        Scope.PLATFORM,
        _PLATFORM_ADMIN,
    ),
    PredefinedRole(
        "roles/platformOperator",
        "Platform Operator",
        "Platform health: ingestion runs, components, incidents, usage and audit metadata. "
        "Never workspace content.",
        Scope.PLATFORM,
        _PLATFORM_OPERATOR,
    ),
)

PREDEFINED_ROLES_BY_NAME: dict[str, PredefinedRole] = {
    role.name: role for role in PREDEFINED_ROLES
}


def get_permission(name: str) -> Permission:
    """The permission with ID ``name`` (``items.get``); ``KeyError`` if unknown."""
    return PERMISSIONS_BY_NAME[name]


def get_predefined_role(name: str) -> PredefinedRole:
    """The predefined role named ``name`` (``roles/collectionEditor``); ``KeyError`` if unknown."""
    return PREDEFINED_ROLES_BY_NAME[name]


def permissions_at_scope(scope: Scope) -> frozenset[str]:
    """Every permission a grant at ``scope`` can confer."""
    return frozenset(p.name for p in PERMISSIONS if scope in p.scopes)


def conferred_permissions(permissions: frozenset[str], scope: Scope) -> frozenset[str]:
    """The part of a role's ``permissions`` that a grant at ``scope`` confers."""
    return frozenset(
        name for name in permissions if scope in PERMISSIONS_BY_NAME[name].scopes
    )
