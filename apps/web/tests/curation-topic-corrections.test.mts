import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

const { correctionSuggestions, correctionsWith, phrasesOf } = await import("../src/modules/curation/governance.ts");

const topics = [
  { name: "t/ops", displayName: "Banking Operations", kind: "DOMAIN", state: "ACTIVE" },
  { name: "t/cards", displayName: "Cards", kind: "TOPIC", parentTopic: "t/ops", state: "ACTIVE", keywords: ["card"], synonyms: ["thẻ"] },
  { name: "t/recon", displayName: "Reconciliation", kind: "TOPIC", parentTopic: "t/ops", state: "ACTIVE", keywords: ["settlement"] },
  { name: "t/napas", displayName: "Domestic switching", kind: "TOPIC", parentTopic: "t/ops", state: "ACTIVE", keywords: ["chargeback dispute"] },
  { name: "t/gone", displayName: "Gone", kind: "TOPIC", parentTopic: "t/ops", state: "DELETED" },
  { name: "t/prop", displayName: "Open banking", kind: "TOPIC", state: "PROPOSED" },
] as const;

let seq = 0;
const correction = (title: string | undefined, to: string[], from: string[] = []) => ({
  name: `c/${++seq}`,
  item: title === undefined ? undefined : `workspaces/w/items/d${seq}`,
  itemDisplayName: title,
  toTopics: to,
  fromTopics: from,
  state: "OPEN" as const,
});

test("phrasesOf: English pairs and single words, stop words and numbers left out, extension dropped", () => {
  assert.deepEqual(phrasesOf("Chargeback dispute guide v2 2024.pdf"), ["chargeback dispute", "chargeback", "dispute"]);
  // A stop word breaks pairs and never stands alone.
  assert.deepEqual(phrasesOf("Policy for card refunds"), ["card refunds", "card", "refunds"]);
  // Words under three letters never pair; singles need four.
  assert.deepEqual(phrasesOf("ATM cash top up"), ["atm cash", "cash top", "cash"]);
});

test("phrasesOf: Vietnamese titles give pairs and acronyms only, never a stop phrase's half", () => {
  // "giao dịch" is a stop phrase: neither "soát giao" nor "dịch napas" is offered; NAPAS stays as an acronym.
  assert.deepEqual(phrasesOf("Đối soát giao dịch NAPAS.docx"), ["đối soát", "napas"]);
  assert.deepEqual(phrasesOf("Quy trình hoàn tiền thẻ"), ["hoàn tiền", "tiền thẻ"]);
  // Typographic punctuation alone doesn't make a title Vietnamese.
  assert.deepEqual(phrasesOf("Refund “express” lane"), ["refund express", "express lane", "refund", "express", "lane"]);
});

test("correctionSuggestions: groups by each active target topic not removed, biggest first", () => {
  const cs = [
    correction("Daily settlement report cards", ["t/recon"], ["t/cards"]),
    correction("Settlement cut-off times", ["t/recon"], ["t/cards"]),
    correction(undefined, ["t/recon"], []),
    correction("Card refund steps", ["t/cards", "t/gone", "t/prop"], []),
    // Kept a topic it already had: not a move.
    correction("Card limits", ["t/cards"], ["t/cards"]),
  ];
  const out = correctionSuggestions(cs, topics);
  assert.deepEqual(
    out.map((s) => [s.topic.name, s.corrections.length]),
    [
      ["t/recon", 3],
      ["t/cards", 1],
    ],
  );
  assert.deepEqual(out[0].from, ["t/cards"]);
  assert.deepEqual(out[1].from, []);
});

test("correctionSuggestions: phrases need two titles, skip the topic's own words and name, at most four", () => {
  const cs = [
    correction("Interbank transfer limits overview", ["t/recon"]),
    correction("Interbank transfer limits FAQ", ["t/recon"]),
    correction("Interbank transfer settlement Reconciliation", ["t/recon"]),
    correction("Lonely title words", ["t/recon"]),
  ];
  const [s] = correctionSuggestions(cs, topics);
  assert.deepEqual(
    s.phrases.map((p) => [p.text, p.n]),
    [
      ["interbank transfer", 3],
      ["interbank", 3],
      ["transfer", 3],
      ["transfer limits", 2],
    ],
  );
  // "settlement" is this topic's keyword and "reconciliation" its name: neither is offered nor counted as misleading.
  assert.ok(!s.phrases.some((p) => p.text === "settlement" || p.text === "reconciliation"));
  assert.ok(!s.misled.some((p) => p.text === "settlement"));
});

test("correctionSuggestions: another topic's keyword or synonym is why the assistant was misled", () => {
  const cs = [correction("Chargeback dispute on card", ["t/recon"], ["t/napas"]), correction("Thẻ tín dụng đối soát", ["t/recon"], ["t/cards"])];
  const [s] = correctionSuggestions(cs, topics);
  assert.deepEqual(
    s.misled.map((m) => [m.text, m.elsewhere]),
    [
      ["chargeback dispute", "t/napas"],
      ["card", "t/cards"],
    ],
  );
  // One title each: nothing to offer yet.
  assert.deepEqual(s.phrases, []);
  assert.deepEqual(s.from, ["t/napas", "t/cards"]);
});

test("correctionSuggestions: Vietnamese titles and acronyms are counted across corrections", () => {
  const cs = [correction("Đối soát giao dịch NAPAS tháng 5", ["t/recon"]), correction("Hướng dẫn đối soát NAPAS", ["t/recon"])];
  const [s] = correctionSuggestions(cs, topics);
  assert.deepEqual(
    s.phrases.map((p) => [p.text, p.n]),
    [
      ["đối soát", 2],
      ["napas", 2],
    ],
  );
});

test("correctionsWith: the corrections whose titles contain a phrase, accents ignored", () => {
  const cs = [correction("Đối soát NAPAS", ["t/recon"]), correction("Doi soat thu cong", ["t/recon"]), correction("Other", ["t/recon"]), correction(undefined, ["t/recon"])];
  assert.deepEqual(
    correctionsWith(cs, "đối soát").map((c) => c.itemDisplayName),
    ["Đối soát NAPAS", "Doi soat thu cong"],
  );
});
