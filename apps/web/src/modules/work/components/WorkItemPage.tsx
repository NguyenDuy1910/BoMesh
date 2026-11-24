"use client";

import { Button, Drawer, Dropdown, Input, Label, ProgressBar, Separator, Spinner, TextField } from "@heroui/react";
import { ChevronRight, CircleCheck, CircleDashed, Download, FileText, History, Lock, MoreHorizontal, Pencil, Search, Share2, Table, Trash2, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type Key, type MutableRefObject, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout, EmptyState, ErrorState, FileIcon, IconButton, List, ListItem, PageHeader, SkeletonRows, Tip, toast } from "@/components/ui";
import { ApiError, errorMessage, resourceId, type Schema } from "@/lib/api/client";
import { plural, relInline } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
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
  const msg = useMessages();
  const params = useSearchParams();
  const router = useRouter();
  const query = useWorkItem(id);
  const a = query.data;
  const space = useSpace(a?.space ? resourceId(a.space) : "").data ?? null;
  const fromSpace = params.get("from") === "space" && space;
  const crumbs = fromSpace
    ? [
        { label: space.displayName ?? "Cộng đồng", href: `/space/${resourceId(space.name)}` },
        { label: msg.nav.work, href: `/space/${resourceId(space.name)}?tab=work` },
      ]
    : [{ label: msg.nav.work, href: "/work" }];

  if (query.isPending)
    return (
      <WorkScroll>
        <div className="page work-page">
          <PageChrome crumbs={[{ label: msg.nav.work, href: "/work" }]} />
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
          <PageChrome crumbs={[{ label: msg.nav.work, href: "/work" }, { label: "Không khả dụng" }]} />
          {denied || missing ? (
            <EmptyState
              icon={denied ? Lock : Search}
              title={denied ? "Bạn không có quyền truy cập nội dung này" : "Công việc này không tồn tại"}
              description={denied ? "Nội dung này ở chế độ riêng tư hoặc chỉ nhóm giảng dạy của cộng đồng mới xem được. Hãy nhờ chủ sở hữu chia sẻ." : "Có thể đã bị xóa."}
              actions={
                <Button variant="primary" onPress={() => router.push("/work")}>
                  Quay lại Công việc
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
  else body = <EmptyState icon={meta.icon} title="Chưa thể hiển thị nội dung này ở đây" description={`${meta.label} cần phiên bản BoMesh mới hơn.`} boxed />;

  /* Drafts open their own citations rail; the rest list the documents in a drawer. */
  const openSources = () => {
    if (a.kind === "DRAFT" && !generating && !failed) setPanel(panel?.kind === "rail" && panel.tab === "sources" ? null : { kind: "rail", tab: "sources" });
    else setSourcesOpen(true);
  };

  return (
    <div className="split work-split">
      <div className="split__main">
        <WorkScroll>
          <div className={`trang ${layout}`}>
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
      toast("Hãy đặt tiêu đề.", { tone: "danger" });
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
  meta.push(<span key="upd">{`Đã cập nhật ${relInline(a.updateTime)}`}</span>);
  if (!isOwner) meta.push(<span key="by">{`Từ ${owners.get(a.owner ?? "") || "someone"}`}</span>);
  if (isOwner && a.space)
    meta.push(
      <span key="vis" className="work-meta__vis">
        {shared ? <Users className="i i-sm" aria-hidden /> : <Lock className="i i-sm" aria-hidden />}
        {shared ? "Đã chia sẻ với cộng đồng" : "Chỉ bạn"}
      </span>,
    );

  const heading = renaming ? (
    <div className="work-rename">
      <TextField aria-label="Tiêu đề" value={name} onChange={setName} autoFocus className="grow">
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
        Lưu
      </Button>
      <Button size="sm" variant="ghost" onPress={() => setRenaming(false)}>
        Hủy
      </Button>
    </div>
  ) : isOwner ? (
    <Tip content="Đổi tên">
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
      title={a.displayName ?? "Công việc"}
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
  if (onVersions) items.push({ id: "versions", label: "Lịch sử phiên bản", icon: History });
  if (canDownload) {
    items.push({ id: "dl:word", label: "Tải xuống dạng Word", icon: FileText }, { id: "dl:pdf", label: "Tải xuống dạng PDF", icon: Download });
    if (a.kind === "EVIDENCE_REVIEW") items.push({ id: "dl:csv", label: "Tải xuống dạng CSV", icon: Table });
  }
  if (canShare) items.push(a.audience === "SPACE" ? { id: "private", label: "Đặt riêng tư", icon: Lock } : { id: "share", label: `Chia sẻ vào ${space.displayName}`, icon: Share2 });
  if (!items.length && !isOwner) return null;
  const onAction = (key: Key) => {
    const k = String(key);
    if (k === "versions") onVersions?.();
    else if (k.startsWith("dl:")) void actions.download(k.slice(3) as DownloadFormat);
    else if (k === "share") void actions.setAudience("SPACE", `Đã chia sẻ vào ${space?.displayName ?? "cộng đồng"}`);
    else if (k === "private") void actions.setAudience("PRIVATE", "Giờ chỉ bạn mới thấy");
    else if (k === "delete") void actions.remove();
  };
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip="Thêm" showTip={false} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="Thêm" onAction={onAction}>
          {items.map((it) => (
            <Dropdown.Item key={it.id} id={it.id} textValue={it.label}>
              <it.icon className="i" aria-hidden />
              <Label>{it.label}</Label>
            </Dropdown.Item>
          ))}
          {isOwner && items.length ? <Separator /> : null}
          {isOwner ? (
            <Dropdown.Item id="delete" textValue="Xóa" variant="danger">
              <Trash2 className="i" aria-hidden />
              <Label>Xóa</Label>
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
  const steps = [`Đang đọc ${plural(n, "document")}`, `Đang soạn ${kindMeta(a.kind).noun}`, "Đang kiểm tra mọi nguồn"];
  const shown = (a.sourceItems ?? []).map((s) => docs.byName.get(s)).filter((d) => !!d);
  return (
    <div className="card card--lg work-gen" role="status" aria-live="polite">
      <div>
        <div className="t-heading">Đang xử lý</div>
        <div className="t-sm muted mt-4">Bạn có thể rời trang này. Tiến trình vẫn tiếp tục và kết quả sẽ có trong Công việc.</div>
      </div>
      <ProgressBar aria-label="Đang tạo" value={Math.max(8, Math.round(((step + 0.6) / steps.length) * 100))}>
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
        title="Không tạo được nội dung này"
        description={reason || "Trợ lý chưa hoàn tất. Chưa có gì được lưu. Hãy thử lại sau giây lát."}
      />
      {isOwner ? (
        <div className="row gap-8 wrap">
          <Button variant="primary" onPress={() => void retry()} isPending={busy}>
            Thử lại
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
            Bỏ
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
          { title: "Đã so sánh", ids: review.compared },
          { title: "Ngữ cảnh", ids: review.context },
        ]
      : [{ title: "", ids: a.sourceItems ?? [] }];
  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Đóng" />
          <Drawer.Header>
            <Drawer.Heading>Nguồn</Drawer.Heading>
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
                            title={<span translate="no">{d?.displayName ?? "Đã gỡ tài liệu"}</span>}
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
            {hidden ? <Callout className="mt-16" title={`${plural(hidden, "source")} bạn không mở được`} description="Chúng bị ẩn vì bạn không còn quyền đọc." /> : null}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
