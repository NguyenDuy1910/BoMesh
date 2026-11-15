"use client";

import { Button, Checkbox, Spinner, TextArea, TextField } from "@heroui/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File as FileGlyph,
  History,
  Pencil,
  Plus,
  Shield,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { EmptyState, FileIcon, IconButton, LinkButton as TextLink, Tip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { downloadItem, type Topic } from "@/modules/knowledge/api";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { RESOURCE_KINDS, topicTree } from "@/modules/knowledge/model";
import { useItem } from "@/modules/knowledge/queries";

import { isUnprocessable } from "../../lifecycle";
import { hasFlag, lastEvent, topicsHref, versionOf, type Flag } from "../../model";
import { useCollectionAudience } from "../../queries";
import { FirstPageCanvas, useFirstPage } from "../FirstPage";
import { ConfBadge, PlainSelect, SourceName } from "../parts";
import type { Draft, SubView } from "./types";

const relLow = (at: string) => rel(at).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());

/** The document itself, in its own pane (preview `docPane`): the first page at reading size, scrolling on its own. */
export function DocPane({ view: v }: { view: SubView }) {
  const { id: ws } = useWorkspace();
  const item = v.sub.item;
  const fmt = hasFlag(v.sub.contribution, "format");
  const page = useFirstPage(fmt ? null : item);
  const download = () => item?.name && downloadItem(ws, item.name, v.fileName).catch((e: unknown) => toast(errorMessage(e), { tone: "danger" }));
  let canvas: ReactNode;
  if (fmt || !item) {
    canvas = (
      <EmptyState
        icon={FileGlyph}
        compact
        title="No preview for this file type"
        description="Download it to check the content."
        actions={
          item ? (
            <Button size="sm" variant="secondary" onPress={() => void download()}>
              <Download className="i" aria-hidden />
              Download
            </Button>
          ) : null
        }
      />
    );
  } else if (page.isPending) {
    canvas = (
      <div className="cur-analyzing">
        <Spinner size="sm" />
        <span>Loading the first page…</span>
      </div>
    );
  } else if (page.data && page.data.kind !== "none") {
    canvas = <FirstPageCanvas page={page.data} />;
  } else {
    canvas = <EmptyState icon={FileGlyph} compact title="No preview yet" />;
  }
  const pages = page.data?.kind === "page" ? page.data.pages : 1;
  return (
    <section className="cur-pane" aria-label="Preview">
      <header className="cur-pane__bar">
        <FileIcon name={v.fileName} mime={v.mime} size="sm" />
        <span className="cur-pane__title truncate" title={v.title} translate="no">
          {v.title}
        </span>
        {!fmt && item ? (
          <>
            <span className="cur-pane__meta num">{`Page 1 of ${pages}`}</span>
            <TextLink href={`/doc/${resourceId(item.name)}`} icon={ExternalLink}>
              Open full preview
            </TextLink>
          </>
        ) : null}
      </header>
      <div className="cur-pane__scroll" tabIndex={0}>
        {canvas}
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
 * The workbench's right side (preview `detailPanel`): who sent it, where to and when · J/K; the note to reviewers
 * and what the assistant found as compact rows; the Classification; and the decision footer pinned at its bottom.
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
        <IconButton icon={ArrowLeft} tip="Back to the queue" onPress={p.onBack} className="cur-back" />
        <div className="grow">
          <h2 className="cur-detail__title" translate="no">
            {v.title}
          </h2>
          <div className="cur-detail__meta">
            <span>
              {v.via ? "Synced from" : "From"} <span className="medium">{v.via ? <SourceName source={c.source} /> : v.contributor}</span>
            </span>
            <span aria-hidden="true"> · </span>
            <span>
              {v.resubmitted ? "Resubmitted" : "Submitted"} {relLow(last.at)}
            </span>
            {v.base ? (
              <>
                <span aria-hidden="true"> · </span>
                <span>
                  to{" "}
                  <NextLink className="link" href={`/studio/collections/${resourceId(v.base)}`} translate="no">
                    {v.baseName || "its collection"}
                  </NextLink>
                </span>
              </>
            ) : null}
            {v.analyzing ? <LifecycleChip lifecycle="analyzing" size="sm" /> : null}
          </div>
        </div>
        {item?.name ? <IconButton icon={Eye} tip="Open full preview" size="sm" className="cur-peek" onPress={() => router.push(`/doc/${resourceId(item.name)}`)} /> : null}
        <div className="cur-detail__nav">
          <span className="t-xs muted num">
            {p.pos + 1} of {p.total}
          </span>
          <IconButton icon={ChevronUp} tip="Previous (K)" size="sm" onPress={() => p.onStep(-1)} isDisabled={p.pos <= 0} />
          <IconButton icon={ChevronDown} tip="Next (J)" size="sm" onPress={() => p.onStep(1)} isDisabled={p.pos >= p.total - 1} />
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

/* ── Note to reviewers and what the assistant found ── */

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
        <figure className="cur-note">
          <figcaption className="t-label">Note to reviewers</figcaption>
          <blockquote translate="no">{note}</blockquote>
        </figure>
      ) : null}
      {last.kind === "RESUBMITTED" && asked ? (
        <div className="cur-asked">
          <Pencil className="i i-xs" aria-hidden />
          <span>
            Resubmitted after {memberNames.get(asked.actor ?? "") || "a reviewer"} asked: “<span translate="no">{asked.message}</span>”
          </span>
        </div>
      ) : null}
      {flags.length ? (
        <ul className="cur-risks" aria-label="What the assistant found">
          {flags.map((f) => (
            <RiskRow key={f.type} flag={f} onCompare={onCompare} />
          ))}
        </ul>
      ) : null}
    </section>
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
    if (!flag.related || related.isError) return <Risk tone="warning" icon={Copy} title="Possible duplicate" text="It looks like a document you can’t open. Check with a workspace admin." />;
    return (
      <Risk
        tone="warning"
        icon={Copy}
        title="Possible duplicate"
        text={
          <>
            Looks like “<span translate="no">{o?.displayName ?? "…"}</span>”.
          </>
        }
        action={<TextLink onPress={() => onCompare(flag.related!)}>Compare</TextLink>}
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
            Replaces {ver ? `v${ver} of ` : ""}“<span translate="no">{o.displayName}</span>”
          </>
        }
        text="The current version stays published until you approve."
        action={<TextLink href={`/doc/${resourceId(flag.related)}`}>Open current</TextLink>}
      />
    );
  }
  if (flag.type === "personal") return <Risk tone="danger" icon={Shield} title="May contain personal data" text="Names, grades or ID numbers shouldn’t be shared. Check before publishing." />;
  return <Risk tone="default" icon={FileGlyph} title="Can’t be searched" text="This file type can’t be searched; people could only download it." />;
}

/* ── Classification ── */

function SugRow({ label, badge, children, foot }: { label: string; badge?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="cur-sug">
      <div className="cur-sug__label">
        <span className="t-label">{label}</span>
        {badge}
      </div>
      <div className="cur-sug__ctl">
        {children}
        {foot}
      </div>
    </div>
  );
}

const byContributor = <span className="t-xs muted">Chosen by the contributor</span>;

function Classification(p: InspectorProps) {
  const { settings } = useWorkspace();
  const { view: v, draft, setDraft } = p;
  const c = v.sub.contribution;
  const s = c.suggestions ?? {};
  const version = c.kind === "NEW_REVISION";
  const audience = useCollectionAudience(draft?.kb || v.base);
  const section = (body: ReactNode) => (
    <section className="cur-insp__sec cur-sugs" aria-labelledby="cur-cls-h">
      <h3 className="cur-insp__h" id="cur-cls-h">
        Classification
      </h3>
      {body}
    </section>
  );
  if (!draft) {
    return section(
      <div className="cur-analyzing">
        <Spinner size="sm" />
        <span>Reading the file and matching it against your topics…</span>
      </div>,
    );
  }
  const topicName = new Map(p.topics.map((t) => [t.name ?? "", t.displayName ?? ""]));

  // Type: the workspace's configured types, else the platform registry.
  const configured = settings?.documentTypes ?? [];
  const kinds: [string, string][] = configured.length ? configured.map((t) => [t.key ?? "", t.displayName ?? t.key ?? ""]) : Object.entries(RESOURCE_KINDS).map(([key, k]) => [key, k.label]);
  if (!kinds.some(([k]) => k === draft.kind)) kinds.push([draft.kind, RESOURCE_KINDS[draft.kind]?.label ?? draft.kind]);
  const suggestedType = s.documentType && s.documentType !== "markdown" ? s.documentType : "";
  const typeBadge = <ConfBadge value={suggestedType ? s.documentTypeConfidence : null} edited={draft.kind !== draft.initial.kind} />;

  // Topics: suggestions toggle on/off; reviewers may add any existing topic.
  const sugg = s.topics ?? [];
  const extra = draft.topics.filter((t) => !sugg.includes(t));
  const toggle = (t: string) => setDraft({ topics: draft.topics.includes(t) ? draft.topics.filter((x) => x !== t) : [...draft.topics, t] });
  const addOpts = topicTree(p.topics).flatMap((dm) => dm.children.filter((t) => !draft.topics.includes(t.name ?? "")).map((t) => [t.name ?? "", `${dm.displayName} · ${t.displayName}`] as const));
  // A changed topic teaches classification: approval records it as a correction; a workspace admin turns corrections into keywords.
  const changed = draft.topics.length !== sugg.length || draft.topics.some((t) => !sugg.includes(t));
  const teach = changed ? (
    <div className="cur-teach">
      <Checkbox isSelected={draft.teach} onChange={(teach) => setDraft({ teach })}>
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <span className="checkbox__label">Use my change to improve classification</span>
        </Checkbox.Content>
      </Checkbox>
      <span className="cur-teach__hint">{p.canManageTopics ? "You’ll find it in Topics → Suggestions." : "Workspace admins see it in Topics → Suggestions."}</span>
    </div>
  ) : null;

  // Proposed new topics are decided in one place, Knowledge Studio → Topics → Suggestions; publishing never waits for them.
  const proposed = (s.proposedTopics ?? [])
    .map((ref) => p.topics.find((t) => t.state === "PROPOSED" && (t.name === ref || t.displayName === ref))?.displayName ?? (p.topics.some((t) => t.name === ref) ? "" : ref))
    .filter(Boolean);

  // Collection: where it lives decides who can see it.
  const aiBase = !c.targetCollection && !!s.collection;
  const baseOpts = p.bases.map((b) => [b.name, b.displayName] as const);
  if (draft.kb && !baseOpts.some(([k]) => k === draft.kb)) baseOpts.push([draft.kb, p.baseNames.get(draft.kb) || "Collection"]);
  const kbBadge = version ? null : aiBase ? <ConfBadge value={s.collectionConfidence} edited={draft.kb !== s.collection} /> : draft.kb !== (c.targetCollection ?? "") ? <ConfBadge edited /> : c.targetCollection ? byContributor : null;

  return section(
    <div className="cur-sug-list">
      <SugRow label="Type" badge={typeBadge}>
        <PlainSelect label="Type" value={draft.kind} options={kinds} onChange={(kind) => setDraft({ kind })} />
      </SugRow>
      <SugRow label="Topics" foot={teach}>
        <div className="cur-topics">
          {sugg.map((t) => (
            <TopicChip key={t} on={draft.topics.includes(t)} name={topicName.get(t) ?? "Topic"} onPress={() => toggle(t)} badge={<ConfBadge value={s.topicsConfidence} />} />
          ))}
          {extra.map((t) => (
            <TopicChip key={t} on name={topicName.get(t) ?? "Topic"} onPress={() => toggle(t)} badge={<span className="cur-conf cur-conf--edited">Added</span>} />
          ))}
          {!sugg.length && !extra.length ? <span className="t-sm muted">No topic suggested</span> : null}
          {addOpts.length ? (
            <PlainSelect
              label="Add topic"
              value=""
              placeholder="Add topic…"
              className="cur-add-topic"
              options={addOpts}
              onChange={(t) => t && !draft.topics.includes(t) && setDraft({ topics: [...draft.topics, t] })}
            />
          ) : null}
        </div>
      </SugRow>
      {proposed.length ? (
        <div className="cur-prop-note">
          <Sparkles className="i i-xs" aria-hidden />
          <div>
            <span>{proposed.length === 1 ? "Suggests a new topic:" : "Suggests new topics:"}</span>{" "}
            {proposed.map((name, i) => (
              <span key={name}>
                {i ? ", " : ""}
                <span className="medium" translate="no">
                  {name}
                </span>
              </span>
            ))}
            <br />
            <span>You can publish without it.</span>{" "}
            {p.canManageTopics ? (
              <NextLink className="link" href={topicsHref("suggestions")}>
                Decide in Topics → Suggestions
              </NextLink>
            ) : (
              <span>A workspace admin decides.</span>
            )}
          </div>
        </div>
      ) : null}
      <SugRow
        label="Collection"
        badge={kbBadge}
        foot={
          audience ? (
            <div className="cur-who">
              <audience.icon className="i i-xs" aria-hidden />
              <span>{`${version ? "Same as the current version · " : ""}${audience.label} will see it`}</span>
            </div>
          ) : null
        }
      >
        {version ? (
          <div className="cur-fixed">
            <span className="truncate" translate="no">
              {p.baseNames.get(draft.kb) || v.baseName}
            </span>
          </div>
        ) : (
          <PlainSelect label="Collection" value={draft.kb} options={baseOpts} placeholder="Choose a collection" onChange={(kb) => setDraft({ kb })} />
        )}
      </SugRow>
      <SugRow label="Summary" badge={<ConfBadge value={s.summary ? s.summaryConfidence : null} edited={draft.summary.trim() !== (s.summary ?? "").trim() && !!(s.summary || draft.summary.trim())} />}>
        <TextField value={draft.summary} onChange={(summary) => setDraft({ summary })} maxLength={280} aria-label="Summary">
          <TextArea rows={3} />
        </TextField>
      </SugRow>
    </div>,
  );
}

function TopicChip({ on, name, onPress, badge }: { on: boolean; name: string; onPress: () => void; badge: ReactNode }) {
  const Icon = on ? Check : Plus;
  return (
    <button type="button" className="cur-topic" aria-pressed={on} onClick={onPress}>
      <Icon className="i i-xs" aria-hidden />
      <span translate="no">{name}</span>
      {badge}
    </button>
  );
}

/* ── Decision footer ── */

/** Preview `cur-decide`: where it publishes, Process it now (default on; never for images and archives), the decisions. */
function DecisionBar({ view: v, draft, setDraft, baseNames, onApprove, onChanges, onDecline }: InspectorProps) {
  const c = v.sub.contribution;
  const replaces = useItem(c.kind === "NEW_REVISION" ? c.replacesItem : null).data;
  const audience = useCollectionAudience(draft?.kb);
  const ver = versionOf(replaces?.document?.revision);
  const hint = !draft
    ? "Waiting for the assistant…"
    : replaces
      ? `Publishes ${ver ? `v${ver + 1} of ` : "a new version of "}“${replaces.displayName}”`
      : draft.kb
        ? `Publishes to ${baseNames.get(draft.kb) ?? ""}${audience ? ` · ${audience.label}` : ""}`
        : "Choose a collection to publish to";
  return (
    <footer className="cur-decide" role="group" aria-label="Decision">
      <span className="cur-decide__hint truncate" title={hint}>
        {hint}
      </span>
      {draft && !isUnprocessable(v.fileName, v.mime) ? (
        <Tip content="Read, classify and index it so search and the assistant can use it.">
          <span className="cur-decide__proc">
            <Checkbox isSelected={draft.process} onChange={(process) => setDraft({ process })}>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span className="checkbox__label">Process it now</span>
              </Checkbox.Content>
            </Checkbox>
          </span>
        </Tip>
      ) : null}
      <div className="cur-decide__btns">
        <Button variant="ghost" onPress={onDecline}>
          Decline
        </Button>
        <Button variant="secondary" onPress={onChanges}>
          <Pencil className="i" aria-hidden />
          Request changes
        </Button>
        <Button variant="primary" onPress={onApprove} isDisabled={!draft || (!draft.kb && c.kind !== "NEW_REVISION")} isPending={!draft}>
          {draft ? <Check className="i" aria-hidden /> : null}
          {draft ? "Approve & publish" : "Analyzing…"}
        </Button>
      </div>
    </footer>
  );
}
