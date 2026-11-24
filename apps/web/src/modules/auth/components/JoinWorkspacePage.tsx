"use client";

import { Button, Spinner } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, CircleX, Clock, Globe, Sparkles, Upload, UserPlus, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { welcomesOnArrival } from "@/components/shell/tour";
import { StatusChip, toast, WorkspaceMark } from "@/components/ui";
import { api, ApiError, call, errorMessage, resourceId, type Schema } from "@/lib/api/client";
import { useSession } from "@/lib/session";
import { joinWorkspace, listPublicWorkspaces, workspaceQueryKey } from "@/lib/workspace";
import { openWorkspace, routeAfterSignIn, signOut } from "@/modules/auth/api";
import { AuthLayout, AuthMark as Mark } from "@/modules/auth/components/AuthLayout";
import { signInHref } from "@/modules/auth/next";

/** What a member of a public workspace can do (preview `P.joinWorkspace`). */
const MEMBER_CAN: readonly [LucideIcon, string][] = [
  [BookOpen, "Đọc tài liệu mở cho mọi thành viên"],
  [Sparkles, "Hỏi trợ lý, kèm nguồn để bạn kiểm chứng"],
  [Upload, "Gửi tài liệu để duyệt"],
  [CircleX, "Rời đi bất cứ lúc nào từ menu tài khoản"],
];

/** The caller's membership of the workspace with this code, else the public workspace it names (none when private or unknown). */
async function lookUp(code: string): Promise<{ member: Schema<"Workspace"> | null; open: Schema<"Workspace"> | null }> {
  const [mine, open] = await Promise.all([
    call(api.GET("/api/v1/workspaces", { params: { query: { filter: `code = ${JSON.stringify(code)}`, pageSize: 1 } } })),
    listPublicWorkspaces(code),
  ]);
  return { member: mine.workspaces?.find((w) => w.state !== "ARCHIVED") ?? null, open: open[0] ?? null };
}

/**
 * `/w/[code]` (preview `P.joinWorkspace`): a public workspace's own address. Signed out: sign in or create an account, then
 * back here. Signed in: the workspace with Join as the one action; already in: straight in. Private or unknown: the same
 * "doesn't work" answer, so the link never tells a private workspace from a missing one.
 */
export function JoinWorkspacePage({ code }: { code: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const here = `/w/${encodeURIComponent(code)}`;
  const [joining, setJoining] = useState(false);
  const entered = useRef(false);

  const lookup = useQuery({ queryKey: ["join-workspace", code, session?.user.name], queryFn: () => lookUp(code), enabled: !!session, retry: false, staleTime: 0 });
  const already = lookup.data?.member ?? null;

  /** Into the workspace, replacing the link in history. A new member landing on Home gets its welcome card, which confirms
      the join in place of the toast. */
  const enter = async (workspace: Schema<"Workspace">, joined: boolean) => {
    const id = resourceId(workspace.name);
    queryClient.removeQueries({ queryKey: workspaceQueryKey });
    const path = await openWorkspace(id);
    router.replace(path);
    if (!joined) toast(`Bạn đã ở trong ${workspace.displayName}`, { tone: "accent" });
    else if (!welcomesOnArrival(id, path)) toast(`Bạn đã tham gia ${workspace.displayName}`);
  };

  useEffect(() => {
    if (!already || entered.current) return;
    entered.current = true;
    void enter(already, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enters once, when the membership is known
  }, [already]);

  if (!session) {
    return (
      <AuthLayout innerClassName="au-narrow">
        <Mark icon={Globe} />
        <h1 className="t-title au-title">Đăng nhập để tham gia</h1>
        <p className="muted au-sub">Không gian làm việc công khai mở cho bất kỳ ai có tài khoản BoMesh. Hãy đăng nhập, hoặc tạo tài khoản bằng email bất kỳ, rồi tham gia.</p>
        <div className="sh-actions">
          <Button variant="primary" size="lg" fullWidth onPress={() => router.push(signInHref(here))}>
            Đăng nhập
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={() => router.push(`/signup?next=${encodeURIComponent(here)}`)}>
            Tạo tài khoản
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const switchAccount = async () => {
    await signOut();
    router.replace(signInHref(here));
  };
  const foot: ReactNode = (
    <p className="au-foot">
      Đã đăng nhập bằng <span className="medium" translate="no">{session.user.email || session.user.username}</span> ·{" "}
      <button type="button" className="link link-button" onClick={() => void switchAccount()}>
        Dùng tài khoản khác
      </button>
    </p>
  );

  if (lookup.isPending || already) {
    return (
      <AuthLayout innerClassName="au-narrow">
        <div className="sh-loading" role="status">
          <Spinner size="sm" />
          <span className="muted">Đang mở liên kết…</span>
        </div>
      </AuthLayout>
    );
  }

  if (lookup.isError) {
    return (
      <AuthLayout innerClassName="au-narrow">
        <Mark icon={Clock} warn />
        <h1 className="t-title au-title">Không mở được liên kết này</h1>
        <p className="muted au-sub">{errorMessage(lookup.error)}</p>
        <div className="sh-actions">
          <Button variant="primary" size="lg" fullWidth onPress={() => void lookup.refetch()}>
            Thử lại
          </Button>
        </div>
        {foot}
      </AuthLayout>
    );
  }

  const workspace = lookup.data.open;
  if (!workspace) {
    return (
      <AuthLayout innerClassName="au-narrow">
        <Mark icon={Clock} warn />
        <h1 className="t-title au-title">Liên kết này không dùng được</h1>
        <p className="muted au-sub">Hãy kiểm tra bạn đã sao chép đủ liên kết, hoặc xin người gửi một liên kết mới.</p>
        <div className="sh-actions">
          <Button variant="secondary" size="lg" fullWidth onPress={async () => router.replace(await routeAfterSignIn(queryClient, null))}>
            Đến BoMesh
          </Button>
        </div>
        {foot}
      </AuthLayout>
    );
  }

  const join = async () => {
    if (joining) return;
    setJoining(true);
    try {
      await joinWorkspace(resourceId(workspace.name));
    } catch (error) {
      // Joined meanwhile (another tab): go in all the same.
      if (error instanceof ApiError && error.code === "ALREADY_EXISTS") return void enter(workspace, false);
      setJoining(false);
      toast(errorMessage(error), { tone: "danger" });
      return;
    }
    await enter(workspace, true);
  };

  return (
    <AuthLayout innerClassName="au-narrow">
      <div className="au-join">
        <div className="au-join__head">
          <WorkspaceMark name={workspace.displayName} logo={workspace.logoUri} size={48} />
          <div className="au-join__id">
            <h1 className="t-title au-join__name" translate="no">
              {workspace.displayName}
            </h1>
            <StatusChip label="Không gian làm việc công khai" icon={Globe} size="sm" />
          </div>
        </div>
        <div className="au-join__can">
          <div className="t-label">Với tư cách thành viên, bạn có thể</div>
          <ul className="au-join__list">
            {MEMBER_CAN.map(([Icon, text]) => (
              <li key={text}>
                <Icon className="i i-sm" aria-hidden />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <Button variant="primary" size="lg" fullWidth isPending={joining} onPress={() => void join()}>
          <UserPlus className="i" aria-hidden />
          {/* The full name is the heading above; a long one ellipsizes here instead of overflowing. */}
          <span className="truncate">{`Tham gia ${workspace.displayName}`}</span>
        </Button>
      </div>
      {foot}
    </AuthLayout>
  );
}
