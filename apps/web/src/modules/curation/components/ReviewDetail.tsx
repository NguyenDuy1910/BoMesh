"use client";

import { Button, Spinner, TextArea, TextField } from "@heroui/react";
import { ArrowLeft, Check, ChevronDown, ChevronUp, Clock, Download, ExternalLink, FileIcon as FileGlyph, GitCompare, History, Plus, Shield, Sparkles } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { Callout, EmptyState, FileIcon, IconButton, ItemIcon, SwitchRow, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { downloadItem, type Topic } from "@/modules/knowledge/api";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { RESOURCE_KINDS, topicTree } from "@/modules/knowledge/model";
import { useItem } from "@/modules/knowledge/queries";

import { acceptTopic, rejectTopic } from "../api";
import { hasFlag, lastEvent, type Flag } from "../model";
import { useInvalidateCuration } from "../queries";
import { FirstPageCanvas, useFirstPage } from "./FirstPage";
import { ConfBadge, LinkButton, PanelCard, PlainSelect, SourceName } from "./parts";
import type { Draft, SubView } from "./review-types";

const relLow = (at: string) => rel(at).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());

/** Revision number from a revision name (`…/revisions/3` → 3). */
export const versionOf = (revision: string | undefined) => {
  const n = Number(resourceId(revision));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export interface ReviewDetailProps {
  view: SubView;
  pos: number;
  total: number;
  draft: Draft | null;
  setDraft: (patch: Partial<Draft>) => void;
  topics: readonly Topic[];
  bases: readonly { name: string; displayName: string }[];
  baseNames: ReadonlyMap<string, string>;
  memberNames: ReadonlyMap<string, string>;
  canManageTaxonomy: boolean;
  onStep: (dir: 1 | -1) => void;
  onBack: () => void;
  onApprove: () => void;
  onChanges: () => void;
  onDecline: () => void;
  onCompare: (related: string) => void;
}

/** One submission (preview `detailPanel`): note, flags, first-page preview, assistant suggestions, sticky decision bar. */
export function ReviewDetail(p: ReviewDetailProps) {
  const { view: v, draft } = p;
  const c = v.sub.contribution;
  const last = lastEvent(c);
  const meta: ReactNode[] = [
    <span key="from">
      {v.via ? "Synced from" : "From"} <span className="medium">{v.via ? <SourceName source={c.source} /> : v.contributor}</span>
    </span>,
    <span key="at">
      {v.resubmitted ? "Resubmitted" : "Submitted"} {relLow(last.at)}
    </span>,
    v.base ? (
      <span key="to">
        to{" "}
        <NextLink className="link" href={`/knowledge/${resourceId(v.base)}`} translate="no">
          {v.baseName}
        </NextLink>
      </span>
    ) : null,
  ].filter(Boolean);

  return (
    <section className="cur-detail" id="cur-detail" aria-label={v.title}>
      <div className="cur-detail__head">
        <IconButton icon={ArrowLeft} tip="Back to the queue" onPress={p.onBack} className="cur-back" />
        <FileIcon name={v.fileName} mime={v.mime} size="lg" />
        <div className="grow">
          <h2 className="cur-detail__title" translate="no">
            {v.title}
          </h2>
          <div className="cur-detail__meta">
            {meta.map((m, i) => (
              <span key={i} className="row gap-6">
                {i ? <span aria-hidden="true"> · </span> : null}
                {m}
              </span>
            ))}
            {v.analyzing ? <LifecycleChip lifecycle="analyzing" size="sm" /> : null}
          </div>
        </div>
        <div className="cur-detail__nav">
          <span className="t-xs muted num">
            {p.pos + 1} of {p.total}
          </span>
          <IconButton icon={ChevronUp} tip="Previous (K)" size="sm" onPress={() => p.onStep(-1)} isDisabled={p.pos <= 0} />
          <IconButton icon={ChevronDown} tip="Next (J)" size="sm" onPress={() => p.onStep(1)} isDisabled={p.pos >= p.total - 1} />
        </div>
      </div>
      <Note view={v} memberNames={p.memberNames} />
      <Flags view={v} onCompare={p.onCompare} />
      <PreviewCard view={v} />
      <Suggestions {...p} />
      <DecisionBar view={v} draft={draft} baseNames={p.baseNames} onApprove={p.onApprove} onChanges={p.onChanges} onDecline={p.onDecline} />
    </section>
  );
}

/* ── Note to reviewers ── */

function Note({ view: v, memberNames }: { view: SubView; memberNames: ReadonlyMap<string, string> }) {
  const c = v.sub.contribution;
  const last = lastEvent(c);
  const note = last.kind === "RESUBMITTED" && last.message ? last.message : c.note;
  const asked = [...(c.events ?? [])].reverse().find((e) => e.kind === "CHANGES_REQUESTED");
  return (
    <>
      {note ? (
        <figure className="cur-note">
          <figcaption className="t-label">Note to reviewers</figcaption>
          <blockquote translate="no">{note}</blockquote>
        </figure>
      ) : null}
      {last.kind === "RESUBMITTED" && asked ? (
        <div className="cur-asked">
          <Clock className="i i-xs" aria-hidden />
          <span>
            Resubmitted after {memberNames.get(asked.actor ?? "") || "a reviewer"} asked: “<span translate="no">{asked.message}</span>”
          </span>
        </div>
      ) : null}
    </>
  );
}

/* ── Flags ── */

function Flags({ view: v, onCompare }: { view: SubView; onCompare: (related: string) => void }) {
  if (!v.flags.length) return null;
  return (
    <div className="cur-flags">
      {v.flags.map((f, i) => (
        <FlagBox key={`${f.type}-${i}`} flag={f} onCompare={onCompare} />
      ))}
    </div>
  );
}

function FlagBox({ flag, onCompare }: { flag: Flag; onCompare: (related: string) => void }) {
  const related = useItem(flag.type === "duplicate" || flag.type === "version" ? flag.related : null);
  const o = related.data;
  if (flag.type === "duplicate") {
    if (!flag.related || related.isError) return <Callout tone="warning" title="Possible duplicate" description="It looks like a document you can’t open. Check with a workspace admin." />;
    return (
      <div className="cur-flagbox">
        <Callout
          tone="warning"
          title="Possible duplicate"
          description={
            <>
              Looks like “<span translate="no">{o?.displayName ?? "…"}</span>”.
            </>
          }
          actions={
            <Button variant="secondary" size="sm" onPress={() => onCompare(flag.related!)}>
              <GitCompare className="i" aria-hidden />
              Compare
            </Button>
          }
        />
        <SwitchRow
          title={`Publish as a new version of “${o?.displayName ?? "…"}”`}
          description="Off: it’s published as a separate document. Turning a submission into a new version isn’t available yet."
          isSelected={false}
          isDisabled
          onChange={() => undefined}
        />
      </div>
    );
  }
  if (flag.type === "version") {
    if (!flag.related || !o) return null;
    const ver = versionOf(o?.document?.revision);
    return (
      <Callout
        tone="accent"
        icon={History}
        title={
          <>
            Replaces {ver ? `v${ver} of ` : ""}“<span translate="no">{o.displayName}</span>”
          </>
        }
        description="The current version stays published until you approve."
        actions={<LinkButton href={`/doc/${resourceId(flag.related)}`}>Open current</LinkButton>}
      />
    );
  }
  if (flag.type === "personal") return <Callout tone="warning" icon={Shield} title="May contain personal data" description="Names, grades or ID numbers shouldn’t be shared. Check before publishing." />;
  return <Callout tone="default" title="Can’t be searched" description="This file type can’t be searched; people could only download it." />;
}

/* ── Preview ── */

function PreviewCard({ view: v }: { view: SubView }) {
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
      <div className="cur-preview__canvas">
        <div className="cur-analyzing">
          <Spinner size="sm" />
          <span>Loading the first page…</span>
        </div>
      </div>
    );
  } else if (page.data && page.data.kind !== "none") {
    canvas = (
      <div className="cur-preview__canvas" tabIndex={0} aria-label="First page">
        <FirstPageCanvas page={page.data} />
      </div>
    );
  } else {
    canvas = <EmptyState icon={FileGlyph} compact title="No preview yet" />;
  }
  const pages = page.data?.kind === "page" ? page.data.pages : null;
  return (
    <PanelCard
      className="cur-preview"
      title="Preview"
      description={!fmt && pages ? `Page 1 of ${pages}` : undefined}
      actions={
        !fmt && item ? (
          <LinkButton href={`/doc/${resourceId(item.name)}`} icon={ExternalLink}>
            Open full preview
          </LinkButton>
        ) : null
      }
    >
      {canvas}
    </PanelCard>
  );
}

/* ── Assistant suggestions ── */

function SugRow({ label, badge, children }: { label: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <div className="cur-sug">
      <div className="cur-sug__label">
        <span className="t-label">{label}</span>
        {badge}
      </div>
      <div className="cur-sug__ctl">{children}</div>
    </div>
  );
}

function Suggestions(p: ReviewDetailProps) {
  const { settings } = useWorkspace();
  const { view: v, draft, setDraft } = p;
  const c = v.sub.contribution;
  const s = c.suggestions ?? {};
  if (!draft) {
    return (
      <PanelCard className="cur-sugs" title="Assistant suggestions">
        <div className="cur-analyzing">
          <Spinner size="sm" />
          <span>Reading the file and suggesting a type, topics and a knowledge base…</span>
        </div>
      </PanelCard>
    );
  }
  const topicName = new Map(p.topics.map((t) => [t.name ?? "", t.displayName ?? ""]));

  // Type
  const configured = settings?.documentTypes ?? [];
  const kinds: [string, string][] = configured.length
    ? configured.map((t) => [t.key ?? "", t.displayName ?? t.key ?? ""])
    : Object.entries(RESOURCE_KINDS).map(([key, k]) => [key, k.label]);
  if (!kinds.some(([k]) => k === draft.kind)) kinds.push([draft.kind, RESOURCE_KINDS[draft.kind]?.label ?? draft.kind]);
  const suggestedType = s.documentType && s.documentType !== "markdown" ? s.documentType : "";
  const typeBadge = <ConfBadge value={suggestedType ? s.documentTypeConfidence : null} edited={draft.kind !== draft.initial.kind} />;

  // Topics: suggestions toggle on/off; reviewers may add any existing topic.
  const sugg = s.topics ?? [];
  const extra = draft.topics.filter((t) => !sugg.includes(t));
  const toggle = (t: string) => setDraft({ topics: draft.topics.includes(t) ? draft.topics.filter((x) => x !== t) : [...draft.topics, t] });
  const tree = topicTree(p.topics);
  const addOpts = tree.flatMap((dm) => dm.children.filter((t) => !draft.topics.includes(t.name ?? "")).map((t) => [t.name ?? "", `${dm.displayName} · ${t.displayName}`] as const));

  // Knowledge base: where it lives decides who can see it.
  const version = c.kind === "NEW_REVISION";
  const aiBase = !c.targetCollection && !!s.collection;
  const baseOpts = p.bases.map((b) => [b.name, b.displayName] as const);
  if (draft.kb && !baseOpts.some(([k]) => k === draft.kb)) baseOpts.push([draft.kb, p.baseNames.get(draft.kb) || "Knowledge base"]);
  const kbBadge = version ? null : aiBase ? (
    <ConfBadge value={s.collectionConfidence} edited={draft.kb !== s.collection} />
  ) : draft.kb !== (c.targetCollection ?? "") ? (
    <ConfBadge edited />
  ) : c.targetCollection ? (
    <span className="t-xs muted">Chosen by the contributor</span>
  ) : null;
  const who = draft.kb === (c.targetCollection || s.collection) && c.audienceSummary ? c.audienceSummary : draft.kb ? `Readers of ${p.baseNames.get(draft.kb) ?? "this knowledge base"}` : "";

  return (
    <PanelCard className="cur-sugs" title="Assistant suggestions" description="Check and edit before you publish.">
      <div className="cur-sug-list">
        <SugRow label="Type" badge={typeBadge}>
          <PlainSelect label="Type" value={draft.kind} options={kinds} onChange={(kind) => setDraft({ kind })} />
        </SugRow>
        <SugRow label="Topics">
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
        <ProposedTopics {...p} />
        <SugRow label="Knowledge base" badge={kbBadge}>
          {version ? (
            <div className="cur-fixed">
              <span className="truncate" translate="no">
                {p.baseNames.get(draft.kb) || v.baseName}
              </span>
            </div>
          ) : (
            <PlainSelect label="Knowledge base" value={draft.kb} options={baseOpts} placeholder="Choose a knowledge base" onChange={(kb) => setDraft({ kb })} />
          )}
          {who ? (
            <div className="cur-who">
              <span>
                {version ? "Same as the current version · " : ""}
                {who} will see it
              </span>
            </div>
          ) : null}
        </SugRow>
        <SugRow label="Summary" badge={<ConfBadge value={s.summary ? s.summaryConfidence : null} edited={draft.summary.trim() !== (s.summary ?? "").trim() && !!(s.summary || draft.summary.trim())} />}>
          <TextField value={draft.summary} onChange={(summary) => setDraft({ summary })} maxLength={280} aria-label="Summary">
            <TextArea rows={3} />
          </TextField>
        </SugRow>
      </div>
    </PanelCard>
  );
}

function TopicChip({ on, name, onPress, badge }: { on: boolean; name: string; onPress: () => void; badge: ReactNode }) {
  const Icon = on ? Check : Plus;
  return (
    <button type="button" className="cur-topic" aria-pressed={on} onClick={onPress}>
      <Icon className="i i-xs" aria-hidden />
      <span>{name}</span>
      {badge}
    </button>
  );
}

/** Proposed new topics: only workspace admins change the taxonomy. */
function ProposedTopics(p: ReviewDetailProps) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const c = p.view.sub.contribution;
  const proposed = (c.suggestions?.proposedTopics ?? [])
    .map((ref) => p.topics.find((t) => t.state === "PROPOSED" && (t.name === ref || t.displayName === ref)) ?? (p.topics.some((t) => t.displayName === ref) ? null : { name: "", displayName: ref, state: "PROPOSED" as const }))
    .filter((t): t is Topic => !!t);
  if (!proposed.length) return null;
  const domainName = (t: Topic) => p.topics.find((d) => d.name === t.parentTopic)?.displayName;

  const accept = async (t: Topic) => {
    try {
      const done = await acceptTopic(ws, t.name ?? "", { parentTopic: t.parentTopic });
      if (p.draft && done.name && !p.draft.topics.includes(done.name)) p.setDraft({ topics: [...p.draft.topics, done.name] });
      invalidate();
      toast(`Added “${done.displayName ?? t.displayName}” to the topics`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };
  const dismiss = async (t: Topic) => {
    try {
      await rejectTopic(ws, t.name ?? "");
      invalidate();
      toast(`Dismissed “${t.displayName}”`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  return (
    <SugRow label="Proposed new topics">
      {proposed.map((t) => {
        const evidence = t.evidence?.length ?? 1;
        const dom = domainName(t);
        return (
          <div key={t.name || t.displayName} className="cur-prop">
            <ItemIcon icon={Sparkles} tone="accent" size="sm" />
            <div className="grow">
              <div className="medium">{t.displayName}</div>
              <div className="t-xs muted">
                {dom ? `In ${dom}` : "A new domain"} · suggested for {plural(evidence, "document")}
              </div>
            </div>
            {p.canManageTaxonomy && t.name ? (
              <div className="row gap-4 none">
                <Button variant="ghost" size="sm" onPress={() => void dismiss(t)}>
                  Dismiss
                </Button>
                <Button variant="secondary" size="sm" onPress={() => void accept(t)}>
                  <Check className="i" aria-hidden />
                  Accept topic
                </Button>
              </div>
            ) : (
              <span className="t-xs muted none cur-prop__wait">
                <Clock className="i i-xs" aria-hidden />
                Waiting for a workspace admin
              </span>
            )}
          </div>
        );
      })}
      {p.canManageTaxonomy ? null : <p className="t-xs muted mt-4">You can publish without it. It’s added once an admin accepts it.</p>}
    </SugRow>
  );
}

/* ── Decision bar ── */

function DecisionBar({
  view: v,
  draft,
  baseNames,
  onApprove,
  onChanges,
  onDecline,
}: {
  view: SubView;
  draft: Draft | null;
  baseNames: ReadonlyMap<string, string>;
  onApprove: () => void;
  onChanges: () => void;
  onDecline: () => void;
}) {
  const c = v.sub.contribution;
  const replaces = useItem(c.kind === "NEW_REVISION" ? c.replacesItem : null).data;
  const ver = versionOf(replaces?.document?.revision);
  const hint = !draft
    ? "Waiting for the assistant…"
    : replaces
      ? `Publishes ${ver ? `v${ver + 1} of ` : "a new version of "}“${replaces.displayName}”`
      : draft.kb
        ? `Publishes to ${baseNames.get(draft.kb) ?? ""}`
        : "Choose a knowledge base to publish to";
  return (
    <div className="cur-decide" role="group" aria-label="Decision">
      <span className="cur-decide__hint truncate">{hint}</span>
      <Button variant="secondary" onPress={onChanges}>
        Request changes
      </Button>
      <Button variant="secondary" onPress={onDecline}>
        Decline
      </Button>
      <Button variant="primary" onPress={onApprove} isDisabled={!draft || (!draft.kb && c.kind !== "NEW_REVISION")} isPending={!draft}>
        {draft ? <Check className="i" aria-hidden /> : null}
        {draft ? "Approve & publish" : "Analyzing…"}
      </Button>
    </div>
  );
}
