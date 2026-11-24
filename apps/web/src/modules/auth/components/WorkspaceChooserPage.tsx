"use client";

import { Button, Chip, SearchField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building, ChevronRight, Layers, LogOut, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { welcomesOnArrival } from "@/components/shell/tour";
import { EmptyState, ErrorState, List, ListItem, NoMatches, SkeletonRows, StatusChip, toast, WorkspaceMark } from "@/components/ui";
import { api, call, errorMessage, resourceId, type Schema } from "@/lib/api/client";
import { plural, relInline } from "@/lib/format";
import { isPlatformOperator, useSession, useSessionExpired } from "@/lib/session";
import { joinWorkspace, listMyWorkspaces, listPublicWorkspaces, workspaceQueryKey } from "@/lib/workspace";
import { openWorkspace, roleDisplayName, signOut, TEMPLATE_LABEL, workspacesOpened } from "@/modules/auth/api";
import { AuthLayout } from "@/modules/auth/components/AuthLayout";
import { signInHref } from "@/modules/auth/next";

/** Search appears once the list is long enough to need it (preview `TOOLS_MIN`). */
const TOOLS_MIN = 7;

interface Choice {
  id: string;
  workspace: Schema<"Workspace">;
  role: string;
  opened: number;
}

async function loadChoices(): Promise<Choice[]> {
  const workspaces = await listMyWorkspaces();
  const opened = workspacesOpened();
  const choices = await Promise.all(
    workspaces.map(async (workspace) => {
      const id = resourceId(workspace.name) ?? "";
      const member = await call(
        api.GET("/api/v1/workspaces/{workspace}/members/{member}", { params: { path: { workspace: id, member: "me" } } }),
      ).catch(() => null);
      return { id, workspace, role: await roleDisplayName(id, member?.roles), opened: opened[id] ?? 0 };
    }),
  );
  return choices.sort((a, b) => b.opened - a.opened || a.workspace.displayName.localeCompare(b.workspace.displayName));
}

export function WorkspaceChooserPage() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const session = useSession();
  const expired = useSessionExpired();
  const [signedOutChecked, setSignedOutChecked] = useState(false);
  const [q, setQ] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // useSession is null during server render; check after mount before redirecting. An expired session has
  // nothing to keep on this page: Sign in explains and comes back here.
  useEffect(() => setSignedOutChecked(true), []);
  useEffect(() => {
    if (!signedOutChecked) return;
    if (expired) router.replace(signInHref(`${window.location.pathname}${window.location.search}`, "expired"));
    else if (!session) router.replace("/signin");
  }, [signedOutChecked, session, expired, router]);

  const query = useQuery({
    queryKey: ["my-workspaces", session?.user.name],
    queryFn: loadChoices,
    enabled: !!session && !expired,
  });
  const publicQuery = useQuery({
    queryKey: ["public-workspaces", session?.user.name],
    queryFn: () => listPublicWorkspaces(),
    enabled: !!session && !expired,
  });

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = query.data ?? [];
    if (!term) return all;
    return all.filter((c) =>
      [c.workspace.displayName, c.workspace.code, c.role, c.workspace.template ? TEMPLATE_LABEL[c.workspace.template] : ""]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [query.data, q]);

  if (!session) return null;

  const all = query.data ?? [];
  const fresh = query.isSuccess && all.length === 0;
  // Public workspaces the account isn't in yet (preview `publicWorkspacesToJoin`).
  const mine = new Set(all.map((c) => c.id));
  const toJoin = query.isSuccess ? (publicQuery.data ?? []).filter((w) => !mine.has(resourceId(w.name))) : [];

  async function open(id: string) {
    if (opening) return;
    setOpening(id);
    router.replace(await openWorkspace(id, next));
  }

  /** Join a public workspace as a member and go straight in (preview `au-ws-join`). */
  async function join(workspace: Schema<"Workspace">) {
    const id = resourceId(workspace.name);
    if (joining || opening) return;
    setJoining(id);
    try {
      await joinWorkspace(id);
    } catch (error) {
      setJoining(null);
      toast(errorMessage(error), { tone: "danger" });
      return;
    }
    queryClient.removeQueries({ queryKey: workspaceQueryKey });
    const path = await openWorkspace(id, next);
    router.replace(path);
    // A new member landing on Home gets its welcome card, which confirms the join in place of the toast.
    if (!welcomesOnArrival(id, path)) toast(`Bạn đã tham gia ${workspace.displayName}`);
  }

  async function checkAgain() {
    const result = await query.refetch();
    const found = result.data ?? [];
    if (found.length) toast(`Bạn đã được thêm vào ${found[0].workspace.displayName}`, { tone: "success" });
    else toast("Chưa có. Chưa không gian làm việc nào thêm hoặc mời bạn.", { tone: "accent" });
  }

  async function leave() {
    await signOut();
    router.replace("/signin");
    toast("Đã đăng xuất", { tone: "accent" });
  }

  // The template only helps tell workspaces apart when they differ.
  const mixed = new Set(all.map((c) => c.workspace.template ?? "ENTERPRISE")).size > 1;

  /** Public workspaces the account isn't in. With no workspace yet, joining is what the page is for: the group leads the
   *  page as "Join a workspace" (preview `publicGroup`). */
  const publicGroup = toJoin.length ? (
    <div className={fresh ? "au-group au-group--lead" : "au-group"}>
      <div className="t-label au-group__label">{fresh ? "Tham gia không gian làm việc" : "Không gian làm việc công khai"}</div>
      <List>
        {toJoin.map((w) => (
          <ListItem
            key={w.name}
            lead={<WorkspaceMark name={w.displayName} logo={w.logoUri} size={36} />}
            title={w.displayName}
            contentTitle
            description={plural(w.memberCount ?? 0, "member")}
            actions={
              <Button variant="secondary" size="sm" isPending={joining === resourceId(w.name)} isDisabled={Boolean(joining)} onPress={() => void join(w)}>
                Tham gia
              </Button>
            }
          />
        ))}
      </List>
      <p className="t-xs muted au-group__note">Bất kỳ ai có tài khoản BoMesh đều có thể tham gia các không gian làm việc này và trở thành thành viên.</p>
    </div>
  ) : null;

  let body: React.ReactNode;
  // A new account's page depends on both lists: wait for the public one before choosing between Join and the empty state.
  if (query.isPending || (fresh && publicQuery.isPending)) body = <SkeletonRows rows={3} />;
  else if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (fresh && publicGroup) {
    // Joining leads; waiting for an admin is a quiet line under it (preview `noWorkspace`).
    body = (
      <>
        {publicGroup}
        <div className="au-wait">
          <span>Đang chờ quản trị viên thêm bạn?</span>
          <Button variant="ghost" size="sm" isPending={query.isFetching} onPress={() => void checkAgain()}>
            <RefreshCw className="i" aria-hidden />
            Kiểm tra lại
          </Button>
        </div>
      </>
    );
  } else if (fresh) {
    body = (
      <EmptyState
        icon={Building}
        title="Bạn chưa ở trong không gian làm việc nào"
        description="Khi quản trị viên thêm hoặc mời bạn, không gian làm việc sẽ hiện ở đây."
        actions={
          <Button variant="primary" isPending={query.isFetching} onPress={() => void checkAgain()}>
            <RefreshCw className="i" aria-hidden />
            Kiểm tra lại
          </Button>
        }
        boxed
      />
    );
  } else {
    body = (
      <>
        {all.length >= TOOLS_MIN || q ? (
          <div className="mb-12">
            <SearchField value={q} onChange={setQ} aria-label="Tìm kiếm không gian làm việc" fullWidth>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Tìm kiếm không gian làm việc" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
          </div>
        ) : null}
        {rows.length ? (
          <List>
            {rows.map((c) =>
              c.workspace.state === "ARCHIVED" ? (
                <ListItem
                  key={c.id}
                  className="au-ws-off"
                  lead={<WorkspaceMark name={c.workspace.displayName} logo={c.workspace.logoUri} size={36} />}
                  title={c.workspace.displayName}
                  contentTitle
                  titleExtra={<StatusChip label="Đã lưu trữ" tone="default" size="sm" />}
                  description="Đã lưu trữ. Hãy nhờ quản trị viên nền tảng khôi phục."
                />
              ) : (
                <ListItem
                  key={c.id}
                  lead={<WorkspaceMark name={c.workspace.displayName} logo={c.workspace.logoUri} size={36} />}
                  title={c.workspace.displayName}
                  contentTitle
                  titleExtra={mixed && c.workspace.template ? <Chip size="sm">{TEMPLATE_LABEL[c.workspace.template]}</Chip> : undefined}
                  description={`${c.role} · ${plural(c.workspace.memberCount ?? 0, "member")}`}
                  meta={c.opened ? `Mở lần cuối ${relInline(c.opened)}` : undefined}
                  actions={<ChevronRight className="i au-chev" aria-hidden />}
                  onPress={() => void open(c.id)}
                />
              ),
            )}
          </List>
        ) : (
          <NoMatches what="không gian làm việc" onClear={() => setQ("")} />
        )}
      </>
    );
  }

  return (
    <AuthLayout innerClassName="au-ws">
      <h1 className="t-title au-title">{fresh ? "Chào mừng bạn đến với BoMesh" : "Chọn không gian làm việc"}</h1>
      <div className="au-sub au-who">
        <p className="au-who__text">
          <span className="t-xs muted">Đã đăng nhập bằng</span>
          <span className="medium au-who__email" translate="no">
            {session.user.email}
          </span>
        </p>
        <Button variant="tertiary" size="sm" onPress={() => void leave()}>
          <LogOut className="i" aria-hidden />
          Đăng xuất
        </Button>
      </div>
      {body}
      {isPlatformOperator(session) ? (
        <div className="au-group">
          <div className="t-label au-group__label">Quản trị</div>
          <List>
            <ListItem
              lead={
                <span className="ws-mark au-console-mark" style={{ width: 36, height: 36 }}>
                  <Layers className="i i-sm" aria-hidden />
                </span>
              }
              title="Bảng điều khiển nền tảng"
              description="Không gian làm việc, người dùng, trình kết nối và tình trạng hệ thống"
              actions={<ChevronRight className="i au-chev" aria-hidden />}
              href="/p/workspaces"
            />
          </List>
        </div>
      ) : null}
      {fresh ? null : publicGroup}
    </AuthLayout>
  );
}
