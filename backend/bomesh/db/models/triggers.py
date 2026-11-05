"""Cross-row invariants that CHECK constraints cannot express.

Every function and trigger is installed through SQLAlchemy metadata, so
``create_all`` stays the one way the schema is created. DDL text is subject to
Python ``%`` formatting, so no statement here contains a ``%`` character.
Trigger failures raise ``P0001`` (``RAISE EXCEPTION``).
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import DDL, MetaData, event

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
    CREATE OR REPLACE FUNCTION bomesh_is_item(p_item uuid, p_tenant uuid, p_type text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM items
        WHERE id = p_item AND tenant_id = p_tenant AND item_type = p_type
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
    """One BEFORE ROW trigger and, unless shared, its own validation function."""

    table: str
    name: str
    events: str
    body: str | None = None
    function: str | None = None
    arguments: tuple[str, ...] = ()
    when: str | None = None

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
        statements.append(
            f"CREATE TRIGGER trg_{self.table}_{self.name}"
            f" BEFORE {self.events} ON {self.table}"
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
    _Trigger(
        table="items",
        name="tree",
        events=(
            "INSERT OR UPDATE OF tenant_id, item_type, parent_item_id, parent_relation, space_id"
        ),
        body="""
DECLARE
  v_parent_tenant uuid;
  v_parent_type varchar(16);
  v_parent_deleted timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.item_type <> OLD.item_type OR NEW.tenant_id <> OLD.tenant_id) THEN
    RAISE EXCEPTION 'Item type and tenant are immutable';
  END IF;
  IF NEW.space_id IS NOT NULL AND NOT bomesh_is_space(NEW.space_id, NEW.tenant_id) THEN
    RAISE EXCEPTION 'Item space must belong to the Item tenant';
  END IF;
  IF NEW.parent_item_id IS NULL OR (
    TG_OP = 'UPDATE'
    AND NEW.parent_item_id IS NOT DISTINCT FROM OLD.parent_item_id
    AND NEW.parent_relation IS NOT DISTINCT FROM OLD.parent_relation
  ) THEN
    RETURN NEW;
  END IF;
  SELECT tenant_id, item_type, deleted_at
  INTO v_parent_tenant, v_parent_type, v_parent_deleted
  FROM items WHERE id = NEW.parent_item_id;
  IF NOT FOUND OR v_parent_tenant <> NEW.tenant_id OR v_parent_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Item parent must be a live Item of the same tenant';
  END IF;
  IF v_parent_type = 'collection' THEN
    IF NEW.parent_relation <> 'contains' THEN
      RAISE EXCEPTION 'an Item in a Collection has parent_relation contains';
    END IF;
  ELSE
    IF NEW.item_type = 'collection' THEN
      RAISE EXCEPTION 'a Collection cannot be parented by a Document';
    END IF;
    IF NEW.parent_relation NOT IN ('child', 'attachment') THEN
      RAISE EXCEPTION 'an Item under a Document has parent_relation child or attachment';
    END IF;
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
    _Trigger(
        table="item_revisions",
        name="document",
        events="INSERT OR UPDATE OF item_id",
        body="""
BEGIN
  IF NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND item_type = 'document') THEN
    RAISE EXCEPTION 'only Document Items have revisions';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="item_uploads",
        name="document",
        events="INSERT OR UPDATE OF item_id, tenant_id",
        body="""
BEGIN
  IF NOT bomesh_is_item(NEW.item_id, NEW.tenant_id, 'document') THEN
    RAISE EXCEPTION 'an Item Upload must reference a Document of its tenant';
  END IF;
  RETURN NEW;
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
    WHERE i.id = NEW.item_id AND i.item_type = 'document'
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
    _same_tenant("reading_lists", "tenant_id", ("space_id", "spaces")),
    _Trigger(
        table="reading_list_entries",
        name="same_tenant",
        events="INSERT OR UPDATE OF reading_list_id, item_id",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reading_lists l JOIN items i ON i.tenant_id = l.tenant_id
    WHERE l.id = NEW.reading_list_id AND i.id = NEW.item_id
  ) THEN
    RAISE EXCEPTION 'a reading list entry must reference an Item of the list tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="item_links",
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
    RAISE EXCEPTION 'Item link container and target must belong to the link tenant';
  END IF;
  IF v_container.item_type <> 'collection' OR v_container.deleted_at IS NOT NULL
     OR v_container.metadata ->> 'system_kind' IS NOT DISTINCT FROM 'conversation_artifacts' THEN
    RAISE EXCEPTION 'Item link container must be a live Collection other than conversation_artifacts';
  END IF;
  IF v_target.item_type <> 'document'
     OR v_target.metadata ->> 'purpose' IS NOT DISTINCT FROM 'conversation_attachment' THEN
    RAISE EXCEPTION 'Item link target must be a Document that is not a conversation attachment';
  END IF;
  IF v_target.parent_item_id = NEW.collection_item_id THEN
    RAISE EXCEPTION 'Item link target already lives in the container';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _same_tenant("saved_items", "tenant_id", ("item_id", "items")),
    _same_tenant("recent_items", "tenant_id", ("item_id", "items")),
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
  v_collection_kind text;
BEGIN
  SELECT * INTO v_role FROM roles WHERE id = NEW.role_id;
  IF v_role.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Role Assignment must reference a live Role';
  END IF;

  IF NEW.item_id IS NOT NULL THEN
    v_scope := 'collection';
    SELECT tenant_id, created_by_user_id, metadata ->> 'system_kind'
    INTO v_scope_tenant, v_collection_owner, v_collection_kind
    FROM items
    WHERE id = NEW.item_id AND item_type = 'collection' AND deleted_at IS NULL;
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

  IF v_collection_kind = 'personal_uploads'
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
      AND item_type = 'collection' AND deleted_at IS NULL
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
    _same_tenant("memories", "tenant_id", ("conversation_id", "conversations")),
    _same_tenant("conversation_shares", "tenant_id", ("conversation_id", "conversations")),
    _Trigger(
        table="conversation_share_recipients",
        name="member",
        events="INSERT OR UPDATE OF share_id, user_id",
        body="""
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM conversation_shares
    WHERE id = NEW.share_id AND audience = 'people'
      AND bomesh_is_active_member(NEW.user_id, tenant_id)
  ) THEN
    RAISE EXCEPTION 'a share recipient must be an active member of a people share tenant';
  END IF;
  RETURN NEW;
END;
""",
    ),
    _Trigger(
        table="artifacts",
        name="references",
        events="INSERT OR UPDATE OF item_id, conversation_id, space_id",
        body="""
DECLARE
  v_tenant uuid;
  v_type varchar(16);
  v_parent_kind text;
BEGIN
  SELECT i.tenant_id, i.item_type, p.metadata ->> 'system_kind'
  INTO v_tenant, v_type, v_parent_kind
  FROM items i LEFT JOIN items p ON p.id = i.parent_item_id
  WHERE i.id = NEW.item_id;
  IF v_type <> 'document' OR v_parent_kind IS DISTINCT FROM 'conversation_artifacts' THEN
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
    WHERE a.id = NEW.artifact_item_id AND s.id = NEW.item_id AND s.item_type = 'document'
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
)


def install(metadata: MetaData) -> None:
    """Create the helper functions and triggers after the tables exist."""

    statements = [*_HELPERS]
    for trigger in _TRIGGERS:
        statements.extend(trigger.statements())
    for statement in statements:
        event.listen(
            metadata, "after_create", DDL(statement).execute_if(dialect="postgresql")
        )
