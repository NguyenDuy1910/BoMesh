# Authentication API Contract

Status: implemented resource contract shared by web and Flutter clients.

## Multi-tenant access

Every request is made by an authenticated User. A User reaches a workspace
(tenant) only through an active `tenant_memberships` row plus
`role_assignments` in that workspace; platform permissions are a separate scope
and never grant workspace data access by themselves. There is no anonymous
session and no public-workspace access.

## Resource model

Authentication mechanisms create one durable `Session`. Mechanism names do not
become URL namespaces.

| Method | Path | Security | Resource operation |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/accounts` | public | Create Account and issue first Session |
| POST | `/api/v1/auth/sessions` | public | Create Session from typed method variant |
| GET | `/api/v1/auth/session` | bearer | Read current Session context |
| PATCH | `/api/v1/auth/session` | bearer | Change active workspace state |
| DELETE | `/api/v1/auth/session` | bearer | Invalidate current Session |

No `/auth/password`, `/auth/google`, or `/auth/guest-sessions` routes remain in
the final contract; the guest route was removed with anonymous access. No
password reset routes are added because current product has no recovery
lifecycle.

## Account creation

`POST /api/v1/auth/accounts` accepts:

```json
{
  "email": "user@example.com",
  "password": "...",
  "username": "analyst",
  "display_name": "Example User"
}
```

`email` is the canonical local credential identifier for account creation.
Password sign-in accepts either the account email or the optional username;
exactly one identifier is required. Account creation returns `201` and the
same `AuthSession` shape as login. `409` uses `ACCOUNT_ALREADY_EXISTS`; `422` uses
`VALIDATION_ERROR`.

## Session creation

`POST /api/v1/auth/sessions` uses `CreateSessionRequest`, a discriminated
`oneOf` union with `method`:

```json
{ "method": "password", "email": "user@example.com", "password": "..." }
```

Username sign-in is also supported for accounts that have one:

```json
{ "method": "password", "username": "analyst", "password": "..." }
```

```json
{ "method": "google", "credential": "provider-issued-token" }
```

The only variants are `password` and `google`; any other `method` (including
the removed `guest`) returns `422 VALIDATION_ERROR`. Each variant has a closed,
concrete schema. No arbitrary `credentials` map is accepted. Future OIDC
providers add a typed variant and provider strategy behind this route; they do
not add a provider-specific route.

All variants return `AuthSession`. Password and provider failures return generic
`401 INVALID_CREDENTIALS` without revealing whether account or credential was
wrong. Session creation and account creation are fully public (`security: []`)
and ignore any bearer token; there is no session-upgrade path.

`AuthSession` and `CurrentSession` always carry a non-null `user_id`; there is
no `session_kind` field. Tokens that do not resolve to a User are rejected.

## Current session lifecycle

`GET /auth/session` resolves identity from the bearer token and returns
`CurrentSession`. It never accepts `user_id`, `workspace_id`, roles, or
permissions from the caller.

`PATCH /auth/session` accepts only:

```json
{ "active_workspace_id": "uuid" }
```

Server validates that the User has an active membership in the target
workspace, creates the replacement session context, and returns `AuthSession`.
A workspace without membership returns `403`; there is no public fallback.
Internal `tenant_id` and JWT claim `active_tenant_id` stay behind the API
boundary.

`DELETE /auth/session` resolves the bearer session and tombstones/revokes it;
response is `204`. No physical business data is deleted.

## OpenAPI and error rules

- Global OpenAPI security is bearer JWT.
- Account/session creation explicitly uses `security: []`.
- Current-session GET/PATCH/DELETE require bearer security.
- Auth errors use shared `{code, message, request_id, details}` envelope.
- Stable auth codes: `INVALID_CREDENTIALS`, `SESSION_EXPIRED`,
  `ACCOUNT_ALREADY_EXISTS`, `ACCOUNT_DISABLED`, `TOO_MANY_ATTEMPTS`.

## Flutter session boundary

The Flutter client sends only `Authorization: Bearer ...`; development identity
headers and compiled-in user/workspace identifiers are not supported. The access
token is persisted with platform secure storage, namespaced by API origin.
Startup and foreground resume revalidate it with `GET /auth/session`.

There is no refresh-token endpoint. Token expiry or a `401` for the current
token clears the authenticated UI; a late response for a replaced token cannot
invalidate the new session. Workspace changes use the replacement token returned
by `PATCH`, discard open resource routes, and recreate the workspace-scoped HTTP
client. Pending work cannot send a newly selected workspace's credentials.

Conversation caches are separate by account and workspace. No unscoped legacy
cache is imported. Unauthenticated clients show the sign-in/register screen;
they never create a session automatically. Sign-out revokes the session and
clears local credentials even when the server cannot be reached; offline
revocation failure is reported, not represented as confirmed server revocation.

Google login passes the provider-issued ID credential through the same session
endpoint. Native client IDs, callback schemes and backend audience configuration
must match the deployed application; Flutter does not embed a provider secret.

The web product shell has one sidebar, defined once in
`web/src/lib/navigation.ts`. It is presentation over the session's
permissions, never an authorization layer. Every member sees New chat, Inbox,
Search and Knowledge. The Manage section lists only the items the caller may
open: Overview (`tenant.read` and `tenant.manage`), Sources (`source.manage` or
`ingestion.read`), People & access (`user.manage`, `role.manage`,
`group.manage` or `access.manage`), Assistant setup (`tenant.manage`),
Activity (`audit.read`) and Settings (`tenant.manage`). A caller with any
`platform.*.read` grant in `platform_permissions` can open the Platform
console, where the same sidebar lists Workspaces, Connectors, AI capabilities
and Usage (`platform.tenant.read`), Users (`platform.user.read`), Audit log
(`platform.audit.read`) and System health (`platform.health.read`). Items
backed by an API that is still pending are hidden when that feature is turned
off. An address the caller may not open renders a no-access page. Legacy
`/app`, `/library` and `/workspace-control/*` addresses redirect permanently to
their `/chat`, `/knowledge`, `/manage/*` and `/platform/*` successors.

The app's Manage destination is presentation over the same permissions, never
an authorization layer: it appears only when the session holds at least one
management permission, and each section follows these codes (Overview
`tenant.read`; Ingestion `ingestion.read`/`ingestion.run`/`source.manage`;
Access `user.manage`/`group.manage`/`role.manage`/`access.manage`; Activity
`audit.read`; Settings `tenant.manage`). Knowledge management on mobile needs
`knowledge.manage` or `collection.share`, because reading knowledge is already
the Library. The Platform switch needs any `platform.*.read` in
`platform_permissions`. Every request is still authorized by the API.

## Local full-access test accounts

`backend/script/seed_account.py` is an idempotent local-development utility,
not an HTTP API. It synchronizes platform-defined roles, creates the sample
administrator accounts `admin1@gamil.com`, `admin2@gamil.com`, and
`admin3@gamil.com` (usernames `sample-admin-1..3`) when absent, grants each
`platform_admin`, and grants each a membership plus `tenant_admin` in every
active workspace. This combines platform administration with workspace data
access without weakening the normal separation of those scopes.

New accounts use the script's default password (`DEFAULT_PASSWORD`) unless
`--password` is supplied. Re-running the script preserves existing passwords;
`--reset-password` is required to change them. If no active workspace exists,
it creates one with code `FinxWorkspace` (`DEFAULT_WORKSPACE_CODE`) so the
accounts can establish an active authenticated workspace through membership.

The complete local reset command, `make reset-all`, runs this seeder after
database initialization.
