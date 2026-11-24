"use client";

import { Button, Spinner } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Clock, Link as LinkIcon, Lock, Send, UserPlus, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { welcomesOnArrival } from "@/components/shell/tour";
import { toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useSession } from "@/lib/session";
import { openWorkspace, routeAfterSignIn, signOut } from "@/modules/auth/api";
import { AuthLayout, AuthMark as Mark } from "@/modules/auth/components/AuthLayout";
import { signInHref } from "@/modules/auth/next";
import { createAccessRequest } from "@/modules/knowledge/bases/api";
import { getItem } from "@/modules/knowledge/api";
import { catalogHref } from "@/modules/knowledge/model";
import { requestToJoin } from "@/modules/spaces/api";

import { acceptShare, resolveShare, shareKeys, type ShareResolution } from "../api";
import { parseTarget, roleWord } from "../model";

/** Where a resolved target opens in the app (a collection is a Browse filter; a conversation is read-only for its audience). */
async function targetPath(target: string | undefined): Promise<{ workspace: string; path: string } | null> {
  const t = parseTarget(target);
  if (!t) return null;
  if (t.kind === "workspace") return { workspace: t.workspace, path: "/home" };
  if (t.kind === "space") return { workspace: t.workspace, path: `/space/${t.id}` };
  if (t.kind === "conversation") return { workspace: t.workspace, path: `/chat/${t.id}` };
  const item = await getItem(t.workspace, t.id, "BASIC");
  return { workspace: t.workspace, path: item.itemKind === "COLLECTION" ? catalogHref({ filters: { kb: [t.id] } }) : `/doc/${t.id}` };
}

const DEAD: Partial<Record<NonNullable<ShareResolution["reason"]> | "NOT_FOUND", [string, string]>> = {
  NOT_FOUND: ["Liên kết này không dùng được", "Hãy kiểm tra bạn đã sao chép đủ liên kết, hoặc xin người gửi một liên kết mới."],
  REVOKED: ["Liên kết này đã bị tắt", "Người tạo đã tắt liên kết. Hãy xin họ một liên kết mới."],
  EXPIRED: ["Liên kết này đã hết hạn", "Hãy xin người gửi một liên kết mới."],
  EXHAUSTED: ["Liên kết mời này đã hết lượt dùng", "Liên kết đã được dùng hết số lần cho phép. Hãy xin người gửi một liên kết mới."],
  SHARE_CREATOR_NOT_ALLOWED: ["Lời mời này không còn hiệu lực", "Người tạo không còn quyền mời người khác vào đây. Hãy xin quản trị viên một lời mời mới."],
  NOT_IN_AUDIENCE: ["Liên kết này không được chia sẻ với bạn", "Chỉ những người được chia sẻ mới mở được. Hãy đề nghị người gửi chia sẻ với bạn."],
};

function Landing({ icon, warn, title, sub, actions, foot }: { icon: LucideIcon; warn?: boolean; title: string; sub: ReactNode; actions: ReactNode; foot?: ReactNode }) {
  return (
    <AuthLayout innerClassName="au-narrow">
      <Mark icon={icon} warn={warn} />
      <h1 className="t-title au-title">{title}</h1>
      <p className="muted au-sub">{sub}</p>
      <div className="sh-actions">{actions}</div>
      {foot}
    </AuthLayout>
  );
}

/**
 * `/s/[token]` (preview `P.share`): every link BoMesh hands out. Signed out: sign in or create an account, then back here.
 * Signed in: `shares:resolve` — open the target (replacing the link in history), Accept an invite, Request access to a
 * collection or space the caller can't open yet (never naming it), or say why the link doesn't work.
 */
export function ShareLandingPage({ token }: { token: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const here = `/s/${encodeURIComponent(token)}`;
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [openError, setOpenError] = useState("");
  // The toast shown once the target opens ("You joined …" after Accept); opening starts once per page.
  const welcome = useRef<string | undefined>(undefined);
  const started = useRef(false);

  const resolution = useQuery({ queryKey: shareKeys.resolve(token), queryFn: () => resolveShare(token), enabled: !!session, retry: false, staleTime: 0 });
  const r = resolution.data;
  const target = parseTarget(r?.target);
  const lockedItem = r?.reason === "NO_ACCESS" && target?.kind === "item" ? target : null;
  // NO_ACCESS to an item: only a (discoverable, LOCKED) collection can be asked for; a document answers 403 here.
  const lockedBase = useQuery({
    queryKey: ["shares", "lockedBase", r?.target],
    queryFn: () => getItem(lockedItem!.workspace, lockedItem!.id, "BASIC"),
    enabled: !!lockedItem,
    retry: false,
  });

  // A share you can read, or an invite with nothing left to grant (or just accepted): open it, replacing the link. A new
  // member landing on Home gets its welcome card, which confirms the join in place of the toast.
  useEffect(() => {
    if (!r?.canOpen || started.current) return;
    started.current = true;
    const joined = welcome.current;
    const message = joined ?? (r.reason === "ALREADY_MEMBER" ? `Bạn đã ở trong ${r.targetDisplayName || r.workspaceDisplayName || "không gian làm việc này"}` : undefined);
    targetPath(r.target)
      .then(async (to) => {
        if (!to) throw new Error("Liên kết này trỏ đến nội dung BoMesh không mở được.");
        const path = await openWorkspace(to.workspace, to.path);
        if (message && !(joined && welcomesOnArrival(to.workspace, path))) toast(message, { tone: "success" });
        router.replace(path);
      })
      .catch((error: unknown) => setOpenError(errorMessage(error)));
  }, [r, router]);

  if (!session) {
    return (
      <Landing
        icon={LinkIcon}
        title="Đăng nhập để mở liên kết này"
        sub="Liên kết chỉ mở được khi có tài khoản BoMesh. Nếu bạn được mời, hãy tạo tài khoản bằng email bất kỳ."
        actions={
          <>
            <Button variant="primary" size="lg" fullWidth onPress={() => router.push(signInHref(here))}>
              Đăng nhập
            </Button>
            <Button variant="secondary" size="lg" fullWidth onPress={() => router.push(`/signup?next=${encodeURIComponent(here)}`)}>
              Tạo tài khoản
            </Button>
          </>
        }
      />
    );
  }

  const home = (
    <Button variant="secondary" size="lg" fullWidth onPress={async () => router.replace(await routeAfterSignIn(queryClient, null))}>
      Đến BoMesh
    </Button>
  );
  const switchAccount = async () => {
    await signOut();
    router.replace(signInHref(here));
  };
  const foot = (
    <p className="au-foot">
      Đã đăng nhập bằng <span className="medium">{session.user.email || session.user.username}</span> ·{" "}
      <button type="button" className="link link-button" onClick={() => void switchAccount()}>
        Dùng tài khoản khác
      </button>
    </p>
  );

  if (openError) {
    return (
      <Landing
        icon={Clock}
        warn
        title="Không mở được liên kết này"
        sub={openError}
        actions={
          <Button variant="primary" size="lg" fullWidth onPress={() => window.location.reload()}>
            Thử lại
          </Button>
        }
        foot={foot}
      />
    );
  }

  if (resolution.isPending || r?.canOpen || (lockedItem && lockedBase.isPending)) {
    return (
      <AuthLayout innerClassName="au-narrow">
        <div className="sh-loading" role="status">
          <Spinner size="sm" />
          <span className="muted">Đang mở liên kết…</span>
        </div>
      </AuthLayout>
    );
  }

  if (resolution.isError) {
    const gone = resolution.error instanceof ApiError && resolution.error.status === 404;
    if (gone) return <Landing icon={Clock} warn title={DEAD.NOT_FOUND![0]} sub={DEAD.NOT_FOUND![1]} actions={home} foot={foot} />;
    return (
      <Landing
        icon={Clock}
        warn
        title="Không mở được liên kết này"
        sub={errorMessage(resolution.error)}
        actions={
          <Button variant="primary" size="lg" fullWidth onPress={() => void resolution.refetch()}>
            Thử lại
          </Button>
        }
        foot={foot}
      />
    );
  }

  const reason = r?.reason;
  const wsName = r?.workspaceDisplayName || "không gian làm việc này";
  const name = r?.targetDisplayName || wsName;
  const role = roleWord(r?.role);

  if (reason && DEAD[reason]) return <Landing icon={Clock} warn title={DEAD[reason]![0]} sub={DEAD[reason]![1]} actions={home} foot={foot} />;

  if (r?.kind === "INVITE") {
    // One text node, so the interface language translates the sentence as a whole.
    const line = <span>{target?.kind === "workspace" ? `Bạn được mời tham gia ${name} với vai trò ${role}.` : `Bạn được mời vào ${name} trong ${wsName} với vai trò ${role}.`}</span>;
    if (r.canAccept) {
      const accept = async () => {
        setBusy(true);
        try {
          const after = await acceptShare(token);
          welcome.current = `Bạn đã tham gia ${after.targetDisplayName || name}`;
          // The effect opens the target once the resolution says it can be opened.
          queryClient.setQueryData(shareKeys.resolve(token), after);
          if (!after.canOpen) setBusy(false);
        } catch (error) {
          setBusy(false);
          await resolution.refetch();
          if (!(error instanceof ApiError && error.status === 400)) toast(errorMessage(error), { tone: "danger" });
        }
      };
      return (
        <Landing
          icon={UserPlus}
          title={`Tham gia ${name}`}
          sub={line}
          actions={
            <Button variant="primary" size="lg" fullWidth isPending={busy} onPress={() => void accept()}>
              <Check className="i" aria-hidden />
              Chấp nhận lời mời
            </Button>
          }
          foot={foot}
        />
      );
    }
    if (reason === "NOT_WORKSPACE_MEMBER") {
      return (
        <Landing
          icon={Building2}
          warn
          title={`Hãy tham gia ${wsName} trước`}
          sub={
            <>
              {line} <span>{`Lời mời dành cho người trong ${wsName}. Hãy xin người gửi lời mời vào không gian làm việc.`}</span>
            </>
          }
          actions={home}
          foot={foot}
        />
      );
    }
  }

  if (reason === "MEMBER_SUSPENDED") {
    return <Landing icon={Lock} warn title="Tư cách thành viên của bạn đang bị tạm ngưng" sub={`Hãy đề nghị quản trị viên của ${wsName} kích hoạt lại.`} actions={home} foot={foot} />;
  }

  if (reason === "NOT_WORKSPACE_MEMBER") {
    return (
      <Landing
        icon={Building2}
        warn
        title={r?.workspaceDisplayName ? `Liên kết này dành cho người trong ${r.workspaceDisplayName}` : "Liên kết này dành cho người trong không gian làm việc khác"}
        sub="Hãy dùng tài khoản bạn có ở đó, hoặc xin người gửi một lời mời."
        actions={
          <Button variant="primary" size="lg" fullWidth onPress={() => void switchAccount()}>
            Dùng tài khoản khác
          </Button>
        }
        foot={foot}
      />
    );
  }

  // NO_ACCESS: the target stays unnamed. A space (join request) or a LOCKED collection (access request) can be asked
  // for; a document's collection is never revealed, so a document can't.
  const base = lockedBase.data?.itemKind === "COLLECTION" ? lockedBase.data : null;
  const ask = async () => {
    if (!target) return;
    setBusy(true);
    try {
      if (target.kind === "space") await requestToJoin(target.workspace, target.id, "Đã mở một liên kết được chia sẻ.");
      else if (base) await createAccessRequest(target.workspace, { base, role: "viewer", reason: "Đã mở một liên kết được chia sẻ." });
      setRequested(true);
      toast("Đã gửi yêu cầu. Bạn sẽ nhận thông báo khi có người phê duyệt.", { tone: "success" });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  const canAsk = target?.kind === "space" || !!base;
  return (
    <Landing
      icon={Lock}
      warn
      title="Bạn chưa có quyền truy cập"
      sub={canAsk ? `Nội dung nằm trong ${wsName} nhưng bạn chưa mở được. Hãy xin quyền truy cập, bạn sẽ nhận thông báo khi có người phê duyệt.` : `Nội dung nằm trong ${wsName} nhưng bạn chưa mở được. Hãy đề nghị người gửi thêm bạn vào.`}
      actions={
        !canAsk ? (
          home
        ) : requested ? (
          <Button variant="secondary" size="lg" fullWidth isDisabled>
            <Check className="i" aria-hidden />
            Đã gửi yêu cầu
          </Button>
        ) : (
          <Button variant="primary" size="lg" fullWidth isPending={busy} onPress={() => void ask()}>
            <Send className="i" aria-hidden />
            Yêu cầu quyền truy cập
          </Button>
        )
      }
      foot={foot}
    />
  );
}
