import assert from "node:assert/strict";
import test from "node:test";

import { callName, greeting, homeOptions, isQuestion } from "../src/modules/home/intent.ts";

const fold = (s: string) => s.toLowerCase();
const tokens = (q: string) => fold(q).split(/\s+/).filter(Boolean);
const doc = (id: string) => ({ id, title: id, fileName: `${id}.pdf`, mime: "application/pdf", kindLabel: "PDF" });

test("isQuestion recognises questions", () => {
  assert.equal(isQuestion("how do I refund"), true);
  assert.equal(isQuestion("refund policy?"), true);
  assert.equal(isQuestion("refund policy"), false);
});

test("greeting and callName", () => {
  assert.equal(greeting(9), "Good morning");
  assert.equal(greeting(14), "Good afternoon");
  assert.equal(greeting(20), "Good evening");
  assert.equal(callName("Nguyen Van Duy"), "Duy");
  assert.equal(callName("Ada Lovelace"), "Ada");
  assert.equal(callName(undefined), "");
});

test("typed text: likely action first, docs capped, matching questions", () => {
  const opts = homeOptions({
    text: "refund policy",
    docs: [doc("a"), doc("b"), doc("c"), doc("d"), doc("e")],
    questions: [{ id: "1", title: "Refund policy for EU" }, { id: "2", title: "Holidays" }],
    starters: [],
    tokens,
    fold,
  });
  assert.deepEqual(opts.slice(0, 2).map((o) => o.kind), ["find", "ask"]);
  assert.equal(opts.filter((o) => o.kind === "doc").length, 4);
  assert.deepEqual(opts.filter((o) => o.kind === "conv").map((o) => (o.kind === "conv" ? o.conv.id : "")), ["1"]);
  assert.equal(homeOptions({ text: "how?", docs: [], questions: [], starters: [], tokens, fold })[0].kind, "ask");
});

test("empty text: recent questions then unasked starters", () => {
  const opts = homeOptions({
    text: " ",
    docs: [],
    questions: [{ id: "1", title: "What is X" }],
    starters: ["What is X", "Who owns Y", "Where is Z", "When is W"],
    tokens,
    fold,
  });
  assert.equal(opts[0].kind, "conv");
  assert.deepEqual(opts.slice(1).map((o) => (o.kind === "ask" ? o.q : "")), ["Who owns Y", "Where is Z", "When is W"]);
});
