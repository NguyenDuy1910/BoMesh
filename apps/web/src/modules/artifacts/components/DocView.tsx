"use client";

import { Button, Tooltip } from "@heroui/react";
import clsx from "clsx";
import { Bold, Heading, Italic, List as ListIcon, Undo2 } from "lucide-react";
import { createElement, useEffect, useMemo, useRef, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ErrorState, SkeletonRows } from "@/components/ui";
import { DocumentRenderer } from "@/modules/knowledge/content/DocumentRenderer";
import type { ContentNode } from "@/modules/knowledge/content/api";
import { useContentWindows } from "@/modules/knowledge/content/queries";

import { diffLines, diffMarkdown, diffNodes, type BlockStatus } from "../diff";
import { htmlToMarkdown } from "../html-markdown";

import type { VersionStructure } from "./useVersionContent";

/**
 * Markdown is drawn one heading level down, so a file's `# Title` reads like
 * the preview's page title (h2) and its sections like h3. The editor undoes it.
 */
export const HEADING_OFFSET = 1;

type HeadingTag = "h2" | "h3" | "h4" | "h5" | "h6";
const SHIFTED: Record<string, HeadingTag> = { h1: "h2", h2: "h3", h3: "h4", h4: "h5", h5: "h6", h6: "h6" };
const BLOCK_TAGS = ["p", "ul", "ol", "table", "pre", "blockquote", "hr", "h1", "h2", "h3", "h4", "h5", "h6"] as const;

const STATUS_CLASS: Record<BlockStatus, string | undefined> = { same: undefined, added: "wk-d-add", removed: "wk-d-del" };
const STATUS_TAG: Record<BlockStatus, string | undefined> = { same: undefined, added: "Đã thêm", removed: "Đã gỡ" };

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

/* ═══════════════ Binary documents (Structured Document) ═══════════════ */

/** Every window of one version's Structured Document, read one after another. */
function useWholeContent(item: string, { revision, version }: VersionStructure) {
  const windows = useContentWindows(item, { revision, version });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = windows;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isError, isFetchingNextPage]);
  const nodes = useMemo(() => windows.data?.pages.flatMap((page) => page.nodes ?? []) ?? [], [windows.data]);
  return { nodes, done: !!windows.data && !hasNextPage, isError, error: windows.error, refetch: windows.refetch };
}

/** What changed between two binary versions, block by block of their Structured Documents. */
export function StructureDiff({ item, before, after }: { item: string; before: VersionStructure; after: VersionStructure }) {
  const older = useWholeContent(item, before);
  const newer = useWholeContent(item, after);
  const changes = useMemo(() => {
    if (!older.done || !newer.done) return null;
    const status = new Map<ContentNode, BlockStatus>();
    const nodes = diffNodes(older.nodes, newer.nodes).map((change) => {
      status.set(change.node, change.status);
      return change.node;
    });
    return { nodes, status };
  }, [newer.done, newer.nodes, older.done, older.nodes]);

  const failed = newer.isError ? newer : older.isError ? older : null;
  if (failed) return <ErrorState error={failed.error} onRetry={() => void failed.refetch()} boxed={false} title="Không tải được nội dung để so sánh" />;
  if (!changes) return <SkeletonRows rows={6} />;
  return (
    <div className="wk-doc">
      <DocumentRenderer nodes={changes.nodes} nodeClassName={(node) => STATUS_CLASS[changes.status.get(node) ?? "same"]} />
    </div>
  );
}

/* ═══════════════ Editing in place ═══════════════ */

const TOOLS = [
  { cmd: "bold", label: "In đậm", icon: Bold },
  { cmd: "italic", label: "In nghiêng", icon: Italic },
  { cmd: "formatBlock", arg: "<h3>", label: "Tiêu đề", icon: Heading },
  { cmd: "insertUnorderedList", label: "Danh sách dấu đầu dòng", icon: ListIcon },
  { cmd: "undo", label: "Hoàn tác", icon: Undo2 },
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
      <div className="wk-etb" role="toolbar" aria-label="Định dạng">
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
        <span className="t-xs muted">Lưu sẽ tạo phiên bản {nextVersion}</span>
      </div>
      <div className="wk-doc">
        <article
          ref={editorRef}
          className="wk-page is-editing"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={`Sửa ${title}`}
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
