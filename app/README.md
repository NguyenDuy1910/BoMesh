# BoThesis Flutter application

Flutter client for the existing `/api/v1` API: authentication, streamed chat,
knowledge library, connections/sources, ingestion activity, and workspace
administration. The same UI adapts to phones, tablets and the web preview.
Workspace permissions and collection ACLs are enforced by the backend; the app
uses returned permissions to show the available actions.

## Run

Start the backend and its configured database, storage, search and workflow
services using the repository's normal setup. Then:

```bash
cd app
flutter pub get
flutter run -d <device-id> \
  --dart-define=BOTHESIS_API_URL=https://<api-host>
```

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
  --dart-define=BOTHESIS_API_URL=http://localhost:8000
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
Google login is enabled when `BOTHESIS_GOOGLE_CLIENT_ID` is supplied:

- Web: supply the web OAuth client ID and register the preview/deployment origin.
- iOS: supply an iOS client ID for the existing bundle ID
  `vn.bodangdiet.bothesis`, and set the Xcode build setting
  `BOTHESIS_GOOGLE_REVERSED_CLIENT_ID` to that client's reversed URL scheme.
- Android: configure an Android OAuth client for `com.bothesis.bothesis` and the actual
  signing certificate. Supply the appropriate server/web client ID through
  `BOTHESIS_GOOGLE_SERVER_CLIENT_ID` when issuing server-verifiable ID tokens.
- Native server client IDs and the backend's allowed Google audience must agree.
  Do not embed an OAuth client secret in Flutter.

Connector OAuth opens the backend-provided authorization URL in the system
browser. Return to the app and refresh the connection after completing consent.
The existing web callback does not define a mobile deep-link callback. Credential
connections use the same provider-specific fields as the web application.
Provider credentials, live external consent and production signing belong to the
deployment; the application does not simulate successful connections.

## Workflows

- Chat: streaming text/reasoning/tool activity, stop/retry/edit, conversation
  search/rename/pin/delete, uploads and existing-document references, collection
  scope, citations, generated artifact downloads/revisions/publishing.
- Library: home/personal/collection browsing, name/content search, document
  uploads and indexing status, source preview/text/metadata, ask-document,
  collection management/sharing and access requests.
- Workspace: overview, members, roles/permissions, groups, approvals, audit and
  settings. Personal connections and requests remain reachable without admin
  permissions; privileged controls use the session's capabilities.
- Connections: provider accounts, credentials/OAuth, resource selection, source
  scope and lifecycle, schedules, sync activity/progress/retry/cancel.

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
