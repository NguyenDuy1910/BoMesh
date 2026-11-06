"use client";

import "katex/dist/katex.min.css";

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remend, { type RemendOptions } from "remend";

import { CITATION_NUMBER_PROP, rehypeCitationMarkers } from "../citation-markers";
import { sourceLookup } from "../citations";
import { nextRevealLength, REVEAL_COMMIT_INTERVAL_MS, splitStreamingMarkdown } from "../streaming-markdown";
import type { AnswerSource } from "../turn";
import { CitationMarker } from "./CitationMarker";

/**
 * An answer's Markdown with inline citation markers (preview `md()` + `.chat-answer`).
 *
 * While streaming, the finished prefix is parsed once per completed block and
 * only the arriving tail re-parses (`streaming-markdown.ts`); text eases onto
 * screen at a steady cadence and a caret follows it. `[n]` becomes a
 * `CitationMarker` only when the answer cites `n`; numbers of documents the
 * reader can't open render nothing; any other `[n]` stays literal.
 */
export interface AnswerMarkdownProps {
  text: string;
  sources: readonly AnswerSource[];
  streaming?: boolean;
  /** The source shown in the panel (its markers are pressed). */
  activeN?: number | null;
  onCite?: (n: number) => void;
  className?: string;
}

interface CitationRendering {
  lookup: ReadonlyMap<number, AnswerSource>;
  activeN?: number | null;
  onCite?: (n: number) => void;
}

const CitationContext = createContext<CitationRendering>({ lookup: new Map() });

export function AnswerMarkdown({ text, sources, streaming = false, activeN, onCite, className }: AnswerMarkdownProps) {
  const lookup = useMemo(() => sourceLookup(sources), [sources]);
  const value = useMemo(() => ({ lookup, activeN, onCite }), [lookup, activeN, onCite]);
  return (
    <CitationContext.Provider value={value}>
      <div className={className ?? "chat-answer"} translate="no">
        <StreamingMarkdown text={text} streaming={streaming} />
      </div>
    </CitationContext.Provider>
  );
}

function MarkdownCitation({ children, ...properties }: HTMLAttributes<HTMLElement>) {
  const { lookup, activeN, onCite } = useContext(CitationContext);
  const raw = (properties as Record<string, unknown>)[CITATION_NUMBER_PROP];
  const n = typeof raw === "string" ? Number(raw) : Number.NaN;
  const source = Number.isFinite(n) ? lookup.get(n) : undefined;
  // Never a citation of this answer: keep the reader's text.
  if (!source) return <>{children}</>;
  if (!source.available) return null;
  const page = source.passages.find((p) => p.page)?.page;
  const label = `Source ${n}: ${source.title || "Document"}${page ? `, page ${page}` : ""}`;
  return <CitationMarker n={n} label={label} pressed={activeN === source.n} onPress={() => onCite?.(n)} />;
}

/* ═══════════════ Streaming ═══════════════ */

// Only the streaming tail can hold a half-written marker; `text-only` keeps a partial link as text.
const TAIL_REMEND: RemendOptions = { linkMode: "text-only" };

const StreamingMarkdown = memo(function StreamingMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const revealed = useRevealedText(text, streaming);
  const revealing = streaming || revealed.length < text.length;
  const { stable, tail } = useMemo(() => (revealing ? splitStreamingMarkdown(revealed) : { stable: revealed, tail: "" }), [revealed, revealing]);
  return (
    <>
      <MarkdownRenderer content={stable} caret={revealing && !tail} />
      {tail ? <TailMarkdown content={tail} /> : null}
    </>
  );
});

const TailMarkdown = memo(function TailMarkdown({ content }: { content: string }) {
  const healed = useMemo(() => remend(content, TAIL_REMEND), [content]);
  return <MarkdownRenderer content={healed} caret normalizeMath={false} />;
});

/** Ease accumulated text onto screen: one commit per interval, a share of the backlog each time. */
function useRevealedText(text: string, streaming: boolean): string {
  const [revealed, setRevealed] = useState(() => (streaming ? "" : text));
  const target = useRef(text);
  const length = useRef(revealed.length);
  const handle = useRef<number | null>(null);
  const last = useRef(0);
  target.current = text;

  useEffect(() => {
    // A regenerated answer replaces the text instead of extending it.
    if (text.length < length.current || !text.startsWith(revealed.slice(0, Math.min(revealed.length, 64)))) {
      length.current = text.length;
      last.current = 0;
      setRevealed(text);
      return;
    }
    if (length.current >= text.length || handle.current !== null) return;
    const commit = (now: number) => {
      handle.current = null;
      const goal = target.current;
      if (length.current >= goal.length) return;
      if (last.current && now - last.current < REVEAL_COMMIT_INTERVAL_MS) {
        handle.current = requestAnimationFrame(commit);
        return;
      }
      length.current = nextRevealLength(goal, length.current);
      last.current = now;
      setRevealed(goal.slice(0, length.current));
      if (length.current < target.current.length) handle.current = requestAnimationFrame(commit);
    };
    handle.current = requestAnimationFrame(commit);
    // `revealed` is read only to detect a replaced answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(
    () => () => {
      if (handle.current === null) return;
      cancelAnimationFrame(handle.current);
      handle.current = null;
    },
    [],
  );
  return revealed;
}

/* ═══════════════ Rendering ═══════════════ */

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const CARET_HOSTS = new Set(["p", "li", "td", "th", "h4", "blockquote"]);

/** Rehype plugin: the writing caret at the end of the last text block (preview `.chat-caret`). */
function rehypeCaret() {
  return (tree: HastNode) => {
    let host: HastNode = tree;
    for (;;) {
      const last = [...(host.children ?? [])].reverse().find((c) => c.type === "element");
      if (!last || last.tagName === "pre" || last.tagName === "code") break;
      host = last;
      if (CARET_HOSTS.has(last.tagName ?? "") && !(last.children ?? []).some((c) => c.type === "element" && ["ul", "ol", "p"].includes(c.tagName ?? ""))) break;
    }
    host.children = [...(host.children ?? []), { type: "element", tagName: "span", properties: { className: ["chat-caret"], ariaHidden: "true" }, children: [] }];
  };
}

const REMARK = [remarkGfm, remarkMath];
const REHYPE = [rehypeKatex, rehypeCitationMarkers];
const REHYPE_CARET = [rehypeKatex, rehypeCitationMarkers, rehypeCaret];

function Heading({ children }: HTMLAttributes<HTMLHeadingElement>) {
  return <h4>{children}</h4>;
}

/* react-markdown passes its `node`; keep it off the DOM. */
function Table({ children, node: _node, ...props }: HTMLAttributes<HTMLTableElement> & { node?: unknown }) {
  return (
    <div className="chat-table">
      <table {...props}>{children}</table>
    </div>
  );
}

/** Links inside the app stay in the app; external ones open a new tab; sandbox paths keep only their label. */
function Anchor({ children, href }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
  if (!href || /^(sandbox|file|attachment):/i.test(href)) return <>{children}</>;
  if (href.startsWith("/")) {
    return (
      <Link className="chat-link" href={href}>
        {children}
      </Link>
    );
  }
  return (
    <a className="chat-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Pre({ children, node: _node, ...props }: HTMLAttributes<HTMLPreElement> & { node?: unknown }) {
  return (
    <pre className="chat-code" {...props}>
      {children}
    </pre>
  );
}

const COMPONENTS: Components = { h1: Heading, h2: Heading, h3: Heading, h4: Heading, h5: Heading, h6: Heading, table: Table, a: Anchor, pre: Pre, cite: MarkdownCitation };

function MarkdownRenderer({ content, caret = false, normalizeMath = true }: { content: string; caret?: boolean; normalizeMath?: boolean }) {
  const normalized = useMemo(() => (normalizeMath ? normalizeMarkdownMath(content) : content), [content, normalizeMath]);
  if (!normalized && !caret) return null;
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={caret ? REHYPE_CARET : REHYPE} components={COMPONENTS}>
      {normalized}
    </ReactMarkdown>
  );
}

/** `\[…\]` / `\(…\)` → `$$…$$` / `$…$`, outside code fences. */
function normalizeMarkdownMath(content: string): string {
  if (!content || (content.match(/^```/gm)?.length ?? 0) % 2 === 1) return content;
  const fence = /(^|\n)(```+|~~~+)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g;
  let out = "";
  let at = 0;
  for (const match of content.matchAll(fence)) {
    const index = match.index ?? 0;
    out += mathText(content.slice(at, index)) + match[0];
    at = index + match[0].length;
  }
  return out + mathText(content.slice(at));
}

function mathText(content: string): string {
  return content
    .replace(/\\\[/g, () => "$$")
    .replace(/\\\]/g, () => "$$")
    .replace(/\\\(/g, () => "$")
    .replace(/\\\)/g, () => "$")
    .replace(/\$\$([\s\S]*?)\$\$/g, (match, expression: string) => (expression.trim() ? `$$\n${expression.trim()}\n$$` : match));
}
