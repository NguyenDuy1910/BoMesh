import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

import {
  addChildren,
  addNodes,
  checkState,
  EMPTY_TREE,
  pathOf,
  sourceNameFor,
  toggleSelection,
  type ContentNode,
} from "../src/modules/ingestion/content-tree.ts";
import { confluenceErrors, confluenceSite, knowledgeBaseNameError } from "../src/modules/ingestion/connect-form.ts";
import {
  cronFor,
  describeSchedule,
  draftFromSchedule,
  nextSyncPhrase,
  validateDraft,
} from "../src/modules/ingestion/schedule.ts";

const schedule = (cron_expression: string) => ({ cron_expression, timezone: "Asia/Ho_Chi_Minh", enabled: true });

test("a schedule reads as a sentence and never as cron", () => {
  assert.equal(describeSchedule(null), "Manual");
  assert.equal(describeSchedule(schedule("0 2 * * *")), "Daily at 02:00");
  assert.equal(describeSchedule(schedule("30 6 * * 1")), "Weekly on Mon at 06:30");
  assert.equal(describeSchedule(schedule("0 6 * * 0")), "Weekly on Sun at 06:00");
  assert.equal(describeSchedule(schedule("0 6 * * 7")), "Weekly on Sun at 06:00");
  assert.equal(describeSchedule(schedule("0 6 * * FRI")), "Weekly on Fri at 06:00");
  assert.equal(describeSchedule(schedule("0 */6 * * *")), "Every 6 hours");
  assert.equal(describeSchedule(schedule("0 * * * *")), "Every hour");
  for (const odd of ["0 2 1 * *", "*/15 * * * *", "0 2 * * 1-5", "nonsense"]) {
    assert.equal(describeSchedule(schedule(odd)), "Custom schedule");
  }
});

test("what is chosen is what is saved: the draft round-trips through cron", () => {
  const weekly = { frequency: "weekly", day: "wed", time: "06:30", timezone: "UTC" } as const;
  assert.equal(cronFor(weekly), "30 6 * * 3");
  assert.deepEqual(draftFromSchedule(schedule("30 6 * * 3"), "UTC").draft, { ...weekly, timezone: "Asia/Ho_Chi_Minh" });
  assert.equal(cronFor({ frequency: "daily", day: "", time: "23:00" }), "0 23 * * *");
  assert.equal(cronFor({ frequency: "manual", day: "mon", time: "02:00" }), null);
  // A schedule written elsewhere starts the editor on a daily default and says it is replacing something.
  const custom = draftFromSchedule(schedule("0 */6 * * *"), "UTC");
  assert.equal(custom.custom, true);
  assert.equal(custom.draft.frequency, "daily");
  assert.equal(draftFromSchedule(null, "Europe/London").draft.timezone, "Europe/London");
});

test("a weekly schedule needs a day, any timed schedule a time", () => {
  assert.deepEqual(validateDraft({ frequency: "weekly", day: "", time: "", timezone: "UTC" }), {
    day: "Choose a day.",
    time: "Choose a time.",
  });
  assert.deepEqual(validateDraft({ frequency: "manual", day: "", time: "", timezone: "UTC" }), {});
});

test("the next sync is said relative to now, and not at all when it is past", () => {
  const now = Date.parse("2026-10-05T10:00:00Z");
  assert.equal(nextSyncPhrase("2026-10-05T10:05:00Z", now), "Next sync in 5 minutes");
  assert.equal(nextSyncPhrase("2026-10-05T13:00:00Z", now), "Next sync in 3 hours");
  assert.equal(nextSyncPhrase("2026-10-07T10:00:00Z", now), "Next sync in 2 days");
  assert.equal(nextSyncPhrase("2026-10-05T09:00:00Z", now), null);
  assert.equal(nextSyncPhrase(null, now), null);
});

const node = (id: string, name: string, resourceType = "page", hasChildren = true): ContentNode => ({
  id,
  name,
  resourceType,
  parentId: null,
  hasChildren,
});

function confluenceTree() {
  let tree = addChildren(EMPTY_TREE, null, [node("eng", "Engineering", "space"), node("ops", "People Ops", "space")]);
  tree = addChildren(tree, "eng", [node("run", "Runbooks"), node("arch", "Architecture")]);
  tree = addChildren(tree, "run", [node("db", "Database", "page", false)]);
  return tree;
}

test("picking a node covers its subtree; picking a parent absorbs what was picked inside it", () => {
  const tree = confluenceTree();
  let selection = toggleSelection(tree, [], "db");
  assert.equal(checkState(tree, selection, "db"), "checked");
  assert.equal(checkState(tree, selection, "run"), "mixed");
  assert.equal(checkState(tree, selection, "eng"), "mixed");
  assert.equal(checkState(tree, selection, "ops"), "unchecked");

  selection = toggleSelection(tree, selection, "eng");
  assert.deepEqual(selection, ["eng"]);
  assert.equal(checkState(tree, selection, "db"), "checked");
  // A covered node cannot be unpicked on its own; its ancestor decides.
  assert.deepEqual(toggleSelection(tree, selection, "run"), ["eng"]);
  assert.deepEqual(toggleSelection(tree, selection, "eng"), []);
});

test("a node found by search marks its known ancestors mixed", () => {
  const tree = addNodes(confluenceTree(), [{ ...node("deep", "Deep page", "page", false), parentId: "arch" }]);
  const selection = toggleSelection(tree, [], "deep");
  assert.equal(checkState(tree, selection, "arch"), "mixed");
  assert.equal(checkState(tree, selection, "eng"), "mixed");
  assert.equal(pathOf(tree, "deep"), "Engineering / Architecture / Deep page");
});

test("sources are named after their space, and never collide with existing names", () => {
  const tree = confluenceTree();
  assert.equal(sourceNameFor(tree, "eng", "confluence"), "Engineering space");
  assert.equal(sourceNameFor(tree, "db", "confluence"), "Engineering — Database");
  assert.equal(sourceNameFor(tree, "eng", "confluence", ["engineering space"]), "Engineering space 2");
  assert.equal(sourceNameFor(tree, "run", "google_drive"), "Runbooks");
});

test("a Confluence site is read however it is typed", () => {
  assert.deepEqual(confluenceSite("northwind"), {
    host: "northwind.atlassian.net",
    cloud: true,
    wikiBase: "https://northwind.atlassian.net/wiki",
  });
  assert.equal(confluenceSite("https://Northwind.atlassian.net/wiki/spaces")?.host, "northwind.atlassian.net");
  assert.deepEqual(confluenceSite("wiki.company.com/confluence/"), {
    host: "wiki.company.com",
    cloud: false,
    wikiBase: "https://wiki.company.com/confluence",
  });
  assert.equal(confluenceSite("not a site"), null);
  assert.equal(confluenceSite(""), null);
});

test("the credentials form names each problem beside its field", () => {
  assert.deepEqual(confluenceErrors({ site: "", email: "", token: "" }), {
    site: "Enter your Confluence site.",
    email: "Enter the email you use for Confluence.",
    token: "Paste your API token.",
  });
  assert.deepEqual(confluenceErrors({ site: "north wind", email: "me@", token: "x" }), {
    site: "Enter a site like northwind.atlassian.net.",
    email: "Enter a valid email, like you@company.com.",
  });
  assert.deepEqual(
    confluenceErrors({ site: "northwind", email: "me@northwind.com", token: "x" }, ["Northwind.atlassian.net"]),
    { site: "This site is already connected. Choose it above." },
  );
});

test("a new knowledge base needs a name nobody else uses", () => {
  assert.equal(knowledgeBaseNameError("  ", []), "Name the new knowledge base.");
  assert.equal(knowledgeBaseNameError("HR policies", ["HR Policies"]), "A knowledge base with this name already exists.");
  assert.equal(knowledgeBaseNameError("Marketing", ["HR Policies"]), "");
});

test("attention leaves paused sources out and puts an expired account first", async () => {
  const { sourceAttention, sourceStatus } = await import("../src/modules/ingestion/connection-state.ts");
  const connection = (id: string, status: string) =>
    ({ id, status, connector_key: "google_drive", account: { label: id, resource_label: null } }) as never;
  const source = (id: string, connection_id: string, status: string, sync: string | null = "succeeded") =>
    ({ id, connection_id, status, display_name: id, sync: sync && { status: sync, failed: 0 }, pending_documents: 0 }) as never;
  const connections = [connection("ok", "connected"), connection("old", "reauth_required")];
  const sources = [
    source("fine", "ok", "ready"),
    source("broken", "ok", "ready", "failed"),
    source("stopped", "old", "ready"),
    source("asked", "ok", "connection_required"),
    source("held", "old", "paused"),
  ];
  const attention = sourceAttention(sources, connections);
  assert.deepEqual(
    attention.reconnect.map((item) => (item as { id: string }).id),
    ["stopped", "asked"],
  );
  assert.deepEqual(attention.failed.map((item) => (item as { id: string }).id), ["broken"]);
  // A sync in flight reads as syncing even before the run that processes it exists.
  assert.equal(sourceStatus(source("busy", "ok", "ready", "running"), connections[0]), "syncing");
});
