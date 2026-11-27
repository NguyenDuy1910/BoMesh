"use client";

import { Button, FieldError, Spinner, TextArea, TextField } from "@heroui/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  File as FileGlyph,
  Globe,
  History,
  Pencil,
  Shield,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { EmptyState, FileIcon, IconButton, LinkButton as TextLink } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, relInline } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { conceptIcon } from "@/modules/home/domainIcon";
import { downloadItem } from "@/modules/knowledge/api";
import { ConceptPicker } from "@/modules/knowledge/components/ConceptPicker";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { useItem } from "@/modules/knowledge/queries";
import { DocumentSurface } from "@/modules/knowledge/reader/components/DocumentSurface";
import { classSchemes, conceptLabel, docAssignments, schemeByName, schemeIconName, schemeLabel, schemeOfConcept, type Taxonomy } from "@/modules/knowledge/taxonomy";

import { cleanName, lastEvent, taxonomyHref, versionOf, type Flag } from "../../model";
import { noteLines, type NoteLink } from "../../noteLinks";
import { useCollectionAudience } from "../../queries";
import { FieldTag, PlainSelect, SourceName } from "../parts";
import type { Draft, SubView } from "./types";

/**
 * The document itself, in its own pane (preview `docPane`): every page at reading size, scrolling on its own, so the
 * reviewer skims the whole file here; Open full preview adds zoom, find and the side panel.
 */
export function DocPane({ view: v }: { view: SubView }) {
  const { id: ws } = useWorkspace();
  const item = v.sub.item;
  const [counted, setCounted] = useState<{ item: string; pages: number }>();
  const pages = counted && counted.item === item?.name ? counted.pages : 0;
  return (
    <section className="cur-pane" aria-label="Xem trước">
      <header className="cur-pane__bar">
        <FileIcon name={v.fileName} mime={v.mime} size="sm" />
        <span className="cur-pane__title truncate" title={v.title} translate="no">
          {v.title}
        </span>
        {item ? (
          <>
            {pages ? <span className="cur-pane__meta num">{plural(pages, "page")}</span> : null}
            <TextLink href={`/doc/${resourceId(item.name)}`} icon={ExternalLink}>
              Mở bản xem trước đầy đủ
            </TextLink>
          </>
        ) : null}
      </header>
      <div className="cur-pane__scroll" tabIndex={0}>
        {item ? (
          <DocumentSurface
            key={item.name}
            document={{ id: resourceId(item.name), cover: item.document?.cover }}
            variant="pane"
            onPages={(n) => setCounted({ item: item.name ?? "", pages: n })}
            onDownload={() =>
              void downloadItem(ws, item.name ?? "", item.document?.fileName || item.displayName || "document").catch((e: unknown) => toast(errorMessage(e), { tone: "danger" }))
            }
          />
        ) : (
          <EmptyState icon={FileGlyph} compact title="Chưa có bản xem trước" />
        )}
      </div>
    </section>
  );
}

export interface InspectorProps {
  view: SubView;
  pos: number;
  total: number;
  /** Queue rows are selected: the floating bulk bar replaces the decision footer. */
  selecting: boolean;
  draft: Draft | null;
  setDraft: (patch: Partial<Draft>) => void;
  taxonomy: Taxonomy;
  bases: readonly { name: string; displayName: string }[];
  baseNames: ReadonlyMap<string, string>;
  memberNames: ReadonlyMap<string, string>;
  /** Classification › Suggestions is open to the caller (where corrections become label proposals). */
  canManageTaxonomy: boolean;
  onStep: (dir: 1 | -1) => void;
  onBack: () => void;
  onApprove: () => void;
  onChanges: () => void;
  onDecline: () => void;
  onCompare: (related: string) => void;
}

/**
 * The workbench's right side (preview `detailPanel`): who sent it and when · J/K; their note and what the assistant
 * found; the form; and the decision footer pinned at its bottom. The document pane names the document; the inspector
 * names it only when there is no pane (narrow screens).
 */
export function Inspector(p: InspectorProps) {
  const { view: v } = p;
  const c = v.sub.contribution;
  const last = lastEvent(c);
  const item = v.sub.item;
  const router = useRouter();
  return (
    <aside className="cur-detail cur-insp" id="cur-detail" aria-label={v.title}>
      <header className="cur-detail__head">
        <IconButton icon={ArrowLeft} tip="Quay lại hàng chờ" onPress={p.onBack} className="cur-back" />
        <div className="grow">
          <h2 className="cur-detail__title cur-detail__title--doc" translate="no">
            {v.title}
          </h2>
          {/* Who on the first line, when on the second: no separator dangling where a narrow inspector wraps. */}
          <div className="cur-detail__meta cur-detail__meta--stack">
            <span className="truncate">
              {v.via ? "Đồng bộ từ" : "Từ"} <span className="medium">{v.via ? <SourceName source={c.source} /> : v.contributor}</span>
            </span>
            <span>{`${v.resubmitted ? "Đã gửi lại" : "Đã gửi"} ${relInline(last.at)}`}</span>
            {v.analyzing ? <LifecycleChip lifecycle="analyzing" size="sm" /> : null}
          </div>
        </div>
        {item?.name ? <IconButton icon={Eye} tip="Mở bản xem trước đầy đủ" size="sm" className="cur-peek" onPress={() => router.push(`/doc/${resourceId(item.name)}`)} /> : null}
        <div className="cur-detail__nav">
          <span className="t-xs muted num">{`${p.pos + 1}/${p.total}`}</span>
          <IconButton icon={ChevronUp} tip="Trước (K)" size="sm" onPress={() => p.onStep(-1)} isDisabled={p.pos <= 0} />
          <IconButton icon={ChevronDown} tip="Tiếp (J)" size="sm" onPress={() => p.onStep(1)} isDisabled={p.pos >= p.total - 1} />
        </div>
      </header>
      <div className="cur-insp__body">
        <Context view={v} memberNames={p.memberNames} onCompare={p.onCompare} />
        <Classification {...p} />
      </div>
      {p.selecting ? null : <DecisionBar {...p} />}
    </aside>
  );
}

/* ── The contributor's note and what the assistant found ── */

function Context({ view: v, memberNames, onCompare }: { view: SubView; memberNames: ReadonlyMap<string, string>; onCompare: (related: string) => void }) {
  const c = v.sub.contribution;
  const last = lastEvent(c);
  const note = last.kind === "RESUBMITTED" && last.message ? last.message : c.note;
  const asked = [...(c.events ?? [])].reverse().find((e) => e.kind === "CHANGES_REQUESTED");
  const flags = v.flags.filter((f, i, all) => all.findIndex((x) => x.type === f.type) === i);
  if (!note && !(last.kind === "RESUBMITTED" && asked) && !flags.length) return null;
  return (
    <section className="cur-insp__sec">
      {note ? (
        // The contributor's words, as a quiet quote under who sent it (the caption is for screen readers).
        <figure className="cur-note">
          <figcaption className="sr-only">Ghi chú cho người duyệt</figcaption>
          <blockquote translate="no">
            <NoteBody note={note} />
          </blockquote>
        </figure>
      ) : null}
      {last.kind === "RESUBMITTED" && asked ? (
        <div className="cur-asked">
          <Pencil className="i i-xs" aria-hidden />
          <span>
            Đã gửi lại sau khi {memberNames.get(asked.actor ?? "") || "một người duyệt"} yêu cầu: “<span translate="no">{asked.message}</span>”
          </span>
        </div>
      ) : null}
      {flags.length ? (
        <ul className="cur-risks" aria-label="Những gì trợ lý phát hiện">
          {flags.map((f) => (
            <RiskRow key={f.type} flag={f} onCompare={onCompare} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** A link as a chip: globe, host, the page's file name; opens in a new tab, the whole address on hover. */
function LinkChip({ link }: { link: NoteLink }) {
  return (
    <a className="cur-link" href={link.href} target="_blank" rel="noopener noreferrer" title={link.full} translate="no">
      <Globe className="i i-xs" aria-hidden />
      <span className="cur-link__host">{link.host}</span>
      {link.tail ? <span className="cur-link__tail">{link.tail}</span> : null}
      <ExternalLink className="i i-xs" aria-hidden />
    </a>
  );
}

/** The note line by line: "Label: URL" alone (an import's "Nguồn: …") is a labelled source; other addresses become chips. */
function NoteBody({ note }: { note: string }) {
  return noteLines(note).map((line, i) =>
    "label" in line ? (
      <div key={i} className="cur-note__src">
        <span className="cur-note__label">{line.label}</span>
        <LinkChip link={line.link} />
      </div>
    ) : (
      <p key={i}>{line.segments.map((s, j) => ("link" in s ? <LinkChip key={j} link={s.link} /> : s.text))}</p>
    ),
  );
}

function Risk({ tone, icon: Icon, title, text, action }: { tone: string; icon: LucideIcon; title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <li className={`cur-risk cur-risk--${tone}`}>
      <Icon className="i i-sm" aria-hidden />
      <div className="cur-risk__body">
        <div className="cur-risk__title">{title}</div>
        {text ? <div className="cur-risk__text">{text}</div> : null}
      </div>
      {action}
    </li>
  );
}

/** Risks as compact rows inside the inspector: icon, what was found, its one action — never full-width alert cards. */
function RiskRow({ flag, onCompare }: { flag: Flag; onCompare: (related: string) => void }) {
  const related = useItem(flag.type === "duplicate" || flag.type === "version" ? flag.related : null);
  const o = related.data;
  if (flag.type === "duplicate") {
    if (!flag.related || related.isError) return <Risk tone="warning" icon={Copy} title="Có thể trùng lặp" text="Có vẻ đây là tài liệu bạn không mở được. Hãy hỏi quản trị viên không gian làm việc." />;
    return (
      <Risk
        tone="warning"
        icon={Copy}
        title="Có thể trùng lặp"
        text={
          <>
            Có vẻ giống “<span translate="no">{o?.displayName ?? "…"}</span>”.
          </>
        }
        action={<TextLink onPress={() => onCompare(flag.related!)}>So sánh</TextLink>}
      />
    );
  }
  if (flag.type === "version") {
    if (!flag.related || !o) return null;
    const ver = versionOf(o.document?.revision);
    return (
      <Risk
        tone="accent"
        icon={History}
        title={
          <>
            Thay thế {ver ? `v${ver} của ` : ""}“<span translate="no">{o.displayName}</span>”
          </>
        }
        text="Phiên bản hiện tại vẫn được công bố cho đến khi bạn duyệt."
        action={<TextLink href={`/doc/${resourceId(flag.related)}`}>Mở bản hiện tại</TextLink>}
      />
    );
  }
  if (flag.type === "personal") return <Risk tone="danger" icon={Shield} title="Có thể chứa dữ liệu cá nhân" text="Không nên chia sẻ tên, điểm số hoặc số định danh. Hãy kiểm tra trước khi công bố." />;
  return <Risk tone="default" icon={FileGlyph} title="Không tra cứu được" text="Loại tệp này không tra cứu được; mọi người chỉ có thể tải xuống." />;
}

/* ── The form ── */

/** One field pattern for the whole form (preview `field`): a label row (the label, its one status tag), the control,
 *  then helper or error lines. */
function Field({ label, tag, children, help }: { label: string; tag?: ReactNode; children: ReactNode; help?: ReactNode }) {
  return (
    <div className="cur-field">
      <div className="cur-field__head">
        <span className="cur-field__label">{label}</span>
        {tag}
      </div>
      {children}
      {help}
    </div>
  );
}

const byContributor = <span className="cur-tag cur-tag--plain">Do người gửi chọn</span>;

/** Document name → Collection (who will see it) → Classification → Summary, under one quiet line saying the assistant
 *  filled them in (preview `suggestionsCard`). */
function Classification(p: InspectorProps) {
  const { view: v, draft, setDraft } = p;
  const c = v.sub.contribution;
  const s = c.suggestions ?? {};
  const version = c.kind === "NEW_REVISION";
  const audience = useCollectionAudience(draft?.kb || v.base);
  const processed = !version && v.sub.item?.document?.indexingState === "SUCCEEDED";
  const section = (body: ReactNode) => (
    <section className="cur-insp__sec cur-sugs" aria-label="Phân loại">
      {processed && draft ? (
        <p className="cur-insp__sub">
          <Sparkles className="i i-xs" aria-hidden />
          <span>Trợ lý đã điền sẵn các mục dưới đây. Kiểm tra trước khi công bố.</span>
        </p>
      ) : null}
      {body}
    </section>
  );
  if (!draft) {
    return section(
      <div className="cur-analyzing">
        <Spinner size="sm" />
        <span>Đang đọc tệp và đối chiếu với bộ phân loại của bạn…</span>
      </div>,
    );
  }

  // Name: the clean title processing wrote for a messy file name. A new version keeps the published document's name.
  const sugTitle = s.title ?? "";
  const draftTitle = cleanName(draft.title);
  const titleTag = sugTitle ? <FieldTag edited={draftTitle !== sugTitle} suggested /> : <FieldTag edited={draftTitle !== v.displayName} />;
  const titleHelp =
    draftTitle && sugTitle && sugTitle !== v.displayName ? (
      <div className="cur-field__help cur-orig">
        <span className="cur-orig__label">Tên gốc:</span>
        <span className="cur-orig__name truncate" translate="no" title={v.displayName}>
          {v.displayName}
        </span>
        {draftTitle !== v.displayName ? (
          <TextLink size="sm" onPress={() => setDraft({ title: v.displayName })}>
            Dùng tên gốc
          </TextLink>
        ) : null}
      </div>
    ) : null;

  // Collection: where it lives decides who can see it — the helper says who, or that one is needed to publish.
  const aiBase = !c.targetCollection && !!s.collection;
  // The submission's own target (often a folder, named by its path) stays a choice after picking another collection.
  const baseOpts = p.bases.map((b) => [b.name, b.displayName] as const);
  for (const k of [v.base, draft.kb]) if (k && !baseOpts.some(([n]) => n === k)) baseOpts.push([k, p.baseNames.get(k) || "Kho tài liệu"]);
  const kbTag = version ? null : aiBase ? (
    <FieldTag value={s.collectionConfidence} edited={draft.kb !== s.collection} suggested />
  ) : draft.kb !== (c.targetCollection ?? "") ? (
    <FieldTag edited />
  ) : c.targetCollection ? (
    byContributor
  ) : null;
  const kbHelp =
    !version && !draft.kb ? (
      <div className="cur-field__help cur-field__help--warning">
        <CircleAlert className="i i-xs" aria-hidden />
        <span>Chọn kho tài liệu để công bố</span>
      </div>
    ) : audience ? (
      <div className="cur-field__help">
        <audience.icon className="i i-xs" aria-hidden />
        <span>{`${version ? "Giống phiên bản hiện tại · " : ""}${audience.label} sẽ thấy`}</span>
      </div>
    ) : null;

  // Classification: one row per classification scheme, in tab order — the assistant's concepts as removable chips
  // (suggested ones marked Chờ duyệt), each with its confidence and evidence. Reviewers add any published concept of the
  // scheme; a scheme that takes at most n concepts drops its oldest to make room.
  const t = p.taxonomy;
  const byName = new Map(docAssignments(t, v.sub.item?.document?.concepts).map((a) => [a.concept ?? "", a]));
  const changed = draft.concepts.length !== draft.classified.length || draft.concepts.some((x) => !draft.classified.includes(x));
  const schemes = classSchemes(t);
  const setScheme = (scheme: string, next: string[]) => {
    const max = schemeByName(t, scheme)?.cardinality?.max;
    const kept = max && next.length > max ? next.slice(next.length - max) : next;
    setDraft({ concepts: [...draft.concepts.filter((x) => schemeOfConcept(x) !== scheme), ...kept] });
  };
  // A changed classification is learned from (a correction; repeated ones become label proposals a workspace admin
  // decides in Phân loại › Gợi ý). Unchanged, what's awaiting review is published as it is.
  const decideIn = p.canManageTaxonomy ? (
    <>
      {" "}
      <NextLink className="link" href={taxonomyHref("suggestions")}>
        Quyết định ở Phân loại → Gợi ý
      </NextLink>
    </>
  ) : null;
  const waiting = !changed && draft.classified.some((x) => byName.get(x)?.state === "SUGGESTED");
  const classNote =
    changed || waiting ? (
      <p className="cur-concept-note">
        {changed ? <Sparkles className="i i-xs" aria-hidden /> : <Clock className="i i-xs" aria-hidden />}
        <span>
          <span>{changed ? "Thay đổi của bạn được dùng để cải thiện phân loại." : "Các khái niệm chờ duyệt được công bố dưới dạng gợi ý."}</span>
          {decideIn}
        </span>
      </p>
    ) : null;
  const classTag = changed ? <FieldTag edited /> : <FieldTag suggested={draft.classified.length > 0} />;

  const summaryEdited = draft.summary.trim() !== (s.summary ?? "").trim() && !!(s.summary || draft.summary.trim());

  return section(
    <div className="cur-form">
      {version ? null : (
        <Field label="Tên tài liệu" tag={titleTag} help={titleHelp}>
          <TextField value={draft.title} onChange={(title) => setDraft({ title })} maxLength={512} aria-label="Tên tài liệu" isInvalid={!draftTitle}>
            {/* The whole name stays readable: one line growing to three; Enter never adds a line break. */}
            <TextArea rows={1} className="cur-name" translate="no" onKeyDown={(e) => e.key === "Enter" && e.preventDefault()} />
            <FieldError>Nhập tên tài liệu.</FieldError>
          </TextField>
        </Field>
      )}
      <Field label="Kho tài liệu" tag={kbTag} help={kbHelp}>
        {version ? (
          <div className="cur-fixed">
            <span className="truncate" translate="no">
              {p.baseNames.get(draft.kb) || v.baseName}
            </span>
          </div>
        ) : (
          <PlainSelect label="Kho tài liệu" value={draft.kb} options={baseOpts} placeholder="Chọn kho tài liệu" onChange={(kb) => setDraft({ kb })} />
        )}
      </Field>
      <Field label="Phân loại" tag={classTag} help={classNote}>
        <div className="cur-schemes" role="group" aria-label="Phân loại">
          {schemes.length ? (
            schemes.map((scheme) => {
              const name = scheme.name ?? "";
              const ids = draft.concepts.filter((x) => schemeOfConcept(x) === name);
              const SchemeIcon = conceptIcon(schemeIconName(name));
              const why = ids.flatMap((id) => {
                const a = byName.get(id);
                return a ? [a] : [];
              });
              return (
                <div key={name} className="cur-scheme">
                  <div className="cur-scheme__head">
                    <SchemeIcon className="i i-xs" aria-hidden />
                    <span className="cur-scheme__name" translate="no">
                      {schemeLabel(scheme)}
                    </span>
                  </div>
                  <ConceptPicker
                    value={ids}
                    onChange={(next) => setScheme(name, next)}
                    taxonomy={t}
                    scheme={name}
                    label={schemeLabel(scheme)}
                    suggested={ids.filter((id) => byName.get(id)?.state === "SUGGESTED")}
                  />
                  {why.length ? (
                    <ul className="cur-why" aria-label="Vì sao chọn các khái niệm này">
                      {why.map((a) => (
                        <li key={a.concept}>
                          <span className="medium" translate="no">
                            {conceptLabel(t, a.concept)}
                          </span>
                          {a.confidence != null && a.source !== "HUMAN" ? <span className="muted num">{` · ${Math.round(a.confidence * 100)}%`}</span> : null}
                          {a.evidence?.quote ? (
                            <>
                              <span className="muted" aria-hidden>
                                {" — "}
                              </span>
                              <span className="muted" translate="no">{`“${a.evidence.quote}”`}</span>
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })
          ) : (
            <span className="t-sm muted">Chưa có khái niệm</span>
          )}
        </div>
      </Field>
      <Field label="Tóm tắt" tag={<FieldTag value={s.summary ? s.summaryConfidence : null} suggested={!!s.summary} edited={summaryEdited} />}>
        <TextField value={draft.summary} onChange={(summary) => setDraft({ summary })} maxLength={280} aria-label="Tóm tắt">
          <TextArea rows={Math.min(8, Math.max(3, Math.ceil(draft.summary.length / 48)))} className="cur-summary" />
        </TextField>
      </Field>
    </div>,
  );
}

/* ── Decision footer ── */

/** Preview `decisionBar`: Approve & publish across the full width, then Request changes and Decline side by side. What
 *  keeps approving unavailable shows in the form (the name's error, the collection's helper). Approving publishes only:
 *  processing came before review. */
function DecisionBar({ view: v, draft, onApprove, onChanges, onDecline }: InspectorProps) {
  const version = v.sub.contribution.kind === "NEW_REVISION";
  return (
    <footer className="cur-decide cur-decide--stack" role="group" aria-label="Quyết định">
      <Button variant="primary" fullWidth onPress={onApprove} isDisabled={!draft || (!version && (!draft.kb || !cleanName(draft.title)))} isPending={!draft}>
        {draft ? <Check className="i" aria-hidden /> : null}
        {draft ? "Duyệt và công bố" : "Đang xử lý…"}
      </Button>
      <div className="cur-decide__alt">
        <Button variant="outline" onPress={onChanges}>
          Yêu cầu chỉnh sửa
        </Button>
        <Button variant="outline" className="cur-decide__decline" onPress={onDecline}>
          Từ chối
        </Button>
      </div>
    </footer>
  );
}
