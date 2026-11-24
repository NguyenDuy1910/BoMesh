"use client";

import { Button, Chip, Input, Spinner, TextField } from "@heroui/react";
import { ArrowUp, Check, Clock, List as ListIcon, Pencil, Quote, Send, Sparkles, TriangleAlert, Undo2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Callout, EmptyState, ErrorState, IconButton, Segmented, SkeletonRows, Tip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel, relInline } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useMemberNames } from "@/modules/knowledge/queries";
import { rollbackRevision } from "@/modules/artifacts/api";
import { htmlToMarkdown } from "@/modules/artifacts/html-markdown";
import { useVersions } from "@/modules/artifacts/queries";

import { draftQuickAsks, draftTypeLabel, recipeDraftType, sourceLine, wordCount, type Artifact } from "../model";
import { useArtifactText, useDocs } from "../queries";
import type { WorkViewProps } from "./WorkItemPage";

type SaveState = "saved" | "saving" | "error";

/**
 * Review loop (preview `drActions`) on the API: a draft shared with its space is in review with the space's
 * staff; Back to draft makes it private and editable again.
 */
export function DraftActions({ artifact: a, canEdit, space, actions, flush }: WorkViewProps) {
  if (!canEdit || !space) return null;
  if (a.audience === "SPACE")
    return (
      <Button variant="secondary" onPress={() => void actions.setAudience("PRIVATE", "Đã trở về bản nháp. Bạn có thể sửa tiếp")}>
        <Pencil className="i" aria-hidden />
        Quay lại bản nháp
      </Button>
    );
  return (
    <Button
      variant="primary"
      onPress={async () => {
        await flush.current();
        await actions.setAudience("SPACE", `Đã gửi ${space.displayName} duyệt`);
      }}
    >
      <Send className="i" aria-hidden />
      Gửi duyệt
    </Button>
  );
}

/** Where the draft stands in review (preview `reviewNote`). */
function ReviewNote({ artifact: a, canEdit, space }: Pick<WorkViewProps, "artifact" | "canEdit" | "space">) {
  const owners = useMemberNames([a.owner]);
  if (a.audience !== "SPACE" || !space) return null;
  if (canEdit)
    return (
      <Callout
        tone="accent"
        icon={Clock}
        title={`${space.displayName} đang duyệt`}
        description={`Đã gửi ${relInline(a.updateTime)}. Tạm ngừng chỉnh sửa cho đến khi bạn đưa về bản nháp.`}
      />
    );
  return <Callout tone="accent" icon={Send} title={`${owners.get(a.owner ?? "") || "Ai đó"} nhờ bạn duyệt bản này`} description="Nội dung được giữ nguyên như người viết." />;
}

/** Grounded document draft: editor with autosave, Ask for changes, sources and versions (preview `drRender`). */
export function DraftView({ artifact: a, canEdit: isOwner, space, actions, flush, panel, setPanel }: WorkViewProps) {
  const text = useArtifactText(a);
  const type = useMemo(() => recipeDraftType(a.name), [a.name]);
  const busy = a.state === "GENERATING";
  /* The body is read-only while the draft is in review (shared with its space). */
  const canEdit = isOwner && !(a.audience === "SPACE" && space);
  /* Content first: the sources and versions rail opens on demand (header source link, ⋯ Version history). */
  const rail = panel?.kind === "rail" ? panel.tab : null;
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
      const next = await actionsRef.current.commit(md, "Chỉnh sửa của bạn");
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
    const ok = await actions.revise({ instructions }, { failure: "Không chỉnh sửa được bản nháp" });
    setAsking(false);
    if (ok) {
      setAsk("");
      toast(`Đã chỉnh sửa: ${instructions.toLowerCase()}`);
    } else setHint("Trợ lý không thực hiện được thay đổi đó. Bản nháp của bạn vẫn giữ nguyên — hãy thử lại sau giây lát.");
  };

  if (text.isPending && a.revision) return <SkeletonRows rows={8} />;
  if (text.isError) {
    const hidden = (a.hiddenSourceCount ?? 0) > 0;
    return hidden ? (
      <Callout tone="warning" icon={TriangleAlert} title="Bản nháp này bị ẩn với bạn" description="Nội dung dùng nguồn bạn không còn mở được. Hãy nhờ chủ sở hữu chia sẻ lại." />
    ) : (
      <ErrorState error={text.error} onRetry={() => void text.refetch()} />
    );
  }

  return (
    <div className={`dr${rail ? " has-rail" : ""}`}>
      <div className="dr-main">
        <ReviewNote artifact={a} canEdit={isOwner} space={space} />
        <div className="dr-paper">
          {canEdit ? (
            <div className="dr-toolbar" role="toolbar" aria-label="Định dạng" onMouseDown={(e) => e.target instanceof Element && e.target.closest(".dr-tool") && e.preventDefault()}>
              <Button variant="ghost" size="sm" className="dr-tool" onPress={() => command("heading")} isDisabled={busy}>
                Tiêu đề
              </Button>
              <Tip content="In đậm">
                <Button variant="ghost" size="sm" className="dr-tool" aria-label="In đậm" onPress={() => command("bold")} isDisabled={busy}>
                  <span className="strong">B</span>
                </Button>
              </Tip>
              <Tip content="Danh sách dấu đầu dòng">
                <Button variant="ghost" size="sm" isIconOnly className="dr-tool" aria-label="Danh sách dấu đầu dòng" onPress={() => command("bullets")} isDisabled={busy}>
                  <ListIcon className="i" aria-hidden />
                </Button>
              </Tip>
              <Tip content="Hoàn tác">
                <Button variant="ghost" size="sm" isIconOnly className="dr-tool" aria-label="Hoàn tác" onPress={() => command("undo")} isDisabled={busy}>
                  <Undo2 className="i" aria-hidden />
                </Button>
              </Tip>
              <span className="grow" />
              <span className="dr-saved" aria-live="polite">
                {saveState === "saving" ? (
                  <>
                    <Spinner size="sm" />
                    Đang lưu…
                  </>
                ) : saveState === "error" ? (
                  <>
                    <TriangleAlert className="i i-sm" aria-hidden />
                    Chưa lưu
                  </>
                ) : (
                  <>
                    <Check className="i i-sm" aria-hidden />
                    Đã lưu
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
              aria-label={canEdit ? "Nội dung bản nháp" : undefined}
              aria-busy={busy || undefined}
              spellCheck
              onInput={onInput}
              onBlur={() => timer.current && void save()}
            >
              {content}
            </div>
          ) : (
            <div className="dr-body">
              <EmptyState icon={Pencil} title="Bản nháp này đang trống" compact />
            </div>
          )}
          <div className="dr-foot t-xs muted">{type ? `${plural(words, "word")} · ${draftTypeLabel(type)}` : plural(words, "word")}</div>
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
              <TextField aria-label="Yêu cầu chỉnh sửa" value={ask} onChange={setAsk} isDisabled={asking || busy} className="dr-ask__input">
                <Input
                  placeholder="Yêu cầu chỉnh sửa, ví dụ: thêm lộ trình"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void revise(ask);
                  }}
                />
              </TextField>
              <Tip content="Chỉnh sửa bản nháp">
                <Button variant="primary" size="sm" isIconOnly aria-label="Chỉnh sửa bản nháp" onPress={() => void revise(ask)} isPending={asking || busy} isDisabled={!ask.trim()}>
                  <ArrowUp className="i" aria-hidden />
                </Button>
              </Tip>
            </div>
          </div>
        ) : null}
      </div>
      {rail ? (
        <DraftRail
          artifact={a}
          canEdit={canEdit}
          tab={rail}
          setTab={(tab) => setPanel({ kind: "rail", tab })}
          onClose={() => setPanel(null)}
          beforeRestore={save}
          onRestored={(next) => {
            setSaveState("saved");
            actions.refresh(next);
          }}
        />
      ) : null}
    </div>
  );
}

/** Sources and versions rail (preview `dr-rail`): opened on demand, closed with its X. */
function DraftRail({
  artifact: a,
  canEdit,
  tab,
  setTab,
  onClose,
  beforeRestore,
  onRestored,
}: Pick<WorkViewProps, "artifact" | "canEdit"> & {
  tab: "sources" | "versions";
  setTab: (t: "sources" | "versions") => void;
  onClose: () => void;
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
      toast("Đã khôi phục phiên bản");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setRestoring(0);
    }
  };
  return (
    <aside className="dr-rail" aria-label="Nguồn và phiên bản">
      <div className="dr-rail__head">
        <Segmented
          label="Nguồn và phiên bản"
          full
          value={tab}
          onChange={setTab}
          options={[
            { value: "sources", label: "Nguồn" },
            { value: "versions", label: "Phiên bản" },
          ]}
        />
        <IconButton icon={X} tip="Đóng bảng" size="sm" onPress={onClose} />
      </div>
      <div className="t-xs muted dr-rail__meta">{tab === "versions" ? (isPending ? "…" : plural(versions.length, "version")) : sourceLine(a)}</div>
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
                        <span className="dr-src__name truncate muted">{docs.isPending ? "…" : "Tài liệu không khả dụng"}</span>
                      )}
                    </div>
                    {d?.ancestors?.[0]?.displayName ? <div className="t-xs muted mt-4">{d.ancestors[0].displayName}</div> : null}
                  </div>
                );
              })
            ) : (
              <EmptyState icon={Quote} title="Không có nguồn được trích dẫn" description="Yêu cầu chỉnh sửa dựa trên các nguồn bạn chọn." compact />
            )
          ) : isPending ? (
            <SkeletonRows rows={3} />
          ) : versions.length ? (
            [...versions].reverse().map((v) => (
              <div key={v.n} className="dr-ver">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="medium truncate">{v.n === 1 && v.author === "assistant" ? "Bản nháp đầu tiên" : v.summary}</div>
                  <div className="t-xs muted">
                    {rel(v.createTime)}
                    {v.text !== undefined ? ` · ${plural(wordCount(v.text), "word")}` : ""}
                  </div>
                </div>
                {v.n === current ? (
                  <Chip size="sm" variant="tertiary">
                    Hiện tại
                  </Chip>
                ) : canEdit ? (
                  <Button size="sm" variant="ghost" onPress={() => void restore(v.n)} isPending={restoring === v.n} isDisabled={!!restoring || a.state === "GENERATING"}>
                    Khôi phục
                  </Button>
                ) : null}
              </div>
            ))
          ) : (
            <EmptyState icon={Undo2} title="Chưa có phiên bản" description="Mỗi lần chỉnh sửa bạn yêu cầu được lưu tại đây." compact />
          )}
      </div>
    </aside>
  );
}
