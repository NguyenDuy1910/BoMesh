-- Separate Knowledge (what exists) from Ingestion (how it is processed).
--
-- Before: an upload started its own processing on arrival (a Temporal
-- workflow per Document, or an in-process "direct" run), a Source sync
-- processed everything it found, and each upload kept its latest run in
-- items.metadata.ingestion.
-- After: adding data only changes the inventory. A Document waits, pending,
-- until an Ingestion Run that someone (or a schedule) starts processes it.
-- One run covers many Documents and keeps one execution record per Document.
BEGIN;

-- 1. Ingestion runs ----------------------------------------------------------
CREATE TABLE ingestion_runs (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    trigger_type varchar(16) NOT NULL,
    scope jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(16) NOT NULL DEFAULT 'queued',
    configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
    item_count integer NOT NULL DEFAULT 0,
    error text,
    created_by_user_id uuid,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT pk_ingestion_runs PRIMARY KEY (id),
    CONSTRAINT fk_ingestion_runs_tenant_id_tenants
        FOREIGN KEY (tenant_id) REFERENCES tenants (id),
    CONSTRAINT fk_ingestion_runs_created_by_user_id_users
        FOREIGN KEY (created_by_user_id) REFERENCES users (id),
    CONSTRAINT ck_ingestion_runs_ingestion_run_trigger_is_valid
        CHECK (trigger_type IN ('manual', 'scheduled', 'api')),
    CONSTRAINT ck_ingestion_runs_ingestion_run_status_is_valid
        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    CONSTRAINT ck_ingestion_runs_ingestion_run_item_count_is_valid
        CHECK (item_count >= 0)
);
CREATE INDEX ix_ingestion_runs_tenant_id_created_at ON ingestion_runs (tenant_id, created_at);
CREATE INDEX ix_ingestion_runs_tenant_id_status ON ingestion_runs (tenant_id, status);

CREATE TABLE ingestion_run_items (
    run_id uuid NOT NULL,
    item_id uuid NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'queued',
    batch_number integer,
    phases jsonb NOT NULL DEFAULT '[]'::jsonb,
    error text,
    chunk_count integer,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT pk_ingestion_run_items PRIMARY KEY (run_id, item_id),
    CONSTRAINT fk_ingestion_run_items_run_id_ingestion_runs
        FOREIGN KEY (run_id) REFERENCES ingestion_runs (id),
    CONSTRAINT fk_ingestion_run_items_item_id_items
        FOREIGN KEY (item_id) REFERENCES items (id),
    CONSTRAINT ck_ingestion_run_items_ingestion_run_item_status_is_valid
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
    CONSTRAINT ck_ingestion_run_items_ingestion_run_item_chunk_count_is_valid
        CHECK (chunk_count IS NULL OR chunk_count >= 0)
);
CREATE INDEX ix_ingestion_run_items_item_id_created_at ON ingestion_run_items (item_id, created_at);
CREATE INDEX ix_ingestion_run_items_run_id_status ON ingestion_run_items (run_id, status);
CREATE INDEX ix_ingestion_run_items_run_id_batch_number ON ingestion_run_items (run_id, batch_number);

-- 2. Items: one processing state, and the version it was built with ---------
ALTER TABLE items ADD COLUMN processed_version text;

-- Same format as bomesh.services.processing_version(). A missing part leaves
-- the version NULL, which reads as outdated: re-processing is the safe answer.
UPDATE items
SET processed_version =
    'parser=' || (metadata #>> '{processing,parser_version}')
    || ';chunker=' || (metadata #>> '{processing,chunker_version}')
    || ';embedding=' || (metadata #>> '{processing,embedding_model}')
    || ';schema=' || (metadata #>> '{processing,index_schema_version}')
    || ';context=' || CASE
        WHEN (metadata #>> '{processing,contextualization_enabled}') = 'true'
            THEN coalesce(metadata #>> '{processing,contextualization_model}', 'off')
        ELSE 'off'
    END
WHERE item_type = 'document'
  AND index_status = 'ready'
  AND jsonb_typeof(metadata -> 'processing') = 'object';

-- No run exists for work that was in flight: it waits for one, like any
-- other unprocessed Document. The per-upload run record is superseded by
-- ingestion_run_items.
UPDATE items SET index_status = 'pending'
WHERE item_type = 'document' AND index_status = 'processing';
UPDATE items SET metadata = metadata - 'ingestion' WHERE metadata ? 'ingestion';

-- 3. Sources: a sync only changes the inventory; keep its latest outcome ----
ALTER TABLE ingestion_sources RENAME COLUMN last_ingested_at TO last_synced_at;
ALTER TABLE ingestion_sources DROP COLUMN last_indexed_at;
ALTER TABLE ingestion_sources ADD COLUMN last_sync_status varchar(16);
ALTER TABLE ingestion_sources ADD COLUMN last_sync_error text;
ALTER TABLE ingestion_sources
    ADD COLUMN last_sync_summary jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ingestion_sources
    ADD CONSTRAINT ck_ingestion_sources_ingestion_source_sync_status_is_valid
    CHECK (
        last_sync_status IS NULL
        OR last_sync_status IN ('running', 'succeeded', 'failed')
    );
UPDATE ingestion_sources SET last_sync_status = 'succeeded'
WHERE last_synced_at IS NOT NULL;

-- 4. Permissions: knowledge vs ingestion capabilities ------------------------
INSERT INTO permissions (code, description, scope_types) VALUES
    ('knowledge.manage', 'Create and organize the workspace''s Collections', ARRAY['tenant']),
    ('ingestion.read', 'See every ingestion run in the workspace', ARRAY['tenant']),
    ('ingestion.run', 'Start processing for the documents of a Collection', ARRAY['collection', 'tenant']),
    ('ingestion.manage', 'Cancel any ingestion run in the workspace', ARRAY['tenant'])
ON CONFLICT (code) DO NOTHING;

-- item.manage is renamed, not re-granted: every role row (tombstones included)
-- keeps its history under the new code.
UPDATE role_permissions
SET permission_code = 'knowledge.manage', updated_at = now()
WHERE permission_code = 'item.manage';
DELETE FROM permissions WHERE code = 'item.manage';

UPDATE permissions
SET description = 'Manage data sources, their sync, and their schedules'
WHERE code = 'source.manage';

-- Whoever could start or watch ingestion before keeps that ability: workspace
-- source managers ran and monitored every ingestion, and Collection editors
-- re-indexed and retried their Collection's Documents.
INSERT INTO role_permissions (role_id, permission_code, deleted_at, created_at, updated_at)
SELECT rp.role_id, granted.code, rp.deleted_at, now(), now()
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
CROSS JOIN (VALUES ('ingestion.read'), ('ingestion.run'), ('ingestion.manage')) AS granted (code)
WHERE rp.permission_code = 'source.manage' AND r.scope_type = 'tenant'
ON CONFLICT (role_id, permission_code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code, deleted_at, created_at, updated_at)
SELECT rp.role_id, 'ingestion.run', rp.deleted_at, now(), now()
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
WHERE rp.permission_code = 'collection.update' AND r.scope_type IN ('tenant', 'collection')
ON CONFLICT (role_id, permission_code) DO NOTHING;

COMMIT;
