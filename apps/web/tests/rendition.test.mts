import assert from "node:assert/strict";
import test from "node:test";

import { loadRendition, type DocumentRendition } from "../src/modules/knowledge/reader/rendition.ts";

const rendition: DocumentRendition = {
  schema: 1,
  truncated: false,
  blocks: [
    { id: "doc_heading_001", kind: "heading", level: 1, text: "Expense policy", page: 1 },
    { id: "p001_para_002", kind: "paragraph", text: "Meals are reimbursed up to the daily limit.", page: 1 },
    {
      id: "p002_para_003",
      kind: "paragraph",
      text: "Travel must be booked through the approved agency at least fourteen days before departure, unless the trip is urgent.",
      page: 2,
    },
    {
      id: "p003_table_001",
      kind: "table",
      caption: null,
      columns: ["#", "Name", "Amount", "Region"],
      rows: [
        ["1", "Alice", "300", "North"],
        ["2", "Bob", "200", "South"],
        ["3", "Carol", "450", "East"],
        ["4", "Dave", "", ""],
        // "Ali" and "30" are inside "Alice" and "300", not quoted themselves.
        ["5", "Ali", "30", ""],
      ],
      total_rows: 5,
      page: 3,
    },
  ],
};

test("concurrent reads of one document version share one download", async (context) => {
  const calls = stubFetch(context, () => json(rendition));

  const [first, second] = await Promise.all([
    loadRendition("item-shared", { uri: "https://storage.test/a", version: "v1" }),
    loadRendition("item-shared", { uri: "https://storage.test/b", version: "v1" }),
  ]);
  const later = await loadRendition("item-shared", { uri: "https://storage.test/c", version: "v1" });

  assert.equal(calls.length, 1);
  assert.equal(first, second);
  assert.equal(later, first);
  assert.equal(first.blocks.length, 4);
});

test("a failed download is retried by the next read", async (context) => {
  let fail = true;
  const calls = stubFetch(context, () => (fail ? new Response("expired", { status: 403 }) : json(rendition)));
  const ref = { uri: "https://storage.test/expired", version: "v1" };

  await assert.rejects(loadRendition("item-retry", ref));
  fail = false;
  const loaded = await loadRendition("item-retry", { ...ref, uri: "https://storage.test/fresh" });

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://storage.test/fresh");
  assert.equal(loaded.blocks[0]?.id, "doc_heading_001");
});

test("an unknown rendition schema is refused and not cached", async (context) => {
  const calls = stubFetch(context, () => json({ ...rendition, schema: 2 }));
  const ref = { uri: "https://storage.test/next", version: "v9" };

  await assert.rejects(loadRendition("item-schema", ref));
  await assert.rejects(loadRendition("item-schema", ref));
  assert.equal(calls.length, 2);
});

test("one reader giving up does not cancel the download for another", async (context) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls = stubFetch(context, async () => {
    await gate;
    return json(rendition);
  });
  const ref = { uri: "https://storage.test/slow", version: "v1" };
  const controller = new AbortController();

  const abandoned = loadRendition("item-abort", ref, controller.signal);
  const kept = loadRendition("item-abort", ref);
  controller.abort();
  release();

  await assert.rejects(abandoned, { name: "AbortError" });
  assert.equal((await kept).blocks.length, 4);
  assert.equal(calls.length, 1);
});

function stubFetch(
  context: { after: (fn: () => void) => void },
  respond: () => Response | Promise<Response>,
): string[] {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return await respond();
  }) as typeof fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
