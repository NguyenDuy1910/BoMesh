"use client";

import { useEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";

import { NO_TEXT_MARKS, searchNeedles, textMarks, type CitedPassage, type TextMarks } from "../marks";
import { DocumentViewer } from "./DocumentViewer";
import { Marked } from "./Marked";
import { CutNotice } from "./ReaderParts";
import { useRepresentationBody, type ViewerProps } from "./viewer";

/** Lines of a text shown as a first page (the review pane). */
const FIRST_PAGE_LINES = 60;

const readText = (response: Response) => response.text();

/**
 * The TEXT representation (document_viewer.md "Payloads"): UTF-8 text the engine already decoded,
 * pretty-printed (JSON) and cut at 1 MiB. MARKDOWN is rendered in the reader's page styling; PLAIN is
 * one monospaced page labelled with its `language`. Cited passages and search words are marked.
 */
export function TextView({ fileKey, representation, refresh, first, highlight, focusHit, onMarks, onDownload }: ViewerProps) {
  const body = useRepresentationBody({ fileKey, representation, refresh }, readText);
  const markdown = representation.textFormat === "MARKDOWN";

  if (body.isPending) {
    return (
      <DocumentViewer format={markdown ? "markdown" : "text"} count={1}>
        <section className="doc-page doc-page--text" aria-busy="true" aria-label="Loading">
          {[92, 76, 84, 60].map((w) => (
            <span key={w} className="skeleton skeleton--line block" style={{ width: `${w}%`, marginBottom: 10 }} />
          ))}
        </section>
      </DocumentViewer>
    );
  }
  if (body.isError) return <ErrorState title="This file didn’t load" error={body.error} onRetry={() => void body.refetch()} />;
  const text = first ? body.data.split("\n", FIRST_PAGE_LINES).join("\n") : body.data;
  return (
    <>
      <TextBody text={text} markdown={markdown} language={representation.language} highlight={highlight} focusHit={focusHit} onMarks={onMarks} />
      {representation.truncated && !first ? <CutNotice onDownload={onDownload}>Showing the first 1 MB — download for the rest.</CutNotice> : null}
    </>
  );
}

function TextBody({
  text,
  markdown: isMarkdown,
  language,
  highlight,
  focusHit,
  onMarks,
}: {
  text: string;
  markdown: boolean;
  language?: string;
  highlight?: ViewerProps["highlight"];
  focusHit: number;
  onMarks: ViewerProps["onMarks"];
}) {
  const passages = highlight?.passages;
  const needles = useMemo(() => (highlight?.q ? searchNeedles(highlight.q, text, highlight.cited) : []), [highlight?.q, highlight?.cited, text]);
  const marking = !!(passages?.length || needles.length);

  const plainMarks = useMemo(() => (!isMarkdown && marking ? textMarks(text, { passages, needles }) : NO_TEXT_MARKS), [isMarkdown, marking, text, passages, needles]);

  /* Markdown: marks are placed while rendering (see `rehypeEvidence`). */
  const rootRef = useRef<HTMLElement>(null);
  const markdown = useMemo(() => {
    if (!isMarkdown) return null;
    const out = { current: NO_TEXT_MARKS };
    const node = (
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={marking ? [[rehypeEvidence, { passages, needles, out }]] : []} components={MD}>
        {text}
      </ReactMarkdown>
    );
    return { node, out };
  }, [isMarkdown, text, marking, passages, needles]);

  useEffect(() => {
    // Rendering ran the Markdown plugin, which counted what it marked.
    const { total, unresolved } = markdown ? markdown.out.current : plainMarks;
    onMarks({ total, unresolved, ready: true });
  }, [markdown, plainMarks, onMarks]);

  // Markdown marks are static markup: the focused one is flagged here rather than by rendering again.
  useEffect(() => {
    const root = rootRef.current;
    if (!markdown || !root) return;
    for (const el of root.querySelectorAll("mark.evidence.is-focus")) el.classList.remove("is-focus");
    for (const el of root.querySelectorAll(`mark.evidence[data-hit="${focusHit}"]`)) el.classList.add("is-focus");
  }, [markdown, focusHit]);

  if (!text.trim()) {
    return (
      <div className="doc-state">
        <EmptyState title="This file is empty" />
      </div>
    );
  }
  if (markdown) {
    return (
      <DocumentViewer format="markdown" count={1}>
        <section ref={rootRef} className="doc-page doc-page--markdown" data-page={1}>
          {markdown.node}
        </section>
      </DocumentViewer>
    );
  }
  return (
    <DocumentViewer format="text" count={1}>
      <section className="doc-page doc-page--text" data-page={1}>
        {language ? (
          <span className="doc-text__lang" translate="no">
            {language}
          </span>
        ) : null}
        <pre className="doc-text">
          <Marked text={text} ranges={plainMarks.ranges} focusHit={focusHit} />
        </pre>
      </section>
    </DocumentViewer>
  );
}

/* Headings start one level down: the page title is h2 in the reader's page styling. Images in a text file point at
   files the viewer can't reach (relative paths) or at third parties, so they aren't loaded. */
const MD: Components = {
  h1: ({ children }) => <h2>{children}</h2>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h3>{children}</h3>,
  h4: ({ children }) => <h3>{children}</h3>,
  a: ({ children, href }) =>
    href && /^(?:https?:|mailto:)/i.test(href) ? (
      <a className="link" href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: () => null,
};

/* ═══════════════ Evidence marks in rendered Markdown ═══════════════ */

/** The parts of a HAST tree this plugin reads and writes. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Elements whose text starts and ends a line of their own, so a quote never runs across them. */
const BLOCK_TAGS: Readonly<Record<string, true>> = Object.fromEntries(
  ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "pre", "blockquote", "table", "thead", "tbody", "tr", "td", "th", "br", "hr", "div"].map((t) => [t, true]),
);

/**
 * Marks cited passages and search words in rendered Markdown: the text of the whole page is matched
 * (as `textMarks` does for plain text) and every text node a mark covers is split, its covered part
 * wrapped in `mark.evidence[data-hit]` — a quote that spans formatting becomes several marks with one
 * hit number. What was marked is written to `out`.
 */
function rehypeEvidence({ passages, needles, out }: { passages?: readonly CitedPassage[]; needles: readonly string[]; out: { current: TextMarks } }) {
  return (tree: HastNode) => {
    const texts: { node: HastNode; parent: HastNode; start: number }[] = [];
    let all = "";
    const walk = (node: HastNode) => {
      for (const child of node.children ?? []) {
        if (child.type === "text") {
          texts.push({ node: child, parent: node, start: all.length });
          all += child.value ?? "";
        } else if (child.type === "element") {
          const block = BLOCK_TAGS[child.tagName ?? ""] === true;
          if (block) all += "\n";
          walk(child);
          if (block) all += "\n";
        }
      }
    };
    walk(tree);
    const marks = textMarks(all, { passages, needles });
    out.current = marks;
    if (!marks.total) return;
    for (const { node, parent, start } of texts) {
      const value = node.value ?? "";
      const end = start + value.length;
      const hits = marks.ranges.filter((r) => r.start < end && r.end > start);
      if (!hits.length) continue;
      const parts: HastNode[] = [];
      let at = 0;
      for (const r of hits) {
        const from = Math.max(0, r.start - start);
        const to = Math.min(value.length, r.end - start);
        if (from > at) parts.push({ type: "text", value: value.slice(at, from) });
        parts.push({ type: "element", tagName: "mark", properties: { className: ["evidence"], dataHit: r.hit }, children: [{ type: "text", value: value.slice(from, to) }] });
        at = to;
      }
      if (at < value.length) parts.push({ type: "text", value: value.slice(at) });
      const siblings = parent.children!;
      siblings.splice(siblings.indexOf(node), 1, ...parts);
    }
  };
}
