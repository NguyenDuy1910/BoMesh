"use client";

import { Button, Drawer, Dropdown, Input, Label, ProgressBar, Separator, Spinner, TextField } from "@heroui/react";
import { ChevronRight, CircleCheck, CircleDashed, Download, FileText, Lock, MoreHorizontal, Pencil, Search, Share2, Trash2, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type Key, type MutableRefObject, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout, EmptyState, ErrorState, FileIcon, IconButton, List, ListItem, Page, SkeletonRows, Tip, toast } from "@/components/ui";
import { ApiError, errorMessage, resourceId, type Schema } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useMemberNames } from "@/modules/knowledge/queries";
import { useSpace } from "@/modules/spaces";

import { useStartWork, useWorkActions, type DownloadFormat, type WorkActions } from "../actions";
import { isSpaceStaff, kindMeta } from "../kinds";
import { dropRecipe, loadRecipe, recipeOf, type Artifact } from "../model";
import { useDocs, useOperation, useWorkItem } from "../queries";
import { DraftActions, DraftView } from "./DraftView";
import { GuideActions, GuideView } from "./GuideView";
import { SpaceTag, WorkStatusChip, WorkTile } from "./parts";
import { QuizActions, QuizView } from "./QuizView";
import { ReviewActions, ReviewView } from "./ReviewView";

type Space = Schema<"Space">;

/** What every kind's view gets. */
export interface WorkViewProps {
  artifact: Artifact;
  /** Owner: only the owner edits, revises and shares (API rule). */
  canEdit: boolean;
  space: Space | null;
  actions: WorkActions;
  /** Saves pending edits before an action that depends on them (draft autosave). */
  flush: MutableRefObject<() => Promise<void>>;
}

/** `/work/[id]` — one piece of work (preview `P.workItem`). */
export function WorkItemPage({ id }: { id: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const query = useWorkItem(id);
  const a = query.data;
  const space = useSpace(a?.space ? resourceId(a.space) : "").data ?? null;
  const fromSpace = params.get("from") === "space" && space;
  const crumbs = (title: string) =>
    fromSpace
      ? [{ label: space.displayName, href: `/space/${resourceId(space.name)}` }, { label: "Work", href: `/space/${resourceId(space.name)}?tab=work` }, { label: title }]
      : [{ label: "Work", href: "/work" }, { label: title }];

  if (query.isPending)
    return (
      <Page>
        <PageChrome crumbs={[{ label: "Work", href: "/work" }]} />
        <SkeletonRows rows={6} />
      </Page>
    );
  if (query.isError || !a || a.state === "DELETED") {
    const denied = query.error instanceof ApiError && query.error.status === 403;
    const missing = !a || a.state === "DELETED" || (query.error instanceof ApiError && query.error.isNotFound);
    return (
      <Page narrow>
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
      </Page>
    );
  }
  return (
    <>
      <PageChrome crumbs={crumbs(a.displayName ?? "")} />
      <WorkItem artifact={a} space={space} />
    </>
  );
}

function WorkItem({ artifact: a, space }: { artifact: Artifact; space: Space | null }) {
  const { member } = useWorkspace();
  const actions = useWorkActions(a);
  const isOwner = !!a.owner && a.owner === member.name;
  const meta = kindMeta(a.kind);
  const flush = useRef<() => Promise<void>>(async () => undefined);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  /* First generation shows progress; a revision of existing work keeps its view (busy) like the preview. */
  const generating = a.state === "GENERATING" && !a.revision;
  const failed = a.state === "FAILED";
  const layout = meta.layout === "wide" ? "work-page--wide" : meta.layout === "doc" ? "work-page--doc" : "work-page";

  const view: WorkViewProps = { artifact: a, canEdit: isOwner, space, actions, flush };
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

  return (
    <div className={`page ${meta.layout === "narrow" ? "" : "page--wide"} ${layout}`}>
      <Header artifact={a} space={space} isOwner={isOwner} actions={actions} kindActions={kindActions} onSources={() => setSourcesOpen(true)} />
      {body}
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
  onSources,
}: {
  artifact: Artifact;
  space: Space | null;
  isOwner: boolean;
  actions: WorkActions;
  kindActions: ReactNode;
  onSources: () => void;
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
        {plural(n, "source")}
      </button>,
    );
  meta.push(<span key="upd">Updated {rel(a.updateTime)}</span>);
  if (!isOwner) meta.push(<span key="by">by {owners.get(a.owner ?? "") ?? "someone"}</span>);
  if (isOwner && a.space)
    meta.push(
      <span key="vis" className="work-meta__vis">
        {shared ? <Users className="i i-sm" aria-hidden /> : <Lock className="i i-sm" aria-hidden />}
        {shared ? "Shared with the space" : "Only you"}
      </span>,
    );

  return (
    <header className="page-header work-head">
      <div className="page-header__lead">
        <WorkTile kind={a.kind} />
      </div>
      <div className="page-header__body">
        <div className="page-header__title-row">
          {renaming ? (
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
            <h1 className="page-header__title work-title">
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
            </h1>
          ) : (
            <h1 className="page-header__title work-title" translate="no">
              {a.displayName}
            </h1>
          )}
          {renaming ? null : <WorkStatusChip artifact={a} staffQuiz={isSpaceStaff(space)} />}
        </div>
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
      </div>
      {kindActions || !busy ? (
        <div className="page-header__actions">
          {kindActions}
          {busy ? null : <MoreMenu artifact={a} space={space} isOwner={isOwner} actions={actions} />}
        </div>
      ) : null}
    </header>
  );
}

function MoreMenu({ artifact: a, space, isOwner, actions }: { artifact: Artifact; space: Space | null; isOwner: boolean; actions: WorkActions }) {
  const failed = a.state === "FAILED";
  const kindPublishes = a.kind === "QUIZ" && isSpaceStaff(space);
  const canShare = isOwner && !failed && !!space && !kindPublishes;
  const canDownload = !failed && a.kind !== "STUDY_GUIDE";
  const items: { id: string; label: string; icon: typeof Trash2; danger?: boolean }[] = [];
  if (canDownload)
    items.push(
      { id: "dl:word", label: "Download as Word", icon: FileText },
      { id: "dl:pdf", label: "Download as PDF", icon: Download },
    );
  if (canShare) items.push(a.audience === "SPACE" ? { id: "private", label: "Make private", icon: Lock } : { id: "share", label: `Share to ${space.displayName}`, icon: Share2 });
  if (!items.length && !isOwner) return null;
  const onAction = (key: Key) => {
    const k = String(key);
    if (k.startsWith("dl:")) void actions.download(k.slice(3) as DownloadFormat);
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

function SourcesDrawer({ artifact: a, isOpen, onClose }: { artifact: Artifact; isOpen: boolean; onClose: () => void }) {
  const docs = useDocs(isOpen ? (a.sourceItems ?? []) : []);
  const hidden = a.hiddenSourceCount ?? 0;
  const n = (a.sourceItems?.length ?? 0) + hidden;
  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <Drawer.Heading>Sources</Drawer.Heading>
            <p className="drawer__description">
              {kindMeta(a.kind).label} built from {plural(n, "document")}.
            </p>
          </Drawer.Header>
          <Drawer.Body>
            {docs.isPending ? (
              <SkeletonRows rows={3} />
            ) : (
              <List plain>
                {(a.sourceItems ?? []).map((s) => {
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
            )}
            {hidden ? <Callout className="mt-16" title={`${plural(hidden, "source")} you can’t open`} description="They are hidden because you can no longer read them." /> : null}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
