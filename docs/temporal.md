# Temporal runtime

BoMesh uses Temporal only to orchestrate two kinds of execution. PostgreSQL is
the single store of their state; nothing reads Temporal visibility, and no
custom Search Attributes are registered.

| Workflow | Id | Started by | Does |
| --- | --- | --- | --- |
| `IngestionRunWorkflow` (`bomesh.ingestion_run`) | `ingestion-run:<run_id>` | `IngestionRunService.create_run` (manual, API, scheduled) | processes one Ingestion Run's Documents |
| `SourceSyncWorkflow` (`bomesh.source_sync`) | `source-sync:<source_id>` | "Sync now", Source creation, the Source's Temporal Schedule | registers what changed at the provider; a scheduled firing then creates one run |

Uploading and syncing never process anything: they only register pending
Documents. One run covers many Documents, so 200 selected Documents are one
workflow, never 200.

## Local setup

The local Compose stack runs Temporal on `127.0.0.1:7233` and its UI on
`127.0.0.1:8080`:

```bash
make services
```

Run the API and worker as separate processes (or `cd backend && uv run main.py`,
which supervises both):

```bash
cd backend
uv run python main.py
uv run python -m bomesh.services.workflow.worker
```

For Temporal Cloud, set `BOMESH_TEMPORAL_TARGET`,
`BOMESH_TEMPORAL_NAMESPACE`, `BOMESH_TEMPORAL_API_KEY`, and
`BOMESH_TEMPORAL_TLS=true`.

## How a run executes

```text
start_run ─► plan_batches ─► process_batch × ≤ parallelism ─► … ─► finish_run
                 ▲                    │ (records each Document's status,
                 └──── next window ◄──┘  phases and error in PostgreSQL)
```

- `plan_batches` assigns the run's queued Documents to batches packed by size,
  bounded by `BOMESH_INGESTION_BATCH_MAX_ITEMS` (default 8) and
  `BOMESH_INGESTION_BATCH_MAX_BYTES` (default 64 MiB); a large file is a batch
  of its own. It is idempotent: a retried call returns the batches already
  planned.
- At most `BOMESH_INGESTION_RUN_PARALLELISM` (default 4) `process_batch`
  activities run at once; the worker's `BOMESH_TEMPORAL_MAX_CONCURRENT_ACTIVITIES`
  bounds a process across runs.
- `process_batch` processes its Documents one after another, heartbeating.
  A Document's own failure (unreadable file, no text) is recorded on its run
  item and never fails the batch. Infrastructure failures retry the batch (up
  to five attempts, bounded exponential backoff); finished Documents are
  skipped on retry. When the last attempt fails, `fail_batch` marks that
  batch's unfinished Documents failed and the run continues. An archive is
  unpacked and its members are appended to the same run.
- A model provider that refuses the account (key, credit, model) stops the
  run: in-flight batches end, the run is `failed` with the reason and its
  unprocessed Documents are `skipped`.
- The workflow continues as new when Temporal suggests it, so history stays
  bounded however many Documents a run has.
- Cancelling a run marks it `cancelled` and its queued Documents at once, then
  cancels the workflow; in-flight batches stop at their next Document,
  interrupted Documents return to `pending`, and `finish_run` still runs.
- A run whose workflow is gone (terminated, never dispatched) is reconciled
  to `failed` at API and worker startup and when its detail is read.

## Syncs and schedules

A sync's workflow id is the Source's, so a second "Sync now" while one runs is
`409`. Temporal Schedules (`ingestion-schedule:<source_id>`) start
`SourceSyncWorkflow` with `process = true` and default to `SKIP` overlaps.
After the sync, the workflow calls `IngestionRunService.create_run` with
`trigger = scheduled` for the Source's pending and outdated Documents — the
same entry point people and API clients use.
