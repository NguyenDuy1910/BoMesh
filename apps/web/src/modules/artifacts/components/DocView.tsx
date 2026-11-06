"use client";

import { Button, Tooltip } from "@heroui/react";
import clsx from "clsx";
import { Bold, Heading, Italic, List as ListIcon, Undo2 } from "lucide-react";
import { createElement, useEffect, useMemo, useRef, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { blockText, type RenditionBlock } from "@/modules/knowledge/reader/rendition";

import { alignSequences, diffLines, diffMarkdown, type BlockStatus } from "../diff";
import { htmlToMarkdown } from "../html-markdown";

/**
 * Markdown is drawn one heading level down, so a file's `# Title` reads like
 * the preview's page title (h2) and its sections like h3. The editor undoes it.
 */
export const HEADING_OFFSET = 1;

type HeadingTag = "h2" | "h3" | "h4" | "h5" | "h6";
const SHIFTED: Record<string, HeadingTag> = { h1: "h2", h2: "h3", h3: "h4", h4: "h5", h5: "h6", h6: "h6" };
const BLOCK_TAGS = ["p", "ul", "ol", "table", "pre", "blockquote", "hr", "h1", "h2", "h3", "h4", "h5", "h6"] as const;

const STATUS_CLASS: Record<BlockStatus, string | undefined> = { same: undefined, added: "wk-d-add", removed: "wk-d-del" };
const STATUS_TAG: Record<BlockStatus, string | undefined> = { same: undefined, added: "Added", removed: "Removed" };

/**
 * Markdown components: headings shifted; with a `status`, the block's
 * top-level element carries the change class and its tag (preview `tagBlock`).
 */
function markdownComponents(status?: BlockStatus): Components {
  const block = (tag: (typeof BLOCK_TAGS)[number]) =>
    function Block({ node, children, className, ...rest }: Record<string, unknown> & ExtraProps & { children?: ReactNode; className?: string }) {
      const top = !!status && status !== "same" && node?.position?.start.offset === 0;
      return createElement(
        SHIFTED[tag] ?? tag,
        { ...rest, className: clsx(className, top && STATUS_CLASS[status!]) || undefined },
        top ? <span className="wk-d-tag">{STATUS_TAG[status!]}</span> : null,
        children,
      );
    };
  // One renderer per block tag; react-markdown's per-tag prop types are too wide to spell out here.
  return Object.fromEntries(BLOCK_TAGS.map((tag) => [tag, block(tag)])) as Components;
}

const PLAIN_COMPONENTS = markdownComponents();

function Markdown({ text, status }: { text: string; status?: BlockStatus }) {
  const components = useMemo(() => (status ? markdownComponents(status) : PLAIN_COMPONENTS), [status]);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

/** A Markdown version as a page (preview `.wk-page`). */
export function MarkdownPage({ text }: { text: string }) {
  return (
    <div className="wk-doc">
      <article className="wk-page" translate="no">
        <Markdown text={text} />
      </article>
    </div>
  );
}

/** A plain-text version (JSON, HTML source, logs) as written. */
export function PlainPage({ text }: { text: string }) {
  return (
    <div className="wk-doc">
      <article className="wk-page" translate="no">
        <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
          {text}
        </pre>
      </article>
    </div>
  );
}

/** What changed between two text versions, block by block (preview `docDiffHtml`). */
export function TextDiff({ before, after, markdown }: { before: string; after: string; markdown: boolean }) {
  const changes = useMemo(() => (markdown ? diffMarkdown(before, after) : diffLines(before, after)), [after, before, markdown]);
  return (
    <div className="wk-doc">
      <article className="wk-page wk-page--diff" translate="no">
        {changes.map((change, i) =>
          markdown ? (
            <Markdown key={i} text={change.text} status={change.status} />
          ) : (
            <p key={i} className={STATUS_CLASS[change.status]}>
              {STATUS_TAG[change.status] ? <span className="wk-d-tag">{STATUS_TAG[change.status]}</span> : null}
              {change.text}
            </p>
          ),
        )}
      </article>
    </div>
  );
}

/* ═══════════════ Binary documents (server rendition) ═══════════════ */

function RenditionBlockView({ block, status = "same" }: { block: RenditionBlock; status?: BlockStatus }) {
  const className = STATUS_CLASS[status];
  const tag = STATUS_TAG[status] ? <span className="wk-d-tag">{STATUS_TAG[status]}</span> : null;
  switch (block.kind) {
    case "heading":
      return createElement(SHIFTED[`h${Math.min(Math.max(block.level, 1), 6)}`] ?? "h3", { className }, tag, block.text);
    case "table":
      return (
        <table className={className}>
          {block.caption ? <caption>{block.caption}</caption> : null}
          <thead>
            <tr>
              {block.columns.map((c, i) => (
                <th key={i}>{i === 0 ? tag : null}{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((v, i) => (
                  <td key={i}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "code":
      return (
        <pre className={clsx("mono", className)}>
          {tag}
          {block.text}
        </pre>
      );
    case "link":
      return (
        <p className={className}>
          {tag}
          <a className="chat-link" href={block.url} target="_blank" rel="noreferrer">
            {block.text || block.url}
          </a>
        </p>
      );
    case "image":
      return block.text ? <p className={clsx("muted", className)}>{tag}{block.text}</p> : null;
    default:
      return (
        <p className={className}>
          {tag}
          {block.text}
        </p>
      );
  }
}

/** A Word/PDF/slides version drawn from its rendition blocks. */
export function RenditionPage({ blocks }: { blocks: readonly RenditionBlock[] }) {
  return (
    <div className="wk-doc">
      <article className="wk-page" translate="no">
        {blocks.map((block) => (
          <RenditionBlockView key={block.id} block={block} />
        ))}
      </article>
    </div>
  );
}

/** Changes between two renditions, block by block. */
export function RenditionDiff({ before, after }: { before: readonly RenditionBlock[]; after: readonly RenditionBlock[] }) {
  const changes = useMemo(() => alignSequences(before, after, (b) => `${b.kind}:${blockText(b).replaceAll(/\s+/g, " ").trim()}`), [after, before]);
  return (
    <div className="wk-doc">
      <article className="wk-page wk-page--diff" translate="no">
        {changes.map((change, i) => (
          <RenditionBlockView key={i} block={change.value} status={change.status} />
        ))}
      </article>
    </div>
  );
}

/* ═══════════════ Editing in place ═══════════════ */

const TOOLS = [
  { cmd: "bold", label: "Bold", icon: Bold },
  { cmd: "italic", label: "Italic", icon: Italic },
  { cmd: "formatBlock", arg: "<h3>", label: "Heading", icon: Heading },
  { cmd: "insertUnorderedList", label: "Bulleted list", icon: ListIcon },
  { cmd: "undo", label: "Undo", icon: Undo2 },
] as const;

export interface DocEditorHandle {
  /** The edited content as Markdown. */
  markdown: () => string;
}

/**
 * Rich-text editing of a Markdown version (preview `wk-edit`): the page
 * becomes editable, a small toolbar formats, `onDirtyChange` reports whether
 * anything changed. Saved as Markdown through `htmlToMarkdown`.
 */
export function DocEditor({
  text,
  title,
  nextVersion,
  onDirtyChange,
  handleRef,
}: {
  text: string;
  title: string;
  nextVersion: number;
  onDirtyChange: (dirty: boolean) => void;
  handleRef: { current: DocEditorHandle | null };
}) {
  const editorRef = useRef<HTMLElement>(null);
  const initial = useRef<string>("");
  const range = useRef<Range | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    initial.current = editor.innerHTML;
    editor.focus();
    handleRef.current = { markdown: () => htmlToMarkdown(editor, { headingOffset: HEADING_OFFSET }) };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  const remember = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)) range.current = selection.getRangeAt(0).cloneRange();
  };
  const changed = () => {
    remember();
    onDirtyChange(!!editorRef.current && editorRef.current.innerHTML !== initial.current);
  };

  const run = (cmd: string, arg?: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (range.current && selection) {
      selection.removeAllRanges();
      selection.addRange(range.current);
    }
    document.execCommand(cmd, false, arg);
    changed();
  };

  return (
    <>
      <div className="wk-etb" role="toolbar" aria-label="Formatting">
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          return (
            <Tooltip key={tool.label}>
              <Button isIconOnly size="sm" variant="ghost" className="button--muted" aria-label={tool.label} onPress={() => run(tool.cmd, "arg" in tool ? tool.arg : undefined)}>
                <Icon className="i i-sm" aria-hidden />
              </Button>
              <Tooltip.Content>{tool.label}</Tooltip.Content>
            </Tooltip>
          );
        })}
        <span className="grow" />
        <span className="t-xs muted">Saving makes version {nextVersion}</span>
      </div>
      <div className="wk-doc">
        <article
          ref={editorRef}
          className="wk-page is-editing"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={`Edit ${title}`}
          translate="no"
          onInput={changed}
          onKeyUp={remember}
          onMouseUp={remember}
        >
          <Markdown text={text} />
        </article>
      </div>
    </>
  );
}
