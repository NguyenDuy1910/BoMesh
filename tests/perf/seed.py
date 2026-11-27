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
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Table, bindparam, insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from bomesh.db.models import Base
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE
from bomesh.services import ARTIFACT_COLLECTION_TYPE
from bomesh.services.knowledge_items.item_store import (
    ARTIFACT_COLLECTION_NAME,
    artifact_collection_id,
)
from bomesh.services.taxonomy.closure import closure_rows
from bomesh.services.taxonomy.normalize import normalize_label
from bomesh.services.taxonomy.snapshot import ConceptView, GroupView, SchemeSnapshot, snapshot_json

_BATCH = 1000


@dataclass(frozen=True, slots=True)
class Scale:
    """Row counts of one seeded workspace (defaults: the full perf dataset)."""

    roots: int = 20
    children_per_root: int = 3
    grandchildren_per_child: int = 2
    documents: int = 5000
    concept_tops: int = 12
    concepts_per_top: int = 25
    concept_proposals: int = 80
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
    operations: int = 5


#: The budget-test dataset: every guarded list holds more than 200 rows.
SMALL = Scale(
    roots=4,
    children_per_root=2,
    grandchildren_per_child=2,
    documents=400,
    concept_tops=10,
    concepts_per_top=20,
    concept_proposals=40,
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
    concept_scheme: str = ""  # the published classification scheme feeding Home (code)
    top_concepts: list[str] = field(default_factory=list)  # notations
    leaf_concepts: list[str] = field(default_factory=list)  # notations (narrower concepts)
    concept_groups: list[str] = field(default_factory=list)
    concept_rules: list[str] = field(default_factory=list)
    concept_proposals: list[str] = field(default_factory=list)  # OPEN NEW_CONCEPT proposal IDs
    label_proposals: list[str] = field(default_factory=list)  # OPEN LABEL proposal IDs
    template_scheme: str = ""  # a published platform template (code)
    template_concepts: list[str] = field(default_factory=list)  # its notations
    fork_scheme: str = ""  # the workspace's unpublished fork of the template (code)
    item_shortcuts: list[tuple[str, str]] = field(default_factory=list)  # (collection, shortcut)
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
    artifacts: list[str] = field(default_factory=list)
    saved_searches: list[str] = field(default_factory=list)
    saved_items: list[str] = field(default_factory=list)  # item ids saved by admin
    recent_items: list[str] = field(default_factory=list)
    notifications: list[str] = field(default_factory=list)
    audit_events: list[str] = field(default_factory=list)
    operations: list[str] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=1)

    @classmethod
    def from_json(cls, raw: str) -> Dataset:
        data = json.loads(raw)
        for key in ("item_shortcuts", "syncs", "space_announcements", "space_events",
                    "space_materials", "request_types", "request_messages", "messages"):
            data[key] = [tuple(pair) for pair in data.get(key, [])]
        return cls(**data)


def _table(name: str) -> Table:
    return Base.metadata.tables[name]


@dataclass(frozen=True, slots=True)
class _Concept:
    """One seeded published concept: notation, Vietnamese prefLabel and its other facts."""

    notation: str
    pref: str
    definition: str
    broader: tuple[str, ...] = ()
    color: str | None = None  # top concepts only
    pref_en: str | None = None
    alt: tuple[str, ...] = ()



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

    async def set_index_states(self, rows: Sequence[dict[str, Any]]) -> None:
        """Set the index state of seeded documents (``item_id`` plus the columns to set);
        the ``items`` insert trigger already created each state row as ``pending``."""
        states = _table("item_index_states")
        statement = update(states).where(states.c.item_id == bindparam("state_item_id"))
        shapes: dict[tuple[str, ...], list[dict[str, Any]]] = {}
        for row in rows:
            params = {key: value for key, value in row.items() if key != "item_id"}
            shapes.setdefault(tuple(sorted(params)), []).append({"state_item_id": row["item_id"], **params})
        for group in shapes.values():
            for start in range(0, len(group), _BATCH):
                await self.c.execute(statement, group[start : start + _BATCH])

    async def show(self, rows: Sequence[tuple[UUID, UUID]]) -> None:
        """Make each ``(item_id, revision_id)`` the item's current revision; its
        content is AVAILABLE from then on."""
        items = _table("items")
        statement = (
            update(items)
            .where(items.c.id == bindparam("shown_item_id"))
            .values(current_revision_id=bindparam("shown_revision_id"))
        )
        params = [{"shown_item_id": item, "shown_revision_id": revision} for item, revision in rows]
        for start in range(0, len(params), _BATCH):
            await self.c.execute(statement, params[start : start + _BATCH])

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
        await self.documents()
        await self.taxonomy()
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

        for name in ("spaces", "conversations", "sources", "connections", "groups", "custom_roles"):
            setattr(self.d, name, [api(v) for v in getattr(self.d, name)])
        for name in ("syncs", "space_announcements", "space_events", "space_materials", "request_types",
                     "messages", "request_messages"):
            setattr(self.d, name, [(api(a), api(b)) for a, b in getattr(self.d, name)])

    async def people(self) -> None:
        ws = uuid4()
        admin = uuid4()
        self.ws, self.admin = ws, admin
        self.d.workspace, self.d.admin = str(ws), str(admin)
        await self.put("tenants", [{
            "id": ws, "code": f"perf-{ws.hex[:8]}", "tenant_name": "Perf Workspace",
            "template": "enterprise", "status": "active", "settings": {},
        }])
        users = [{"id": admin, "email": f"admin-{ws.hex[:6]}@perf.example", "user_name": "Perf Admin",
                  "status": "active", "preferences": {}}]
        self.member_ids = [uuid4() for _ in range(self.s.members)]
        users += [{"id": uid, "email": f"m{i}-{ws.hex[:6]}@perf.example",
                   "user_name": f"Member {i:03d}", "status": "active", "preferences": {},
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
                                   "group_name": f"Group {i:02d}", "description": "Perf group"}
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
                              "role_name": f"Perf role {i}", "scope_type": "tenant",
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
            items.append(self._collection(pid, None, "Personal uploads", {}, inherit=False, creator=uid,
                                          item_type=PERSONAL_COLLECTION_TYPE))
            grants.append({"id": uuid4(), "user_id": uid, "role_id": self.roles["collectionOwner"], "item_id": pid})
            self.personal[uid] = pid
        # The admin's hidden artifacts collection.
        art = artifact_collection_id(ws, self.admin)
        items.append(self._collection(art, None, ARTIFACT_COLLECTION_NAME, {}, inherit=False,
                                      creator=self.admin, item_type=ARTIFACT_COLLECTION_TYPE))
        grants.append({"id": uuid4(), "user_id": self.admin, "role_id": self.roles["collectionOwner"], "item_id": art})
        self.artifact_collection = art
        await self.put("items", items)
        await self.put("role_assignments", grants)
        self.d.collections = [str(c) for c in self.collection_ids]
        self.d.leaf_collections = [str(c) for c in self.leaf_ids]
        self.d.personal_collection = str(self.personal[self.admin])

    def _collection(self, cid: UUID, parent: UUID | None, name: str, meta: dict[str, Any], *,
                    inherit: bool, creator: UUID | None = None, item_type: str = "standard") -> dict[str, Any]:
        created = self.ago()
        return {"id": cid, "tenant_id": self.ws, "item_kind": "collection", "item_type": item_type,
                "parent_item_id": parent, "item_name": name,
                "description": None, "discoverable": False, "accepts_contributions": False, **meta,
                "inherit_access": inherit, "created_by_user_id": creator or self.admin,
                "created_at": created, "updated_at": created}

    async def taxonomy(self) -> None:
        """The faceted taxonomy: one published classification scheme (Home's featured
        concepts, ``document.concepts`` facets, classification) whose narrower concepts
        label most documents with content, its groups, rules and proposals; a published
        platform template and the workspace's unpublished fork of it."""
        s, ws = self.s, self.ws
        colors = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b",
                  "#e377c2", "#7f7f7f", "#bcbd22", "#17becf", "#393b79", "#637939"]
        concepts: list[_Concept] = []
        for t in range(s.concept_tops):
            top = f"area-{t:02d}"
            concepts.append(_Concept(top, f"Lĩnh vực {t:02d}", f"Văn bản thuộc lĩnh vực {t:02d}.",
                                     color=colors[t % len(colors)], pref_en=f"Area {t:02d}"))
            self.d.top_concepts.append(top)
            for c in range(s.concepts_per_top):
                leaf = f"{top}-{c:02d}"
                # "Tổng quan" is shared by several concepts (ListSharedLabels).
                concepts.append(_Concept(leaf, f"Chủ đề {t:02d}.{c:02d}", f"Văn bản về chủ đề {t:02d}.{c:02d}.",
                                         broader=(top,), alt=("Tổng quan",) if c == 0 else ()))
                self.d.leaf_concepts.append(leaf)
        tops, leaves = self.d.top_concepts, self.d.leaf_concepts
        groups = [("core", "Cốt lõi", leaves[::s.concepts_per_top][:3], True),
                  ("featured", "Nổi bật", tops[:4], False)]
        scheme_id, ids = await self.scheme(
            ws, "domain", "Lĩnh vực", "classification", concepts, groups=groups,
            max_depth=2, max_labels=3, has_primary=True, assign_top_concepts=False,
            llm_policy="always", auto_threshold=Decimal("0.85"), review_threshold=Decimal("0.5"))
        self.d.concept_scheme = "domain"
        self.d.concept_groups = [code for code, *_ in groups]

        # Assignments: 4 in 6 documents ASSIGNED (an accepted primary, maybe a human label and
        # a suggestion), 1 UNCERTAIN (a suggestion only), the rest unlabeled or EMPTY.
        leaf_ids = [ids[notation] for notation in leaves]
        deleted = {UUID(d) for d in self.d.deleted_documents}

        def label(item: UUID, concept: UUID, state: str, source: str, confidence: float | None,
                  primary: bool = False) -> dict[str, Any]:
            human = source == "human"
            return {"id": uuid4(), "item_id": item, "concept_id": concept, "scheme_id": scheme_id,
                    "is_primary": primary, "confidence": confidence, "source": source, "state": state,
                    "scheme_version": 1, "classifier_version": None if human else "perf",
                    "evidence": {}, "reviewed_by_user_id": self.admin if human else None,
                    "reviewed_at": self.ago(30) if human else None,
                    "created_by_user_id": self.admin if human else None}

        labels, outcomes = [], []
        for n, did in enumerate(self.document_ids):
            if did in deleted or did not in self.with_content:
                continue
            first, second, third = self.r.sample(leaf_ids, 3)
            kind = n % 6
            if kind <= 3:
                labels.append(label(did, first, "accepted", "llm", 0.9, primary=True))
                if kind % 2:
                    labels.append(label(did, second, "accepted", "human", None))
                if kind == 3:
                    labels.append(label(did, third, "suggested", "llm", 0.6))
                outcome, confidence = "assigned", 0.9
            elif kind == 4:
                labels.append(label(did, first, "suggested", "llm", 0.55))
                outcome, confidence = "uncertain", 0.55
            elif n % 12 == 5:
                outcome, confidence = "empty", None
            else:
                continue
            outcomes.append({"item_id": did, "scheme_id": scheme_id, "outcome": outcome,
                             "confidence": confidence, "scheme_version": 1, "classifier_version": "perf",
                             "revision_number": 1, "classified_at": self.ago(60)})
        await self.put("item_concepts", labels)
        await self.put("item_classifications", outcomes)

        rules = []
        for k in range(2 * s.concept_tops):
            prior = k % 3 == 2
            rules.append({"id": uuid4(), "tenant_id": ws, "code": f"rule-{k:02d}",
                          "when_collection_item_id": self.collection_ids[k % len(self.collection_ids)],
                          "then_concept_id": leaf_ids[k * 7 % len(leaf_ids)],
                          "effect": "prior" if prior else "implies",
                          "weight": Decimal("0.4") if prior else None, "created_by_user_id": self.admin})
        await self.put("concept_rules", rules)
        self.d.concept_rules = [row["code"] for row in rules]

        # Proposals: NEW_CONCEPT under a top concept and LABEL on a leaf, a quarter decided.
        proposals, evidence = [], []
        for k in range(s.concept_proposals):
            pid = uuid4()
            is_label = k % 2 == 1
            decided = k % 8 >= 6
            proposals.append({
                "id": pid, "tenant_id": ws, "scheme_id": scheme_id,
                "kind": "label" if is_label else "new_concept",
                "proposal_name": f"Nhãn đề xuất {k:03d}" if is_label else f"Chủ đề đề xuất {k:03d}",
                "definition": None if is_label else f"Văn bản về chủ đề đề xuất {k:03d}.",
                "broader_concept_id": None if is_label else ids[tops[k % len(tops)]],
                "target_concept_id": leaf_ids[k % len(leaf_ids)] if is_label else None,
                "origin": "correction" if is_label else "cluster",
                "state": "rejected" if decided else "open",
                "decided_by_user_id": self.admin if decided else None,
                "decided_at": self.ago(10) if decided else None, "created_at": self.ago(30)})
            evidence += [{"proposal_id": pid, "item_id": did} for did in self.r.sample(self.published, 3)]
            if not decided:
                (self.d.label_proposals if is_label else self.d.concept_proposals).append(str(pid))
        await self.put("concept_proposals", proposals)
        await self.put("concept_proposal_items", evidence)

        # A platform template (org units) and the workspace's fork of its version 1.
        units: list[_Concept] = []
        for u in range(3):
            top = f"unit-{u}"
            units.append(_Concept(top, f"Khối {u}", f"Khối đơn vị {u}."))
            units += [_Concept(f"{top}-{c}", f"Đơn vị {u}.{c}", f"Đơn vị {u}.{c}.", broader=(top,))
                      for c in range(3)]
        template_code = f"perf-tpl-{ws.hex[:8]}"
        template = await self.scheme(None, template_code, "Đơn vị (mẫu)", "authority", units, max_depth=2,
                                     groups=[("blocks", "Khối", ["unit-0", "unit-1", "unit-2"], False)])
        await self.scheme(ws, "org-unit", "Đơn vị", "authority", units, published=False, template=template,
                          max_depth=2)
        self.d.template_scheme = template_code
        self.d.template_concepts = [c.notation for c in units]
        self.d.fork_scheme = "org-unit"

    async def scheme(self, tenant: UUID | None, code: str, name: str, purpose: str,
                     concepts: Sequence[_Concept], *, published: bool = True,
                     groups: Sequence[tuple[str, str, Sequence[str], bool]] = (),
                     template: tuple[UUID, dict[str, UUID]] | None = None,
                     **settings: Any) -> tuple[UUID, dict[str, UUID]]:
        """Insert scheme ``code`` (``settings``: ``concept_schemes`` columns) with ``concepts``
        and ``groups`` (code, name, member notations, query expansion). ``published`` makes it
        version 1 the way ``:publish`` leaves it: a ``concept_scheme_versions`` snapshot
        (``snapshot_json``) and the ``concept_closure``; else its concepts are DRAFTs.
        ``template``: (scheme, notation → concept) of the template version 1 it forks.
        Returns the scheme ID and notation → concept ID."""
        sid = uuid4()
        ids = {c.notation: uuid4() for c in concepts}
        row: dict[str, Any] = {
            "id": sid, "tenant_id": tenant, "code": code, "scheme_name": name, "purpose": purpose,
            "description": f"Perf scheme {code}", "position": 0, "max_depth": 3, "min_labels": 0,
            "max_labels": None, "has_primary": False, "assign_top_concepts": True,
            "section_assignments": False, "llm_policy": "never", "auto_threshold": None,
            "review_threshold": None, "published_version": 1 if published else None,
            "template_scheme_id": template[0] if template else None,
            "template_version": 1 if template else None, **settings}
        await self.put("concept_schemes", [row])
        await self.put("concepts", [
            {"id": ids[c.notation], "tenant_id": tenant, "scheme_id": sid, "notation": c.notation,
             "definition": c.definition, "color": c.color,
             "state": "published" if published else "draft", "first_version": 1 if published else None,
             "template_concept_id": template[1][c.notation] if template else None}
            for c in concepts])
        labels = []
        for c in concepts:
            texts = [("pref", "vi", c.pref), *([("pref", "en", c.pref_en)] if c.pref_en else []),
                     *(("alt", "vi", alt) for alt in c.alt)]
            labels += [{"id": uuid4(), "concept_id": ids[c.notation], "kind": kind, "language_code": language,
                        "label_text": value, "normalized": normalize_label(value)}
                       for kind, language, value in texts]
        await self.put("concept_labels", labels)
        await self.put("concept_relations", [
            {"source_concept_id": ids[c.notation], "target_concept_id": ids[parent], "kind": "broader"}
            for c in concepts for parent in c.broader])
        group_rows, members, group_views = [], [], []
        for position, (group_code, group_name, notations, expansion) in enumerate(groups):
            gid = uuid4()
            group_rows.append({"id": gid, "scheme_id": sid, "code": group_code, "group_name": group_name,
                               "position": position, "query_expansion": expansion})
            members += [{"group_id": gid, "concept_id": ids[n], "position": p} for p, n in enumerate(notations)]
            group_views.append(GroupView(gid, group_code, group_name, position, expansion,
                                         tuple(ids[n] for n in notations)))
        await self.put("concept_groups", group_rows)
        await self.put("concept_group_members", members)
        if not published:
            return sid, ids

        def threshold(value: Decimal | None) -> float | None:
            return None if value is None else float(value)

        snapshot = SchemeSnapshot(
            scheme_id=sid, code=code, name=name, purpose=purpose, version=1, position=row["position"],
            min_labels=row["min_labels"], max_labels=row["max_labels"], has_primary=row["has_primary"],
            max_depth=row["max_depth"], assign_top_concepts=row["assign_top_concepts"],
            section_assignments=row["section_assignments"], llm_policy=row["llm_policy"],
            auto_threshold=threshold(row["auto_threshold"]),
            review_threshold=threshold(row["review_threshold"]),
            concepts={
                ids[c.notation]: ConceptView(
                    id=ids[c.notation], notation=c.notation, scheme_code=code, state="published",
                    pref_labels={"vi": c.pref, **({"en": c.pref_en} if c.pref_en else {})},
                    alt_labels=tuple(("vi", alt) for alt in c.alt), definition=c.definition,
                    color=c.color, broader=tuple(ids[parent] for parent in c.broader))
                for c in concepts},
            groups=tuple(group_views))
        await self.put("concept_scheme_versions", [{"scheme_id": sid, "version": 1,
                                                    "published_by_user_id": self.admin,
                                                    "snapshot": snapshot_json(snapshot)}])
        await self.put("concept_closure", [{"ancestor_id": ancestor, "descendant_id": descendant, "depth": depth}
                                           for ancestor, descendant, depth in closure_rows(snapshot)])
        return sid, ids

    async def documents(self) -> None:
        s, ws = self.s, self.ws
        items, revisions, uploads = [], [], []
        index_states_rows: list[dict[str, Any]] = []
        shown: list[tuple[UUID, UUID]] = []
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
            file_name = f"doc-{n:05d}.pdf"
            verified = n % 9 == 0
            meta: dict[str, Any] = {
                "description": f"Summary of document {n}", "language_code": "en",
                "verified_by_user_id": self.admin if verified else None,
                "verified_at": created if verified else None,
                "next_review_at": self.now + timedelta(days=self.r.randint(-60, 120)) if verified else None,
            }
            revision_count = 0 if status != "ready" else 1 + (n % 3)
            items.append({
                "id": did, "tenant_id": ws, "item_kind": "document", "item_type": "pdf",
                "parent_item_id": parent, "item_name": f"Document {n:05d} handbook",
                **meta, "purpose": "knowledge",
                "is_published": bool(published),
                "created_by_user_id": self.active_members[n % len(self.active_members)],
                "created_at": created, "updated_at": updated,
                "deleted_at": self.ago(20) if n % 50 == 11 else None,
            })
            index_status = "pending" if status != "ready" else index_states[n % len(index_states)]
            indexed_revision = revision_count if status == "ready" and n % 10 < 6 else None
            if (index_status, indexed_revision) != ("pending", None):
                index_states_rows.append({"item_id": did, "index_status": index_status,
                                          "indexed_revision_number": indexed_revision})
            self.document_ids.append(did)
            if n % 50 == 11:
                self.d.deleted_documents.append(str(did))
            elif published and status == "ready":
                self.published.append(did)
            for number in range(1, revision_count + 1):
                rid = uuid4()
                revisions.append({"id": rid, "item_id": did, "revision_number": number,
                                  "content_id": uuid4(), "file_name": file_name,
                                  "mime_type": "application/pdf", "size_bytes": 1000 + n,
                                  "summary": f"Revision {number}", "created_by_user_id": self.admin,
                                  "created_at": created + timedelta(minutes=number)})
                if number == revision_count:
                    shown.append((did, rid))
            if revision_count >= 3 and n % 50 != 11:
                self.d.multi_revision_documents.append(str(did))
            if status != "ready":
                uploads.append({"item_id": did, "tenant_id": ws, "owner_user_id": self.admin,
                                "content_id": uuid4(), "mime_type": "application/pdf",
                                "size_bytes": 1000 + n, "file_name": file_name, "status": status})
        await self.put("items", items)
        await self.set_index_states(index_states_rows)
        await self.put("item_revisions", revisions)
        await self.show(shown)
        await self.put("item_uploads", uploads)
        self.with_content = {item for item, _ in shown}
        self.d.documents = [str(d) for d in self.document_ids]
        self.d.published_documents = [str(d) for d in self.published]
        # Shortcuts: a collection shows a document that lives elsewhere.
        shortcuts, seen = [], set()
        for k in range(min(150, len(self.published))):
            doc = self.published[k * 7 % len(self.published)]
            col = self.leaf_ids[(k * 5 + 3) % len(self.leaf_ids)]
            parent = items[self.document_ids.index(doc)]["parent_item_id"]
            if col == parent or (col, doc) in seen:
                continue
            seen.add((col, doc))
            lid = uuid4()
            shortcuts.append({"id": lid, "tenant_id": ws, "collection_item_id": col, "target_item_id": doc,
                          "created_by_user_id": self.admin})
            self.d.item_shortcuts.append((str(col), str(lid)))
        await self.put("item_shortcuts", shortcuts)
        # Shares: workspace-wide shares of published documents (ListShares, GetShare).
        await self.put("resource_shares", [
            {"id": uuid4(), "tenant_id": ws, "kind": "share", "audience": "workspace",
             "item_id": self.published[k], "created_by_user_id": self.admin}
            for k in range(min(60, len(self.published)))
        ])

    async def contributions(self) -> None:
        """Member contributions in every state; candidates live in personal collections."""
        states = ["analyzing", "in_review", "changes_requested", "approved", "rejected", "withdrawn"]
        contributors = [uid for uid in self.personal if uid != self.admin] or [self.admin]
        items, rows = [], []
        targets = [UUID(r) for i, r in enumerate(self.d.roots) if i % 2 == 0]
        for k in range(self.s.contributions):
            uid = contributors[k % len(contributors)]
            cand = uuid4()
            state = states[k % len(states)]
            items.append({"id": cand, "tenant_id": self.ws, "item_kind": "document", "item_type": "pdf",
                          "parent_item_id": self.personal[uid],
                          "item_name": f"Contribution {k:04d}",
                          "purpose": "knowledge", "is_published": False,
                          "created_by_user_id": uid})
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
            self.d.contributions.setdefault(state, []).append(str(cid))
        await self.put("items", items)
        revisions = [{"id": uuid4(), "item_id": row["id"], "revision_number": 1, "content_id": uuid4(),
                      "file_name": f"contrib-{k}.pdf", "mime_type": "application/pdf", "size_bytes": 2048}
                     for k, row in enumerate(items)]
        await self.put("item_revisions", revisions)
        await self.show([(row["item_id"], row["id"]) for row in revisions])
        await self.put("contributions", rows)

    async def ingestion(self) -> None:
        s, ws = self.s, self.ws
        conns, sources, syncs, externals = [], [], [], []
        for k in range(s.connections):
            cid = uuid4()
            conns.append({"id": cid, "tenant_id": ws, "code": f"conn-{k}",
                          "connector_key": "confluence" if k % 2 == 0 else "google_drive",
                          "owner_user_id": None, "integration_connection_name": f"Connection {k}",
                          "provider_account_id": f"acct-{k}", "provider_account_label": f"Account {k}",
                          "scopes": ["read"], "config": {},
                          "status": ["active", "active", "reauthorization_required", "failed"][k % 4],
                          "connected_at": self.ago(), "created_by_user_id": self.admin})
            self.d.connections.append(str(cid))
            for j in range(s.sources_per_connection):
                sid = uuid4()
                sources.append({"id": sid, "tenant_id": ws, "code": f"src-{k}-{j}",
                                "integration_connection_id": cid, "target_item_id": UUID(self.d.roots[(k + j) % len(self.d.roots)]),
                                "ingestion_source_name": f"Source {k}.{j}", "resource_type": "space",
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
                              "source_url": f"https://wiki.example/{n}",
                              "provider_data": {"path": f"Space/Page {n}"}, "last_seen_at": self.ago(10)})
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
            rows.append({"id": sid, "tenant_id": ws, "code": f"space-{k}", "space_name": f"Space {k}",
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
                types.append({"id": tid, "space_id": sid, "code": f"type-{t}", "request_type_name": f"Request type {t}",
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
        convs, msgs = [], []
        session = UUID(self.d.admin_session)
        questions = ["What is the travel policy?", "How do I request leave?", "Where is the VPN guide?",
                     "Who approves purchases?", "What is the onboarding checklist?"]
        for k in range(s.conversations):
            cid = uuid4()
            last = self.ago(60)
            convs.append({"id": cid, "tenant_id": ws, "code": f"conv-{k:04d}", "owner_user_id": self.admin,
                          "created_by_session_id": session, "conversation_name": f"Conversation {k}", "pinned": k % 10 == 0,
                          "scope_collection_ids": [UUID(self.d.roots[k % len(self.d.roots)])],
                          "scope_space_ids": [], "state": {}, "last_message_at": last,
                          "created_at": last - timedelta(hours=1)})
            self.d.conversations.append(str(cid))
            for m in range(s.messages_per_conversation):
                mid = uuid4()
                user = m % 2 == 0
                rating = "unhelpful" if not user and m % 6 == 1 else None
                msgs.append({"id": mid, "conversation_id": cid, "role": "user" if user else "assistant",
                             "content": questions[(k + m) % len(questions)] if user else "Here is the answer.",
                             "sequence_number": m + 1,
                             "generation_state": "completed", "feedback_rating": rating,
                             "feedback_at": last if rating else None,
                             "created_at": last - timedelta(minutes=s.messages_per_conversation - m)})
                if not user:
                    self.d.messages.append((str(cid), str(mid)))
        await self.put("conversations", convs)
        await self.put("messages", msgs)
        # Artifacts: documents in the admin's hidden collection.
        items, arts, revs = [], [], []
        for k in range(s.artifacts):
            aid = uuid4()
            items.append({"id": aid, "tenant_id": ws, "item_kind": "document", "item_type": "markdown",
                          "parent_item_id": self.artifact_collection,
                          "item_name": f"Artifact {k}", "purpose": "knowledge",
                          "is_published": True, "created_by_user_id": self.admin,
                          "owner_user_id": self.admin})
            arts.append({"item_id": aid, "kind": "draft",
                         "conversation_id": UUID(self.d.conversations[k % len(self.d.conversations)]),
                         "audience": "private"})
            revs.append({"id": uuid4(), "item_id": aid, "revision_number": 1, "content_id": uuid4(),
                         "file_name": f"artifact-{k}.md", "mime_type": "text/markdown",
                         "size_bytes": 64, "author": "assistant"})
            self.d.artifacts.append(str(aid))
        await self.put("items", items)
        await self.set_index_states([{"item_id": row["id"], "index_status": "unsupported"} for row in items])
        await self.put("artifacts", arts)
        await self.put("item_revisions", revs)
        await self.show([(row["item_id"], row["id"]) for row in revs])

    async def library(self) -> None:
        ws, s = self.ws, self.s
        saved = self.published[:60]
        await self.put("saved_items", [{"tenant_id": ws, "user_id": self.admin, "item_id": d} for d in saved])
        self.d.saved_items = [str(d) for d in saved]
        recent = self.published[60:160]
        await self.put("recent_items", [{"tenant_id": ws, "user_id": self.admin, "item_id": d,
                                         "viewed_at": self.ago(14)} for d in recent])
        self.d.recent_items = [str(d) for d in recent]
        searches = [{"id": uuid4(), "tenant_id": ws, "user_id": self.admin, "saved_search_name": f"Search {k}",
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
