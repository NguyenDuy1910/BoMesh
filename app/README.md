# BoMesh Flutter application

Flutter client for the existing `/api/v1` API, focused on the two things people
do on a phone: ask questions (Chat) and manage their documents (Library).
Workspace administration — members, roles, groups, sharing, connectors, sync
activity, audit — lives in the web console; the app keeps only access-request
review, badged on the account button. Permissions and collection ACLs are
enforced by the backend; the app uses returned permissions to show actions.

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

## Workflows

- Chat: one header (conversations, title, new chat, account); streaming
  text/reasoning/tool activity, stop/retry/edit, conversation
  search/rename/pin/delete. One "+" adds context: upload a file, use a library
  document, or limit the search to some collections. Citations and generated
  artifacts open in place.
- Library: search, then "My files" or "Workspace" collections. Each row shows
  the file type and date, or what it is waiting for. Upload opens the system
  picker at once and uploads straight away; formats are checked in the app, not
  by the picker, because Android and iOS cannot filter Markdown, YAML or logs.
  Files are streamed from disk, never held in memory.
- Account: workspace switch, access requests (approve/deny, or cancel your
  own), sign out.

Unavailable indexed text, expired signed previews, failed streams, empty lists,
permission errors and pending external operations are shown explicitly rather
than replaced with fabricated results. Connector ingestion requires the configured
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
session expiry/replacement, scope isolation, interrupted
history, SSE fragmentation/authorization, attachment ownership and form/layout
boundaries. Use the running application for integration and visual verification.
