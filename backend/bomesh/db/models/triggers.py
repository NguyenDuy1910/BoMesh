"""Cross-row invariants that CHECK constraints cannot express.

Every function and trigger is installed through SQLAlchemy metadata, so
``create_all`` stays the one way the schema is created. DDL text is subject to
Python ``%`` formatting, so no statement here contains a ``%`` character.
Trigger failures raise ``P0001`` (``RAISE EXCEPTION``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import DDL, Connection, MetaData, event

#: Small predicates shared by the trigger functions below.
_HELPERS = (
    """
    CREATE OR REPLACE FUNCTION bomesh_is_active_member(p_user uuid, p_tenant uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM tenant_memberships
        WHERE user_id = p_user AND tenant_id = p_tenant
          AND status = 'active' AND deleted_at IS NULL
      )
    $$
    """,
    """
    CREATE OR REPLACE FUNCTION bomesh_is_item(p_item uuid, p_tenant uuid, p_kind text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM items
        WHERE id = p_item AND tenant_id = p_tenant AND item_kind = p_kind
      )
    $$
    """,
    """
    CREATE OR REPLACE FUNCTION bomesh_is_space(p_space uuid, p_tenant uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM spaces WHERE id = p_space AND tenant_id = p_tenant)
    $$
    """,
    # Generic same-tenant reference check. Arguments: the tenant column of the
    # row, then (reference column, referenced table) pairs; every referenced
    # table has ``id`` and ``tenant_id``.
    """
    CREATE OR REPLACE FUNCTION bomesh_require_same_tenant() RETURNS trigger AS $$
    DECLARE
      v_row jsonb := to_jsonb(NEW);
      v_tenant uuid := (v_row ->> TG_ARGV[0])::uuid;
      v_reference uuid;
      v_found boolean;
      v_index int := 1;
    BEGIN
      WHILE v_index < TG_NARGS LOOP
        v_reference := (v_row ->> TG_ARGV[v_index])::uuid;
        IF v_reference IS NOT NULL THEN
          EXECUTE 'SELECT EXISTS (SELECT 1 FROM ' || quote_ident(TG_ARGV[v_index + 1])
            || ' WHERE id = $1 AND tenant_id = $2)'
            INTO v_found USING v_reference, v_tenant;
          IF NOT v_found THEN
            RAISE EXCEPTION USING MESSAGE = TG_TABLE_NAME || '.' || TG_ARGV[v_index]
              || ' must reference ' || TG_ARGV[v_index + 1] || ' of the same tenant';
          END IF;
        END IF;
        v_index := v_index + 2;
      END LOOP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
    """,
)


@dataclass(frozen=True, slots=True)
class _Trigger:
    """One ROW trigger (``BEFORE`` unless ``timing``) and, unless shared, its own function.

    ``deferred`` makes it an ``AFTER`` constraint trigger checked at commit, for
    invariants that span rows written in one transaction.
    """

    table: str
    name: str
    events: str
    body: str | None = None
    function: str | None = None
    arguments: tuple[str, ...] = ()
    when: str | None = None
    timing: str = "BEFORE"
    deferred: bool = False

    def statements(self) -> list[str]:
        function = self.function or f"bomesh_validate_{self.table}_{self.name}"
        statements = []
        if self.body is not None:
            statements.append(
                f"CREATE OR REPLACE FUNCTION {function}() RETURNS trigger AS $$\n"
                f"{self.body}\n$$ LANGUAGE plpgsql"
            )
        arguments = ", ".join(f"'{argument}'" for argument in self.arguments)
        when = f" WHEN ({self.when})" if self.when else ""
        kind, timing = ("CONSTRAINT TRIGGER", "AFTER") if self.deferred else ("TRIGGER", self.timing)
        deferrable = " DEFERRABLE INITIALLY DEFERRED" if self.deferred else ""
        statements.append(
            f"CREATE {kind} trg_{self.table}_{self.name}"
            f" {timing} {self.events} ON {self.table}{deferrable}"
            f" FOR EACH ROW{when} EXECUTE FUNCTION {function}({arguments})"
        )
        return statements


def _same_tenant(table: str, tenant_column: str, *references: tuple[str, str]) -> _Trigger:
    columns = ", ".join(column for column, _ in references)
    return _Trigger(
        table=table,
        name="same_tenant",
        events=f"INSERT OR UPDATE OF {tenant_column}, {columns}",
        function="bomesh_require_same_tenant",
        arguments=(tenant_column, *(part for pair in references for part in pair)),
    )


_TRIGGERS = (
    _Trigger(
        table="access_sessions",
        name="lineage",
        events=(
            "INSERT OR UPDATE OF user_id, auth_identity_id, authentication_method, "
            "parent_session_id"
        ),
        body="""
DECLARE
  v_parent record;
BEGIN
  IF NEW.auth_identity_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM auth_identities WHERE id = NEW.auth_identity_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Access Session identity must belong to its User';
  END IF;
  IF NEW.parent_session_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM access_sessions WHERE id = NEW.parent_session_id;
    IF v_parent.user_id IS DISTINCT FROM NEW.user_id
       OR v_parent.authentication_method IS DISTINCT FROM NEW.authentication_method
       OR v_parent.auth_identity_id IS DISTINCT FROM NEW.auth_identity_id THEN
      RAISE EXCEPTION 'a rotated Access Session keeps the User, method and identity of its parent';
    END IF;
  END IF;
  RETURN NEW;
END;
""",
    ),
    # Tenant, kind and type are immutable; the containment policy: a collection
    # may be a root and its parent is a collection; a document is never a root
    # and its parent is a collection or a document (source sync).
    _Trigger(
        table="items",
        name="tree",
        events="INSERT OR UPDATE OF tenant_id, item_kind, item_type, parent_item_id",
        body="""
DECLARE
  v_parent_tenant uuid;
  v_parent_kind varchar(16);
  v_parent_deleted timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id <> OLD.tenant_id OR NEW.item_kind <> OLD.item_kind
    OR NEW.item_type <> OLD.item_type
  ) THEN
    RAISE EXCEPTION 'Item tenant, kind and type are immutable';
  END IF;
  IF NEW.parent_item_id IS NULL THEN
    IF NEW.item_kind = 'document' THEN
      RAISE EXCEPTION 'a Document is never a root';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.parent_item_id IS NOT DISTINCT FROM OLD.parent_item_id THEN
    RETURN NEW;
  END IF;
  SELECT tenant_id, item_kind, deleted_at
  INTO v_parent_tenant, v_parent_kind, v_parent_deleted
  FROM items WHERE id = NEW.parent_item_id;
  IF NOT FOUND OR v_parent_tenant <> NEW.tenant_id OR v_parent_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Item parent must be a live Item of the same tenant';
  END IF;
  IF NEW.item_kind = 'collection' AND v_parent_kind <> 'collection' THEN
    RAISE EXCEPTION 'a Collection''s parent is a Collection';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestry(id, parent_item_id) AS (
      SELECT id, parent_item_id FROM items WHERE id = NEW.parent_item_id
      UNION
      SELECT i.id, i.parent_item_id FROM items i JOIN ancestry a ON i.id = a.parent_item_id
    )
    SELECT 1 FROM ancestry WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Item hierarchy cycle detected';
  END IF;
  RETURN NEW;
END;
""",
    ),
    # A revision belongs to a Document and its content maps to the Document's
    # file class (bomesh_file_class, generated from the format registry).
    _Trigger(
        table="item_revisions",
        name="document",
        events="INSERT OR UPDATE OF item_id, mime_type, file_name",
        body="""
DECLARE
  v_kind varchar(16);
  v_type varchar(64);
BEGIN
  SELECT item_kind, item_type INTO v_kind, v_type FROM items WHERE id = NEW.item_id;
  IF v_kind IS DISTINCT FROM 'document' THEN
    RAISE EXCEPTION 'only Document Items have revisions';
  END IF;
  IF bomesh_file_class(NEW.mime_type, NEW.file_name) <> v_type THEN
    RAISE EXCEPTION 'a revision''s content must map to its Document item_type';
  END IF;
  RETURN NEW;
END;
""",
    ),
    # A Document shows its newest live revision, and shows one whenever it has
    # one; checked at commit because the revision and the pointer are written
    # in one transaction (item_model.md §4.8).
    _Trigger(
        table="items",
        name="current_revision",
        events="INSERT OR UPDATE OF current_revision_id",
        deferred=True,
        function="bomesh_check_item_current_revision",
        body="""
DECLARE
  v_item uuid;
  v_current uuid;
  v_newest uuid;
BEGIN
  IF TG_TABLE_NAME = 'items' THEN
    v_item := NEW.id;
  ELSE
    v_item := NEW.item_id;
  END IF;
  SELECT current_revision_id INTO v_current FROM items WHERE id = v_item;
  SELECT id INTO v_newest FROM item_revisions
  WHERE item_id = v_item AND deleted_at IS NULL
  ORDER BY revision_number DESC LIMIT 1;
  IF v_current IS DISTINCT FROM v_newest THEN
    RAISE EXCEPTION 'an Item''s current revision must be its newest live revision';
  END IF;
  RETURN NULL;
END;
""",
    ),
    _Trigger(
        table="item_revisions",
        name="current_revision",
        events="INSERT OR UPDATE OF deleted_at",
        deferred=True,
        function="bomesh_check_item_current_revision",
    ),
    # An upload belongs to a Document of its tenant, promises content of the
    # Document's file class and, for an archive member, names an archive
    # Document of the same tenant.
    _Trigger(
        table="item_uploads",
        name="document",
        events="INSERT OR UPDATE OF item_id, tenant_id, mime_type, file_name, archive_item_id",
        body="""
DECLARE
  v_type varchar(64);
BEGIN
  SELECT item_type INTO v_type FROM items
  WHERE id = NEW.item_id AND tenant_id = NEW.tenant_id AND item_kind = 'document';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an Item Upload must reference a Document of its tenant';
  END IF;
  IF bomesh_file_class(NEW.mime_type, NEW.file_name) <> v_type THEN
    RAISE EXCEPTION 'an Item Upload''s content must map to its Document item_type';
  END IF;
  IF NEW.archive_item_id IS NOT NULL
     AND NOT bomesh_is_item(NEW.archive_item_id, NEW.tenant_id, 'document') THEN
    RAISE EXCEPTION 'an archive member comes from a Document of its tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="item_index_states",
        name="document",
        events="INSERT OR UPDATE OF item_id",
        body="""
BEGIN
  IF NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND item_kind = 'document') THEN
    RAISE EXCEPTION 'only Document Items have an index state';
  END IF;
  RETURN NEW;
END;
""",
    ),
    # Every Document has exactly one index state, created with it (pending).
    _Trigger(
        table="items",
        name="index_state",
        timing="AFTER",
        events="INSERT",
        when="NEW.item_kind = 'document'",
        function="bomesh_create_item_index_state",
        body="""
BEGIN
  INSERT INTO item_index_states (item_id) VALUES (NEW.id);
  RETURN NULL;
END;
""",
    ),
    _Trigger(
        table="contributions",
        name="references",
        events=(
            "INSERT OR UPDATE OF tenant_id, item_id, target_item_id, replaces_item_id, "
            "ingestion_source_id"
        ),
        body="""
BEGIN
  IF NOT bomesh_is_item(NEW.item_id, NEW.tenant_id, 'document') THEN
    RAISE EXCEPTION 'Contribution candidate must be a Document of its tenant';
  END IF;
  IF NEW.target_item_id IS NOT NULL
     AND NOT bomesh_is_item(NEW.target_item_id, NEW.tenant_id, 'collection') THEN
    RAISE EXCEPTION 'Contribution target must be a Collection of its tenant';
  END IF;
  IF NEW.replaces_item_id IS NOT NULL
     AND NOT bomesh_is_item(NEW.replaces_item_id, NEW.tenant_id, 'document') THEN
    RAISE EXCEPTION 'Contribution replaced Item must be a Document of its tenant';
  END IF;
  IF NEW.ingestion_source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ingestion_sources
    WHERE id = NEW.ingestion_source_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Contribution source must belong to its tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="topics",
        name="parent",
        events="INSERT OR UPDATE OF tenant_id, parent_topic_id",
        body="""
BEGIN
  IF NEW.parent_topic_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM topics
    WHERE id = NEW.parent_topic_id AND tenant_id = NEW.tenant_id AND kind = 'domain'
  ) THEN
    RAISE EXCEPTION 'a topic parent must be a domain of the same tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="item_topics",
        name="references",
        events="INSERT OR UPDATE OF item_id, topic_id",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM items i JOIN topics t ON t.tenant_id = i.tenant_id
    WHERE i.id = NEW.item_id AND i.item_kind = 'document'
      AND t.id = NEW.topic_id AND t.state = 'active' AND t.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'an Item topic tags a Document with an active topic of its tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="contribution_topics",
        name="same_tenant",
        events="INSERT OR UPDATE OF contribution_id, topic_id",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM contributions c JOIN topics t ON t.tenant_id = c.tenant_id
    WHERE c.id = NEW.contribution_id AND t.id = NEW.topic_id
  ) THEN
    RAISE EXCEPTION 'a contribution topic must belong to the contribution tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="item_shortcuts",
        name="references",
        events="INSERT OR UPDATE OF tenant_id, collection_item_id, target_item_id, deleted_at",
        when="NEW.deleted_at IS NULL",
        body="""
DECLARE
  v_container record;
  v_target record;
BEGIN
  SELECT * INTO v_container FROM items WHERE id = NEW.collection_item_id;
  SELECT * INTO v_target FROM items WHERE id = NEW.target_item_id;
  IF v_container.tenant_id <> NEW.tenant_id OR v_target.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Item shortcut container and target must belong to the shortcut tenant';
  END IF;
  IF v_container.item_kind <> 'collection' OR v_container.deleted_at IS NOT NULL
     OR v_container.item_type = 'conversation_artifacts' THEN
    RAISE EXCEPTION 'Item shortcut container must be a live Collection other than conversation_artifacts';
  END IF;
  IF v_target.item_kind <> 'document'
     OR v_target.purpose IS NOT DISTINCT FROM 'conversation_attachment' THEN
    RAISE EXCEPTION 'Item shortcut target must be a Document that is not a conversation attachment';
  END IF;
  IF v_target.parent_item_id = NEW.collection_item_id THEN
    RAISE EXCEPTION 'Item shortcut target already lives in the container';
  END IF;
  RETURN NEW;
END;
""",
    ),
    # A share or invite names targets, role and recipients of its own tenant;
    # an invite grants a role of its target's scope on a standard Collection,
    # a space or the workspace (database_architecture.md "Resource shares").
    _Trigger(
        table="resource_shares",
        name="references",
        events=(
            "INSERT OR UPDATE OF tenant_id, kind, item_id, space_id, conversation_id, role_id, "
            "recipient_user_ids"
        ),
        when="NEW.revoked_at IS NULL",
        body="""
DECLARE
  v_item record;
  v_role record;
  v_scope text := 'tenant';
BEGIN
  IF NEW.item_id IS NOT NULL THEN
    SELECT * INTO v_item FROM items WHERE id = NEW.item_id;
    IF v_item.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Resource share item must belong to the share tenant';
    END IF;
    IF NEW.kind = 'invite'
       AND (v_item.item_kind <> 'collection' OR v_item.item_type <> 'standard') THEN
      RAISE EXCEPTION 'an invite targets a standard Collection, never a document or a system Collection';
    END IF;
    v_scope := 'collection';
  ELSIF NEW.space_id IS NOT NULL THEN
    IF NOT bomesh_is_space(NEW.space_id, NEW.tenant_id) THEN
      RAISE EXCEPTION 'Resource share space must belong to the share tenant';
    END IF;
    v_scope := 'space';
  ELSIF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Resource share conversation must belong to the share tenant';
  END IF;
  IF NEW.role_id IS NOT NULL THEN
    SELECT * INTO v_role FROM roles WHERE id = NEW.role_id;
    IF v_role.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'an invite grants a live Role';
    END IF;
    IF v_role.tenant_id IS NULL AND v_role.scope_type <> v_scope THEN
      RAISE EXCEPTION 'an invite Role scope must match its target scope';
    END IF;
    IF v_role.tenant_id IS NOT NULL AND v_role.tenant_id <> NEW.tenant_id THEN
      RAISE EXCEPTION 'an invite grants a custom Role of its own tenant';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.recipient_user_ids) AS recipient(user_id)
    WHERE NOT bomesh_is_active_member(recipient.user_id, NEW.tenant_id)
  ) THEN
    RAISE EXCEPTION 'Resource share recipients must be active members of the share tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _same_tenant("saved_items", "tenant_id", ("item_id", "items")),
    _same_tenant("recent_items", "tenant_id", ("item_id", "items")),
    _Trigger(
        table="topic_corrections",
        name="references",
        events="INSERT OR UPDATE OF tenant_id, item_id, actor_user_id",
        body="""
BEGIN
  IF NOT bomesh_is_item(NEW.item_id, NEW.tenant_id, 'document') THEN
    RAISE EXCEPTION 'Topic Correction item must be a Document of its tenant';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id)
     AND NOT bomesh_is_active_member(NEW.actor_user_id, NEW.tenant_id) THEN
    RAISE EXCEPTION 'Topic Correction actor must be an active member of its tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="topic_correction_changes",
        name="same_tenant",
        events="INSERT OR UPDATE OF topic_correction_id, topic_id",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM topic_corrections c JOIN topics t ON t.tenant_id = c.tenant_id
    WHERE c.id = NEW.topic_correction_id AND t.id = NEW.topic_id
  ) THEN
    RAISE EXCEPTION 'a Topic Correction change must reference a Topic of the correction tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    # A correction records at least one changed topic: checked at commit, after the
    # correction and its change rows are all written (or the correction is deleted).
    _Trigger(
        table="topic_corrections",
        name="has_changes",
        events="INSERT",
        deferred=True,
        function="bomesh_require_topic_correction_change",
        body="""
DECLARE
  v_correction uuid;
BEGIN
  IF TG_TABLE_NAME = 'topic_corrections' THEN
    v_correction := NEW.id;
  ELSE
    v_correction := OLD.topic_correction_id;
  END IF;
  IF EXISTS (SELECT 1 FROM topic_corrections WHERE id = v_correction)
     AND NOT EXISTS (
       SELECT 1 FROM topic_correction_changes WHERE topic_correction_id = v_correction
     ) THEN
    RAISE EXCEPTION 'a Topic Correction records at least one topic change';
  END IF;
  RETURN NULL;
END;
""",
    ),
    _Trigger(
        table="topic_correction_changes",
        name="has_changes",
        events="DELETE OR UPDATE OF topic_correction_id",
        deferred=True,
        function="bomesh_require_topic_correction_change",
    ),
    _same_tenant("knowledge_gap_decisions", "tenant_id", ("resolved_by_item_id", "items")),
    _Trigger(
        table="role_assignments",
        name="scope",
        events=(
            "INSERT OR UPDATE OF user_id, group_id, all_members, role_id, tenant_id, item_id, "
            "space_id, deleted_at"
        ),
        when="NEW.deleted_at IS NULL",
        body="""
DECLARE
  v_role record;
  v_scope varchar(16);
  v_scope_tenant uuid;
  v_collection_owner uuid;
  v_collection_type text;
BEGIN
  SELECT * INTO v_role FROM roles WHERE id = NEW.role_id;
  IF v_role.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Role Assignment must reference a live Role';
  END IF;

  IF NEW.item_id IS NOT NULL THEN
    v_scope := 'collection';
    SELECT tenant_id, created_by_user_id, item_type
    INTO v_scope_tenant, v_collection_owner, v_collection_type
    FROM items
    WHERE id = NEW.item_id AND item_kind = 'collection' AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Collection-scoped Role Assignment must target a live Collection';
    END IF;
  ELSIF NEW.space_id IS NOT NULL THEN
    v_scope := 'space';
    SELECT tenant_id INTO v_scope_tenant
    FROM spaces WHERE id = NEW.space_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Space-scoped Role Assignment must target a live space';
    END IF;
  ELSIF NEW.tenant_id IS NOT NULL THEN
    v_scope := 'tenant';
    v_scope_tenant := NEW.tenant_id;
  ELSE
    v_scope := 'platform';
  END IF;

  IF v_role.tenant_id IS NULL THEN
    IF v_role.scope_type <> v_scope THEN
      RAISE EXCEPTION 'Role scope does not match the Role Assignment scope';
    END IF;
  ELSIF v_role.tenant_id IS DISTINCT FROM v_scope_tenant THEN
    RAISE EXCEPTION 'a custom Role is assigned only within its own tenant';
  END IF;

  IF NEW.all_members THEN
    IF v_role.tenant_id IS NOT NULL OR v_role.code <> 'collectionViewer' THEN
      RAISE EXCEPTION 'an all-members grant uses the predefined collectionViewer role';
    END IF;
  ELSIF NEW.group_id IS NOT NULL THEN
    IF v_scope_tenant IS NULL THEN
      RAISE EXCEPTION 'a platform Role cannot be assigned to a group';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM groups
      WHERE id = NEW.group_id AND tenant_id = v_scope_tenant AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Role Assignment group must belong to the scope tenant';
    END IF;
  ELSIF v_scope_tenant IS NOT NULL
        AND NOT bomesh_is_active_member(NEW.user_id, v_scope_tenant) THEN
    RAISE EXCEPTION 'Role Assignment user must be an active member of the scope tenant';
  END IF;

  IF v_collection_type = 'personal'
     AND NEW.user_id IS DISTINCT FROM v_collection_owner THEN
    RAISE EXCEPTION 'a personal Collection carries only its owner grant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="group_memberships",
        name="tenant",
        events="INSERT OR UPDATE OF group_id, user_id, deleted_at",
        when="NEW.deleted_at IS NULL",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM groups g
    JOIN tenant_memberships m ON m.tenant_id = g.tenant_id AND m.deleted_at IS NULL
    WHERE g.id = NEW.group_id AND g.deleted_at IS NULL AND m.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'a group member must belong to the group tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="ingestion_sources",
        name="references",
        events="INSERT OR UPDATE OF tenant_id, integration_connection_id, target_item_id",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM integration_connections
    WHERE id = NEW.integration_connection_id AND tenant_id = NEW.tenant_id
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Ingestion Source connection must be live and belong to its tenant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM items
    WHERE id = NEW.target_item_id AND tenant_id = NEW.tenant_id
      AND item_kind = 'collection' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Ingestion Source target must be a live Collection of its tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="external_resources",
        name="same_tenant",
        events="INSERT OR UPDATE OF item_id, ingestion_source_id",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM items i JOIN ingestion_sources s ON s.tenant_id = i.tenant_id
    WHERE i.id = NEW.item_id AND s.id = NEW.ingestion_source_id
  ) THEN
    RAISE EXCEPTION 'External Resource and Ingestion Source must belong to the same tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _same_tenant("ingestion_runs", "tenant_id", ("retry_of_run_id", "ingestion_runs")),
    _Trigger(
        table="conversations",
        name="owner",
        events=(
            "INSERT OR UPDATE OF tenant_id, owner_user_id, created_by_session_id, "
            "scope_collection_ids, scope_space_ids"
        ),
        body="""
DECLARE
  v_creator uuid;
BEGIN
  SELECT user_id INTO v_creator FROM access_sessions WHERE id = NEW.created_by_session_id;
  IF v_creator IS DISTINCT FROM NEW.owner_user_id THEN
    RAISE EXCEPTION 'Conversation creator session must belong to its owner';
  END IF;
  IF TG_OP = 'INSERT' AND NOT bomesh_is_active_member(NEW.owner_user_id, NEW.tenant_id) THEN
    RAISE EXCEPTION 'Conversation owner must be an active member of its tenant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.scope_collection_ids) AS scope(id)
    WHERE NOT bomesh_is_item(scope.id, NEW.tenant_id, 'collection')
  ) THEN
    RAISE EXCEPTION 'Conversation scope collections must be Collections of its tenant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.scope_space_ids) AS scope(id)
    WHERE NOT bomesh_is_space(scope.id, NEW.tenant_id)
  ) THEN
    RAISE EXCEPTION 'Conversation scope spaces must be spaces of its tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _same_tenant("sandbox_sessions", "tenant_id", ("conversation_id", "conversations")),
    _Trigger(
        table="artifacts",
        name="references",
        events="INSERT OR UPDATE OF item_id, conversation_id, space_id",
        body="""
DECLARE
  v_tenant uuid;
  v_kind varchar(16);
  v_parent_type varchar(64);
BEGIN
  SELECT i.tenant_id, i.item_kind, p.item_type
  INTO v_tenant, v_kind, v_parent_type
  FROM items i LEFT JOIN items p ON p.id = i.parent_item_id
  WHERE i.id = NEW.item_id;
  IF v_kind <> 'document' OR v_parent_type IS DISTINCT FROM 'conversation_artifacts' THEN
    RAISE EXCEPTION 'an Artifact is a Document in the conversation_artifacts Collection';
  END IF;
  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'Artifact conversation must belong to the Artifact tenant';
  END IF;
  IF NEW.space_id IS NOT NULL AND NOT bomesh_is_space(NEW.space_id, v_tenant) THEN
    RAISE EXCEPTION 'Artifact space must belong to the Artifact tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="artifact_source_items",
        name="same_tenant",
        events="INSERT OR UPDATE OF artifact_item_id, item_id",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM items a JOIN items s ON s.tenant_id = a.tenant_id
    WHERE a.id = NEW.artifact_item_id AND s.id = NEW.item_id AND s.item_kind = 'document'
  ) THEN
    RAISE EXCEPTION 'an Artifact source must be a Document of the Artifact tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="space_materials",
        name="same_tenant",
        events="INSERT OR UPDATE OF space_id, item_id",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM spaces s JOIN items i ON i.tenant_id = s.tenant_id
    WHERE s.id = NEW.space_id AND i.id = NEW.item_id
  ) THEN
    RAISE EXCEPTION 'a space material must reference an Item of the space tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="requests",
        name="references",
        events=(
            "INSERT OR UPDATE OF tenant_id, space_id, request_type_id, collection_item_id, "
            "faq_item_id, requester_user_id, assignee_user_id"
        ),
        body="""
BEGIN
  IF NEW.space_id IS NOT NULL AND NOT bomesh_is_space(NEW.space_id, NEW.tenant_id) THEN
    RAISE EXCEPTION 'Request space must belong to its tenant';
  END IF;
  IF NEW.request_type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM request_types WHERE id = NEW.request_type_id AND space_id = NEW.space_id
  ) THEN
    RAISE EXCEPTION 'Request type must belong to the request space';
  END IF;
  IF NEW.collection_item_id IS NOT NULL
     AND NOT bomesh_is_item(NEW.collection_item_id, NEW.tenant_id, 'collection') THEN
    RAISE EXCEPTION 'Request collection must be a Collection of its tenant';
  END IF;
  IF NEW.faq_item_id IS NOT NULL
     AND NOT bomesh_is_item(NEW.faq_item_id, NEW.tenant_id, 'document') THEN
    RAISE EXCEPTION 'Request FAQ item must be a Document of its tenant';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id)
     AND NOT bomesh_is_active_member(NEW.requester_user_id, NEW.tenant_id) THEN
    RAISE EXCEPTION 'Request requester must be an active member of its tenant';
  END IF;
  IF NEW.assignee_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id
          OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id)
     AND NOT bomesh_is_active_member(NEW.assignee_user_id, NEW.tenant_id) THEN
    RAISE EXCEPTION 'Request assignee must be an active member of its tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    # Not an invariant: tells the ingestion worker (LISTEN bomesh_cover) that a
    # document's content arrived or its current content changed, so it
    # produces the cover (document_viewer.md "Cover on the Item"). Delivered
    # on commit; nothing is notified for a rolled-back change.
    _Trigger(
        table="items",
        name="cover",
        timing="AFTER",
        events="INSERT OR UPDATE OF current_revision_id",
        when=(
            "NEW.item_kind = 'document' AND NEW.current_revision_id IS NOT NULL"
            " AND NEW.deleted_at IS NULL"
        ),
        function="bomesh_notify_item_cover",
        body="""
BEGIN
  IF TG_OP = 'INSERT' OR OLD.current_revision_id IS DISTINCT FROM NEW.current_revision_id THEN
    PERFORM pg_notify('bomesh_cover', NEW.id::text);
  END IF;
  RETURN NULL;
END;
""",
    ),
)


def _create_file_class_function(_metadata: MetaData, connection: Connection, **_: Any) -> None:
    """``bomesh_file_class``: the Document file-class rule, generated from the format registry.

    Imported at create time because the registry lives in the services layer,
    whose package imports these models.
    """
    from bomesh.services.knowledge_items.file_types import file_class_function_sql

    if connection.dialect.name == "postgresql":
        connection.execute(DDL(file_class_function_sql()))


def install(metadata: MetaData) -> None:
    """Create the helper functions and triggers after the tables exist."""

    event.listen(metadata, "after_create", _create_file_class_function)
    statements = [*_HELPERS]
    for trigger in _TRIGGERS:
        statements.extend(trigger.statements())
    for statement in statements:
        event.listen(
            metadata, "after_create", DDL(statement).execute_if(dialect="postgresql")
        )
