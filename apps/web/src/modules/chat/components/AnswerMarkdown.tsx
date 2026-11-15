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
import { RevealPacer, revealLength, splitStreamingMarkdown } from "../streaming-markdown";
import type { AnswerSource } from "../turn";
import { CitationMarker } from "./CitationMarker";

/**
 * An answer's Markdown with inline citation markers (preview `md()` + `.chat-answer`).
 *
 * A streamed answer renders as its finished blocks, each parsed once when it
 * completes, plus the block being written (`streaming-markdown.ts`); text flows
 * onto screen at the pace it arrives (`RevealPacer`) and a caret follows it. `[n]` becomes a
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

// Only the block being written can hold a half-written marker; `text-only` keeps a partial link as text.
const TAIL_REMEND: RemendOptions = { linkMode: "text-only" };

/**
 * A stored answer parses once, as one document. A streamed answer renders as
 * its finished blocks plus the block being written, and keeps that shape after
 * it settles: the end of a stream (and the stored copy replacing the live one)
 * swaps no DOM, and a long answer never re-parses what is already on screen.
 */
const StreamingMarkdown = memo(function StreamingMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const [streamed, setStreamed] = useState(streaming);
  if (streaming && !streamed) setStreamed(true);
  const revealed = useRevealedText(text, streaming);
  const revealing = streaming || revealed.length < text.length;
  const { stable, tail } = useMemo(() => (streamed ? splitStreamingMarkdown(revealed) : { stable: "", tail: "" }), [revealed, streamed]);
  const blocks = useFinishedBlocks(stable);
  if (!streamed) return <MarkdownBlock content={text} />;
  return (
    <>
      {blocks.map((content, i) => (
        <MarkdownBlock key={i} content={content} caret={revealing && !tail && i === blocks.length - 1} />
      ))}
      {tail || (revealing && !blocks.length) ? <MarkdownBlock key={blocks.length} content={tail} partial={revealing} caret={revealing} /> : null}
    </>
  );
});

/** The finished prefix as blocks, appended as they complete (a regenerated prefix starts over). */
function useFinishedBlocks(stable: string): readonly string[] {
  const [state, setState] = useState<{ text: string; blocks: readonly string[] }>({ text: "", blocks: [] });
  if (state.text === stable) return state.blocks;
  const next = state.text && stable.startsWith(state.text)
    ? { text: stable, blocks: [...state.blocks, stable.slice(state.text.length)] }
    : { text: stable, blocks: stable ? [stable] : [] };
  setState(next);
  return next.blocks;
}

interface Reveal {
  pacer: RevealPacer;
  text: string;
  streaming: boolean;
  shown: number;
  frame: number;
  last: number;
}

/** The part of `text` on screen: paced to the arrival rate, whole words at a time, one state update per new word. */
function useRevealedText(text: string, streaming: boolean): string {
  const [initial] = useState(() => (streaming ? 0 : text.length));
  const [shown, setShown] = useState(initial);
  const reveal = useRef<Reveal | null>(null);

  useEffect(() => {
    const r = (reveal.current ??= { pacer: new RevealPacer(initial), text, streaming, shown: initial, frame: 0, last: 0 });
    const head = Math.min(64, r.shown);
    if (text.length < r.shown || text.slice(0, head) !== r.text.slice(0, head)) {
      // A regenerated answer replaces the text instead of extending it.
      r.pacer = new RevealPacer(text.length);
      r.shown = text.length;
      setShown(text.length);
    } else {
      r.pacer.arrive(text.length, performance.now());
    }
    r.text = text;
    r.streaming = streaming;
    if (r.frame || r.shown >= text.length) return;
    const paint = (now: number) => {
      r.frame = 0;
      const elapsed = r.last ? Math.min(now - r.last, 100) : 16;
      r.last = now;
      const next = revealLength(r.text, r.pacer.advance(r.text.length, elapsed, !r.streaming), r.shown);
      if (next !== r.shown) {
        r.shown = next;
        setShown(next);
      }
      if (r.shown < r.text.length) r.frame = requestAnimationFrame(paint);
      else r.last = 0;
    };
    r.frame = requestAnimationFrame(paint);
  }, [text, streaming, initial]);

  useEffect(
    () => () => {
      const r = reveal.current;
      if (r?.frame) cancelAnimationFrame(r.frame);
      if (r) r.frame = 0;
    },
    [],
  );
  return shown >= text.length ? text : text.slice(0, shown);
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

/** One markdown block; `partial` = still being written (healed, math left as typed). */
const MarkdownBlock = memo(function MarkdownBlock({ content, partial = false, caret = false }: { content: string; partial?: boolean; caret?: boolean }) {
  const source = useMemo(() => (partial ? remend(content, TAIL_REMEND) : normalizeMarkdownMath(content)), [content, partial]);
  if (!source && !caret) return null;
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={caret ? REHYPE_CARET : REHYPE} components={COMPONENTS}>
      {source}
    </ReactMarkdown>
  );
});

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
