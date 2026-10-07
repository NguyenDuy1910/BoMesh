# BoMesh Flutter application

Flutter client for the existing `/api/v1` API, following
`docs/mobile-ux-blueprint.html`. Destinations: **Chat**, **Knowledge**,
**Inbox**, and **Manage** (only for people holding a workspace management
permission). Search and the account sheet sit in the header; the Platform
console is a separate scope opened from the account sheet. Permissions and
collection ACLs are enforced by the backend; the app uses the returned session
and effective collection permissions only to decide what to show.

## Run

Start the backend and its configured database, storage, search and workflow
services using the repository's normal setup. Then:

```bash
cd app
flutter pub get
flutter run -d <device-id> \
  --dart-define=BOMESH_API_URL=https://<api-host>
```

From the repository root, the Makefile wraps the same commands:

```bash
make app-web                       # web-server on http://127.0.0.1:5174
make app-run                       # DEVICE defaults to chrome
make app-run DEVICE=<device-id>    # see `make app-devices`
make app-run APP_ENV=prod          # uses app/env/prod.json
```

Dart defines come from `app/env/<APP_ENV>.json` (default `local`) via
`--dart-define-from-file`. Keeping them in one stable file preserves the
incremental build cache between runs. `flutter pub get` runs only when
`pubspec.yaml`/`pubspec.lock` change; `flutter run` itself uses `--no-pub`.
Extra flags pass through `FLUTTER_RUN_FLAGS`.

`flutter devices` lists available devices. The default API origin is
`http://localhost:8000`; the client appends `/api/v1`. iOS simulators can reach
the Mac through localhost. Android emulators normally use `http://10.0.2.2:8000`.
A physical device needs a reachable LAN/HTTPS host, not the phone's localhost.
There are no compiled-in user IDs, workspace IDs or development identity headers.
Unauthenticated users see the sign-in/register screen; sign in with an existing
account or register. Workspaces are reachable only through membership.

For local browser verification:

```bash
flutter run -d web-server --web-hostname=127.0.0.1 --web-port=5174 \
  --dart-define=BOMESH_API_URL=http://localhost:8000
```

The browser origin must be allowed by the API CORS policy. Secure browser storage
requires localhost or HTTPS. iOS currently permits local HTTP for development;
use HTTPS and tighten App Transport Security for distribution. Android cleartext
HTTP is enabled only in the debug manifest. Android release signing must use the
team's release keystore rather than the scaffold's local debug signer.

## Authentication and Google configuration

Sessions use platform secure storage, are revalidated on startup/resume, and
expire without inventing a refresh-token endpoint. Switching workspace replaces
the bearer session and clears the old resource navigation stack. Local chat
history is separated by account and workspace; it is not a cross-device history
service.

Password, username and registration login work without a Google project.
Google login is enabled when `BOMESH_GOOGLE_CLIENT_ID` is supplied:

- Web: supply the web OAuth client ID and register the preview/deployment origin.
- iOS: supply an iOS client ID for the existing bundle ID
  `vn.bodangdiet.bomesh`, and set the Xcode build setting
  `BOMESH_GOOGLE_REVERSED_CLIENT_ID` to that client's reversed URL scheme.
- Android: configure an Android OAuth client for `com.bomesh.bomesh` and the actual
  signing certificate. Supply the appropriate server/web client ID through
  `BOMESH_GOOGLE_SERVER_CLIENT_ID` when issuing server-verifiable ID tokens.
- Native server client IDs and the backend's allowed Google audience must agree.
  Do not embed an OAuth client secret in Flutter.

## Structure

- `lib/ui/` — the design system: blueprint tokens (cool neutrals, indigo by
  default, amber reserved for evidence), bundled IBM Plex Sans/Mono, tone
  tiles, file tiles, avatars, status pills, app header, list groups and rows,
  search field, segmented switch, attention and metric cards, FAB, sticky
  action bar, sheets, loading/empty/error states and formatting.
- `lib/app/` — app root, appearance (Auto/Light/Dark plus accent, remembered
  per device), the tab shell (each tab keeps its own navigation stack), the
  first-run tour, the account sheet, and `WorkspaceScope` (workspace API
  client, session, Manage sections, cross-tab actions such as "ask about this
  knowledge base" and opening Search).
- `lib/features/` — `auth` (sign-in, create account, choose workspace), `chat`,
  `knowledge`, `inbox`, `search` and `manage` (overview, sources, people &
  access, activity, settings, platform).

## Workflows

- Sign in: password or Google. Several memberships → choose a workspace
  first; one → straight to Chat. Creating an account also creates the
  person's own workspace (current backend behavior); an admin adds them to a
  team workspace.
- Chat: greeting, three starters and recent chats; the composer has "+"
  (upload or choose from Knowledge) and a separate scope chip. Answers stream
  with one work-summary line, amber citations open a source sheet that pages
  through passages and opens the document at the passage. Generated files
  open Preview / Changes / History, download, save to Knowledge and "ask for
  changes". History: search, pinned, by day; rename, pin, delete.
- Knowledge: My files first, then readable knowledge bases, filtered by name
  and by effective access (All / Can edit / View only / Only you). Create
  (`knowledge.manage`) opens the new base on Documents. A base shows
  Documents (search, Needs attention / Failed / Processing, retry or process
  in place, Add or Ask) and, by permission, Sources, Access and Settings.
  Documents open the shared viewer (download, details, ask about it or a
  cited passage).
- Inbox: access requests (own and reviewable) and, with `source.manage`,
  failing sources and connected accounts, each opening where it is fixed.
  Read state is kept on this device; there are no push/email notifications.
- Search: knowledge bases, document names, chats saved on this device,
  people (`user.manage`) and Manage pages; "Search inside documents" uses
  `POST /documents/search` and opens the passage; the last row asks Chat.
- Manage: what needs a decision first, then Sources (sources, sync history,
  accounts, connect a source end to end), People & access (members, groups,
  roles with permission editing, requests), Activity, Settings, and the
  workspace at a glance.
- Account sheet: workspace switch, appearance and accent, tour, Platform
  console (`platform.*.read`), sign out.
- Not offered because the API does not exist yet (see "Proposed" in
  `backend/docs_design/api_contract.md`): chat sharing, assistant settings,
  knowledge gaps, server notifications, discovery of knowledge bases you
  cannot read, workspace-wide general access, archive/restore.

## Verification

```bash
cd app
flutter analyze
flutter test ../tests/flutter
flutter build ios --simulator --debug
flutter build apk --debug
```

Backend ACL/approval/document regressions are under
`tests/test_mobile_workspace_flows.py`. They use the existing isolated-schema
Postgres fixtures when `TEST_DATABASE_URL` is supplied. Flutter tests cover
session expiry/replacement, scope isolation, interrupted history, SSE
fragmentation/authorization, attachment ownership, History rename, form/layout
boundaries and "Make searchable" (run requests for a collection or one
document, 409 messages, failed reasons, and nothing offered without
`ingestion.run`). Use the running application for integration and visual
verification against `docs/mobile-ux-blueprint.html`.
