# Performance remediation plan

Status: **plan, not implemented.** Produced from a measured audit of the running
system (production build, Chrome 1440×900, CDP Performance API, SQLAlchemy
statement counting). Each item states its evidence, root cause and the check
that proves it fixed.

## How the numbers were taken

- Web: `npm run build && npm run start` (BUILD_ID `3NbbqbmDRNN4JqCXkwOAi`).
- Backend: the running FastAPI process, local Postgres, local RustFS.
- SQL counted with a `before_cursor_execute` listener, not by enabling
  `log_min_duration_statement` (see the caveat at the end).
- **The host was under load average ≈ 4.2 while measuring.** Absolute
  millisecond figures vary by up to 20× between runs for the same call. Every
  claim below that drives a fix is **structural** — request counts, query
  counts, byte counts, code paths — and reproduces exactly. Latencies are
  quoted only to show relative weight.

## Baseline

| Route | API calls | API span | JS cold |
| --- | ---: | ---: | ---: |
| `/home` | 31 | 2002 ms | 653 KB |
| `/knowledge` | 30 | 1502 ms | 17 KB |
| `/knowledge/library` | 21 | 1060 ms | 19 KB |
| `/documents` | 18 | 1070 ms | 74 KB |
| `/people` | 19 | 812 ms | 20 KB |
| `/requests` | 15 | 1853 ms | 4 KB |
| `/inbox` | 14 | 758 ms | 4 KB |
| `/chats` | 22 | 833 ms | 2 KB |

`/knowledge` cold load: **27 JS files, 499 KB transferred, 1631 KB decoded**.
The build emits **1680 chunks / 11 MB** in total.

SQL per list call, counted exactly:

| Endpoint | Queries | Per item |
| --- | ---: | ---: |
| `items?pageSize=20` | 121 | 6.0 |
| `items?pageSize=100` | 166 | 5.5 |
| `items?pageSize=200` (root collections only) | 76 | — |

---

## P0 — Stop measuring the wrong thing (minutes)

### P0.1 Serve a production build

**Evidence.** `ps` showed `next dev` on `:3000`; the page loaded
`[turbopack]_browser_dev_hmr-client`, 47 unbundled chunks, and `.next/dev` was
the active output directory.

**Why it matters.** Dev mode ships unminified modules, the HMR client, dev
React and source maps. Every latency the user perceives is multiplied by it,
and no optimisation below can be evaluated while it is in place.

**Fix.** Document the run path. `apps/web/package.json` already has
`build`/`start`; add a `make web` (or equivalent) that does
`npm run build && npm run start`, and note in the README that `npm run dev` is
for editing only.

**Verify.** `ps` shows `next-server`, not `next dev`; no `browser_dev_hmr`
chunk in the network panel.

**Risk.** None. `dev` stays available.

### P0.2 Add `Timing-Allow-Origin` to the API

**Evidence.** Cross-origin resource timing returns `startTime`/`duration` only;
`requestStart`, `responseStart`, `connectEnd` come back as `0` or negative.
Server time and network time are indistinguishable from the browser.

**Fix.** One response header on `/api/v1/*` (`Timing-Allow-Origin: <web origin>`,
configurable, defaulting to the app origin).

**Verify.** `performance.getEntriesByType('resource')` on an API entry returns a
non-zero `responseStart`.

**Why first.** Every later item needs before/after numbers, and right now they
cannot be attributed.

---

## P1 — Shell cost: every page pays for the sidebar (hours)

**Evidence.** `/inbox` needs 2 API calls and receives 14. `/requests` needs 3
and receives 15. The same 12–15 calls appear on every route.

### P1.1 Nav badges download 500-row lists to display a count

`apps/web/src/components/shell/badges.ts:45,55`

```ts
// sources
const page = await call(api.GET(".../sources", { params: { path, query: { pageSize: 500 } } }));
return (page.sources ?? []).filter((s) => s.state === "FAILED" || s.state === "REAUTHORIZATION_REQUIRED").length;
// connections: same shape
```

Two 500-row list downloads per page load, filtered client-side, to produce two
integers.

**Fix.** `pageSize: 1` with the state filter pushed into `filter`, then read
`totalSize` — the pattern `documents` and `people` in the same file already
use (`badges.ts:33,67`):

```
filter=state = "FAILED" OR state = "REAUTHORIZATION_REQUIRED"
```

Feasibility confirmed in the contract, not assumed:
- `ListSourcesResponse.totalSize` and `ListConnectionsResponse.totalSize`
  exist (`openapi.yaml:12266`), and both handlers already return
  `total_size=total`.
- `state` is a filterable field on both: `source_filters` (`api/dto/ingestion/
  sources.py:122`) and `CONNECTION_FILTERS` (`api/dto/ingestion/connections.py:162`).
- The filter parser supports `OR` (`api/aip/filtering.py:6,188`).

**Verify.** Network panel shows `pageSize=1&filter=...`; badge values unchanged
on a workspace with a known failing source.

**Risk.** Low.

### P1.2 Two `useSpaces` hooks, two cache keys, two requests

- `apps/web/src/modules/spaces/queries.ts:58` → key `spacesKeys.list(id)`
- `apps/web/src/modules/knowledge/library/queries.ts:72` → key `[id, "spaces", "all"]`

Same endpoint, different key, so React Query caches them separately and the
page fetches twice.

**Fix.** Delete the duplicate; both call sites import the one in
`modules/spaces/queries.ts`.

**Verify.** One `spaces?pageSize=200` request per page load.

### P1.3 The shell fetches knowledge data on routes that never show it

`components/shell/Sidebar.tsx:61,94,98,109` mounts `useMySpaces`,
`useNavBadges`, `useKnowledgeBases` and `SidebarConversations`
unconditionally. `useKnowledgeBases` (`modules/knowledge/queries.ts:99`) is a
`items?pageSize=200` call — the most expensive endpoint in the app (6 queries
per item) — fetched on `/inbox`, `/requests`, `/chats`, `/work`.

**Fix.** Two options, pick per data:
- **Keep** what the sidebar genuinely renders (spaces, recent conversations,
  request badge) and give each a `staleTime` measured in minutes.
- **Drop from the shell** what only the Knowledge page uses (knowledge bases
  list, saved searches, topics, saved items) and mount it in the Knowledge
  layout instead.

**Verify.** `/inbox` drops from 14 to ≈5 calls; `/knowledge` keeps its own.

**Risk.** Medium — the sidebar's Manage group renders knowledge bases. Check
whether that group can read a lighter endpoint (a count) instead.

### P1.4 `useCatalog` runs one full search per domain facet

`apps/web/src/modules/knowledge/browse/useCatalog.ts:72,108,112` issues the main
search, then `useQueries` over `domainRequests` (one `items:search` per domain),
then a paged pool. On `/knowledge` that is **5 separate searches**, each
scanning the corpus.

**Fix.** Ask the backend for facets in one call — `SearchItems` already returns
`SearchItemsFacet` values — and derive domain counts from that response instead
of re-searching per domain.

**Verify.** `/knowledge` issues 1 `items:search` instead of 5.

**Risk.** Medium. Confirm the single response carries every facet the UI groups
by; if not, extend the facet request rather than re-searching.

---

## P2 — Backend N+1 in item projection (the real debt)

**Evidence.** `items?pageSize=20` runs 121 statements; `pageSize=100` runs 166.
Distribution inside one 20-item request:

```
×27  WITH RECURSIVE governed_documents(...)      visibility, per item
×23  SELECT roles.scope_type, role_permissions   grants, per item
×21  WITH RECURSIVE item_path(...)               ancestry, per item
× 9  item_revisions / topics / now()             per document
```

**Root cause.** `backend/bomesh/services/knowledge_items/items.py:520-525`:

```python
records = [
    await projector.project(row, full=full)   # awaited sequentially, per row
    for row in rows
]
```

and `support.py:302 project()` calls, per item,
`collection_permissions()` (authorizer.py:267) → `ancestry()` +
a chain-grant query, then `_document()` (support.py:426) → revision + topics +
`SELECT now()`.

The authorizer *does* cache (`_member`, `_groups`, `_workspace` maps), so
workspace-level grants resolve once — but `ancestry`, the chain-grant query,
the revision lookup, the topic lookup and `now()` are all per-item and
uncached.

**Why it is debt rather than a current outage.** Against local Postgres each
statement is ~0.1 ms, so the whole thing costs ~20 ms and is invisible. With a
remote database at 2 ms RTT, or a 100-row page, the same code is 300 ms–1 s
per list call — and the shell calls it on every page (P1.3).

**Fix — batch the six per-item lookups into six per-request ones:**

| Lookup | Today | Batch |
| --- | --- | --- |
| `ancestry(item_id)` | 1 recursive CTE per item | one CTE over `id = ANY($1)` |
| chain grants | 1 query per item | one query grouped by item |
| `governed_documents` visibility | 1 per item | one query over the id set |
| `current_revision(item_id)` | 1 per item | one query `WHERE item_id = ANY($1)` |
| `topics` | 1 per item | one query `WHERE item_id = ANY($1)` |
| `SELECT now()` | 1 per item | once per request |

Target: `items?pageSize=20` from 121 → **≤10 statements**, independent of page
size except for the batch arrays.

**Verify.** Re-run the statement counter; assert `queries < 15` for pageSize
20/100/200 in a unit test so it cannot regress.

**Risk.** Medium-high. This touches authorization resolution, so the invariant
is: **a batched visibility/permission result must equal the per-item result for
every item.** Test with a mixed set (readable, unreadable, deleted ancestor,
personal collection, LOCKED root) before and after.

**Do not** parallelise the existing loop with `asyncio.gather` and call it
fixed — it multiplies concurrent statements on one session, which is not safe
and does not reduce the count.

---

## P3 — Bundle (after P0–P2)

**Evidence.** 1680 chunks / 11 MB emitted; a single page loads 27 files,
499 KB transferred, 1631 KB decoded.

**Steps, in order of measured value:**
1. Identify the top 5 chunks by decoded size (HeroUI + react-aria dominate).
2. Move dialogs/editors that are not needed on first paint behind
   `next/dynamic` (`ContributeDialog`, `EditDetailsDialog`, artifact editors).
3. Re-measure decoded KB per route; keep a budget in CI.

**Verify.** Per-route decoded JS budget, enforced.

**Risk.** Low, but do it last: the API work in P1/P2 changes perceived speed
more than the bundle does on a warm cache.

---

## P4 — Session expiry (small, user-visible)

**Evidence.** `backend/config/env_config.py:154` — JWT TTL 900 s. On expiry the
app redirects to `/signin` silently; during this audit it happened four times
and each time the current view was lost with no message.

**Fix.** On a `401` from a data call, refresh silently if a refresh path
exists; otherwise show a "session expired — sign in to continue" prompt that
preserves the return URL. Never a bare redirect mid-task.

**Verify.** Force a 401 (expired token) on `/knowledge` and confirm the message
and return-to path.

---

## Sequencing and acceptance

| Phase | Items | Effort | Unblocks |
| --- | --- | --- | --- |
| P0 | production build, `Timing-Allow-Origin` | minutes | trustworthy measurement |
| P1 | badges, duplicate `useSpaces`, shell scope, catalog facets | ~1 day | −10 to −25 calls/page |
| P2 | batch item projection | ~2–3 days | query count independent of page size |
| P3 | bundle | ~1 day | first-load weight |
| P4 | session expiry | ~half day | user-visible papercut |

**Acceptance for the whole plan**, measured on a production build with the host
otherwise idle:

- `/inbox` ≤ 6 API calls; `/knowledge` ≤ 10; `/home` ≤ 12.
- `items` list ≤ 10 SQL statements at pageSize 20, 100 and 200.
- No duplicate endpoint calls on any route.
- Every route's API span under 500 ms locally.
- No route ships more than 400 KB decoded JS on first load.

## Rollback

Every item is independently revertable: P1 is query-parameter and call-site
changes, P2 is one service method (`project`) with a batch preload, P3 is
import boundaries, P4 is error handling. P2 is the only one that touches
authorization, so it ships behind the existing test suite plus the mixed-set
fixture described above.

---

## A caveat worth recording

While hunting the slow query I enabled `log_min_duration_statement = 0` to find
it. Under that setting 20 concurrent list calls took **31 s**, and the obvious
conclusion — "the backend collapses under load" — would have been wrong. It was
the logging itself. With it off, the same 20 calls complete in ~180 ms.

Lesson for whoever repeats this: **measure query counts in the application, not
by turning on Postgres logging on a live instance.** A benchmark that changes
the system it measures will produce a confident, wrong answer.

---

## API load test (2026-11)

Harness: `tests/perf/` — `seed.py` (one workspace: 5,000 documents, 200 collections,
151 members, a published `domain` concept scheme with 312 concepts and labelled documents, 20 ingestion runs with 5,375 tasks, …), `load_api.py`
(`setup --recreate` · `run` · `teardown`, isolated database `bomesh_perf`; every
`openapi.yaml` operation except the model-backed ones: statement count in-process,
5 sequential calls per case against uvicorn, 20 virtual users for 60 s) and
`test_query_budgets.py` (statement budgets, flat in page size, run by the suite).
No model is called.

| | Before | After |
| --- | ---: | ---: |
| Throughput, 20 users, one uvicorn process | 7.5 req/s | **70.3 req/s** |
| Unexpected errors / 500s | 0 | 0 |
| ListItems p50 (sequential) | 6,012 ms | 72 ms |
| SearchItems facets p50 | 11,129 ms | 119 ms |
| ListIngestionTasks ps=200 p50 | 9,626 ms | ≈ 40 ms |
| ListTopics p50 | 2,390 ms | ≈ 70 ms |
| GetMemberHome p50 | 11,952 ms (142 stmts) | 248 ms (39 stmts) |
| ListNotifications | 90 stmts, 1,033 ms | 12 stmts, ≈ 32 ms |
| CreateRequest | 139 stmts | 23 stmts |
| PublishArtifact | 638 stmts, 618 checkouts | 27 stmts, 7 checkouts |
| ListArtifacts / ListReadingLists | 74→101 / 65 stmts | 13 / 14 stmts, flat |
| ImportTopics validateOnly (210 rows) | 221 stmts, row locks | 8 stmts, no locks |
| Pool checkouts per read request | 7–15 | ≤ 3 |

Fixes:

- **Visibility** (`iam/visibility.py`): the visible set is one `MATERIALIZED`, `DISTINCT`
  CTE per statement, tested with a hashed `IN … IS TRUE`; only the document-child walk
  recurses. The recursive estimate went from ~8 M rows to the real ~5 k, so JIT and
  per-row rescans no longer occur.
- **Pool and authorizer**: JIT off on the app engines; `BOMESH_DB_POOL_SIZE` /
  `BOMESH_DB_MAX_OVERFLOW` (default 20 + 20); a request's authorization lookups share one
  autocommit connection (`Authorizer.keep_connection`); the workspace row is read once
  per request.
- **Set-based authorization**: `Authorizer.holders_permissions` / `active_members`
  (notification fan-out, PublishArtifact audience via `visible_to`), SQL read rules for
  notification subjects (`readable_requests`, `readable_contributions`).
- **Batching**: ListArtifacts, ListReadingLists, Home (`home_reading_lists`). (The
  ListTopics/ImportTopics rows above were measured on the legacy topic taxonomy, since
  replaced by concept schemes.)

Remaining:

- Under 20 concurrent users the p95 of most reads is 0.7–1 s: one uvicorn process is
  CPU-bound at ~70 req/s. Run several API workers or replicas in production.
- GetMemberHome is still the heaviest read (39 statements, p95 0.6 s sequential, 1.9 s
  under load); ListItems/SearchItems keep 16–17 statements (7 authentication and
  authorization, flat in page size).
