"use client";

import { Button, Drawer, Dropdown, Input, Label, ProgressBar, Separator, Spinner, TextField } from "@heroui/react";
import { ChevronRight, CircleCheck, CircleDashed, Download, FileText, History, Lock, MoreHorizontal, Pencil, Search, Share2, Table, Trash2, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type Key, type MutableRefObject, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout, EmptyState, ErrorState, FileIcon, IconButton, List, ListItem, PageHeader, SkeletonRows, Tip, toast } from "@/components/ui";
import { ApiError, errorMessage, resourceId, type Schema } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useMemberNames } from "@/modules/knowledge/queries";
import { useSpace } from "@/modules/spaces";

import { useStartWork, useWorkActions, type DownloadFormat, type WorkActions } from "../actions";
import { isSpaceStaff, kindMeta } from "../kinds";
import { dropRecipe, loadRecipe, recipeOf, reviewSources, sourceLine, type Artifact } from "../model";
import { useDocs, useOperation, useWorkItem } from "../queries";
import { DraftActions, DraftView } from "./DraftView";
import { GuideActions, GuideView } from "./GuideView";
import { SpaceTag, WorkStatusChip, WorkTile } from "./parts";
import { QuizActions, QuizView } from "./QuizView";
import { EvidencePanel, ReviewActions, ReviewView } from "./ReviewView";

type Space = Schema<"Space">;

/** The one side panel a work page may have open (preview: one panel at a time). */
export type WorkPanel = { kind: "cell"; option: string; criterion: string } | { kind: "rail"; tab: "sources" | "versions" };

/** What every kind's view gets. */
export interface WorkViewProps {
  artifact: Artifact;
  /** Owner: only the owner edits, revises and shares (API rule). */
  canEdit: boolean;
  space: Space | null;
  actions: WorkActions;
  /** Saves pending edits before an action that depends on them (draft autosave). */
  flush: MutableRefObject<() => Promise<void>>;
  /** The open side panel: a review cell's evidence or the draft's citations/versions rail. */
  panel: WorkPanel | null;
  setPanel: (panel: WorkPanel | null) => void;
}

/** The page's own scroller (`/work/[id]` is a bare route): the hero, top-row peek and kept scroll follow it. */
function WorkScroll({ children }: { children: ReactNode }) {
  return (
    <div className="work-scroll" id="work-scroll" data-keep-scroll>
      {children}
    </div>
  );
}

/** `/work/[id]` — one piece of work (preview `P.workItem`). */
export function WorkItemPage({ id }: { id: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const query = useWorkItem(id);
  const a = query.data;
  const space = useSpace(a?.space ? resourceId(a.space) : "").data ?? null;
  const fromSpace = params.get("from") === "space" && space;
  const crumbs = fromSpace
    ? [
        { label: space.displayName ?? "Space", href: `/space/${resourceId(space.name)}` },
        { label: "Work", href: `/space/${resourceId(space.name)}?tab=work` },
      ]
    : [{ label: "Work", href: "/work" }];

  if (query.isPending)
    return (
      <WorkScroll>
        <div className="page work-page">
          <PageChrome crumbs={[{ label: "Work", href: "/work" }]} />
          <SkeletonRows rows={6} />
        </div>
      </WorkScroll>
    );
  if (query.isError || !a || a.state === "DELETED") {
    const denied = query.error instanceof ApiError && query.error.status === 403;
    const missing = !a || a.state === "DELETED" || (query.error instanceof ApiError && query.error.isNotFound);
    return (
      <WorkScroll>
        <div className="page page--narrow">
          <PageChrome crumbs={[{ label: "Work", href: "/work" }, { label: "Not available" }]} />
          {denied || missing ? (
            <EmptyState
              icon={denied ? Lock : Search}
              title={denied ? "You don’t have access to this" : "This work doesn’t exist"}
              description={denied ? "It’s private, or only the teaching team of its space can see it. Ask the owner to share it." : "It may have been deleted."}
              actions={
                <Button variant="primary" onPress={() => router.push("/work")}>
                  Back to Work
                </Button>
              }
            />
          ) : (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          )}
        </div>
      </WorkScroll>
    );
  }
  return <WorkItem key={a.name} artifact={a} space={space} crumbs={crumbs} />;
}

function WorkItem({ artifact: a, space, crumbs }: { artifact: Artifact; space: Space | null; crumbs: { label: string; href: string }[] }) {
  const { member } = useWorkspace();
  const actions = useWorkActions(a);
  const isOwner = !!a.owner && a.owner === member.name;
  const meta = kindMeta(a.kind);
  const flush = useRef<() => Promise<void>>(async () => undefined);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [panel, setPanel] = useState<WorkPanel | null>(null);
  /* First generation shows progress; a revision of existing work keeps its view (busy) like the preview. */
  const generating = a.state === "GENERATING" && !a.revision;
  const failed = a.state === "FAILED";
  const layout = meta.layout === "wide" ? "page--wide work-page--wide" : meta.layout === "doc" ? "page--wide work-page--doc" : "work-page";

  const view: WorkViewProps = { artifact: a, canEdit: isOwner, space, actions, flush, panel, setPanel };
  let kindActions: ReactNode = null;
  if (!generating && !failed) {
    if (a.kind === "EVIDENCE_REVIEW") kindActions = <ReviewActions {...view} />;
    else if (a.kind === "DRAFT") kindActions = <DraftActions {...view} />;
    else if (a.kind === "STUDY_GUIDE") kindActions = <GuideActions {...view} />;
    else if (a.kind === "QUIZ") kindActions = <QuizActions {...view} />;
  }
  let body: ReactNode;
  if (generating) body = <GeneratingState artifact={a} />;
  else if (failed) body = <FailedState artifact={a} isOwner={isOwner} actions={actions} />;
  else if (a.kind === "EVIDENCE_REVIEW") body = <ReviewView {...view} />;
  else if (a.kind === "DRAFT") body = <DraftView {...view} />;
  else if (a.kind === "STUDY_GUIDE") body = <GuideView {...view} />;
  else if (a.kind === "QUIZ") body = <QuizView {...view} />;
  else body = <EmptyState icon={meta.icon} title="This can’t be shown here yet" description={`${meta.label} needs a newer version of BoMesh.`} boxed />;

  /* Drafts open their own citations rail; the rest list the documents in a drawer. */
  const openSources = () => {
    if (a.kind === "DRAFT" && !generating && !failed) setPanel(panel?.kind === "rail" && panel.tab === "sources" ? null : { kind: "rail", tab: "sources" });
    else setSourcesOpen(true);
  };

  return (
    <div className="split work-split">
      <div className="split__main">
        <WorkScroll>
          <div className={`page ${layout}`}>
            <Header
              artifact={a}
              space={space}
              isOwner={isOwner}
              actions={actions}
              kindActions={kindActions}
              crumbs={crumbs}
              onSources={openSources}
              onVersions={a.kind === "DRAFT" && !generating && !failed ? () => setPanel({ kind: "rail", tab: "versions" }) : undefined}
            />
            {body}
          </div>
        </WorkScroll>
      </div>
      {/* The review's evidence sits beside the page, non-modal, so the work stays usable while it's open. */}
      {a.kind === "EVIDENCE_REVIEW" && panel?.kind === "cell" && !generating ? <EvidencePanel {...view} at={panel} /> : null}
      <SourcesDrawer artifact={a} isOpen={sourcesOpen} onClose={() => setSourcesOpen(false)} />
    </div>
  );
}

/* ═══════════════ Header ═══════════════ */

function Header({
  artifact: a,
  space,
  isOwner,
  actions,
  kindActions,
  crumbs,
  onSources,
  onVersions,
}: {
  artifact: Artifact;
  space: Space | null;
  isOwner: boolean;
  actions: WorkActions;
  kindActions: ReactNode;
  crumbs: { label: string; href: string }[];
  onSources: () => void;
  onVersions?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const owners = useMemberNames([a.owner]);
  const n = (a.sourceItems?.length ?? 0) + (a.hiddenSourceCount ?? 0);
  const busy = a.state === "GENERATING";
  const save = () => {
    const t = name.trim();
    if (!t) {
      toast("Give it a title.", { tone: "danger" });
      return;
    }
    setRenaming(false);
    if (t !== a.displayName) void actions.rename(t);
  };
  const shared = a.audience === "SPACE";

  const meta: ReactNode[] = [];
  if (space)
    meta.push(
      <Link key="sp" className="work-meta__space" href={`/space/${resourceId(space.name)}`}>
        <SpaceTag space={space} />
      </Link>,
    );
  if (n)
    meta.push(
      <button key="src" type="button" className="link-button work-meta__src" onClick={onSources}>
        {sourceLine(a)}
      </button>,
    );
  meta.push(<span key="upd">Updated {rel(a.updateTime)}</span>);
  if (!isOwner) meta.push(<span key="by">by {owners.get(a.owner ?? "") || "someone"}</span>);
  if (isOwner && a.space)
    meta.push(
      <span key="vis" className="work-meta__vis">
        {shared ? <Users className="i i-sm" aria-hidden /> : <Lock className="i i-sm" aria-hidden />}
        {shared ? "Shared with the space" : "Only you"}
      </span>,
    );

  const heading = renaming ? (
    <div className="work-rename">
      <TextField aria-label="Title" value={name} onChange={setName} autoFocus className="grow">
        <Input
          translate="no"
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setRenaming(false);
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      </TextField>
      <Button size="sm" variant="primary" onPress={save}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onPress={() => setRenaming(false)}>
        Cancel
      </Button>
    </div>
  ) : isOwner ? (
    <Tip content="Rename">
      <button
        type="button"
        className="work-title__btn"
        translate="no"
        onClick={() => {
          setName(a.displayName ?? "");
          setRenaming(true);
        }}
      >
        {a.displayName}
        <Pencil className="i work-title__pen" aria-hidden />
      </button>
    </Tip>
  ) : (
    <span translate="no">{a.displayName}</span>
  );

  return (
    <PageHeader
      title={a.displayName ?? "Work"}
      heading={heading}
      lead={<WorkTile kind={a.kind} />}
      chips={renaming ? null : <WorkStatusChip artifact={a} staffQuiz={isSpaceStaff(space)} />}
      meta={
        <div className="work-meta">
          {meta.map((m, i) => [
            i ? (
              <span key={`d${i}`} className="work-meta__dot" aria-hidden="true">
                ·
              </span>
            ) : null,
            m,
          ])}
        </div>
      }
      actions={
        kindActions || !busy ? (
          <>
            {kindActions}
            {busy ? null : <MoreMenu artifact={a} space={space} isOwner={isOwner} actions={actions} onVersions={onVersions} />}
          </>
        ) : null
      }
      crumbs={crumbs}
    />
  );
}

/** ⋯ (preview `moreItems`): the kind's own entries, downloads, sharing, then Delete. */
function MoreMenu({ artifact: a, space, isOwner, actions, onVersions }: { artifact: Artifact; space: Space | null; isOwner: boolean; actions: WorkActions; onVersions?: () => void }) {
  const failed = a.state === "FAILED";
  /* A staff quiz publishes through its own action; a draft is shared by sending it for review. */
  const ownFlow = (a.kind === "QUIZ" && isSpaceStaff(space)) || a.kind === "DRAFT";
  const canShare = isOwner && !failed && !!space && !ownFlow;
  const canDownload = !failed && a.kind !== "STUDY_GUIDE";
  const items: { id: string; label: string; icon: typeof Trash2 }[] = [];
  if (onVersions) items.push({ id: "versions", label: "Version history", icon: History });
  if (canDownload) {
    items.push({ id: "dl:word", label: "Download as Word", icon: FileText }, { id: "dl:pdf", label: "Download as PDF", icon: Download });
    if (a.kind === "EVIDENCE_REVIEW") items.push({ id: "dl:csv", label: "Download as CSV", icon: Table });
  }
  if (canShare) items.push(a.audience === "SPACE" ? { id: "private", label: "Make private", icon: Lock } : { id: "share", label: `Share to ${space.displayName}`, icon: Share2 });
  if (!items.length && !isOwner) return null;
  const onAction = (key: Key) => {
    const k = String(key);
    if (k === "versions") onVersions?.();
    else if (k.startsWith("dl:")) void actions.download(k.slice(3) as DownloadFormat);
    else if (k === "share") void actions.setAudience("SPACE", `Shared to ${space?.displayName ?? "the space"}`);
    else if (k === "private") void actions.setAudience("PRIVATE", "Now only you can see it");
    else if (k === "delete") void actions.remove();
  };
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip="More" showTip={false} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="More" onAction={onAction}>
          {items.map((it) => (
            <Dropdown.Item key={it.id} id={it.id} textValue={it.label}>
              <it.icon className="i" aria-hidden />
              <Label>{it.label}</Label>
            </Dropdown.Item>
          ))}
          {isOwner && items.length ? <Separator /> : null}
          {isOwner ? (
            <Dropdown.Item id="delete" textValue="Delete" variant="danger">
              <Trash2 className="i" aria-hidden />
              <Label>Delete</Label>
            </Dropdown.Item>
          ) : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/* ═══════════════ Generating / failed ═══════════════ */

function GeneratingState({ artifact: a }: { artifact: Artifact }) {
  const recipe = a.name ? loadRecipe(a.name) : null;
  const op = useOperation(recipe?.operation);
  const docs = useDocs(a.sourceItems ?? []);
  const pct = Number(op.data?.metadata?.progressPercent ?? 0) || 0;
  const step = pct >= 67 ? 2 : pct >= 34 ? 1 : 0;
  const n = (a.sourceItems?.length ?? 0) + (a.hiddenSourceCount ?? 0);
  const steps = [`Reading ${plural(n, "document")}`, `Drafting the ${kindMeta(a.kind).noun}`, "Checking every source"];
  const shown = (a.sourceItems ?? []).map((s) => docs.byName.get(s)).filter((d) => !!d);
  return (
    <div className="card card--lg work-gen" role="status" aria-live="polite">
      <div>
        <div className="t-heading">Working on it</div>
        <div className="t-sm muted mt-4">You can leave this page. It keeps going and lands in Work.</div>
      </div>
      <ProgressBar aria-label="Generating" value={Math.max(8, Math.round(((step + 0.6) / steps.length) * 100))}>
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      <ol className="work-gen__steps">
        {steps.map((s, i) => (
          <li key={s} className={`work-gen__step ${i < step ? "is-done" : i === step ? "is-current" : ""}`}>
            {i < step ? <CircleCheck className="i" aria-hidden /> : i === step ? <Spinner size="sm" /> : <CircleDashed className="i" aria-hidden />}
            <span>{s}</span>
          </li>
        ))}
      </ol>
      {shown.length ? (
        <div className="work-gen__docs">
          {shown.slice(0, 6).map((d) => (
            <span key={d.name} className="work-doc-pill">
              <FileIcon mime={d.document?.mimeType} name={d.document?.fileName} size="sm" />
              <span className="truncate" translate="no">
                {d.displayName}
              </span>
            </span>
          ))}
          {shown.length > 6 ? <span className="work-doc-pill">+{shown.length - 6}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Honest failure: the assistant couldn't generate it (the reason from the operation when known). */
function FailedState({ artifact: a, isOwner, actions }: { artifact: Artifact; isOwner: boolean; actions: WorkActions }) {
  const router = useRouter();
  const startWork = useStartWork();
  const recipe = a.name ? loadRecipe(a.name) : null;
  const op = useOperation(recipe?.operation);
  const [busy, setBusy] = useState(false);
  const reason = op.data?.error?.message;
  const retry = async () => {
    setBusy(true);
    try {
      const next = recipeOf(a);
      await startWork({ ...next, operation: undefined }, { replace: true });
      await actions.discard();
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="work-gen card card--lg" role="alert">
      <Callout
        tone="danger"
        icon={TriangleAlert}
        title={`This ${kindMeta(a.kind).noun} couldn’t be generated`}
        description={reason || "The assistant couldn’t finish it. Nothing was saved. Try again in a moment."}
      />
      {isOwner ? (
        <div className="row gap-8 wrap">
          <Button variant="primary" onPress={() => void retry()} isPending={busy}>
            Try again
          </Button>
          <Button
            variant="ghost"
            onPress={() => {
              void actions.discard().then(() => {
                if (a.name) dropRecipe(a.name);
                router.push("/work");
              });
            }}
          >
            Discard
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════ Sources drawer ═══════════════ */

/** Preview `DR['work-sources']`: the documents, grouped Compared · Context for a review; locked ones can't be opened. */
function SourcesDrawer({ artifact: a, isOpen, onClose }: { artifact: Artifact; isOpen: boolean; onClose: () => void }) {
  const docs = useDocs(isOpen ? (a.sourceItems ?? []) : []);
  const hidden = a.hiddenSourceCount ?? 0;
  const review = reviewSources(a);
  const groups =
    a.kind === "EVIDENCE_REVIEW"
      ? [
          { title: "Compared", ids: review.compared },
          { title: "Context", ids: review.context },
        ]
      : [{ title: "", ids: a.sourceItems ?? [] }];
  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <Drawer.Heading>Sources</Drawer.Heading>
            <p className="drawer__description">{sourceLine(a)}</p>
          </Drawer.Header>
          <Drawer.Body>
            {docs.isPending ? (
              <SkeletonRows rows={3} />
            ) : (
              groups
                .filter((g) => g.ids.length)
                .map((g) => (
                  <div key={g.title || "all"}>
                    {g.title ? <div className="t-label mt-16 mb-8">{g.title}</div> : null}
                    <List plain>
                      {g.ids.map((s) => {
                        const d = docs.byName.get(s);
                        return (
                          <ListItem
                            key={s}
                            lead={<FileIcon mime={d?.document?.mimeType} name={d?.document?.fileName} />}
                            title={<span translate="no">{d?.displayName ?? "Removed document"}</span>}
                            description={d?.ancestors?.[0]?.displayName}
                            actions={d ? <ChevronRight className="i muted" aria-hidden /> : <Lock className="i muted" aria-hidden />}
                            href={d ? `/doc/${resourceId(s)}` : undefined}
                          />
                        );
                      })}
                    </List>
                  </div>
                ))
            )}
            {hidden ? <Callout className="mt-16" title={`${plural(hidden, "source")} you can’t open`} description="They are hidden because you can no longer read them." /> : null}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
