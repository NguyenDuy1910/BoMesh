import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  RevealPacer,
  rehypeCaret,
  revealLength,
  splitStreamingMarkdown,
} from "../src/modules/chat/streaming-markdown.ts";

/** The answer's Markdown with the writing caret, as the chat renders it while streaming. */
const withCaret = (markdown: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeCaret] }, markdown));
const CARET = '<span class="chat-caret" aria-hidden="true"></span>';

test("the caret never goes inside a void element and sits at the very end of the text", () => {
  // A hard line break, a rule, a task checkbox: React refuses children on void elements.
  assert.ok(withCaret("Line one  \nline two").endsWith(`line two${CARET}</p>`));
  assert.ok(withCaret("Text\n\n---").endsWith(`<hr/>${CARET}`));
  assert.ok(withCaret("- [ ] task").includes(`task${CARET}</li>`));
  // After the last words, not inside an earlier bold run.
  assert.ok(withCaret("a **b** c").endsWith(`c${CARET}</p>`));
  assert.ok(withCaret("ends **bold**").endsWith(`</strong>${CARET}</p>`));
  // Into the last cell and the last item, never into code.
  assert.ok(withCaret("| a |\n|---|\n| b |").includes(`b${CARET}</td>`));
  assert.ok(withCaret("- one\n- two").includes(`two${CARET}</li>`));
  assert.ok(withCaret("```\ncode\n```").endsWith(`</pre>${CARET}`));
});

const FRAME = 16;

/** Paint frames until ``until`` ms; ``arrivals`` add text at their time. Returns each frame's shown length. */
function simulate(text: string, arrivals: Array<[at: number, length: number]>, until: number, doneAt = Infinity) {
  const pacer = new RevealPacer();
  const frames: Array<{ now: number; received: number; position: number; shown: number }> = [];
  let received = 0;
  let shown = 0;
  for (let now = 0; now <= until; now += FRAME) {
    for (const [at, length] of arrivals) {
      if (at <= now && length > received) {
        received = length;
        pacer.arrive(received, at);
      }
    }
    const position = pacer.advance(received, FRAME, now >= doneAt);
    shown = revealLength(text.slice(0, received), position, shown);
    frames.push({ now, received, position, shown });
  }
  return frames;
}

test("keeps a fenced code block whole even when it contains a blank line", () => {
  const text = "Here is the fix:\n\n```python\na = 1\n\nb = 2\n```\nDone.";
  const { stable, tail } = splitStreamingMarkdown(text);

  assert.equal(stable, "Here is the fix:\n\n");
  assert.equal(tail, "```python\na = 1\n\nb = 2\n```\nDone.");
});

test("keeps an unterminated fence in the tail", () => {
  const { stable, tail } = splitStreamingMarkdown("Intro.\n\n```ts\nconst a = 1;\n");

  assert.equal(stable, "Intro.\n\n");
  assert.equal(tail, "```ts\nconst a = 1;\n");
});

test("keeps a loose list in one piece so it renders as one list", () => {
  const { stable, tail } = splitStreamingMarkdown("Steps:\n\n- First\n\n- Second\n\n- Third\n");

  assert.equal(stable, "Steps:\n\n");
  assert.equal(tail, "- First\n\n- Second\n\n- Third\n");
});

test("keeps a numbered list in one piece so numbering never restarts", () => {
  const { stable, tail } = splitStreamingMarkdown("Order:\n\n1. One\n\n2. Two\n\n3. Th");

  assert.equal(stable, "Order:\n\n");
  assert.equal(tail, "1. One\n\n2. Two\n\n3. Th");
});

test("keeps an indented list continuation with its item", () => {
  const text = "Checklist:\n\n- Parent\n\n    Detail for the parent.\n\n- Next\n";

  const { stable, tail } = splitStreamingMarkdown(text);

  assert.equal(stable, "Checklist:\n\n");
  assert.equal(tail, "- Parent\n\n    Detail for the parent.\n\n- Next\n");
});

test("releases a completed list once the next top-level block starts", () => {
  const { stable, tail } = splitStreamingMarkdown("Steps:\n\n- First\n\n- Second\n\nThen deploy");

  assert.equal(stable, "Steps:\n\n- First\n\n- Second\n\n");
  assert.equal(tail, "Then deploy");
});

test("keeps a display math block whole", () => {
  const text = "The rate is:\n\n$$\nr = \\frac{a}{b}\n\nc = 1\n$$\n\nDone";
  const { stable, tail } = splitStreamingMarkdown(text);

  assert.equal(stable, "The rate is:\n\n$$\nr = \\frac{a}{b}\n\nc = 1\n$$\n\n");
  assert.equal(tail, "Done");
});

test("parses text that uses reference definitions as a single document", () => {
  const text = "See the [policy][p] for detail.\n\n[p]: https://example.com/policy\n";

  assert.deepEqual(splitStreamingMarkdown(text), { stable: "", tail: text });
});

test("advances the boundary to the last finished block", () => {
  const text = "# Title\n\nFirst paragraph.\n\n## Section\n\nSecond para";
  const { stable, tail } = splitStreamingMarkdown(text);

  assert.equal(stable, "# Title\n\nFirst paragraph.\n\n## Section\n\n");
  assert.equal(tail, "Second para");
});

test("holds the first block until a later one starts", () => {
  assert.deepEqual(splitStreamingMarkdown("A partial para"), { stable: "", tail: "A partial para" });
});

test("reveals whole words and never overshoots the received text", () => {
  const text = "The quick brown fox jumps over the lazy dog and keeps running along.";
  const frames = simulate(text, [[0, text.length]], 3000, 0);

  const paints = [...new Set(frames.map((f) => f.shown))].map((n) => text.slice(0, n));
  assert.ok(paints.length > 3, "a burst is revealed over several paints");
  assert.equal(paints.at(-1), text);
  for (const paint of paints.slice(0, -1)) assert.match(paint, /(^$|[ \n\t]$)/, `"${paint}" ends mid-word`);
  for (const f of frames) assert.ok(f.shown <= f.received);
});

test("moves steadily between network bursts instead of jumping with them", () => {
  // 30 characters every 300ms (100 characters/s), the way a model streams over a proxy.
  const text = "lorem ipsum dolor sit amet ".repeat(40);
  const arrivals: Array<[number, number]> = [];
  for (let at = 0, length = 30; length <= text.length; at += 300, length += 30) arrivals.push([at, length]);
  const frames = simulate(text, arrivals, 6000).filter((f) => f.now >= 1000 && f.now <= 6000);

  for (let i = 1; i < frames.length; i += 1) {
    const step = frames[i]!.position - frames[i - 1]!.position;
    assert.ok(step <= 4, `jumped ${step.toFixed(1)} characters in one frame at ${frames[i]!.now}ms`);
    if (frames[i - 1]!.position < frames[i - 1]!.received) assert.ok(step > 0, `stalled at ${frames[i]!.now}ms with text waiting`);
  }
  // It keeps up: never more than ~one burst behind.
  for (const f of frames) assert.ok(f.received - f.position <= 60, `fell ${f.received - f.position} characters behind`);
});

test("drains a large backlog quickly once the stream ends", () => {
  const text = "word ".repeat(2000); // 10k characters arriving at once, then the stream ends
  const frames = simulate(text, [[0, text.length]], 3000, 0);
  const finished = frames.find((f) => f.shown === text.length);
  assert.ok(finished && finished.now <= 1500, `finished at ${finished?.now}ms`);
});

test("shows a short reply at once without waiting for more text", () => {
  const frames = simulate("Hi", [[0, 2]], 200);
  assert.ok(frames.find((f) => f.shown === 2)!.now <= 100);
  assert.equal(revealLength("Hi there", 8, 2), 8);
});
