-- BoThesis is now BoMesh (Business-only Knowledge Mesh). Rename the database
-- functions that carry the product name; triggers reference functions by
-- identity, so they keep working unchanged. Safe to re-run.
--
-- Run it in the renamed database. Renaming the database and its role is an
-- operational step (see backend/docs_design/database_architecture.md).
BEGIN;

DO $$
DECLARE
  suffix text;
BEGIN
  FOREACH suffix IN ARRAY ARRAY[
    'validate_access_session',
    'validate_approval_request',
    'validate_conversation_session',
    'validate_external_resource',
    'validate_group_membership',
    'validate_ingestion_source',
    'validate_item_parent',
    'validate_role_assignment'
  ] LOOP
    IF to_regprocedure(format('public.bothesis_%s()', suffix)) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.bothesis_%s() RENAME TO bomesh_%s', suffix, suffix);
    END IF;
  END LOOP;
END
$$;

COMMIT;
