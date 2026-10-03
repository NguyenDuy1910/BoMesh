-- Remove anonymous guest sessions and public workspaces. Every request is an
-- authenticated User that reaches a tenant only through tenant_memberships and
-- role_assignments. Nothing is physically deleted: active guest sessions are
-- revoked, guest-owned conversations and the system guest role are tombstoned,
-- and 'guest' stays a valid historical access_sessions.kind that can never be
-- active again. Safe to re-run.
BEGIN;

-- Public workspaces --------------------------------------------------------

DROP TRIGGER IF EXISTS trg_tenants_validate_public_access ON tenants;
DROP FUNCTION IF EXISTS bothesis_validate_tenant_public_access();

ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS ck_tenants_public_access_is_complete,
    DROP CONSTRAINT IF EXISTS ck_tenants_tenant_public_access_is_complete,
    DROP CONSTRAINT IF EXISTS ck_tenants_tenant_visibility_is_valid,
    DROP CONSTRAINT IF EXISTS fk_tenants_public_access_role_id_roles,
    DROP COLUMN IF EXISTS public_access_role_id,
    DROP COLUMN IF EXISTS visibility;

-- Guest access sessions: revoke, keep as history ---------------------------

UPDATE access_sessions
SET status = 'revoked',
    ended_at = now(),
    end_reason = 'guest_access_retired',
    updated_at = now()
WHERE kind <> 'user'
  AND status = 'active';

ALTER TABLE access_sessions
    DROP CONSTRAINT IF EXISTS ck_access_sessions_access_session_guest_is_retired,
    ADD CONSTRAINT ck_access_sessions_access_session_guest_is_retired
        CHECK (kind = 'user' OR status <> 'active');

CREATE OR REPLACE FUNCTION bothesis_validate_access_session() RETURNS trigger AS $$
DECLARE
  identity_user uuid;
  parent_tenant uuid;
  parent_user uuid;
  parent_kind varchar(24);
BEGIN
  IF NEW.kind <> 'user' THEN
    RAISE EXCEPTION 'Access Session must belong to a User';
  END IF;
  IF NEW.auth_identity_id IS NOT NULL THEN
    SELECT user_id INTO identity_user FROM auth_identities
    WHERE id = NEW.auth_identity_id AND status = 'active';
    IF NOT FOUND OR identity_user IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'Access Session identity must be active and belong to its User';
    END IF;
  END IF;
  IF NEW.parent_session_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_session_id = NEW.id THEN
    RAISE EXCEPTION 'Access Session cannot parent itself';
  END IF;
  SELECT tenant_id, user_id, kind INTO parent_tenant, parent_user, parent_kind
  FROM access_sessions WHERE id = NEW.parent_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Access Session parent must exist'; END IF;
  IF NEW.transition_reason = 'token_rotation' THEN
    IF parent_kind <> 'user' OR parent_tenant <> NEW.tenant_id
       OR parent_user IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'token rotation must preserve session subject and tenant';
    END IF;
  ELSIF NEW.transition_reason = 'tenant_switch' THEN
    IF parent_kind <> 'user' OR parent_user IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'tenant switch must preserve the User subject';
    END IF;
  ELSE
    RAISE EXCEPTION 'Access Session transition reason is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Guest-owned conversations: tombstone, keep as history --------------------

UPDATE conversations
SET status = 'deleted',
    updated_at = now()
WHERE owner_user_id IS NULL
  AND status <> 'deleted';

ALTER TABLE conversations
    DROP CONSTRAINT IF EXISTS ck_conversations_conversation_owner_required,
    ADD CONSTRAINT ck_conversations_conversation_owner_required
        CHECK (owner_user_id IS NOT NULL OR status <> 'active');

CREATE OR REPLACE FUNCTION bothesis_validate_conversation_session() RETURNS trigger AS $$
DECLARE
  session_tenant uuid;
  creator_user_id uuid;
  creator_kind varchar(24);
BEGIN
  SELECT tenant_id, user_id, kind
  INTO session_tenant, creator_user_id, creator_kind
  FROM access_sessions WHERE id = NEW.created_by_session_id;
  IF NOT FOUND OR session_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Conversation creator session must belong to its tenant';
  END IF;
  IF creator_kind <> 'user' OR NEW.owner_user_id IS NULL
     OR creator_user_id IS DISTINCT FROM NEW.owner_user_id THEN
    RAISE EXCEPTION 'Conversation owner must match its creator User session';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- System guest role: tombstone with its grants and assignments -------------

UPDATE role_assignments assignment
SET deleted_at = now(),
    updated_at = now()
FROM roles role
WHERE assignment.role_id = role.id
  AND role.tenant_id IS NULL
  AND role.code = 'guest'
  AND assignment.deleted_at IS NULL;

UPDATE role_permissions permission_grant
SET deleted_at = now(),
    updated_at = now()
FROM roles role
WHERE permission_grant.role_id = role.id
  AND role.tenant_id IS NULL
  AND role.code = 'guest'
  AND permission_grant.deleted_at IS NULL;

UPDATE roles
SET status = 'inactive',
    updated_at = now()
WHERE tenant_id IS NULL
  AND code = 'guest'
  AND status <> 'inactive';

COMMIT;
