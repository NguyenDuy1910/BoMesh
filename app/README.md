# BoMesh Flutter application

Flutter client for the existing `/api/v1` API. Three destinations, following
`docs/mobile-ux-blueprint.html`: **Ask** (the assistant), **Library** (your
files and the workspace's collections) and **Manage** (workspace and platform
operations, shown only to people holding a management permission).
Permissions and collection ACLs are enforced by the backend; the app uses the
returned permissions to decide which sections and actions to show.

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

- `lib/ui/` — the design system: theme tokens (light and dark, warm paper and
  ink with one violet accent), tone tiles, file tiles, avatars, status pills,
  app header, list groups and rows, search field, segmented switch, attention
  and metric cards, FAB, sticky action bar, sheets (options, pickers,
  confirmations, text prompts), loading/empty/error states and formatting.
  Screens compose these; they do not style Material widgets themselves.
- `lib/app/` — app root, appearance (Auto/Light/Dark, remembered per device),
  the three-tab shell (each tab keeps its own navigation stack), the account
  sheet, and `WorkspaceScope` (the workspace API client, the session, which
  Manage sections are open, and app-wide actions).
- `lib/features/` — `auth`, `chat` (Ask), `knowledge` (Library, documents,
  collections, sharing, uploads) and `manage` (overview, ingestion, access,
  activity, settings, platform).

## Workflows

- Ask: the composer is the screen. History, new chat and account sit in the
  header; "+" adds a file, a Library document or limits the search to
  collections. Answers stream in place with one quiet line per piece of work
  ("Searched 6 sources", "Ran code"), tappable citations that open the source
  passage, and file cards (Preview / Download) for files the assistant made.
  History lives on its own screen (search, pinned, by day; rename, pin, delete
  from a row's "···").
- Library: search, then "My files" or "Workspace" collections. Rows show the
  file type, size and date; a document says "Not searchable yet" only when it
  is. A document opens its preview with one action, "Ask about this document".
  Upload opens a sheet: choose where, optionally "Make searchable right away"
  (one ingestion run for exactly the uploaded files), then pick files. Files
  are streamed from disk and checked by extension in the app.
- Manage → Workspace: what needs a decision first (access requests, failed
  documents), the workspace at a glance, then the sections the person may open:
  Knowledge (collections, sharing, adding knowledge), Ingestion (runs with
  progress, run detail with "Retry failed", sources with "Sync now"), Access
  (members, groups, roles, access requests), Activity (usage chart, sign-ins,
  audit) and Settings (workspace name). Manage → Platform (platform
  permissions only): system health, tenants, users and audit, read-only.
- Account sheet (avatar): workspace switch, appearance, sign out.
- On the web only: connecting a new source (OAuth), editing what a role can do,
  Agent and Experience settings.

Unavailable indexed text, expired signed previews, failed streams, empty lists,
permission errors and pending external operations are shown explicitly rather
than replaced with fabricated results. Processing requires the configured
worker, and grounded answers require the configured LLM/search providers.

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
