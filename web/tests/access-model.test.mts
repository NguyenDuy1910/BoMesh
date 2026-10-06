import assert from "node:assert/strict";
import test from "node:test";

import { accessErrorMessage, canGrant, defaultRoleId, roleOptions, type RoleChoice } from "../src/modules/manage/access/access-model.ts";
import { toggleAbility } from "../src/modules/manage/access/capabilities.ts";

const role = (id: string, permissions: string[] | null, extra: Partial<RoleChoice> = {}): RoleChoice => ({
  id,
  name: id,
  permissions,
  active: true,
  system: false,
  memberCount: 0,
  ...extra,
});

const admin = role("admin", ["tenant.read", "knowledge.read", "user.manage", "role.manage", "tenant.manage"], { system: true });
const member = role("member", ["tenant.read", "knowledge.read"], { system: true });
const viewer = role("viewer", ["knowledge.read"], { active: false });

test("new members default to the least-privileged role the caller may grant, never an admin", () => {
  assert.equal(defaultRoleId([admin, member], admin.permissions!), "member");
  // A disabled role is never offered, even when it allows less.
  assert.equal(defaultRoleId([admin, member, viewer], admin.permissions!), "member");
  // A caller who cannot grant the smaller role gets nothing rather than something bigger than they hold.
  assert.equal(defaultRoleId([admin], ["tenant.read"]), "");
});

test("a role is grantable only when active and within the caller's own permissions", () => {
  assert.equal(canGrant(member, ["tenant.read", "knowledge.read", "user.manage"]), true);
  assert.equal(canGrant(admin, ["tenant.read", "knowledge.read", "user.manage"]), false);
  assert.equal(canGrant(viewer, ["knowledge.read"]), false);
  // Without role.manage the permissions are unknown; the server decides.
  assert.equal(canGrant(role("seen", null), []), true);
});

test("role options keep a member's current role even when it can no longer be granted", () => {
  const options = roleOptions([admin, member, viewer], "viewer", ["tenant.read", "knowledge.read"]);
  assert.deepEqual(
    options.map((option) => [option.value, option.disabled, option.label]),
    [["admin", true, "admin"], ["member", false, "member"], ["viewer", false, "viewer (disabled)"]],
  );
});

test("server refusals read as sentences; unknown ones pass through capitalised", () => {
  assert.equal(
    accessErrorMessage(new Error("an administrator cannot change their own workspace access"), "x"),
    "You can’t change your own access. Ask another admin.",
  );
  assert.equal(
    accessErrorMessage(new Error("roles may include only permissions already held by the acting administrator: audit.read"), "x"),
    "You can only give abilities you have yourself.",
  );
  assert.equal(accessErrorMessage(new Error("group name is taken"), "x"), "Group name is taken.");
  assert.equal(accessErrorMessage(null, "Try again."), "Try again.");
});

test("turning an ability on brings what it needs; turning one off removes what depended on it", () => {
  assert.deepEqual(new Set(toggleAbility([], "collection.update", true)), new Set(["collection.update", "collection.read", "knowledge.read"]));
  assert.deepEqual(new Set(toggleAbility(["knowledge.read", "collection.read", "collection.update"], "knowledge.read", false)), new Set());
});
