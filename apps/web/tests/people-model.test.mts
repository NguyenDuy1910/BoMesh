import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_ROLE,
  MEMBER_ROLE,
  PERMISSION_GROUPS,
  accountGuard,
  directRoles,
  isSwitchOn,
  leavesNoAdmin,
  primaryRole,
  roleGuard,
  splitEmails,
  toggleSwitch,
  uniqueCopyName,
  withRoles,
  workspaceRoles,
} from "../src/modules/people/model.ts";

const CUSTOM = "workspaces/w/roles/auditor";
const ROLE_NAMES = new Set([ADMIN_ROLE, MEMBER_ROLE, CUSTOM]);

test("withRoles moves a user to exactly one workspace role and keeps everything else", () => {
  const policy = {
    etag: "e1",
    bindings: [
      { role: ADMIN_ROLE, members: ["user:a", "user:b"] },
      { role: MEMBER_ROLE, members: ["user:c"] },
      { role: "roles/collectionViewer", members: ["user:b", "group:g1"] },
    ],
  };
  const next = withRoles(policy, new Map([["b", CUSTOM], ["c", ADMIN_ROLE]]), ROLE_NAMES);
  assert.equal(next.etag, "e1");
  assert.deepEqual(next.bindings, [
    { role: ADMIN_ROLE, members: ["user:a", "user:c"] },
    { role: "roles/collectionViewer", members: ["user:b", "group:g1"] },
    { role: CUSTOM, members: ["user:b"] },
  ]);
  assert.deepEqual(policy.bindings[0].members, ["user:a", "user:b"], "input is not mutated");
});

test("primaryRole and directRoles read one role per member", () => {
  const policy = { bindings: [{ role: MEMBER_ROLE, members: ["user:x"] }, { role: CUSTOM, members: ["user:x"] }] };
  assert.deepEqual(directRoles(policy, "x", ROLE_NAMES), [MEMBER_ROLE, CUSTOM]);
  assert.equal(primaryRole([MEMBER_ROLE, CUSTOM]), CUSTOM);
  assert.equal(primaryRole([CUSTOM, ADMIN_ROLE]), ADMIN_ROLE);
  assert.equal(primaryRole([]), MEMBER_ROLE);
});

test("self and last-admin guards", () => {
  const people = [
    { user: "users/me", role: ADMIN_ROLE, state: "ACTIVE" },
    { user: "users/other", role: ADMIN_ROLE, state: "SUSPENDED" },
    { user: "users/m", role: MEMBER_ROLE, state: "ACTIVE" },
  ];
  assert.equal(roleGuard(people[0], people, "users/me"), "You can’t change your own role");
  assert.equal(roleGuard(people[0], people, "users/m"), "The last workspace admin keeps this role");
  assert.equal(roleGuard(people[2], people, "users/me"), "");
  assert.equal(accountGuard(people[0], people, "users/m", "remove"), "You can’t remove the last workspace admin");
  assert.equal(accountGuard(people[2], people, "users/m", "suspend"), "You can’t suspend yourself");
  assert.equal(leavesNoAdmin([people[0]], MEMBER_ROLE, people), true);
  assert.equal(leavesNoAdmin([people[0]], ADMIN_ROLE, people), false);
});

test("permission switches toggle whole bundles and ignore unsupported permissions", () => {
  const audit = PERMISSION_GROUPS.flatMap((g) => g.items).find((i) => i.id === "audit.read")!;
  const catalog = new Set(["auditEvents.list", "auditEvents.get", "items.list"]);
  assert.equal(isSwitchOn(audit, new Set(["auditEvents.list"]), catalog), false);
  const on = toggleSwitch(["items.list"], audit, true, catalog);
  assert.deepEqual(on, ["auditEvents.get", "auditEvents.list", "items.list"]);
  assert.equal(isSwitchOn(audit, new Set(on), catalog), true);
  assert.deepEqual(toggleSwitch(on, audit, false, catalog), ["items.list"]);
});

test("workspaceRoles lists built-ins first, then custom roles by name", () => {
  const roles = workspaceRoles(
    [
      { name: "roles/collectionViewer", displayName: "Collection Viewer", includedPermissions: [] },
      { name: MEMBER_ROLE, displayName: "Workspace Member", includedPermissions: ["items.list"] },
      { name: ADMIN_ROLE, displayName: "Workspace Admin", includedPermissions: [] },
    ],
    [
      { name: "workspaces/w/roles/z", displayName: "Zeta", includedPermissions: [] },
      { name: "workspaces/w/roles/a", displayName: "Alpha", includedPermissions: [] },
    ],
  );
  assert.deepEqual(
    roles.map((r) => [r.label, r.builtIn]),
    [["Workspace admin", true], ["Member", true], ["Alpha", false], ["Zeta", false]],
  );
});

test("emails split on commas, semicolons and spaces; copy names stay unique", () => {
  assert.deepEqual(splitEmails(" A@x.com, b@x.com;a@x.com\nc@x.com "), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.equal(uniqueCopyName("Member", ["Member", "member copy"]), "Member copy 2");
});
