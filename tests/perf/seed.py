"""Bulk seeding of a large, realistic workspace for the performance harness.

Everything is written with SQLAlchemy Core ``INSERT ... VALUES`` batches on one
connection (no API, no ORM unit of work), so 5,000 documents and a 5,000-item
ingestion run seed in seconds. The schema's triggers and CHECKs still run, so
the dataset is valid by construction.

``seed(engine, Scale())`` returns a :class:`Dataset` of the identifiers the load
harness resolves path parameters from; ``Dataset.to_json`` lets a later run
reuse a seeded database without seeding again.
"""

from __future__ import annotations

import json
import random
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Table, insert, select, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from bomesh.db.models import Base
from bomesh.services import ARTIFACT_COLLECTION_KIND
from bomesh.services.knowledge_items.item_store import (
    ARTIFACT_COLLECTION_TITLE,
    artifact_collection_id,
    revision_object_key,
)

PERSONAL_KIND = "personal_uploads"
_BATCH = 1000


@dataclass(frozen=True, slots=True)
class Scale:
    """Row counts of one seeded workspace (defaults: the full perf dataset)."""

    roots: int = 20
    children_per_root: int = 3
    grandchildren_per_child: int = 2
    documents: int = 5000
    domains: int = 8
    topics_per_domain: int = 7
    members: int = 150
    groups: int = 12
    runs: int = 20
    big_run_items: int = 5000
    connections: int = 4
    sources_per_connection: int = 3
    spaces: int = 8
    conversations: int = 120
    messages_per_conversation: int = 12
    requests: int = 120
    notifications: int = 400
    audit_events: int = 3000
    contributions: int = 240
    artifacts: int = 30
    reading_lists: int = 10
    operations: int = 5


#: The budget-test dataset: every guarded list holds more than 200 rows.
SMALL = Scale(
    roots=4,
    children_per_root=2,
    grandchildren_per_child=2,
    documents=400,
    domains=3,
    topics_per_domain=4,
    members=210,
    groups=3,
    runs=4,
    big_run_items=300,
    connections=2,
    sources_per_connection=2,
    spaces=3,
    conversations=210,
    messages_per_conversation=2,
    requests=210,
    notifications=250,
    audit_events=300,
    contributions=240,
    artifacts=40,
    reading_lists=40,
    operations=40,
)


@dataclass(slots=True)
class Dataset:
    """Identifiers of the seeded rows (strings, JSON-friendly)."""

    workspace: str = ""
    admin: str = ""
    admin_session: str = ""
    member: str = ""  # an ordinary ACTIVE member (workspaceMember)
    members: list[str] = field(default_factory=list)
    suspended_member: str = ""
    groups: list[str] = field(default_factory=list)
    custom_roles: list[str] = field(default_factory=list)
    roots: list[str] = field(default_factory=list)
    collections: list[str] = field(default_factory=list)
    leaf_collections: list[str] = field(default_factory=list)
    personal_collection: str = ""
    documents: list[str] = field(default_factory=list)
    published_documents: list[str] = field(default_factory=list)
    deleted_documents: list[str] = field(default_factory=list)
    stored_documents: list[str] = field(default_factory=list)
    multi_revision_documents: list[str] = field(default_factory=list)
    domains: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    proposed_topics: list[str] = field(default_factory=list)
    topic_corrections: list[str] = field(default_factory=list)
    item_links: list[tuple[str, str]] = field(default_factory=list)  # (collection, link)
    contributions: dict[str, list[str]] = field(default_factory=dict)  # state -> ids
    connections: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    syncs: list[tuple[str, str]] = field(default_factory=list)  # (source, sync)
    runs: list[str] = field(default_factory=list)
    big_run: str = ""
    spaces: list[str] = field(default_factory=list)
    space_announcements: list[tuple[str, str]] = field(default_factory=list)
    space_events: list[tuple[str, str]] = field(default_factory=list)
    space_materials: list[tuple[str, str]] = field(default_factory=list)
    request_types: list[tuple[str, str]] = field(default_factory=list)
    requests: list[str] = field(default_factory=list)
    request_messages: list[tuple[str, str]] = field(default_factory=list)
    conversations: list[str] = field(default_factory=list)
    messages: list[tuple[str, str]] = field(default_factory=list)  # (conversation, message)
    shares: list[tuple[str, str]] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)
    reading_lists: list[str] = field(default_factory=list)
    saved_searches: list[str] = field(default_factory=list)
    saved_items: list[str] = field(default_factory=list)  # item ids saved by admin
    recent_items: list[str] = field(default_factory=list)
    notifications: list[str] = field(default_factory=list)
    audit_events: list[str] = field(default_factory=list)
    operations: list[str] = field(default_factory=list)
    storage_keys: list[str] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=1)

    @classmethod
    def from_json(cls, raw: str) -> Dataset:
        data = json.loads(raw)
        for key in ("item_links", "syncs", "space_announcements", "space_events",
                    "space_materials", "request_types", "request_messages", "messages", "shares"):
            data[key] = [tuple(pair) for pair in data.get(key, [])]
        return cls(**data)


def _table(name: str) -> Table:
    return Base.metadata.tables[name]


class _Seeder:
    def __init__(self, connection: AsyncConnection, scale: Scale) -> None:
        self.c = connection
        self.s = scale
        self.r = random.Random(20261114)
        self.now = datetime.now(UTC)
        self.d = Dataset()
        self.roles: dict[str, UUID] = {}
        #: UUID -> code of every seeded row that has a code (its API resource ID).
        self.codes: dict[str, str] = {}

    # -- helpers -------------------------------------------------------------

    def ago(self, max_days: float = 365.0) -> datetime:
        return self.now - timedelta(seconds=self.r.uniform(60, max_days * 86400))

    async def put(self, table: str, rows: Sequence[dict[str, Any]]) -> None:
        """Insert ``rows``; rows with different key sets go in separate batches
        (an executemany needs one shape, and omitted keys keep server defaults)."""
        shapes: dict[tuple[str, ...], list[dict[str, Any]]] = {}
        for row in rows:
            shapes.setdefault(tuple(sorted(row)), []).append(row)
        for group in shapes.values():
            for start in range(0, len(group), _BATCH):
                await self.c.execute(insert(_table(table)), group[start : start + _BATCH])
        self.d.counts[table] = self.d.counts.get(table, 0) + len(rows)
        if table != "tenants":
            self.codes.update({str(row["id"]): row["code"] for row in rows if "code" in row and "id" in row})

    # -- phases --------------------------------------------------------------

    async def run(self) -> Dataset:
        rows = await self.c.execute(
            select(_table("roles").c.code, _table("roles").c.id).where(
                _table("roles").c.tenant_id.is_(None)
            )
        )
        self.roles = {code: role_id for code, role_id in rows}
        await self.people()
        await self.collections()
        await self.topics()
        await self.documents()
        await self.contributions()
        await self.ingestion()
        await self.spaces()
        await self.conversations()
        await self.library()
        await self.operations()
        self._api_ids()
        return self.d

    def _api_ids(self) -> None:
        """Resources with a ``code`` are addressed by it in the API: swap UUIDs for codes."""
        def api(value: str) -> str:
            return self.codes.get(value, value)

        for name in ("topics", "domains", "proposed_topics", "spaces", "conversations", "reading_lists",
                     "sources", "connections", "groups", "custom_roles"):
            setattr(self.d, name, [api(v) for v in getattr(self.d, name)])
        for name in ("syncs", "space_announcements", "space_events", "space_materials", "request_types",
                     "messages", "shares", "request_messages"):
            setattr(self.d, name, [(api(a), api(b)) for a, b in getattr(self.d, name)])

    async def people(self) -> None:
        ws = uuid4()
        admin = uuid4()
        self.ws, self.admin = ws, admin
        self.d.workspace, self.d.admin = str(ws), str(admin)
        await self.put("tenants", [{
            "id": ws, "code": f"perf-{ws.hex[:8]}", "name": "Perf Workspace",
            "template": "enterprise", "status": "active", "settings": {},
        }])
        users = [{"id": admin, "email": f"admin-{ws.hex[:6]}@perf.example", "display_name": "Perf Admin",
                  "status": "active", "preferences": {}}]
        self.member_ids = [uuid4() for _ in range(self.s.members)]
        users += [{"id": uid, "email": f"m{i}-{ws.hex[:6]}@perf.example",
                   "display_name": f"Member {i:03d}", "status": "active", "preferences": {},
                   "created_at": self.ago()} for i, uid in enumerate(self.member_ids)]
        await self.put("users", users)
        suspended = set(self.member_ids[-3:])
        await self.put("tenant_memberships", [
            {"user_id": uid, "tenant_id": ws, "status": "active",
             "joined_at": self.ago(), "last_active_at": self.ago(30)}
            for uid in [admin, *self.member_ids]
        ])
        self.active_members = [uid for uid in self.member_ids if uid not in suspended]
        self.d.members = [str(u) for u in self.active_members]
        self.d.member = str(self.active_members[0])
        self.d.suspended_member = str(self.member_ids[-1])
        assignments = [
            {"id": uuid4(), "user_id": admin, "role_id": self.roles["workspaceAdmin"], "tenant_id": ws},
            {"id": uuid4(), "user_id": admin, "role_id": self.roles["platformAdmin"]},
        ]
        assignments += [{"id": uuid4(), "user_id": uid, "role_id": self.roles["workspaceMember"],
                         "tenant_id": ws} for uid in self.member_ids]
        await self.put("role_assignments", assignments)
        # Suspended after their grants exist (grants require an ACTIVE member).
        await self.c.execute(
            _table("tenant_memberships").update()
            .where(_table("tenant_memberships").c.user_id.in_(suspended))
            .values(status="suspended")
        )
        self.group_ids = [uuid4() for _ in range(self.s.groups)]
        await self.put("groups", [{"id": g, "tenant_id": ws, "code": f"group-{i:02d}",
                                   "display_name": f"Group {i:02d}", "description": "Perf group"}
                                  for i, g in enumerate(self.group_ids)])
        memberships = []
        for g in self.group_ids:
            for uid in self.r.sample(self.active_members, min(12, len(self.active_members))):
                memberships.append({"group_id": g, "user_id": uid, "joined_at": self.ago()})
        await self.put("group_memberships", memberships)
        self.d.groups = [str(g) for g in self.group_ids]
        # Custom roles with a few permissions each.
        role_rows, perms = [], []
        catalog = [row[0] for row in await self.c.execute(text(
            "SELECT code FROM permissions WHERE 'tenant' = ANY(scope_types) AND custom_roles_supported"
        ))]
        for i in range(3):
            rid = uuid4()
            role_rows.append({"id": rid, "tenant_id": ws, "code": f"perfRole{i}",
                              "display_name": f"Perf role {i}", "scope_type": "tenant",
                              "is_system": False})
            perms += [{"role_id": rid, "permission_code": code}
                      for code in self.r.sample(catalog, min(8, len(catalog)))]
            self.d.custom_roles.append(str(rid))
        await self.put("roles", role_rows)
        await self.put("role_permissions", perms)
        await self.put("workspace_assistant_settings", [{
            "tenant_id": ws, "instructions": "Answer from the knowledge base.",
            "welcome_message": "Hello", "capabilities": {}, "starter_prompts": [],
        }])
        session = uuid4()
        await self.put("access_sessions", [{
            "id": session, "user_id": admin, "authentication_method": "internal",
            "expires_at": self.now + timedelta(days=1),
        }])
        self.d.admin_session = str(session)

    async def collections(self) -> None:
        ws, s = self.ws, self.s
        items, grants = [], []
        self.collection_ids: list[UUID] = []
        self.leaf_ids: list[UUID] = []
        for r in range(s.roots):
            root = uuid4()
            meta: dict[str, Any] = {"description": f"Root collection {r}"}
            if r % 3 == 0:
                meta["discoverable"] = True
            if r % 2 == 0:
                meta["accepts_contributions"] = True
            items.append(self._collection(root, None, f"Root {r:02d}", meta, inherit=False))
            self.d.roots.append(str(root))
            self.collection_ids.append(root)
            # Mixed access: all members, a group, individual users.
            if r % 4 == 0:
                grants.append({"id": uuid4(), "all_members": True, "role_id": self.roles["collectionViewer"], "item_id": root})
            grants.append({"id": uuid4(), "group_id": self.group_ids[r % len(self.group_ids)],
                           "role_id": self.roles["collectionEditor" if r % 2 else "collectionViewer"], "item_id": root})
            for uid in self.r.sample(self.active_members, 3):
                grants.append({"id": uuid4(), "user_id": uid, "role_id": self.roles["collectionViewer"], "item_id": root})
            grants.append({"id": uuid4(), "user_id": self.active_members[0],
                           "role_id": self.roles["collectionOwner" if r == 0 else "collectionViewer"], "item_id": root})
            for c in range(s.children_per_root):
                child = uuid4()
                boundary = c == s.children_per_root - 1 and r % 2 == 1
                items.append(self._collection(child, root, f"Root {r:02d} / Sub {c}", {}, inherit=not boundary))
                if boundary:
                    grants.append({"id": uuid4(), "group_id": self.group_ids[(r + 1) % len(self.group_ids)],
                                   "role_id": self.roles["collectionViewer"], "item_id": child})
                self.collection_ids.append(child)
                for g in range(s.grandchildren_per_child):
                    leaf = uuid4()
                    items.append(self._collection(leaf, child, f"Root {r:02d} / Sub {c} / Leaf {g}", {}, inherit=True))
                    self.collection_ids.append(leaf)
                    self.leaf_ids.append(leaf)
        # Personal collections (owner grant only) for a few members, and the admin.
        self.personal: dict[UUID, UUID] = {}
        for uid in [self.admin, *self.active_members[:10]]:
            pid = uuid4()
            items.append(self._collection(pid, None, "Personal uploads", {"system_kind": PERSONAL_KIND},
                                          inherit=False, creator=uid))
            grants.append({"id": uuid4(), "user_id": uid, "role_id": self.roles["collectionOwner"], "item_id": pid})
            self.personal[uid] = pid
        # The admin's hidden artifacts collection.
        art = artifact_collection_id(ws, self.admin)
        items.append(self._collection(art, None, ARTIFACT_COLLECTION_TITLE,
                                      {"system_kind": ARTIFACT_COLLECTION_KIND}, inherit=False, creator=self.admin))
        grants.append({"id": uuid4(), "user_id": self.admin, "role_id": self.roles["collectionOwner"], "item_id": art})
        self.artifact_collection = art
        await self.put("items", items)
        await self.put("role_assignments", grants)
        self.d.collections = [str(c) for c in self.collection_ids]
        self.d.leaf_collections = [str(c) for c in self.leaf_ids]
        self.d.personal_collection = str(self.personal[self.admin])

    def _collection(self, cid: UUID, parent: UUID | None, title: str, meta: dict[str, Any], *,
                    inherit: bool, creator: UUID | None = None) -> dict[str, Any]:
        created = self.ago()
        return {"id": cid, "tenant_id": self.ws, "item_type": "collection", "parent_item_id": parent,
                "parent_relation": "contains" if parent else None, "title": title, "metadata": meta,
                "inherit_access": inherit, "status": "ready", "created_by_user_id": creator or self.admin,
                "created_at": created, "updated_at": created}

    async def topics(self) -> None:
        rows = []
        self.topic_ids: list[UUID] = []
        for d in range(self.s.domains):
            did = uuid4()
            rows.append({"id": did, "tenant_id": self.ws, "code": f"domain-{d}", "kind": "domain",
                         "display_name": f"Domain {d}", "description": "Perf domain", "state": "active",
                         "keywords": [f"domain{d}"], "synonyms": [], "guidance": "Domain guidance"})
            self.d.domains.append(str(did))
            for t in range(self.s.topics_per_domain):
                tid = uuid4()
                state = "proposed" if t >= self.s.topics_per_domain - 2 else "active"
                rows.append({"id": tid, "tenant_id": self.ws, "code": f"topic-{d}-{t}", "kind": "topic",
                             "parent_topic_id": did, "display_name": f"Topic {d}.{t}",
                             "description": "Perf topic", "state": state,
                             "keywords": [f"kw{d}{t}", f"term{t}"], "synonyms": [f"syn{d}{t}"],
                             "guidance": "Classify documents about this.",
                             "rule_collection_ids": [self.collection_ids[(d * 7 + t) % len(self.collection_ids)]],
                             "rule_source_codes": []})
                if state == "active":
                    self.topic_ids.append(tid)
                    self.d.topics.append(str(tid))
                else:
                    self.d.proposed_topics.append(str(tid))
        await self.put("topics", rows)

    async def documents(self) -> None:
        s, ws = self.s, self.ws
        items, revisions, item_topics, uploads = [], [], [], []
        self.document_ids: list[UUID] = []
        self.published: list[UUID] = []
        placement = self.leaf_ids + self.collection_ids
        index_states = ["ready"] * 6 + ["pending", "processing", "failed", "unsupported"]
        for n in range(s.documents):
            did = uuid4()
            parent = placement[n % len(placement)]
            status = "pending" if n % 40 == 7 else ("failed" if n % 97 == 3 else "ready")
            published = n % 5 != 0
            created = self.ago()
            updated = created + timedelta(seconds=self.r.uniform(0, 86400 * 30))
            meta: dict[str, Any] = {"file_name": f"doc-{n:05d}.pdf", "summary": f"Summary of document {n}",
                                    "language": "en"}
            if n % 6 == 0:
                meta["source"] = {"source_code": f"src-{n % 5}", "url": f"https://wiki.example/{n}",
                                  "path": f"Space/Page {n}", "updated_at": updated.isoformat()}
            if n % 9 == 0:
                meta["verification"] = {"state": "verified", "verifier_user_id": str(self.admin),
                                        "verified_at": created.isoformat(),
                                        "next_review_at": (self.now + timedelta(days=self.r.randint(-60, 120))).isoformat()}
            revision_count = 0 if status == "pending" else 1 + (n % 3)
            items.append({
                "id": did, "tenant_id": ws, "item_type": "document", "parent_item_id": parent,
                "parent_relation": "contains", "document_type": "pdf", "title": f"Document {n:05d} handbook",
                "mime_type": "application/pdf", "size_bytes": 1000 + n,
                "storage_key": revision_object_key(ws, did, revision_count) if revision_count else None,
                "metadata": meta, "inherit_access": True, "status": status,
                "publication_state": "published" if published else "unpublished",
                "index_status": "pending" if status != "ready" else index_states[n % len(index_states)],
                "indexed_revision_number": revision_count if status == "ready" and n % 10 < 6 else None,
                "created_by_user_id": self.active_members[n % len(self.active_members)],
                "created_at": created, "updated_at": updated,
                "deleted_at": self.ago(20) if n % 50 == 11 else None,
            })
            self.document_ids.append(did)
            if n % 50 == 11:
                self.d.deleted_documents.append(str(did))
            elif published and status == "ready":
                self.published.append(did)
            for number in range(1, revision_count + 1):
                revisions.append({"id": uuid4(), "item_id": did, "revision_number": number,
                                  "storage_key": revision_object_key(ws, did, number),
                                  "mime_type": "application/pdf", "size_bytes": 1000 + n,
                                  "summary": f"Revision {number}", "created_by_user_id": self.admin,
                                  "created_at": created + timedelta(minutes=number)})
            if revision_count >= 3 and n % 50 != 11:
                self.d.multi_revision_documents.append(str(did))
            if status == "pending":
                uploads.append({"item_id": did, "tenant_id": ws, "owner_user_id": self.admin, "status": "pending"})
            for topic in self.r.sample(self.topic_ids, n % 4):
                item_topics.append({"item_id": did, "topic_id": topic, "created_by_user_id": None})
        await self.put("items", items)
        await self.put("item_revisions", revisions)
        await self.put("item_topics", item_topics)
        await self.put("item_uploads", uploads)
        self.d.documents = [str(d) for d in self.document_ids]
        self.d.published_documents = [str(d) for d in self.published]
        # Links: a collection shows a document that lives elsewhere.
        links, seen = [], set()
        for k in range(min(150, len(self.published))):
            doc = self.published[k * 7 % len(self.published)]
            col = self.leaf_ids[(k * 5 + 3) % len(self.leaf_ids)]
            parent = items[self.document_ids.index(doc)]["parent_item_id"]
            if col == parent or (col, doc) in seen:
                continue
            seen.add((col, doc))
            lid = uuid4()
            links.append({"id": lid, "tenant_id": ws, "collection_item_id": col, "target_item_id": doc,
                          "created_by_user_id": self.admin})
            self.d.item_links.append((str(col), str(lid)))
        await self.put("item_links", links)
        corrections = [{"id": uuid4(), "tenant_id": ws, "item_id": self.published[k],
                        "from_topic_ids": [self.topic_ids[k % len(self.topic_ids)]],
                        "to_topic_ids": [self.topic_ids[(k + 1) % len(self.topic_ids)]],
                        "actor_user_id": self.admin, "state": "open"}
                       for k in range(min(40, len(self.published)))]
        await self.put("topic_corrections", corrections)
        self.d.topic_corrections = [str(row["id"]) for row in corrections]

    async def contributions(self) -> None:
        """Member contributions in every state; candidates live in personal collections."""
        states = ["analyzing", "in_review", "changes_requested", "approved", "rejected", "withdrawn"]
        contributors = [uid for uid in self.personal if uid != self.admin] or [self.admin]
        items, rows, topics = [], [], []
        targets = [UUID(r) for i, r in enumerate(self.d.roots) if i % 2 == 0]
        for k in range(self.s.contributions):
            uid = contributors[k % len(contributors)]
            cand = uuid4()
            state = states[k % len(states)]
            items.append({"id": cand, "tenant_id": self.ws, "item_type": "document",
                          "parent_item_id": self.personal[uid], "parent_relation": "contains",
                          "document_type": "pdf", "title": f"Contribution {k:04d}", "mime_type": "application/pdf",
                          "size_bytes": 2048, "metadata": {"file_name": f"contrib-{k}.pdf"},
                          "inherit_access": True, "status": "ready", "publication_state": "unpublished",
                          "index_status": "pending", "created_by_user_id": uid})
            replaces = self.published[k % len(self.published)] if k % 5 == 4 else None
            cid = uuid4()
            decided = state in ("approved", "rejected")
            rows.append({"id": cid, "tenant_id": self.ws, "item_id": cand,
                         "kind": "new_revision" if replaces else "new_document", "origin": "member",
                         "contributor_user_id": uid, "target_item_id": targets[k % len(targets)],
                         "replaces_item_id": replaces, "note": "Please review", "suggestions": {},
                         "flags": [], "state": state, "created_at": self.ago(90),
                         "decided_by_user_id": self.admin if decided else None,
                         "decided_at": self.ago(30) if decided else None})
            topics.append({"contribution_id": cid, "topic_id": self.topic_ids[k % len(self.topic_ids)],
                           "relation": "suggested"})
            self.d.contributions.setdefault(state, []).append(str(cid))
        await self.put("items", items)
        await self.put("item_revisions", [{"id": uuid4(), "item_id": row["id"], "revision_number": 1,
                                           "storage_key": revision_object_key(self.ws, row["id"], 1),
                                           "mime_type": "application/pdf", "size_bytes": 2048}
                                          for row in items])
        await self.put("contributions", rows)
        await self.put("contribution_topics", topics)

    async def ingestion(self) -> None:
        s, ws = self.s, self.ws
        conns, sources, syncs, externals = [], [], [], []
        for k in range(s.connections):
            cid = uuid4()
            conns.append({"id": cid, "tenant_id": ws, "code": f"conn-{k}",
                          "connector_key": "confluence" if k % 2 == 0 else "google_drive",
                          "owner_user_id": None, "display_name": f"Connection {k}",
                          "provider_account_id": f"acct-{k}", "provider_account_label": f"Account {k}",
                          "scopes": ["read"], "config": {},
                          "status": ["active", "active", "reauthorization_required", "failed"][k % 4],
                          "connected_at": self.ago(), "created_by_user_id": self.admin})
            self.d.connections.append(str(cid))
            for j in range(s.sources_per_connection):
                sid = uuid4()
                sources.append({"id": sid, "tenant_id": ws, "code": f"src-{k}-{j}",
                                "integration_connection_id": cid, "target_item_id": UUID(self.d.roots[(k + j) % len(self.d.roots)]),
                                "display_name": f"Source {k}.{j}", "resource_type": "space",
                                "external_resource_id": f"SPACE{k}{j}", "external_resource_label": f"Space {k}{j}",
                                "config": {}, "publishing_policy": "review_first" if j % 2 else "auto_publish",
                                "paused_at": self.ago(5) if j == 2 else None, "created_by_user_id": self.admin})
                self.d.sources.append(str(sid))
                for q in range(6):
                    yid = uuid4()
                    started = self.ago(60)
                    syncs.append({"id": yid, "ingestion_source_id": sid,
                                  "trigger_type": ["manual", "scheduled", "creation"][q % 3],
                                  "status": "failed" if q % 4 == 3 else "succeeded",
                                  "added_count": q * 3, "updated_count": q, "removed_count": 0,
                                  "failed_count": 1 if q % 4 == 3 else 0, "failures": [],
                                  "started_at": started, "finished_at": started + timedelta(minutes=5),
                                  "created_by_user_id": self.admin})
                    self.d.syncs.append((str(sid), str(yid)))
        await self.put("integration_connections", conns)
        await self.put("ingestion_sources", sources)
        await self.put("ingestion_syncs", syncs)
        # Connector-origin documents carry an external resource.
        for n, did in enumerate(self.document_ids[: len(self.document_ids) // 6]):
            externals.append({"id": uuid4(), "item_id": did, "ingestion_source_id": UUID(self.d.sources[n % len(self.d.sources)]),
                              "external_id": f"ext-{n}", "external_version": "1",
                              "source_url": f"https://wiki.example/{n}", "metadata": {}, "last_seen_at": self.ago(10)})
        await self.put("external_resources", externals)
        # Runs: one huge run over every document, the rest small, in every status.
        statuses = ["succeeded", "failed", "cancelled", "succeeded", "running", "queued"]
        runs, run_items = [], []
        live_docs = [d for d in self.document_ids if str(d) not in set(self.d.deleted_documents)]
        for k in range(s.runs):
            rid = uuid4()
            big = k == 0
            members = live_docs[: s.big_run_items] if big else self.r.sample(live_docs, 25)
            status = "succeeded" if big else statuses[k % len(statuses)]
            started = self.ago(30)
            finished = started + timedelta(minutes=30) if status in ("succeeded", "failed", "cancelled") else None
            runs.append({"id": rid, "tenant_id": ws, "trigger_type": "manual",
                         "scope": {"filter": "index_status = \"PENDING\""}, "status": status,
                         "configuration": {}, "item_count": len(members), "created_by_user_id": self.admin,
                         "started_at": started if status != "queued" else None, "finished_at": finished,
                         "created_at": started})
            for i, did in enumerate(members):
                item_status = {"succeeded": "succeeded" if i % 23 else "failed", "failed": "failed",
                               "cancelled": "cancelled", "running": ["running", "queued", "succeeded"][i % 3],
                               "queued": "queued"}[status]
                run_items.append({"run_id": rid, "item_id": did, "status": item_status,
                                  "batch_number": i // 50, "phases": [], "revision_number": 1,
                                  "chunk_count": 12 if item_status == "succeeded" else None,
                                  "error": {"code": "PARSE_FAILED", "message": "bad pdf"} if item_status == "failed" else None,
                                  "error_class": "permanent" if item_status == "failed" else None,
                                  "started_at": started if item_status != "queued" else None,
                                  "finished_at": finished if item_status in ("succeeded", "failed", "cancelled") else None})
            self.d.runs.append(str(rid))
            if big:
                self.d.big_run = str(rid)
        await self.put("ingestion_runs", runs)
        await self.put("ingestion_run_items", run_items)

    async def spaces(self) -> None:
        ws, s = self.ws, self.s
        rows, grants, anns, events, mats, types = [], [], [], [], [], []
        for k in range(s.spaces):
            sid = uuid4()
            rows.append({"id": sid, "tenant_id": ws, "code": f"space-{k}", "display_name": f"Space {k}",
                         "space_type": "team", "join_policy": ["open", "request", "invite"][k % 3],
                         "description": "Perf space", "created_by_user_id": self.admin})
            self.d.spaces.append(str(sid))
            grants.append({"id": uuid4(), "user_id": self.admin, "role_id": self.roles["spaceLead"], "space_id": sid})
            for uid in self.r.sample(self.active_members, min(20, len(self.active_members))):
                if uid == self.active_members[0] and k == 0:
                    continue
                grants.append({"id": uuid4(), "user_id": uid, "role_id": self.roles["spaceMember"], "space_id": sid})
            for a in range(5):
                aid = uuid4()
                anns.append({"id": aid, "space_id": sid, "title": f"Announcement {a}", "body": "Body",
                             "pinned": a == 0, "author_user_id": self.admin})
                self.d.space_announcements.append((str(sid), str(aid)))
            for e in range(5):
                eid = uuid4()
                start = self.now + timedelta(days=e - 2)
                events.append({"id": eid, "space_id": sid, "title": f"Event {e}", "start_at": start,
                               "end_at": start + timedelta(hours=1), "created_by_user_id": self.admin})
                self.d.space_events.append((str(sid), str(eid)))
            for m in range(10):
                mid = uuid4()
                mats.append({"id": mid, "space_id": sid, "item_id": self.published[(k * 10 + m) % len(self.published)],
                             "note": "Read this", "added_by_user_id": self.admin})
                self.d.space_materials.append((str(sid), str(mid)))
            for t in range(3):
                tid = uuid4()
                types.append({"id": tid, "space_id": sid, "code": f"type-{t}", "display_name": f"Request type {t}",
                              "description": "Perf type", "fields": [], "rules": [], "created_by_user_id": self.admin})
                self.d.request_types.append((str(sid), str(tid)))
        await self.put("spaces", rows)
        await self.put("role_assignments", grants)
        await self.put("space_announcements", anns)
        await self.put("space_events", events)
        await self.put("space_materials", mats)
        await self.put("request_types", types)
        # Requests in every kind and state.
        reqs, msgs = [], []
        states = ["open", "needs_info", "approved", "denied", "answered", "withdrawn", "closed"]
        type_by_space = {sp: ty for sp, ty in self.d.request_types}
        used_asks: set[tuple[Any, ...]] = set()
        for k in range(s.requests):
            rid = uuid4()
            requester = self.admin if k % 4 == 0 else self.active_members[k % len(self.active_members)]
            kind = ["service", "question", "space_membership", "collection_access", "connector"][k % 5]
            state = states[k % len(states)]
            space = UUID(self.d.spaces[k % len(self.d.spaces)])
            row: dict[str, Any] = {"id": rid, "tenant_id": ws, "kind": kind, "requester_user_id": requester,
                                   "state": state, "title": f"Request {k}", "fields": {},
                                   "created_at": self.ago(60)}
            if kind == "service":
                row.update(space_id=space, request_type_id=UUID(type_by_space[str(space)]))
            elif kind == "question":
                row.update(space_id=space, question="Where is the policy?")
            elif kind == "space_membership":
                row.update(space_id=space, requested_role_id=self.roles["spaceMember"])
            elif kind == "collection_access":
                row.update(collection_item_id=UUID(self.d.roots[k % len(self.d.roots)]),
                           requested_role_id=self.roles["collectionViewer"])
            else:
                row.update(connector_key="confluence")
            if state in ("open", "needs_info") and kind in ("collection_access", "space_membership", "connector"):
                ask = (requester, kind, row.get("collection_item_id"), row.get("space_id"), row.get("connector_key"))
                if ask in used_asks:
                    row["state"] = "closed"
                    row["closed_at"] = self.ago(5)
                used_asks.add(ask)
            reqs.append(row)
            self.d.requests.append(str(rid))
            for m in range(3):
                mid = uuid4()
                msgs.append({"id": mid, "request_id": rid, "author_user_id": requester if m % 2 == 0 else self.admin,
                             "text": f"Message {m}", "internal": False})
                self.d.request_messages.append((str(rid), str(mid)))
        await self.put("requests", reqs)
        await self.put("request_messages", msgs)

    async def conversations(self) -> None:
        ws, s = self.ws, self.s
        convs, msgs, shares = [], [], []
        session = UUID(self.d.admin_session)
        questions = ["What is the travel policy?", "How do I request leave?", "Where is the VPN guide?",
                     "Who approves purchases?", "What is the onboarding checklist?"]
        for k in range(s.conversations):
            cid = uuid4()
            last = self.ago(60)
            convs.append({"id": cid, "tenant_id": ws, "code": f"conv-{k:04d}", "owner_user_id": self.admin,
                          "created_by_session_id": session, "title": f"Conversation {k}", "pinned": k % 10 == 0,
                          "scope_collection_ids": [UUID(self.d.roots[k % len(self.d.roots)])],
                          "scope_space_ids": [], "state": {}, "last_message_at": last,
                          "created_at": last - timedelta(hours=1)})
            self.d.conversations.append(str(cid))
            for m in range(s.messages_per_conversation):
                mid = uuid4()
                user = m % 2 == 0
                meta: dict[str, Any] = {} if user else {"citations": []}
                rating = "unhelpful" if not user and m % 6 == 1 else None
                msgs.append({"id": mid, "conversation_id": cid, "role": "user" if user else "assistant",
                             "content": questions[(k + m) % len(questions)] if user else "Here is the answer.",
                             "metadata": meta, "sequence_number": m + 1, "status": "active",
                             "generation_state": "completed", "feedback_rating": rating,
                             "feedback_at": last if rating else None,
                             "created_at": last - timedelta(minutes=s.messages_per_conversation - m)})
                if not user:
                    self.d.messages.append((str(cid), str(mid)))
            if k % 10 == 0:
                shid = uuid4()
                shares.append({"id": shid, "tenant_id": ws, "conversation_id": cid, "owner_user_id": self.admin,
                               "audience": "workspace", "title": f"Conversation {k}",
                               "snapshot": {"messages": []}, "message_count": s.messages_per_conversation})
                self.d.shares.append((str(cid), str(shid)))
        await self.put("conversations", convs)
        await self.put("messages", msgs)
        await self.put("conversation_shares", shares)
        # Artifacts: documents in the admin's hidden collection.
        items, arts, revs = [], [], []
        for k in range(s.artifacts):
            aid = uuid4()
            items.append({"id": aid, "tenant_id": ws, "item_type": "document",
                          "parent_item_id": self.artifact_collection, "parent_relation": "contains",
                          "document_type": "markdown", "title": f"Artifact {k}", "mime_type": "text/markdown",
                          "storage_key": revision_object_key(ws, aid, 1),
                          "metadata": {"file_name": f"artifact-{k}.md"}, "inherit_access": True,
                          "status": "ready", "publication_state": "published", "index_status": "unsupported",
                          "created_by_user_id": self.admin})
            arts.append({"item_id": aid, "kind": "draft", "owner_user_id": self.admin,
                         "conversation_id": UUID(self.d.conversations[k % len(self.d.conversations)]),
                         "audience": "private"})
            revs.append({"id": uuid4(), "item_id": aid, "revision_number": 1,
                         "storage_key": revision_object_key(ws, aid, 1), "mime_type": "text/markdown",
                         "size_bytes": 64, "author": "assistant"})
            self.d.artifacts.append(str(aid))
        await self.put("items", items)
        await self.put("artifacts", arts)
        await self.put("item_revisions", revs)

    async def library(self) -> None:
        ws, s = self.ws, self.s
        lists, entries = [], []
        for k in range(s.reading_lists):
            lid = uuid4()
            lists.append({"id": lid, "tenant_id": ws, "code": f"list-{k}", "owner_user_id": self.admin,
                          "kind": "standard", "title": f"Reading list {k}",
                          "audience": "workspace" if k % 2 else "private"})
            for p in range(20):
                entries.append({"reading_list_id": lid, "item_id": self.published[(k * 20 + p) % len(self.published)],
                                "position": p, "added_by_user_id": self.admin})
            self.d.reading_lists.append(str(lid))
        await self.put("reading_lists", lists)
        await self.put("reading_list_entries", entries)
        saved = self.published[:60]
        await self.put("saved_items", [{"tenant_id": ws, "user_id": self.admin, "item_id": d} for d in saved])
        self.d.saved_items = [str(d) for d in saved]
        recent = self.published[60:160]
        await self.put("recent_items", [{"tenant_id": ws, "user_id": self.admin, "item_id": d,
                                         "viewed_at": self.ago(14)} for d in recent])
        self.d.recent_items = [str(d) for d in recent]
        searches = [{"id": uuid4(), "tenant_id": ws, "user_id": self.admin, "display_name": f"Search {k}",
                     "query": "", "filter": 'document.indexState = "READY"', "layout": "list"} for k in range(10)]
        await self.put("saved_searches", searches)
        self.d.saved_searches = [str(row["id"]) for row in searches]
        notes = [{"id": uuid4(), "tenant_id": ws, "recipient_user_id": self.admin,
                  "kind": ["request_updated", "access_request", "new_document"][k % 3],
                  "subject_type": "request" if k % 3 == 0 else None,
                  "subject_id": UUID(self.d.requests[k % len(self.d.requests)]) if k % 3 == 0 else None,
                  "title": f"Notification {k}", "body": "Body",
                  "read_at": self.ago(5) if k % 2 else None, "created_at": self.ago(30)}
                 for k in range(s.notifications)]
        await self.put("notifications", notes)
        self.d.notifications = [str(row["id"]) for row in notes]
        categories = ["knowledge", "files", "sources", "people", "settings", "spaces", "requests", "sign_in"]
        audits = [{"id": uuid4(), "tenant_id": ws, "actor_user_id": self.admin,
                   "category": categories[k % len(categories)], "action": "update",
                   "resource_type": "item", "target_name": f"workspaces/{ws}/items/{self.document_ids[k % len(self.document_ids)]}",
                   "outcome": "succeeded" if k % 17 else "failed", "details": {}, "created_at": self.ago(90)}
                  for k in range(s.audit_events)]
        await self.put("audit_logs", audits)
        self.d.audit_events = [str(row["id"]) for row in audits[:50]]
        await self.put("platform_health_checks", [
            {"id": uuid4(), "checked_at": self.ago(2), "service": svc,
             "status": ["healthy", "healthy", "degraded", "unhealthy"][k % 4], "latency_ms": 10 + k}
            for k in range(200) for svc in (["postgres", "qdrant", "object_storage"][k % 3],)
        ])

    async def operations(self) -> None:
        ops = [{"id": uuid4(), "user_id": self.admin, "tenant_id": self.ws, "verb": "exportAuditEvents",
                "target": f"workspaces/{self.ws}", "progress_percent": 100, "finished_at": self.ago(1),
                "expires_at": self.now + timedelta(days=7)} for _ in range(self.s.operations)]
        await self.put("operations", ops)
        self.d.operations = [str(row["id"]) for row in ops]


async def seed(engine: AsyncEngine, scale: Scale = Scale(), *, analyze: bool = True) -> Dataset:
    """Seed one workspace at ``scale`` in a single transaction, then ANALYZE (optional)."""
    async with engine.begin() as connection:
        dataset = await _Seeder(connection, scale).run()
    if analyze:
        async with engine.connect() as connection:
            await connection.execution_options(isolation_level="AUTOCOMMIT")
            await connection.execute(text("ANALYZE"))
    return dataset


__all__ = ["SMALL", "Dataset", "Scale", "seed"]
