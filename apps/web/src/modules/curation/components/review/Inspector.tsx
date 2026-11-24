"use client";

import { Autocomplete, Button, Checkbox, FieldError, Header, ListBox, Popover, SearchField, Spinner, TextArea, TextField } from "@heroui/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  ExternalLink,
  Eye,
  File as FileGlyph,
  Globe,
  History,
  Pencil,
  Plus,
  Shield,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { EmptyState, FileIcon, IconButton, LinkButton as TextLink } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, relInline } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { downloadItem, type Topic } from "@/modules/knowledge/api";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { topicToneProps } from "@/modules/knowledge/components/TopicTag";
import { fold, topicLooks, topicTree, type TopicLook } from "@/modules/knowledge/model";
import { useItem } from "@/modules/knowledge/queries";
import { DocumentSurface } from "@/modules/knowledge/reader/components/DocumentSurface";

import { cleanName, lastEvent, topicsHref, versionOf, type Flag } from "../../model";
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
  topics: readonly Topic[];
  bases: readonly { name: string; displayName: string }[];
  baseNames: ReadonlyMap<string, string>;
  memberNames: ReadonlyMap<string, string>;
  canManageTopics: boolean;
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

/** Document name → Collection (who will see it) → Topics → Summary, under one quiet line saying the assistant filled
 *  them in (preview `suggestionsCard`). */
function Classification(p: InspectorProps) {
  const { view: v, draft, setDraft } = p;
  const c = v.sub.contribution;
  const s = c.suggestions ?? {};
  const version = c.kind === "NEW_REVISION";
  const audience = useCollectionAudience(draft?.kb || v.base);
  const processed = !version && v.sub.item?.document?.indexingState === "SUCCEEDED";
  const looks = useMemo(() => topicLooks(p.topics), [p.topics]);
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
        <span>Đang đọc tệp và đối chiếu với các chủ đề của bạn…</span>
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

  // Topics: suggestions toggle on/off; reviewers may add any existing topic.
  const topicName = new Map(p.topics.map((t) => [t.name ?? "", t.displayName ?? ""]));
  const sugg = s.topics ?? [];
  const extra = draft.topics.filter((t) => !sugg.includes(t));
  const toggle = (t: string) => setDraft({ topics: draft.topics.includes(t) ? draft.topics.filter((x) => x !== t) : [...draft.topics, t] });
  const addGroups = topicTree(p.topics)
    .map((dm) => ({
      name: dm.name ?? "",
      displayName: dm.displayName ?? "",
      topics: dm.children.filter((t) => !draft.topics.includes(t.name ?? "")).map((t) => ({ name: t.name ?? "", displayName: t.displayName ?? "" })),
    }))
    .filter((g) => g.topics.length);
  // A changed topic teaches classification: approval records it as a correction; a workspace admin turns corrections into keywords.
  const changed = draft.topics.length !== sugg.length || draft.topics.some((t) => !sugg.includes(t));
  const teach = changed ? (
    <div className="cur-teach">
      <Checkbox isSelected={draft.teach} onChange={(teach) => setDraft({ teach })}>
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <span className="checkbox__label">Dùng thay đổi của tôi để cải thiện phân loại</span>
        </Checkbox.Content>
      </Checkbox>
      <span className="cur-teach__hint">{p.canManageTopics ? "Bạn sẽ thấy ở Chủ đề → Gợi ý." : "Quản trị viên không gian làm việc sẽ thấy ở Chủ đề → Gợi ý."}</span>
    </div>
  ) : null;
  // Proposed new topics are decided in one place, Knowledge Studio → Topics → Suggestions; publishing never waits for them.
  const proposed = (s.proposedTopics ?? [])
    .map((ref) => p.topics.find((t) => t.state === "PROPOSED" && (t.name === ref || t.displayName === ref))?.displayName ?? (p.topics.some((t) => t.name === ref) ? "" : ref))
    .filter(Boolean);
  const proposedNote = proposed.length ? (
    <div className="cur-prop-note">
      <Sparkles className="i i-xs" aria-hidden />
      <div>
        <span>{proposed.length === 1 ? "Đề xuất chủ đề mới:" : "Đề xuất các chủ đề mới:"}</span>{" "}
        {proposed.map((name, i) => (
          <span key={name}>
            {i ? ", " : ""}
            <span className="medium" translate="no">
              {name}
            </span>
          </span>
        ))}
        <br />
        <span>Bạn có thể công bố mà không cần chủ đề này.</span>{" "}
        {p.canManageTopics ? (
          <NextLink className="link" href={topicsHref("suggestions")}>
            Quyết định ở Chủ đề → Gợi ý
          </NextLink>
        ) : (
          <span>Quản trị viên không gian làm việc sẽ quyết định.</span>
        )}
      </div>
    </div>
  ) : null;
  const topicsTag = changed ? <FieldTag edited /> : <FieldTag value={sugg.length ? s.topicsConfidence : null} suggested={sugg.length > 0} />;

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
      <Field
        label="Chủ đề"
        tag={topicsTag}
        help={
          teach || proposedNote ? (
            <>
              {teach}
              {proposedNote}
            </>
          ) : null
        }
      >
        <div className="cur-topics" role="group" aria-label="Chủ đề">
          {sugg.map((t) => (
            <TopicChip key={t} on={draft.topics.includes(t)} name={topicName.get(t) ?? "Chủ đề"} look={looks.get(t)} onPress={() => toggle(t)} />
          ))}
          {extra.map((t) => (
            <TopicChip key={t} on name={topicName.get(t) ?? "Chủ đề"} look={looks.get(t)} onPress={() => toggle(t)} />
          ))}
          {!sugg.length && !extra.length ? <span className="t-sm muted">Chưa gợi ý chủ đề</span> : null}
          {addGroups.length ? <AddTopic groups={addGroups} onAdd={(t) => !draft.topics.includes(t) && setDraft({ topics: [...draft.topics, t] })} /> : null}
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

/** A suggested or added topic (preview `tchip`): chosen, a neutral chip with the topic's icon in its domain's color
 *  and × to decline it; declined, dashed and muted with + to take it back. */
function TopicChip({ on, name, look, onPress }: { on: boolean; name: string; look?: TopicLook; onPress: () => void }) {
  const { style, Icon } = topicToneProps(look);
  return (
    <button type="button" className="cur-topic" aria-pressed={on} style={style} onClick={onPress} title={name}>
      {on ? <Icon className="i i-xs cur-topic__icon" aria-hidden /> : <Plus className="i i-xs" aria-hidden />}
      <span className="cur-topic__name" translate="no">
        {name}
      </span>
      {on ? <X className="i i-xs cur-topic__x" aria-hidden /> : null}
    </button>
  );
}

interface TopicGroup {
  name: string;
  displayName: string;
  topics: { name: string; displayName: string }[];
}

/** Add topic: a small ghost button at the end of the chips opening a searchable list of the topics not chosen yet,
 *  under their domains. Typing matches a topic or its domain (case and diacritics ignored); Enter or a click adds the
 *  topic and closes the list. */
function AddTopic({ groups, onAdd }: { groups: readonly TopicGroup[]; onAdd: (topic: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const fq = fold(q.trim());
  const shown = fq
    ? groups.map((g) => (fold(g.displayName).includes(fq) ? g : { ...g, topics: g.topics.filter((t) => fold(t.displayName).includes(fq)) })).filter((g) => g.topics.length)
    : groups;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQ("");
  };
  return (
    <Popover isOpen={open} onOpenChange={onOpenChange}>
      <Button variant="ghost" size="sm" className="cur-add-topic">
        <Plus className="i" aria-hidden />
        Thêm chủ đề
      </Button>
      <Popover.Content placement="bottom start" className="cur-topic-pick">
        <Popover.Dialog aria-label="Thêm chủ đề" className="cur-topic-pick__dialog">
          <Autocomplete.Filter inputValue={q} onInputChange={setQ}>
            <SearchField aria-label="Tìm chủ đề" autoFocus fullWidth className="search-input search-input--sm search-input--full">
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Tìm chủ đề" autoComplete="off" />
                <SearchField.ClearButton aria-label="Xóa tìm kiếm" />
              </SearchField.Group>
            </SearchField>
            <ListBox
              aria-label="Chủ đề"
              className="cur-topic-pick__list"
              onAction={(key) => {
                onAdd(String(key));
                onOpenChange(false);
              }}
              renderEmptyState={() => <div className="cur-topic-pick__none">Không có kết quả</div>}
            >
              {shown.map((g) => (
                <ListBox.Section key={g.name} id={g.name}>
                  <Header translate="no">{g.displayName}</Header>
                  {g.topics.map((t) => (
                    <ListBox.Item key={t.name} id={t.name} textValue={t.displayName}>
                      <span className="truncate" translate="no">
                        {t.displayName}
                      </span>
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              ))}
            </ListBox>
          </Autocomplete.Filter>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
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
