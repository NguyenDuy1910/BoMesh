"use client";

import { Button, Description, FieldError, Input, Label, ListBox, Select, Spinner, TextArea, TextField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, CheckCheck, CircleAlert, CircleCheck, Folder, Info, Lock, Send, Share, StickyNote, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { Callout } from "@/components/ui/Callout";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { Disclosure } from "@/components/ui/Disclosure";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { LinkButton } from "@/components/ui/LinkButton";
import { List, ListItem } from "@/components/ui/List";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { toast } from "@/components/ui/Toast";
import { api, call, errorMessage, requestId, resourceId } from "@/lib/api/client";
import { fmtSize, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createContribution, searchItems, uploadDocument, type Contribution, type Item } from "../api";
import { contributionHref } from "../library/contributions";
import { CONTRIBUTE_TYPES, fileProblem, tokens, topicTree } from "../model";
import { openDocumentPreview } from "../preview/store";
import { invalidateKnowledge, useContributionTargets, useItem, useKnowledgeModel } from "../queries";
import type { ContributeOptions } from "./contribute-store";
import { KnowledgeModal } from "./KnowledgeModal";
import { useWhoCanSeeCollection } from "./ResourceDetails";
import { TopicPicker } from "./TopicPicker";
import { entriesOf, expandPicked, isZipName, MAX_BATCH_FILES, pickedFromEntries, pickedFromInput, type LeftOut, type Picked } from "../upload-sources";

/* ═══════════════ Files ═══════════════ */

interface Entry {
  id: number;
  file: File;
  /** The folder it came from inside a picked folder or ZIP ("Biểu mẫu.zip/Học vụ"); "" for a loose file. */
  where: string;
  err: string;
  /** 0–1 while uploading. */
  progress: number;
  state: "ready" | "uploading" | "done" | "failed";
}

/** Files uploaded at the same time; a folder can hold up to `MAX_BATCH_FILES`. */
const UPLOAD_PARALLEL = 4;

/** What the contributor confirms for one file (preview `ctb.meta`). `kb` "" = let the assistant suggest. */
interface Meta {
  title: string;
  topics: string[];
  kb: string;
  summary: string;
}

const ACCEPT = CONTRIBUTE_TYPES.map((x) => `.${x}`).join(",");
/** A ZIP opens into its documents; a new version takes the file itself. */
const ACCEPT_WITH_ZIP = `${ACCEPT},.zip`;
let entrySeq = 0;

const stemOf = (name: string) => name.replace(/\.[^.]+$/, "");

/** File names that suggest personal data (preview `PERSONAL_RE`); the assistant checks the content after submission. */
const PERSONAL_RE = /\bcv\b|résumé|resume|transcript|salary|payslip|passport|national id|\bid card\b|medical|customer export|card numbers?|\bpan\b|cccd/i;

/** Title words that identify a document (versions, "draft", years dropped; preview `titleWords`). */
function titleWords(name: string): Set<string> {
  return new Set(tokens(stemOf(name)).filter((w) => !/^(v\d+|draft|update|updated|copy|final|new|\d{4})$/.test(w)));
}

/** Shared words over all words (preview `titleSim`). */
function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

/* ═══════════════ Check the details: one file ═══════════════ */

/** A published document whose title closely matches the file's (SearchItems over what the caller can see). */
function usePossibleDuplicate(fileName: string) {
  const { id: ws, member } = useWorkspace();
  const stem = stemOf(fileName).replace(/_+/g, " ");
  const query = useQuery({
    queryKey: [ws, "contribute", "duplicate", stem],
    queryFn: () => searchItems(ws, { query: stem, filter: "itemKind = DOCUMENT AND document.publicationState = PUBLISHED", pageSize: 5 }),
    enabled: !!stem.trim(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const best = (query.data?.results ?? [])
    .map((r) => r.item)
    .filter((i): i is Item => !!i && i.state !== "DELETED" && i.parentItem !== member.personalCollection)
    .map((item) => ({ item, sim: titleSimilarity(fileName, item.displayName ?? "") }))
    .sort((a, b) => b.sim - a.sim)[0];
  return best && best.sim >= 0.55 ? best : null;
}

interface CheckFileProps {
  entry: Entry;
  meta: Meta;
  many: boolean;
  touched: boolean;
  busy: boolean;
  onChange: (patch: Partial<Meta>) => void;
}

/** One file's details as an editable form (preview `checkFile`). */
function CheckFile({ entry: x, meta: m, many, touched, busy, onChange }: CheckFileProps) {
  const { topics } = useKnowledgeModel();
  const targets = useContributionTargets();
  const target = targets.data.find((t) => t.name === m.kb);
  const who = useWhoCanSeeCollection(target ? { id: resourceId(target.name), displayName: target.displayName } : null);
  const duplicate = usePossibleDuplicate(x.file.name);
  const titleError = touched && !m.title.trim() ? "Hãy đặt tiêu đề." : "";
  const WhoIcon = who.icon;

  return (
    <section className="ctb-check" aria-label={`Thông tin cho ${x.file.name}`}>
      {many ? (
        <div className="ctb-check__file">
          <FileIcon name={x.file.name} size="sm" />
          <span className="medium truncate" translate="no">
            {x.file.name}
          </span>
          <span className="t-xs muted none">{fmtSize(x.file.size)}</span>
        </div>
      ) : null}
      {PERSONAL_RE.test(x.file.name) || duplicate ? (
        <div className="stack gap-8">
          {PERSONAL_RE.test(x.file.name) ? (
            <Callout
              tone="warning"
              title="Có thể chứa dữ liệu cá nhân"
              description="Hãy xóa thông tin cá nhân trước khi gửi, hoặc ghi chú lý do cần giữ lại."
            />
          ) : null}
          {duplicate ? (
            <Callout
              title="Có thể trùng lặp"
              description={`Giống “${stemOf(duplicate.item.displayName ?? "")}” (tiêu đề tương tự ${Math.round(duplicate.sim * 100)}%). Nếu tài liệu này thay thế tài liệu đó, hãy gửi phiên bản mới của tài liệu đó.`}
              actions={
                <Button size="sm" variant="tertiary" onPress={() => openDocumentPreview({ item: duplicate.item.name ?? "" })}>
                  Xem trước
                </Button>
              }
            />
          ) : null}
        </div>
      ) : null}
      <TextField value={m.title} onChange={(title) => onChange({ title })} isRequired isInvalid={!!titleError} isDisabled={busy} maxLength={120}>
        <Label>Tiêu đề</Label>
        <Input />
        <FieldError>{titleError}</FieldError>
      </TextField>
      <div className="field">
        <span className="label">Chủ đề</span>
        <TopicPicker
          value={m.topics}
          onChange={(next) => onChange({ topics: next })}
          topics={topics}
          label="Chủ đề"
          empty={topicTree(topics).length ? "Chưa rõ chủ đề. Hãy thêm nếu bạn biết." : "Không gian làm việc này chưa có chủ đề nào."}
          isDisabled={busy}
        />
      </div>
      <Select value={m.kb || "suggest"} onChange={(v) => onChange({ kb: v === "suggest" ? "" : String(v) })} isDisabled={busy}>
        <Label>Kho tài liệu</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Description>
          {target ? (
            <span className="row gap-4">
              <WhoIcon className="i i-xs" aria-hidden />
              <span>{`${who.label} sẽ thấy tài liệu khi được công bố.`}</span>
            </span>
          ) : (
            "Trợ lý chọn mục phù hợp nhất. Người duyệt sẽ xác nhận."
          )}
        </Description>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id="suggest" textValue="Để trợ lý đề xuất">
              Để trợ lý đề xuất
              <ListBox.ItemIndicator />
            </ListBox.Item>
            {targets.data.map((t) => (
              <ListBox.Item key={t.name} id={t.name ?? ""} textValue={t.displayName ?? ""}>
                {t.displayName}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <TextField value={m.summary} onChange={(summary) => onChange({ summary })} maxLength={280} isDisabled={busy}>
        <Label>
          Tóm tắt <span className="label__opt">(không bắt buộc)</span>
        </Label>
        <TextArea rows={2} />
        <Description>Hiển thị trong kết quả tìm kiếm và cho người duyệt.</Description>
      </TextField>
    </section>
  );
}

/* ═══════════════ Dialog ═══════════════ */

export interface ContributeDialogProps extends ContributeOptions {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Contribute (preview `M['contribute']`, DOCUMENT_LIFECYCLE.md). Destination first — Contribute to a collection
 * (a reviewer checks it before it's published) or Upload to My files — then drop or browse files. Contributing
 * takes two steps: Continue opens Check the details (title, type, topics, collection and who will see it,
 * summary, possible-duplicate and personal-data warnings, a note for reviewers; Back keeps edits), and Submit
 * uploads each file into the member's PERSONAL collection with what they confirmed, then opens a contribution
 * for review. Upload to My files and Submit a new version (one file, required "What changed?") are one step.
 */
export function ContributeDialog({ isOpen, onClose, mode, collection, folder, item }: ContributeDialogProps) {
  const { id: ws, can, member } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const targets = useContributionTargets();
  const base = useItem(item);
  const baseDoc: Item | undefined = item ? base.data : undefined;
  const personal = member.personalCollection;
  const canShare = can("contributions.create") && (targets.data.length > 0 || !!item);
  const presetPrivate = mode === "private" || (!!collection && !!personal && resourceId(collection) === resourceId(personal));
  const [dest, setDest] = useState<"share" | "private">(item ? "share" : canShare && !presetPrivate ? "share" : "private");
  // A collection passed in (a collection page) is pre-selected when it takes contributions.
  const preset = collection && !presetPrivate ? `workspaces/${ws}/items/${resourceId(collection)}` : "";
  const [step, setStep] = useState<"pick" | "details">("pick");
  const [meta, setMeta] = useState<Record<number, Meta>>({});
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** What folders and ZIPs held that can't be sent, one line per source; `capped`: a pick went over `MAX_BATCH_FILES`. */
  const [leftOut, setLeftOut] = useState<LeftOut[]>([]);
  const [capped, setCapped] = useState(false);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // Folders and ZIPs are read asynchronously: they join the list as it is when they're done.
  const filesRef = useRef(files);
  filesRef.current = files;
  const priv = !item && (dest === "private" || !canShare);
  const twoStep = !item && !priv;

  const valid = files.filter((f) => !f.err);
  const skipped = files.length - valid.length;
  const full = !!item && valid.length > 0;
  const noteError = item && touched && !note.trim() ? "Mô tả nội dung thay đổi." : "";
  const fileError = touched && !busy && !valid.length ? (files.length ? "Không tệp nào thêm được. Hãy thêm tệp được hỗ trợ." : "Thêm ít nhất một tệp.") : "";

  const toEntry = (file: File, where = "", err = fileProblem(file)): Entry => ({ id: ++entrySeq, file, where, err, progress: 0, state: "ready" });

  /**
   * Add picked or dropped files (preview `addInputs`). Loose files are listed as they are; a folder or a ZIP adds the
   * documents inside it, flat, each with where it came from (upload-sources.ts). A new version takes one file, never
   * a folder or a ZIP.
   */
  async function addPicked(picked: Picked[]) {
    if (item) {
      const loose = picked.filter((p) => !p.path.includes("/"));
      let next = [...filesRef.current, ...loose.map(({ file }) => toEntry(file, "", isZipName(file.name) ? "Hãy chọn chính tệp tài liệu, không phải tệp ZIP" : fileProblem(file)))];
      // A new version takes one file: keep the latest valid one.
      const ok = next.filter((x) => !x.err);
      if (ok.length > 1) next = next.filter((x) => x.err || x === ok.at(-1));
      if (next.some((x) => !x.err)) setTouched(false);
      setFiles(next);
      return;
    }
    setReading(true);
    try {
      const { added, leftOut: left, unreadable } = await expandPicked(picked, (f) => !fileProblem(f));
      let next = [...filesRef.current, ...added.map((a) => toEntry(a.file, a.where)), ...unreadable.map((f) => toEntry(f, "", "Không mở được tệp ZIP này"))];
      const ok = next.filter((x) => !x.err);
      if (ok.length > MAX_BATCH_FILES) {
        const extra = new Set(ok.slice(MAX_BATCH_FILES));
        next = next.filter((x) => !extra.has(x));
        setCapped(true);
      }
      if (left.length) setLeftOut((list) => [...list, ...left]);
      if (next.some((x) => !x.err)) setTouched(false);
      setFiles(next);
    } finally {
      setReading(false);
    }
  }

  const patch = (id: number, p: Partial<Entry>) => setFiles((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x)));

  /** Continue: Check the details. Edits survive Back; only new files get first values. */
  function toDetails() {
    const next: Record<number, Meta> = {};
    for (const x of valid) {
      const title = stemOf(x.file.name).replace(/_+/g, " ").replace(/\s+/g, " ").trim();
      next[x.id] = meta[x.id] ?? {
        title,
        topics: [],
        kb: targets.data.some((t) => t.name === preset) ? preset : "",
        summary: "",
      };
    }
    setMeta(next);
    setTouched(false);
    setStep("details");
  }

  function go() {
    if (busy) return;
    if (!valid.length || (item && !note.trim())) {
      setTouched(true);
      return;
    }
    if (twoStep) return toDetails();
    void upload();
  }

  /** Upload every valid file into My files (with what was confirmed) and, when sharing, open a contribution for each. */
  async function upload() {
    if (!personal) return;
    const missing = twoStep && valid.find((x) => !meta[x.id]?.title.trim());
    if (missing) {
      setTouched(true);
      return;
    }
    setBusy(true);
    const uploaded: { entry: Entry; doc: Item; contribution?: Contribution }[] = [];
    let failed = 0;
    const send = async (entry: Entry) => {
      patch(entry.id, { state: "uploading", progress: 0 });
      const m = twoStep ? meta[entry.id] : null;
      try {
        const doc = await uploadDocument(
          ws,
          {
            parentItem: personal,
            file: entry.file,
            displayName: m?.title.trim(),
            document: m ? { topics: m.topics, summary: m.summary.trim() || undefined } : undefined,
          },
          (p) => patch(entry.id, { progress: p }),
        );
        let contribution: Contribution | undefined;
        if (!priv) {
          contribution = await createContribution(ws, {
            kind: item ? "NEW_REVISION" : "NEW_DOCUMENT",
            item: doc.name,
            targetCollection: item ? undefined : (m?.kb && m.kb === preset && folder ? `workspaces/${ws}/items/${resourceId(folder)}` : m?.kb) || undefined,
            replacesItem: item ? `workspaces/${ws}/items/${resourceId(item)}` : undefined,
            note: note.trim() || undefined,
            changeSummary: item ? note.trim() : undefined,
          });
        }
        patch(entry.id, { state: "done", progress: 1 });
        uploaded.push({ entry, doc, contribution });
      } catch (error) {
        patch(entry.id, { state: "failed", err: errorMessage(error) });
        failed++;
      }
    };
    // A folder can bring a hundred files: a few uploads at a time, not all at once.
    const queue = [...valid];
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_PARALLEL, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await send(next);
      }),
    );
    setBusy(false);
    invalidateKnowledge(qc, ws);
    if (priv && uploaded.length) {
      // My files never need review: prepare them for search and answers right away.
      void call(
        api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
          params: { path: { workspace: ws }, query: { requestId: requestId() } },
          body: { selector: { items: uploaded.map((u) => u.doc.name ?? "") }, trigger: "MANUAL" },
        }),
      ).catch(() => undefined);
    }
    if (failed) {
      // Keep only what still needs sending; the errors show on the files.
      setFiles((list) => list.filter((x) => x.state !== "done"));
      setStep("pick");
      if (uploaded.length) toast(`Đã gửi ${plural(uploaded.length, "file")}; ${plural(failed, "file")} không tải lên được`, { tone: "warning" });
      return;
    }
    onClose();
    if (priv) {
      toast("Đã thêm vào Tệp của tôi", { action: { label: "Mở", onPress: () => router.push("/knowledge/library?tab=files") } });
      return;
    }
    const message = item ? "Đã gửi duyệt phiên bản mới" : uploaded.length === 1 ? "Đã gửi duyệt" : `Đã gửi duyệt ${plural(uploaded.length, "document")}`;
    const open = uploaded.length === 1 ? uploaded[0].contribution?.name : "";
    toast(message, {
      action: can("contributions.review")
        ? { label: "Duyệt ngay", onPress: () => router.push("/studio?tab=documents&view=review") }
        : { label: "Mở", onPress: () => router.push(contributionHref(open)) },
    });
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // Entries are only readable while the drop event runs: take them now, walk the folders after.
    const entries = item ? [] : entriesOf(e.dataTransfer);
    if (entries.some((x) => x.isDirectory)) {
      setReading(true);
      void pickedFromEntries(entries).then(addPicked);
    } else if (e.dataTransfer.files.length) void addPicked(pickedFromInput(e.dataTransfer.files));
  };

  const n = valid.length;
  const footer = (primary: ReactNode) => (
    <>
      <Button variant="ghost" onPress={onClose} isDisabled={busy}>
        Hủy
      </Button>
      {primary}
    </>
  );

  if (step === "details") {
    const checked = valid.filter((x) => meta[x.id]);
    const lone = checked.length === 1 ? checked[0] : null;
    const shortNote = note.trim();
    return (
      <KnowledgeModal
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        guard={busy}
        title="Kiểm tra thông tin"
        icon={CheckCheck}
        description="Hãy sửa những gì chưa đúng. Người duyệt sẽ thấy những gì bạn xác nhận ở đây."
        footerStart={
          busy ? null : (
            <Button variant="ghost" onPress={() => setStep("pick")}>
              <ArrowLeft className="i" aria-hidden />
              Quay lại
            </Button>
          )
        }
        footer={footer(
          <Button variant="primary" onPress={() => void upload()} isPending={busy}>
            <Send className="i" aria-hidden />
            {checked.length > 1 ? `Gửi duyệt ${checked.length}` : "Gửi duyệt"}
          </Button>,
        )}
      >
        {lone ? (
          <div className="ctb-current">
            <FileIcon name={lone.file.name} />
            <div className="grow">
              <div className="medium truncate" translate="no">
                {lone.file.name}
              </div>
              <div className="t-xs muted">{fmtSize(lone.file.size)}</div>
            </div>
          </div>
        ) : null}
        <div className="ctb-checks">
          {checked.map((x) => (
            <CheckFile
              key={x.id}
              entry={x}
              meta={meta[x.id]}
              many={checked.length > 1}
              touched={touched}
              busy={busy}
              onChange={(p) => setMeta((all) => ({ ...all, [x.id]: { ...all[x.id], ...p } }))}
            />
          ))}
        </div>
        <div className="ctb-fields">
          <Disclosure title="Ghi chú cho người duyệt" icon={StickyNote} summary={shortNote ? (shortNote.length > 40 ? `${shortNote.slice(0, 40)}…` : shortNote) : "Không bắt buộc"}>
            <TextField value={note} onChange={setNote} maxLength={400} aria-label="Ghi chú cho người duyệt" isDisabled={busy}>
              <TextArea rows={2} placeholder="Nội dung và đối tượng hữu ích" />
            </TextField>
          </Disclosure>
        </div>
      </KnowledgeModal>
    );
  }

  const label = item ? "Gửi phiên bản mới" : priv ? (n > 1 ? `Thêm ${n} tệp` : "Thêm vào Tệp của tôi") : "Tiếp tục";
  const hint = skipped
    ? `${plural(skipped, "file")} sẽ bị bỏ qua`
    : priv
      ? "Chỉ bạn thấy được."
      : twoStep
        ? "Bạn sẽ kiểm tra lại thông tin trước khi gửi."
        : "Bạn có thể rút lại khi tài liệu đang chờ duyệt.";
  const version = /\/revisions\/(\d+)$/.exec(baseDoc?.document?.revision ?? "")?.[1] ?? "1";

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      guard={busy}
      title={item ? "Gửi phiên bản mới" : priv ? "Tải lên Tệp của tôi" : "Gửi tài liệu"}
      icon={priv ? Lock : Upload}
      description={
        item
          ? "Người duyệt sẽ xem trước khi tài liệu thay thế phiên bản hiện tại."
          : priv
            ? "Chỉ bạn thấy các tệp này. Hỏi về chúng trong trò chuyện."
            : "Chia sẻ điều nhóm bạn nên biết. Người duyệt xem trước khi công bố."
      }
      footerStart={busy || !personal ? null : hint}
      footer={footer(
        <Button variant="primary" onPress={go} isPending={busy} isDisabled={!personal || reading}>
          {twoStep ? null : priv ? <Upload className="i" aria-hidden /> : <Send className="i" aria-hidden />}
          {label}
          {twoStep ? <ArrowRight className="i" aria-hidden /> : null}
        </Button>,
      )}
    >
      {baseDoc ? (
        <div className="ctb-current">
          <FileIcon name={baseDoc.document?.fileName} mime={baseDoc.document?.mimeType} />
          <div className="grow">
            <div className="medium truncate" translate="no">
              {stemOf(baseDoc.displayName ?? "")}
            </div>
            <div className="t-xs muted">
              Phiên bản hiện tại v{version}
              {baseDoc.ancestors?.[0]?.displayName ? ` · ${baseDoc.ancestors[0].displayName}` : ""}
            </div>
          </div>
        </div>
      ) : null}
      {!item && !busy && canShare && personal ? (
        <div className="field ctb-dest">
          <span className="label">Nên đặt ở đâu?</span>
          <ChoiceGroup
            label="Nên đặt ở đâu?"
            columns={2}
            value={dest}
            onChange={setDest}
            options={[
              { value: "share", title: "Gửi tài liệu vào kho tài liệu", description: "Nhóm có thể tìm thấy sau khi người duyệt công bố tài liệu.", icon: Share },
              { value: "private", title: "Tải lên Tệp của tôi", description: "Chỉ bạn xem được. Hỏi về tài liệu trong trò chuyện.", icon: Lock },
            ]}
          />
        </div>
      ) : null}
      {busy ? (
        <p className="t-sm muted mb-12">{priv ? "Đang thêm vào Tệp của tôi…" : `Đang tải lên phiên bản mới của ${stemOf(baseDoc?.displayName ?? "tài liệu")}…`}</p>
      ) : null}
      {!personal ? (
        <p className="t-sm muted row gap-6">
          <Lock className="i i-sm" aria-hidden />
          Bạn không thêm được tệp vào kho tài liệu nào.
        </p>
      ) : busy || full ? null : (
        <>
          <button
            type="button"
            className={clsx("ctb-drop", dragging && "is-drag")}
            aria-describedby="ctb-drop-hint"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={onDrop}
          >
            <span className="ctb-drop__icon">
              <Upload className="i i-lg" aria-hidden />
            </span>
            <span className="medium">
              {item ? "Thả tệp mới vào đây hoặc" : "Thả tệp hoặc thư mục vào đây, hoặc"} <span className="text-accent">chọn tệp</span>
            </span>
            <span className="description" id="ctb-drop-hint">
              {item ? "PDF, Word, Excel, PowerPoint, văn bản, Markdown hoặc HTML · tối đa 100 MB" : "PDF, Word, Excel, PowerPoint, văn bản, Markdown, HTML hoặc tệp ZIP · tối đa 100 MB mỗi tệp"}
            </span>
          </button>
          {item ? null : (
            // A file picker opens files or a folder, never both: the folder picker is the quiet second way in.
            <div className="ctb-drop-alt">
              {reading ? (
                <span className="t-sm muted row gap-6" role="status">
                  <Spinner size="sm" />
                  Đang đọc tệp…
                </span>
              ) : (
                <LinkButton icon={Folder} onPress={() => folderInput.current?.click()}>
                  Chọn thư mục
                </LinkButton>
              )}
            </div>
          )}
          <input
            ref={input}
            type="file"
            hidden
            multiple={!item}
            accept={item ? ACCEPT : ACCEPT_WITH_ZIP}
            onChange={(e) => {
              if (e.target.files?.length) void addPicked(pickedFromInput(e.target.files));
              e.target.value = "";
            }}
          />
          {item ? null : (
            <input
              ref={(el) => {
                folderInput.current = el;
                el?.setAttribute("webkitdirectory", ""); // not in React's input props
              }}
              type="file"
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void addPicked(pickedFromInput(e.target.files));
                e.target.value = "";
              }}
            />
          )}
        </>
      )}
      {fileError ? (
        <div className="field-error mt-8" role="alert">
          <CircleAlert className="i" aria-hidden />
          <span>{fileError}</span>
        </div>
      ) : null}
      {files.length ? (
        <div className={busy && !item ? "" : "mt-12"}>
          <List>
            {files.map((x) => (
              <ListItem
                key={x.id}
                lead={<FileIcon name={x.file.name} />}
                title={<span translate="no">{x.file.name}</span>}
                description={
                  x.err ? (
                    <span className="field-error">
                      <CircleAlert className="i" aria-hidden />
                      <span>{x.err}</span>
                    </span>
                  ) : busy || x.state !== "ready" ? (
                    <span className="row gap-8">
                      <span className="grow">
                        <ProgressBar label="Tiến trình tải lên" value={Math.round(x.progress * 100)} tone={x.state === "done" ? "success" : undefined} />
                      </span>
                      <span className="num t-xs muted ctb-pct">{Math.round(x.progress * 100)}%</span>
                    </span>
                  ) : x.where ? (
                    <>
                      <span translate="no">{x.where}</span> · {fmtSize(x.file.size)}
                    </>
                  ) : (
                    fmtSize(x.file.size)
                  )
                }
                actions={
                  busy ? (
                    x.err ? (
                      <span className="t-xs muted">Đã bỏ qua</span>
                    ) : x.state === "done" ? (
                      <CircleCheck className="i text-success" aria-label="Đã tải lên" />
                    ) : null
                  ) : (
                    <IconButton icon={X} tip={`Gỡ ${x.file.name}`} size="sm" onPress={() => setFiles(files.filter((f) => f.id !== x.id))} />
                  )
                }
              />
            ))}
          </List>
        </div>
      ) : null}
      {!busy && (leftOut.length || capped) ? (
        // What a folder or ZIP held that can't be sent: one line per source, never one error row per file.
        <ul className="ctb-left" role="status">
          {leftOut.map((l) => (
            <li key={l.source}>
              <Info className="i i-sm" aria-hidden />
              <span>{`Đã bỏ qua ${plural(l.count, "file")} trong “${l.source}”: định dạng không đọc được, tệp rỗng hoặc tệp quá 100 MB.`}</span>
            </li>
          ))}
          {capped ? (
            <li>
              <Info className="i i-sm" aria-hidden />
              <span>{`Chỉ thêm ${MAX_BATCH_FILES} tệp đầu tiên. Hãy gửi phần còn lại trong lần khác.`}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
      {item && !busy ? (
        <div className="ctb-fields">
          <TextField
            value={note}
            onChange={(v) => {
              setNote(v);
              if (v.trim()) setTouched(false);
            }}
            maxLength={400}
            isRequired
            isInvalid={!!noteError}
          >
            <Label>Có gì thay đổi?</Label>
            <TextArea rows={3} placeholder="VD: Đã sửa mục 2 và cập nhật ngày tháng" />
            {noteError ? <FieldError>{noteError}</FieldError> : <Description>Người duyệt sẽ thấy nội dung này cạnh phiên bản hiện tại.</Description>}
          </TextField>
        </div>
      ) : null}
    </KnowledgeModal>
  );
}
