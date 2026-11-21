"use client";

import { Button, Spinner } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Clock, Link as LinkIcon, Lock, Send, UserPlus, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useSession } from "@/lib/session";
import { openWorkspace, routeAfterSignIn, signOut } from "@/modules/auth/api";
import { AuthLayout } from "@/modules/auth/components/AuthLayout";
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
  NOT_FOUND: ["This link doesn’t work", "Check that you copied all of it, or ask whoever sent it for a new one."],
  REVOKED: ["This link was turned off", "Whoever made it turned it off. Ask them for a new one."],
  EXPIRED: ["This link has expired", "Ask whoever sent it for a new one."],
  EXHAUSTED: ["This invite link was used up", "It was used as many times as allowed. Ask whoever sent it for a new one."],
  SHARE_CREATOR_NOT_ALLOWED: ["This invite is no longer valid", "Whoever made it can no longer invite people here. Ask an admin for a new invite."],
  NOT_IN_AUDIENCE: ["This link wasn’t shared with you", "Only the people it was shared with can open it. Ask whoever sent it to share it with you."],
};

function Mark({ icon: Icon, warn }: { icon: LucideIcon; warn?: boolean }) {
  return (
    <span className={warn ? "au-mark au-mark--warn" : "au-mark"}>
      <Icon className="i" aria-hidden />
    </span>
  );
}

function Landing({ icon, warn, title, sub, actions, foot }: { icon: LucideIcon; warn?: boolean; title: string; sub: ReactNode; actions: ReactNode; foot?: ReactNode }) {
  return (
    <AuthLayout single innerClassName="au-narrow">
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

  // A share you can read, or an invite with nothing left to grant (or just accepted): open it, replacing the link.
  useEffect(() => {
    if (!r?.canOpen || started.current) return;
    started.current = true;
    const message = welcome.current ?? (r.reason === "ALREADY_MEMBER" ? `You’re already in ${r.targetDisplayName || r.workspaceDisplayName || "it"}` : undefined);
    targetPath(r.target)
      .then(async (to) => {
        if (!to) throw new Error("This link points at something BoMesh can’t open.");
        const path = await openWorkspace(to.workspace, to.path);
        if (message) toast(message, { tone: "success" });
        router.replace(path);
      })
      .catch((error: unknown) => setOpenError(errorMessage(error)));
  }, [r, router]);

  if (!session) {
    return (
      <Landing
        icon={LinkIcon}
        title="Sign in to open this link"
        sub="Links open for people with a BoMesh account. If you were invited, create one with any email."
        actions={
          <>
            <Button variant="primary" size="lg" fullWidth onPress={() => router.push(signInHref(here))}>
              Sign in
            </Button>
            <Button variant="secondary" size="lg" fullWidth onPress={() => router.push(`/signup?next=${encodeURIComponent(here)}`)}>
              Create account
            </Button>
          </>
        }
      />
    );
  }

  const home = (
    <Button variant="secondary" size="lg" fullWidth onPress={async () => router.replace(await routeAfterSignIn(queryClient, null))}>
      Go to BoMesh
    </Button>
  );
  const switchAccount = async () => {
    await signOut();
    router.replace(signInHref(here));
  };
  const foot = (
    <p className="au-foot">
      Signed in as <span className="medium">{session.user.email || session.user.username}</span> ·{" "}
      <button type="button" className="link link-button" onClick={() => void switchAccount()}>
        Use another account
      </button>
    </p>
  );

  if (openError) {
    return (
      <Landing
        icon={Clock}
        warn
        title="This link didn’t open"
        sub={openError}
        actions={
          <Button variant="primary" size="lg" fullWidth onPress={() => window.location.reload()}>
            Try again
          </Button>
        }
        foot={foot}
      />
    );
  }

  if (resolution.isPending || r?.canOpen || (lockedItem && lockedBase.isPending)) {
    return (
      <AuthLayout single innerClassName="au-narrow">
        <div className="sh-loading" role="status">
          <Spinner size="sm" />
          <span className="muted">Opening the link…</span>
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
        title="This link didn’t open"
        sub={errorMessage(resolution.error)}
        actions={
          <Button variant="primary" size="lg" fullWidth onPress={() => void resolution.refetch()}>
            Try again
          </Button>
        }
        foot={foot}
      />
    );
  }

  const reason = r?.reason;
  const wsName = r?.workspaceDisplayName || "this workspace";
  const name = r?.targetDisplayName || wsName;
  const role = roleWord(r?.role);

  if (reason && DEAD[reason]) return <Landing icon={Clock} warn title={DEAD[reason]![0]} sub={DEAD[reason]![1]} actions={home} foot={foot} />;

  if (r?.kind === "INVITE") {
    // One text node, so the interface language translates the sentence as a whole.
    const line = <span>{target?.kind === "workspace" ? `You’re invited to join ${name} as ${role}.` : `You’re invited to ${name} in ${wsName} as ${role}.`}</span>;
    if (r.canAccept) {
      const accept = async () => {
        setBusy(true);
        try {
          const after = await acceptShare(token);
          welcome.current = `You joined ${after.targetDisplayName || name}`;
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
          title={`Join ${name}`}
          sub={line}
          actions={
            <Button variant="primary" size="lg" fullWidth isPending={busy} onPress={() => void accept()}>
              <Check className="i" aria-hidden />
              Accept invite
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
          title={`Join ${wsName} first`}
          sub={
            <>
              {line} <span>{`It’s for people in ${wsName}. Ask whoever sent it for an invite to the workspace.`}</span>
            </>
          }
          actions={home}
          foot={foot}
        />
      );
    }
  }

  if (reason === "MEMBER_SUSPENDED") {
    return <Landing icon={Lock} warn title="Your membership is suspended" sub={`Ask an admin of ${wsName} to reactivate it.`} actions={home} foot={foot} />;
  }

  if (reason === "NOT_WORKSPACE_MEMBER") {
    return (
      <Landing
        icon={Building2}
        warn
        title={r?.workspaceDisplayName ? `This link is for people in ${r.workspaceDisplayName}` : "This link is for people in another workspace"}
        sub="Use the account you have there, or ask whoever sent it for an invite."
        actions={
          <Button variant="primary" size="lg" fullWidth onPress={() => void switchAccount()}>
            Use another account
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
      if (target.kind === "space") await requestToJoin(target.workspace, target.id, "Opened a shared link.");
      else if (base) await createAccessRequest(target.workspace, { base, role: "viewer", reason: "Opened a shared link." });
      setRequested(true);
      toast("Request sent. You’ll get a notification when someone approves it.", { tone: "success" });
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
      title="You don’t have access yet"
      sub={canAsk ? `It’s in ${wsName}, but you can’t open it. Ask for access and you’ll get a notification when someone approves it.` : `It’s in ${wsName}, but you can’t open it. Ask whoever sent it to add you.`}
      actions={
        !canAsk ? (
          home
        ) : requested ? (
          <Button variant="secondary" size="lg" fullWidth isDisabled>
            <Check className="i" aria-hidden />
            Request sent
          </Button>
        ) : (
          <Button variant="primary" size="lg" fullWidth isPending={busy} onPress={() => void ask()}>
            <Send className="i" aria-hidden />
            Request access
          </Button>
        )
      }
      foot={foot}
    />
  );
}
