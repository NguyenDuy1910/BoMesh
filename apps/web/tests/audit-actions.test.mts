import assert from "node:assert/strict";
import test from "node:test";

import {
  auditActionArea,
  describeAuditAction,
  describeAuditTarget,
  describeSignInMethod,
} from "../src/modules/manage/activity/audit-actions.ts";

/** Every action code the backend writes today (grep `action=` in backend/bomesh). */
const BACKEND_CODES = [
  "artifact.created", "artifact.published", "artifact.revised",
  "collection.access.granted", "collection.access.revoked", "collection.created",
  "collection.deleted", "collection.updated", "document.updated", "document.deleted",
  "group.created", "group.deleted", "group.members_replaced", "group.updated",
  "ingestion.source.created", "ingestion.source.deleted", "ingestion.source.sync_requested",
  "ingestion.source.updated", "integration.connection.authorized", "integration.connection.created",
  "integration.connection.deleted", "integration.connection.disconnected",
  "integration.connection.updated", "integration.connection.validated", "member.added",
  "role.created", "role.updated", "role_assignment.platform_admin.granted", "tenant.updated",
  "user.updated",
  ...["resource_access", "plugin_installation"].flatMap((type) =>
    ["created", "approved", "denied", "cancelled"].map((status) => `approval_request.${type}.${status}`),
  ),
];

/** Words people never see (ux contract): internal nouns and code punctuation. */
const LEAKS = /[._]|\btenant\b|\bingestion\b|\bcollection\b|\bchunk\b|\bembedding\b|\bintegration\b/i;

test("known codes read as plain sentences", () => {
  assert.equal(describeAuditAction("collection.access.granted"), "Shared a knowledge base");
  assert.equal(describeAuditAction("ingestion.source.sync_requested"), "Started a sync");
  assert.equal(describeAuditAction("integration.connection.disconnected"), "Disconnected an account");
  assert.equal(describeAuditAction("approval_request.resource_access.approved"), "Approved an access request");
  assert.equal(describeAuditAction("TENANT.UPDATED "), "Changed workspace settings");
});

test("details sharpen the sentence when they say what changed", () => {
  assert.equal(describeAuditAction("tenant.updated", { changed_fields: ["name"] }), "Renamed the workspace");
  assert.equal(describeAuditAction("tenant.updated", { changed_fields: ["name", "settings"] }), "Changed workspace settings");
  assert.equal(describeAuditAction("user.updated", { changed_fields: ["roles"] }), "Changed a member’s role");
  assert.equal(describeAuditAction("member.added", { readmitted: true }), "Added a member back");
  assert.equal(describeAuditAction("document.updated", { previous_status: "active", status: "archived" }), "Archived a document");
});

test("every code the backend writes has a sentence that leaks no internal words", () => {
  for (const code of BACKEND_CODES) {
    const sentence = describeAuditAction(code);
    assert.doesNotMatch(sentence, LEAKS, `${code} → ${sentence}`);
    assert.match(sentence, /^[A-Z]/, `${code} → ${sentence}`);
    assert.notEqual(auditActionArea(code), "other", `${code} has no area`);
  }
});

test("unknown codes fall back to a humanised sentence, never the dotted code", () => {
  assert.equal(describeAuditAction("document.uploaded"), "Uploaded a document");
  assert.equal(describeAuditAction("tenant.suspended"), "Suspended a workspace");
  assert.equal(describeAuditAction("ingestion.run.retry_requested"), "Sync retry requested");
  assert.equal(describeAuditAction("widget"), "Widget");
  for (const code of ["", null, undefined, "...", "constructor", "toString.__proto__", "collection.chunk_embedding.rebuilt_now"]) {
    const sentence = describeAuditAction(code);
    assert.equal(typeof sentence, "string");
    assert.ok(sentence.length > 0, `${String(code)} gave an empty sentence`);
    assert.doesNotMatch(sentence, LEAKS, `${String(code)} → ${sentence}`);
    assert.doesNotMatch(sentence, /function|\[object/i, `${String(code)} → ${sentence}`);
  }
});

test("areas group actions the way the Activity filter offers them", () => {
  assert.equal(auditActionArea("approval_request.plugin_installation.created"), "sources");
  assert.equal(auditActionArea("approval_request.resource_access.created"), "people");
  assert.equal(auditActionArea("role_assignment.platform_admin.granted"), "people");
  assert.equal(auditActionArea("collectionish.created"), "other");
});

test("targets name the resource kind in product words, plus a recorded name", () => {
  assert.equal(describeAuditTarget({ action: "ingestion.source.created", resource_type: "ingestion_source" }), "Source");
  assert.equal(
    describeAuditTarget({ action: "member.added", resource_type: "user", details: { email: "an@northwind.test" } }),
    "Member · an@northwind.test",
  );
});

test("sign-in methods read as the button the person pressed", () => {
  assert.equal(describeSignInMethod("oidc"), "Google");
  assert.equal(describeSignInMethod("password"), "Password");
  assert.equal(describeSignInMethod("magic_link"), "Magic link");
  assert.equal(describeSignInMethod("constructor"), "Constructor");
});
