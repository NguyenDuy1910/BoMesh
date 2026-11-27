"use client";

import { Button, Description, Drawer, FieldError, Label, Spinner, TextArea, TextField } from "@heroui/react";
import { CircleAlert, Eye, File as FileGlyph, FileText, GitCompare, History, Send, Shield, Trash2, Undo2, Upload, X } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";

import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { KeyValue } from "@/components/ui/KeyValue";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import type { Messages } from "@/i18n/messages";
import { resourceId } from "@/lib/api/client";
import { fmtSize, relInline } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import type { Contribution } from "../../api";
import { openContribute } from "../../components/contribute-store";
import { schemeRows } from "../../components/ConceptsByScheme";
import { CONTRIBUTE_TYPES, DOC_TYPES, docTypeOf, fileProblem } from "../../model";
import { useContribution, useItemsByName, useKnowledgeModel } from "../../queries";
import { flagText, lastEvent, lastEventAt, PUBLISHED_KEYS, who, type ContributionEventView } from "../contributions";
import { useContributionActions } from "../useContributionActions";
import { useContributionViews, type ContributionView } from "../useContributionViews";
import { ProgressStepper, TimelineSteps } from "./ContributionTimeline";

/** The contribution panel (preview `DR['ctb']`): where it stands, the revise form, progress, details and history. */
export function ContributionDrawer({ id, focusRevise, onClose }: { id: string; focusRevise?: boolean; onClose: () => void }) {
  const query = useContribution(id);
  return (
    <Drawer.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog className="drawer__dialog--lg">
          <Drawer.CloseTrigger aria-label="Đóng" />
          {query.data ? (
            <Panel contribution={query.data} focusRevise={focusRevise} onClose={onClose} />
          ) : query.isError ? (
            <>
              <Drawer.Header>
                <Drawer.Heading>Không có tài liệu đã gửi</Drawer.Heading>
              </Drawer.Header>
              <Drawer.Body>
                <EmptyState icon={FileGlyph} title="Tài liệu đã gửi này không khả dụng" description="Có thể nó đã bị rút lại." compact />
              </Drawer.Body>
            </>
          ) : (
            <>
              <Drawer.Header>
                <Drawer.Heading>Tài liệu đã gửi</Drawer.Heading>
              </Drawer.Header>
              <Drawer.Body>
                <SkeletonRows rows={4} />
              </Drawer.Body>
            </>
          )}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

/** Which details section the panel shows: how a published one is classified, or what was suggested/confirmed. */
function detailsOf(v: ContributionView): "classified" | "suggested" | null {
  if (PUBLISHED_KEYS.includes(v.life) && v.published) return "classified";
  if (v.life === "analyzing" || v.life === "review" || v.life === "changes" || v.contribution.suggestions) return "suggested";
  return null;
}

/**
 * One contribution. Each fact appears once: the file (and, when no section names it, the collection) in the
 * subtitle; where it stands in Progress (plus an alert with the reviewer's message); the details in their
 * section; every event in History (collapsed).
 */
function Panel({ contribution, focusRevise, onClose }: { contribution: Contribution; focusRevise?: boolean; onClose: () => void }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const m = useMessages();
  const { view } = useContributionViews([contribution]);
  const actions = useContributionActions();
  const v = view(contribution);
  const c = contribution;
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const details = detailsOf(v);
  const state = stateBlock(v, m);
  const openId = v.published ? resourceId(v.published.name) : resourceId(c.item);
  const ext = (v.fileName.split(".").pop() || "file").toUpperCase();
  const subtitle: ReactNode[] = [
    !details && v.base ? (
      <span key="kb" translate="no">
        {v.base}
      </span>
    ) : null,
    `${ext} · ${fmtSize(v.sizeBytes)}`,
    !v.mine ? `Do ${who(c.contributor ?? "", v.ctx)} gửi` : null,
    c.replacesItem ? (
      <span key="orig">
        Phiên bản mới của{" "}
        <NextLink className="link" href={`/doc/${resourceId(c.replacesItem)}`} translate="no">
          {v.revised?.displayName ?? "tài liệu đã công bố"}
        </NextLink>
      </span>
    ) : null,
  ].filter(Boolean);

  const withdrawBtn = (
    <Button
      variant="ghost"
      onPress={() =>
        void actions.withdraw(v).then((done) => {
          if (done) onClose();
        })
      }
    >
      <Undo2 className="i" aria-hidden />
      Rút lại
    </Button>
  );
  const openBtn = (label: string, variant: "primary" | "secondary", icon: ReactNode) => (
    <Button variant={variant} onPress={() => router.push(`/doc/${openId}`)}>
      {icon}
      {label}
    </Button>
  );

  async function resubmit() {
    setTouched(true);
    if (!note.trim() || (file && fileProblem(file))) return;
    setBusy(true);
    const ok = await actions.resubmit(v, { changeSummary: note.trim(), file });
    setBusy(false);
    if (ok) {
      setNote("");
      setFile(null);
      setTouched(false);
    }
  }

  let foot: ReactNode = null;
  let footStart: ReactNode = null;
  if (v.mine) {
    switch (v.life) {
      case "analyzing":
      case "review":
        // The API withdraws only once it's in review (not while the assistant is reading it).
        footStart = c.state === "IN_REVIEW" ? withdrawBtn : null;
        foot = openBtn("Mở bản xem trước", "secondary", <Eye className="i" aria-hidden />);
        break;
      case "changes":
        footStart = withdrawBtn;
        foot = (
          <Button variant="primary" isPending={busy} onPress={() => void resubmit()}>
            <Send className="i" aria-hidden />
            Gửi lại
          </Button>
        );
        break;
      case "published":
      case "publishing":
      case "queued":
      case "update":
      case "stored":
      case "merged":
        foot = (
          <>
            {can("contributions.create") && v.published ? (
              <Button
                variant="tertiary"
                onPress={() => {
                  onClose();
                  openContribute({ item: v.published?.name });
                }}
              >
                <Upload className="i" aria-hidden />
                Gửi phiên bản mới
              </Button>
            ) : null}
            {openBtn("Mở", "primary", <FileText className="i" aria-hidden />)}
          </>
        );
        break;
      case "rejected":
        foot = (
          <Button
            variant="danger-soft"
            onPress={() => {
              actions.remove(v);
              onClose();
            }}
          >
            <Trash2 className="i" aria-hidden />
            Gỡ
          </Button>
        );
        break;
    }
  }

  return (
    <>
      <Drawer.Header>
        <div className="row gap-12">
          <FileIcon name={v.fileName} mime={v.mime} />
          <div className="grow">
            <Drawer.Heading>
              <span translate="no">{v.title}</span>
            </Drawer.Heading>
            <p className="drawer__description">
              {subtitle.map((part, i) => (
                <span key={i}>
                  {i ? " · " : null}
                  {part}
                </span>
              ))}
            </p>
          </div>
        </div>
      </Drawer.Header>
      <Drawer.Body>
        <div className="ctb-panel">
          {state.alert}
          {v.life === "changes" && v.mine ? (
            <ReviseForm note={note} setNote={setNote} file={file} setFile={setFile} touched={touched} autoFocus={focusRevise} />
          ) : null}
          <section>
            <h3 className="ctb-sec__title">Tiến độ</h3>
            <ProgressStepper view={v} />
          </section>
          {details ? <Details view={v} kind={details} /> : null}
          <Disclosure icon={History} title="Lịch sử" summary={`Cập nhật lần cuối ${relInline(lastEventAt(c))}`}>
            <TimelineSteps view={v} quoted={state.quoted} />
          </Disclosure>
        </div>
      </Drawer.Body>
      {foot || footStart ? (
        <Drawer.Footer>
          {footStart ? <div className="drawer__footer-start row gap-8">{footStart}</div> : null}
          {foot}
        </Drawer.Footer>
      ) : null}
    </>
  );
}

/**
 * Where it stands when someone decided something: an alert with their message (History doesn't repeat it).
 * Every other state is the stepper's current step. Returns the event the alert quotes (preview `stateBlock`).
 */
function stateBlock(v: ContributionView, m: Messages): { alert: ReactNode; quoted?: ContributionEventView } {
  const quote = (text?: string) =>
    text ? (
      <blockquote className="ctb-quote" translate="no">
        {text}
      </blockquote>
    ) : null;
  const c = v.contribution;
  if (v.life === "changes") {
    const e = lastEvent(c, "changes");
    return { alert: <Callout tone="warning" title={`${who(e?.by ?? "", v.ctx)} đã yêu cầu chỉnh sửa`} description={quote(e?.text)} />, quoted: e };
  }
  if (v.life === "rejected") {
    const e = lastEvent(c, "rejected");
    return { alert: <Callout tone="danger" title={`${who(e?.by ?? "", v.ctx)} đã từ chối`} description={quote(e?.text) ?? "Tệp sẽ không được công bố."} />, quoted: e };
  }
  if (v.life === "unpublished") return { alert: <Callout tone="default" title={m.state.lifecycle.unpublished.label} description={m.state.lifecycle.unpublished.desc} /> };
  if (v.life === "failed") {
    return {
      alert: (
        <Callout
          tone="danger"
          title="Không xử lý được — đã báo cho người duyệt"
          description="Tài liệu đã được duyệt nhưng tệp không xử lý được để tra cứu. Bạn không cần làm gì."
        />
      ),
    };
  }
  return { alert: null };
}

const ACCEPT = CONTRIBUTE_TYPES.map((x) => `.${x}`).join(",");

function ReviseForm({
  note,
  setNote,
  file,
  setFile,
  touched,
  autoFocus,
}: {
  note: string;
  setNote: (v: string) => void;
  file: File | null;
  setFile: (f: File | null) => void;
  touched: boolean;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const err = touched && !note.trim() ? "Mô tả những gì bạn đã thay đổi." : "";
  const problem = file ? fileProblem(file) : "";
  return (
    <section className="ctb-revise" aria-label="Sửa và gửi lại">
      <h3 className="ctb-sec__title">Sửa và gửi lại</h3>
      <div className="field">
        <span className="label">
          Tệp thay thế<span className="label__opt">(không bắt buộc)</span>
        </span>
        <input
          ref={input}
          type="file"
          hidden
          accept={ACCEPT}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
        {file ? (
          <div className="ctb-revfile">
            <FileIcon name={file.name} mime={file.type} />
            <span className="grow stack gap-2">
              <span className="medium truncate" translate="no">
                {file.name}
              </span>
              {problem ? (
                <span className="field-error">
                  <CircleAlert className="i" aria-hidden />
                  <span>{problem}</span>
                </span>
              ) : (
                <span className="t-xs muted">{fmtSize(file.size)}</span>
              )}
            </span>
            <IconButton icon={X} tip="Gỡ tệp" size="sm" onPress={() => setFile(null)} />
          </div>
        ) : (
          <>
            <div className="row wrap gap-8">
              <Button size="sm" variant="tertiary" onPress={() => input.current?.click()}>
                <Upload className="i" aria-hidden />
                Chọn tệp
              </Button>
            </div>
            <div className="description">Giữ tệp hiện tại nếu bạn chỉ cần giải thích thêm.</div>
          </>
        )}
      </div>
      <TextField value={note} onChange={setNote} maxLength={400} isRequired isInvalid={!!err} autoFocus={autoFocus}>
        <Label>Bạn đã thay đổi gì?</Label>
        <TextArea id="ctb-rev-note" rows={3} placeholder="VD: Đã bỏ đáp án đầy đủ và giữ cách làm của tôi" />
        {err ? <FieldError>{err}</FieldError> : <Description className="sr-only">Bắt buộc</Description>}
      </TextField>
    </section>
  );
}

const FLAG_ICON = { PERSONAL_DATA: Shield, UNSEARCHABLE_FORMAT: FileGlyph } as const;

/**
 * Read-only details (preview `suggestion`): how a published one is classified; otherwise what the contributor
 * confirmed (the concepts written on the candidate) or what the assistant suggested — concepts by classification scheme.
 */
function Details({ view: v, kind }: { view: ContributionView; kind: "classified" | "suggested" }) {
  const { taxonomy } = useKnowledgeModel();
  const c = v.contribution;
  const s = c.suggestions;
  const related = useItemsByName(
    (c.flags ?? []).map((f) => f.relatedItem),
    { view: "BASIC" },
  );
  const collection = (sub?: string) => (
    <span key="kb" className="stack gap-2">
      {v.base ? <span translate="no">{v.base}</span> : <span className="muted">Chưa chọn</span>}
      {sub ? <span className="t-xs muted">{sub}</span> : null}
    </span>
  );

  if (kind === "classified") {
    return (
      <section>
        <h3 className="ctb-sec__title">Cách phân loại</h3>
        <KeyValue
          pairs={[
            ["Loại", DOC_TYPES[docTypeOf(v.published?.itemType)].label],
            ...schemeRows(taxonomy, v.published?.document?.concepts, { compact: true }),
            ["Kho tài liệu", collection()],
          ]}
        />
      </section>
    );
  }

  const confirmed = !!v.ctx.confirmed;
  const head = <h3 className="ctb-sec__title">{confirmed ? (v.mine ? "Những gì bạn đã xác nhận" : "Người gửi đã xác nhận") : "Trợ lý đã đề xuất"}</h3>;
  if (!confirmed && (v.life === "analyzing" || !s)) {
    return (
      <section>
        {head}
        <div className="ctb-reading">
          <Spinner size="sm" />
          <span>Đang đọc tệp…</span>
        </div>
      </section>
    );
  }
  const doc = v.candidate?.document;
  const flags = (c.flags ?? []).map((f) => {
    const rel = f.relatedItem ? related.items.get(f.relatedItem)?.displayName : undefined;
    return { kind: f.kind ?? "", text: flagText(f.kind, rel) };
  });
  const chosenBy = c.targetCollection
    ? `${v.mine ? "you" : who(c.contributor ?? "", v.ctx)} đã chọn`
    : v.base
      ? "Do trợ lý đề xuất"
      : "Trợ lý chọn mục phù hợp nhất. Người duyệt sẽ xác nhận.";
  return (
    <section>
      {head}
      <KeyValue
        pairs={[
          ...schemeRows(taxonomy, doc?.concepts, { compact: true }),
          ["Kho tài liệu", collection(chosenBy)],
        ]}
      />
      {flags.length ? (
        <ul className="ctb-flags">
          {flags.map((f) => {
            const Icon = FLAG_ICON[f.kind as keyof typeof FLAG_ICON] ?? GitCompare;
            return (
              <li key={f.kind}>
                <Icon className="i i-sm" aria-hidden />
                <span translate="no">{f.text}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="t-xs muted mt-8">Người duyệt có thể thay đổi trước khi công bố.</p>
    </section>
  );
}
