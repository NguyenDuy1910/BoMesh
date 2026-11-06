"use client";

import { Button, Chip, Input, Spinner, TextField } from "@heroui/react";
import { ArrowUp, Check, ChevronDown, List as ListIcon, Pencil, Quote, Send, Sparkles, TriangleAlert, Undo2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Callout, EmptyState, ErrorState, Segmented, SkeletonRows, Tip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { rollbackRevision } from "@/modules/artifacts/api";
import { htmlToMarkdown } from "@/modules/artifacts/html-markdown";
import { useVersions } from "@/modules/artifacts/queries";

import { draftQuickAsks, draftTypeLabel, recipeDraftType, wordCount, type Artifact } from "../model";
import { useArtifactText, useDocs } from "../queries";
import type { WorkViewProps } from "./WorkItemPage";

type SaveState = "saved" | "saving" | "error";

/** Mark ready for review / Back to draft (preview `drActions`). Ready = shared with the space's staff. */
export function DraftActions({ artifact: a, canEdit, space, actions, flush }: WorkViewProps) {
  if (!canEdit || !space) return null;
  if (a.audience === "SPACE")
    return (
      <Button variant="tertiary" onPress={() => void actions.setAudience("PRIVATE", "Back to draft", { undo: false })}>
        <Pencil className="i" aria-hidden />
        Back to draft
      </Button>
    );
  return (
    <Button
      variant="primary"
      onPress={async () => {
        await flush.current();
        await actions.setAudience("SPACE", `Sent to ${space.displayName} for review`);
      }}
    >
      <Send className="i" aria-hidden />
      Mark ready for review
    </Button>
  );
}

/** Grounded document draft: editor with autosave, Ask for changes, sources and versions (preview `drRender`). */
export function DraftView({ artifact: a, canEdit, space, actions, flush }: WorkViewProps) {
  const text = useArtifactText(a);
  const type = useMemo(() => recipeDraftType(a.name), [a.name]);
  const busy = a.state === "GENERATING";
  const [rail, setRail] = useState(false);
  const [tab, setTab] = useState<"sources" | "versions">("sources");
  const [ask, setAsk] = useState("");
  const [hint, setHint] = useState("");
  const [asking, setAsking] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [words, setWords] = useState(0);
  const editor = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The revision whose content the editor's DOM shows (loaded, or produced by our own commit). */
  const shown = useRef<string | undefined>(undefined);
  const lastSaved = useRef("");
  const [frozen, setFrozen] = useState<{ key: number; text: string } | null>(null);
  /* One element per load: React never re-renders over the person's typing. */
  const content = useMemo(() => (frozen ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{frozen.text}</ReactMarkdown> : null), [frozen]);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  /* (Re)load the editor when a newer revision arrives than the one it shows (assistant revision, restore);
     an older one (the cache catching up with our own commit) never overwrites the person's text. */
  useEffect(() => {
    if (text.data === undefined || text.isPlaceholderData || !a.revision) return;
    if (shown.current && Number(resourceId(a.revision)) <= Number(resourceId(shown.current))) return;
    shown.current = a.revision;
    setFrozen((f) => ({ key: (f?.key ?? 0) + 1, text: text.data }));
    lastSaved.current = text.data.trim();
    setWords(wordCount(text.data));
  }, [text.data, text.isPlaceholderData, a.revision]);

  const save = useCallback(async () => {
    clearTimeout(timer.current ?? undefined);
    timer.current = null;
    const el = editor.current;
    if (!el || !canEdit) return;
    const md = htmlToMarkdown(el);
    setWords(wordCount(md));
    if (md.trim() === lastSaved.current) {
      setSaveState("saved");
      return;
    }
    setSaveState("saving");
    try {
      const next = await actionsRef.current.commit(md, "Your edits");
      shown.current = next.revision;
      lastSaved.current = md.trim();
      setSaveState("saved");
    } catch (e) {
      setSaveState("error");
      toast(errorMessage(e), { tone: "danger" });
    }
  }, [canEdit]);

  useEffect(() => {
    flush.current = save;
  }, [flush, save]);
  /* Leaving the page saves pending typing. */
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => void (timer.current && saveRef.current()), []);

  const onInput = () => {
    setSaveState("saving");
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => void save(), 900);
  };

  const command = (cmd: "heading" | "bold" | "bullets" | "undo") => {
    const body = editor.current;
    if (!body) return;
    if (!body.contains(document.getSelection()?.anchorNode ?? null)) {
      body.focus();
      const r = document.createRange();
      r.selectNodeContents(body);
      r.collapse(false);
      const s = document.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
    if (cmd === "heading") {
      const cur = String(document.queryCommandValue("formatBlock") || "").toLowerCase();
      document.execCommand("formatBlock", false, /^h[23]$/.test(cur) ? "p" : "h3");
    } else if (cmd === "bold") document.execCommand("bold");
    else if (cmd === "bullets") document.execCommand("insertUnorderedList");
    else document.execCommand("undo");
    onInput();
  };

  const revise = async (q: string) => {
    const instructions = q.trim();
    if (!instructions || asking || busy) return;
    setHint("");
    setAsking(true);
    await save();
    const ok = await actions.revise({ instructions }, { failure: "Couldn’t revise the draft" });
    setAsking(false);
    if (ok) {
      setAsk("");
      toast(`Revised: ${instructions.toLowerCase()}`);
    } else setHint("The assistant couldn’t make that change. Your draft is unchanged — try again in a moment.");
  };

  if (text.isPending && a.revision) return <SkeletonRows rows={8} />;
  if (text.isError) {
    const hidden = (a.hiddenSourceCount ?? 0) > 0;
    return hidden ? (
      <Callout tone="warning" icon={TriangleAlert} title="This draft is hidden from you" description="It uses sources you can no longer open. Ask the owner to share them again." />
    ) : (
      <ErrorState error={text.error} onRetry={() => void text.refetch()} />
    );
  }

  return (
    <div className="dr">
      <div className="dr-main">
        {a.audience === "SPACE" && space ? (
          <Callout tone="accent" icon={Send} title="Ready for review" description={`Shared with ${space.displayName} ${rel(a.updateTime)}.`} />
        ) : null}
        <div className="dr-paper">
          {canEdit ? (
            <div className="dr-toolbar" role="toolbar" aria-label="Formatting" onMouseDown={(e) => e.target instanceof Element && e.target.closest(".dr-tool") && e.preventDefault()}>
              <Button variant="ghost" size="sm" className="dr-tool" onPress={() => command("heading")} isDisabled={busy}>
                Heading
              </Button>
              <Tip content="Bold">
                <Button variant="ghost" size="sm" className="dr-tool" aria-label="Bold" onPress={() => command("bold")} isDisabled={busy}>
                  <span className="strong">B</span>
                </Button>
              </Tip>
              <Tip content="Bulleted list">
                <Button variant="ghost" size="sm" isIconOnly className="dr-tool" aria-label="Bulleted list" onPress={() => command("bullets")} isDisabled={busy}>
                  <ListIcon className="i" aria-hidden />
                </Button>
              </Tip>
              <Tip content="Undo">
                <Button variant="ghost" size="sm" isIconOnly className="dr-tool" aria-label="Undo" onPress={() => command("undo")} isDisabled={busy}>
                  <Undo2 className="i" aria-hidden />
                </Button>
              </Tip>
              <span className="grow" />
              <span className="dr-saved" aria-live="polite">
                {saveState === "saving" ? (
                  <>
                    <Spinner size="sm" />
                    Saving…
                  </>
                ) : saveState === "error" ? (
                  <>
                    <TriangleAlert className="i i-sm" aria-hidden />
                    Not saved
                  </>
                ) : (
                  <>
                    <Check className="i i-sm" aria-hidden />
                    Saved
                  </>
                )}
              </span>
            </div>
          ) : null}
          {frozen ? (
            <div
              key={frozen.key}
              ref={editor}
              className="dr-body"
              translate="no"
              contentEditable={canEdit && !busy}
              suppressContentEditableWarning
              role={canEdit ? "textbox" : undefined}
              aria-multiline={canEdit || undefined}
              aria-label={canEdit ? "Draft text" : undefined}
              aria-busy={busy || undefined}
              spellCheck
              onInput={onInput}
              onBlur={() => timer.current && void save()}
            >
              {content}
            </div>
          ) : (
            <div className="dr-body">
              <EmptyState icon={Pencil} title="This draft is empty" compact />
            </div>
          )}
          <div className="dr-foot t-xs muted">
            {plural(words, "word")} · {type ? draftTypeLabel(type) : "Draft"}
          </div>
        </div>
        {canEdit ? (
          <div className="dr-ask">
            {hint ? <div className="t-xs muted mb-8">{hint}</div> : null}
            <div className="dr-ask__chips">
              {draftQuickAsks(type).map((q) => (
                <button key={q} type="button" className="rv-chip" disabled={asking || busy} onClick={() => void revise(q)}>
                  {q}
                </button>
              ))}
            </div>
            <div className="dr-ask__field">
              <Sparkles className="i dr-ask__icon" aria-hidden />
              <TextField aria-label="Ask for changes" value={ask} onChange={setAsk} isDisabled={asking || busy} className="dr-ask__input">
                <Input
                  placeholder="Ask for changes, e.g. add a timeline"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void revise(ask);
                  }}
                />
              </TextField>
              <Tip content="Revise draft">
                <Button variant="primary" size="sm" isIconOnly aria-label="Revise draft" onPress={() => void revise(ask)} isPending={asking || busy} isDisabled={!ask.trim()}>
                  <ArrowUp className="i" aria-hidden />
                </Button>
              </Tip>
            </div>
          </div>
        ) : null}
      </div>
      <aside className={`dr-rail${rail ? " is-open" : ""}`} aria-label="Sources and versions">
        <DraftRail
          artifact={a}
          canEdit={canEdit}
          tab={tab}
          setTab={setTab}
          rail={rail}
          setRail={setRail}
          beforeRestore={save}
          onRestored={(next) => {
            setSaveState("saved");
            actions.refresh(next);
          }}
        />
      </aside>
    </div>
  );
}

function DraftRail({
  artifact: a,
  canEdit,
  tab,
  setTab,
  rail,
  setRail,
  beforeRestore,
  onRestored,
}: Pick<WorkViewProps, "artifact" | "canEdit"> & {
  tab: "sources" | "versions";
  setTab: (t: "sources" | "versions") => void;
  rail: boolean;
  setRail: (v: boolean) => void;
  /** Saves pending typing first, so it can't land on top of the restored text. */
  beforeRestore: () => Promise<void>;
  onRestored: (next: Artifact) => void;
}) {
  const { id: ws } = useWorkspace();
  const docs = useDocs(a.sourceItems ?? []);
  const { versions, isPending } = useVersions(a.name, a.revision);
  const [restoring, setRestoring] = useState(0);
  const sources = a.sourceItems ?? [];
  const current = versions.find((v) => v.name === a.revision)?.n ?? versions.at(-1)?.n;
  const restore = async (n: number) => {
    setRestoring(n);
    try {
      await beforeRestore();
      onRestored(await rollbackRevision(ws, resourceId(a.name), n));
      toast("Version restored");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setRestoring(0);
    }
  };
  return (
    <>
      <button type="button" className="dr-rail__toggle" aria-expanded={rail} onClick={() => setRail(!rail)}>
        <Quote className="i i-sm" aria-hidden />
        <span className="grow">Sources and versions</span>
        <span className="t-xs muted">
          {sources.length} · {versions.length}
        </span>
        <ChevronDown className="i dr-rail__chev" aria-hidden />
      </button>
      <div className="dr-rail__body">
        <Segmented
          label="Rail"
          full
          value={tab}
          onChange={setTab}
          options={[
            { value: "sources", label: `Sources ${sources.length}` },
            { value: "versions", label: isPending ? "Versions" : `Versions ${versions.length}` },
          ]}
        />
        <div className="dr-rail__list">
          {tab === "sources" ? (
            sources.length ? (
              sources.map((s, i) => {
                const d = docs.byName.get(s);
                return (
                  <div key={s} className="dr-src">
                    <div className="row gap-8">
                      <span className="cite" aria-hidden="true">
                        {i + 1}
                      </span>
                      {d ? (
                        <Link className="dr-src__name truncate" href={`/doc/${resourceId(s)}`} translate="no">
                          {d.displayName}
                        </Link>
                      ) : (
                        <span className="dr-src__name truncate muted">{docs.isPending ? "…" : "Document not available"}</span>
                      )}
                    </div>
                    {d?.ancestors?.[0]?.displayName ? <div className="t-xs muted mt-4">{d.ancestors[0].displayName}</div> : null}
                  </div>
                );
              })
            ) : (
              <EmptyState icon={Quote} title="No sources cited" description="Ask for changes that draw on your sources." compact />
            )
          ) : isPending ? (
            <SkeletonRows rows={3} />
          ) : versions.length ? (
            [...versions].reverse().map((v) => (
              <div key={v.n} className="dr-ver">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="medium truncate">{v.n === 1 && v.author === "assistant" ? "First draft" : v.summary}</div>
                  <div className="t-xs muted">
                    {rel(v.createTime)}
                    {v.text !== undefined ? ` · ${plural(wordCount(v.text), "word")}` : ""}
                  </div>
                </div>
                {v.n === current ? (
                  <Chip size="sm" variant="tertiary">
                    Current
                  </Chip>
                ) : canEdit ? (
                  <Button size="sm" variant="ghost" onPress={() => void restore(v.n)} isPending={restoring === v.n} isDisabled={!!restoring || a.state === "GENERATING"}>
                    Restore
                  </Button>
                ) : null}
              </div>
            ))
          ) : (
            <EmptyState icon={Undo2} title="No versions yet" description="Each revision you ask for is saved here." compact />
          )}
        </div>
      </div>
    </>
  );
}
