# Authentication and Identity Contract

Status: target contract (`/api/v1`, OpenAPI tag Identity) used by the web
client. Method catalogue: `api_design.md` §3; schemas:
`openapi.yaml`.

Implementation status: sign-in throttling (`429`) is not implemented, and no
mail transport is configured, so password-reset emails are not sent.

## Multi-tenant access

Every request is made by an authenticated User. There is no anonymous or guest
session. A User reaches a workspace only as an ACTIVE Member
(`workspaces/{workspace}/members/{member}`) whose IAM bindings grant the
needed permission. Platform roles (`platformRole` `OPERATOR`, `ADMIN`) are a
separate scope and never grant workspace data access by themselves.

A workspace is `PRIVATE` (members are added or invited by admins) or `PUBLIC`.
A public workspace is listed to every signed-in User
(`ListWorkspaces` `filter=visibility = PUBLIC`) and any signed-in User may
join it (`:join`), which makes them an ACTIVE Member holding
`roles/workspaceMember`, exactly as if an admin had added them. Being public
grants nothing by itself: without the membership, every workspace request is
denied as below. Any Member may `:leave`, except the last workspace admin.

Sessions carry no workspace. The workspace is explicit in every resource name
(`workspaces/{workspace}/...`), and membership plus permission are checked on
every request against that name. A request for a workspace where the caller is
not an active member is denied (`403`); there is no fallback workspace.

## Identity and session separation

- **User** `users/{user}`: the account (`email`, `username`, `displayName`,
  `state` `ACTIVE`/`SUSPENDED`, `platformRole`). `users/me` names the caller.
- **auth_identities**: credentials bound to a User, keyed by
  (`issuer`, `subject`): the local password identity and one row per external
  provider (Google today). An identity is never addressed by email alone.
- **Session** `sessions/{session}`: one sign-in (`user`,
  `authenticationMethod` `PASSWORD`/`GOOGLE`, `expireTime`, `lastSeenTime`,
  `state` `ACTIVE`/`ENDED`). `sessions/current` names the session of the
  presented token.

Sign-in mechanisms all create a Session; mechanism names never become URL
namespaces.

| Method | Auth | Purpose |
| --- | --- | --- |
| CreateUser | public | Sign up; `validateOnly` checks email/username only |
| CreateSession | public | Sign in with a typed credential |
| GetSession / ListSessions | own | Read current or own sessions |
| DeleteSession | own | Sign out (`sessions/current`) or end another own session |
| GetUser / UpdateUser | self or platform | Read/update `users/me` (`displayName`, `username`) |
| GetUserPreferences / UpdateUserPreferences | self | `users/me/preferences`, including `lastWorkspace` |
| SendPasswordReset | public | Email a reset link |
| ResetPassword | public | Consume `resetToken`, set `newPassword` |

Platform account administration (ListUsers, SuspendUser, ActivateUser,
LookupUser) is listed in `api_design.md` §3.

## Sign-up

CreateUser takes `email`, `password` and optional `username`, `displayName`.
The server assigns the ID and returns the User in `ACTIVE`; it does not sign
the caller in, the client follows with CreateSession. Email or username in use
returns `409 ALREADY_EXISTS` (`EMAIL_ALREADY_USED` / `USERNAME_ALREADY_USED`);
invalid input `400 INVALID_ARGUMENT`; throttling `429` (target; not implemented yet).

## Joining through an invite

An account belongs to no workspace until a membership is created for it:
CreateMember by an administrator, or an accepted INVITE share
(`api_design.md` §4 "Share"). The invite URL `/s/{token}` is opened by the web
client; a signed-out visitor signs in or signs up (CreateUser, then
CreateSession) and is sent back to the same URL, which calls ResolveShare and,
on the visitor's confirmation, AcceptShare. Accepting a workspace invite
creates the membership (with the member's PERSONAL collection) and grants the
invite's role; the client then enters that workspace. The token is a bearer
secret for joining only: it never authenticates a request, is not a session,
and works only for a signed-in account. Space and collection invites require
an existing active membership.

## Session creation

CreateSession accepts only `credential`, a closed union:

```json
{ "credential": { "password": { "email": "user@example.com", "password": "..." } } }
```

```json
{ "credential": { "password": { "username": "analyst", "password": "..." } } }
```

```json
{ "credential": { "google": { "idToken": "provider-issued-token" } } }
```

Exactly one of `email`/`username` is required for password sign-in. No
arbitrary credential map is accepted. Further OIDC/SSO providers add a typed
`credential` variant and a server-side provider strategy that resolves an
`auth_identities` row by issuer and subject; they never add a provider route.
Google tokens are verified against the configured audience; clients never
embed a provider secret.

The response is the Session with `accessToken`, returned only in this
response and never readable again (GetSession/ListSessions omit it). Wrong
credentials return `401 UNAUTHENTICATED` reason `INVALID_CREDENTIALS`, the same
whether or not the account exists; a suspended account returns
`400 FAILED_PRECONDITION` reason `USER_SUSPENDED`; throttling `429` (target;
not implemented yet). Public
methods ignore any bearer token; there is no session-upgrade path.

## Token handling, expiry and revocation

- The bearer token resolves to an ACTIVE, unexpired Session of an ACTIVE User;
  anything else is `401 UNAUTHENTICATED`. Identity is never taken from caller
  input (no user, workspace, role or permission headers or body fields).
- Sessions expire at `expireTime`. There is no refresh method; an expired
  session requires a new CreateSession.
- DeleteSession ends the session (`ACTIVE` → `ENDED`) and revokes its token. It
  returns the ended Session; sessions end softly and stay readable. Ending an
  already ENDED session is `400 FAILED_PRECONDITION`; another user's session is
  `403`.
- SuspendUser and ResetPassword end every session of the account.
- Removing or suspending a Member does not end sessions; the next request for
  that workspace fails the per-request membership check.

## Password reset

SendPasswordReset always returns Empty whether or not the email belongs to an
account (no enumeration). ResetPassword consumes a single-use, expiring
`resetToken`; an invalid, used or expired token returns
`400 FAILED_PRECONDITION` reason `RESET_TOKEN_INVALID`; weak passwords
`400 INVALID_ARGUMENT`. Both are to be throttled (`429`, not implemented yet).

## Workspace selection

After sign-in the client calls ListWorkspaces (workspaces the caller is a
member of). It opens `lastWorkspace` from GetUserPreferences when still listed;
otherwise one membership enters directly and several show a chooser. Choosing
a workspace is a client navigation plus UpdateUserPreferences
(`lastWorkspace`); it issues no new token. UpdateUserPreferences rejects a
`lastWorkspace` the caller does not belong to with `400 INVALID_ARGUMENT`.
GetMember on `workspaces/{workspace}/members/me` and
TestWorkspaceIamPermissions give the caller's membership and permissions for
navigation.

## Error rules

- Global OpenAPI security is bearer; CreateUser, CreateSession,
  SendPasswordReset and ResetPassword declare `security: []`.
- Errors use the shared error envelope (canonical code plus `reason`);
  stable reasons: `INVALID_CREDENTIALS`, `USER_SUSPENDED`,
  `EMAIL_ALREADY_USED`, `USERNAME_ALREADY_USED`, `RESET_TOKEN_INVALID`.

## Client session boundary

Clients send only `Authorization: Bearer ...`; development identity headers
and compiled-in user/workspace identifiers are not supported.

A `401` for the current token ends the authenticated session on the client; a
late response for a replaced token cannot invalidate a newer session. Switching
workspace discards open resource routes and workspace-scoped caches; pending
work for the previous workspace keeps addressing that workspace by name and is
authorized on its own. Conversation and other local caches are separated by
account and workspace. Unauthenticated clients show sign-in/sign-up and never
create a session automatically. Sign-out calls DeleteSession and clears local
credentials even when the server is unreachable; an offline failure is
reported, not shown as confirmed revocation.

The web client treats the end of the current session — `expireTime` passing
(a timer on the device clock, with `expireTime - createTime` counted from
sign-in so clock skew cannot end a fresh session) or a `401` for the current
token — as **expired**, not signed out. The session record is kept and marked
expired (other tabs follow through storage events); the open page and its
client state and caches stay; no further request is sent with or without the
dead token (the API boundary answers it locally with `401 UNAUTHENTICATED`,
which is never retried) except the public identity methods. A blocking
"Your session expired" dialog offers the regular password/Google sign-in in
place: a new session for the same user resumes the page at the same address
and refetches its data; a session for a different user drops all cached data
and reloads Home. The dialog also offers the full Sign in page
(`/signin?next=<page>&reason=expired`, which explains the expiry and returns
to `next` — a same-origin path only — for the same user) and Sign out. A page
opened with an already expired session goes straight to that Sign in page.
Sign-out keeps clearing the session in every tab. Renewal without
re-authentication is not supported: there is no refresh method.

The web client initializes the page-global Google Identity client once and
uses Google's rendered popup button without the optional FedCM button flow.
Native client IDs, authorized web origins, callback schemes and the backend
audience must match the deployed application.

Navigation (web sidebar, Platform console) is
presentation over the caller's permissions from TestWorkspaceIamPermissions
and `platformRole`, never an authorization layer; every request is still
authorized by the API. Addresses the caller may not open render a no-access
page.

## Seeded workspaces and accounts

`backend/script/seed.py` (`make seed`, also run by `make reset-all` and
`make db-reset`) is an idempotent seeding utility, not an API. Every account's
password is `19102003` (`--password` overrides). It seeds two CAMPUS workspaces:

| Code | Workspace | Seeded structure |
| --- | --- | --- |
| `hcmute` | *Trường Đại học Công nghệ Kỹ thuật TP. Hồ Chí Minh* | shared root collection *Kho tài liệu chung* (`workspaceMembers` → `collectionViewer`, accepts contributions) with the faculty/office folders of `seed_fixtures/hcmute/collections.json`; restricted root *Kho bài giảng nội bộ* (no `workspaceMembers` grant, discoverable); space *Khoa Công nghệ Thông tin* (`khoa-cntt`); the topics of `seed_fixtures/hcmute/topics.csv` |
| `ftu-hcmc` | *Phân hiệu Trường Đại học Ngoại thương tại TP. Hồ Chí Minh* | none: collections and topics come with its ingestion |

A workspace's display name is the organization's official name; its code is
the short web address. Apart from the platform owner, every seeded account is a
**system account** named after its purpose, never after a person: the username
is `platform.{role}` or `{workspaceCode}.{role}` (unique across the platform),
the email `{username}@bomesh.internal` (a reserved domain that never receives
mail), the display name `{organization} · {role}`. Accounts sign in with their
username or email.

| Username | Purpose | Grants |
| --- | --- | --- |
| `nguyendqduy` | Nguyễn Đình Quốc Duy, platform owner (`nguyendqduy@gmail.com`), the one real account | `platformAdmin` + `workspaceAdmin` in both workspaces |
| `platform.admin` | Platform administration | `platformAdmin`, no membership |
| `platform.operator` | Platform operations | `platformOperator`, no membership |
| `platform.noaccess` | Negative case | active account, no membership, no role |
| `hcmute.admin` | HCM-UTE system administration | `workspaceAdmin` |
| `hcmute.curator` | HCM-UTE knowledge administration; creates its seeded resources | `workspaceAdmin` |
| `hcmute.member` | Plain member | `workspaceMember` |
| `hcmute.collection-owner` | Collection role | `workspaceMember` + `collectionOwner` on *Kho bài giảng nội bộ* |
| `hcmute.collection-editor` | Collection role | `workspaceMember` + `collectionEditor` on *Kho bài giảng nội bộ* |
| `hcmute.collection-viewer` | Collection role | `workspaceMember` + `collectionViewer` on *Kho bài giảng nội bộ* |
| `hcmute.space-lead` | Space role | `workspaceMember` + `spaceLead` on `khoa-cntt` |
| `hcmute.space-staff` | Space role | `workspaceMember` + `spaceStaff` on `khoa-cntt` |
| `hcmute.space-member` | Space role | `workspaceMember` + `spaceMember` on `khoa-cntt` |
| `hcmute.suspended` | Negative case | `workspaceMember`, account `SUSPENDED` |
| `ftu-hcmc.admin` | FTU HCMC system administration | `workspaceAdmin` |
| `ftu-hcmc.curator` | FTU HCMC knowledge administration | `workspaceAdmin` |
| `ftu-hcmc.member` | Plain member | `workspaceMember` |
| `ftu-hcmc.suspended` | Negative case | `workspaceMember`, account `SUSPENDED` |

The seed writes identities, memberships (each with its PERSONAL collection),
the shared resources and the role bindings in one transaction, then imports
topics and folders through the public API (ImportTopics MERGE,
ImportCollections) as the workspace's curator. Every run restores the matrix:
names and passwords are reset, imports create only what is missing, and each
account's direct bindings on the workspace, the restricted collection and the
space become exactly the listed roles. Workspace and account IDs are
generated, not fixed. Real people join through sign-up, invitations or SSO.

