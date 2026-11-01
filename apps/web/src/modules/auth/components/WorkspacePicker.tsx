"use client";

import { Building2, Check, ChevronRight, Copy, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { WorkspaceMark } from "@/components/patterns/WorkspaceMark";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { ui } from "@/components/ui/design-system";
import { ApiError } from "@/lib/api/request";
import type { AuthWorkspace } from "@/lib/auth/session";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { appBrand } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { refreshSession, signOut } from "@/modules/auth/api";
import { AuthScreen, BrandLine } from "@/modules/auth/components/AuthScreen";
import { useWorkspaceSwitch } from "@/modules/auth/queries";

/** What the person can do there, said from the permissions the session grants — never role codes. */
function accessLabel(workspace: AuthWorkspace): string {
  return workspace.permissions.includes("tenant.manage") ? "Admin" : "Member";
}

/**
 * Entry into a workspace, outside the product shell. One membership enters
 * chat directly; several are picked here; none tells a new account exactly
 * what to send its admin and re-reads the session on "Check again".
 */
export function WorkspacePicker() {
  const router = useRouter();
  const session = useAuthSession();
  const { error: switchError, switchingId, switchWorkspace } = useWorkspaceSwitch();
  const [leaving, setLeaving] = useState(false);
  const autoEntered = useRef(false);

  const single = session?.workspaces.length === 1 ? session.workspaces[0] : null;

  const enter = async (workspaceId: string) => {
    if (await switchWorkspace(workspaceId)) router.replace("/chat");
  };

  // One workspace: nothing to choose.
  useEffect(() => {
    if (!single || autoEntered.current) return;
    autoEntered.current = true;
    void enter(single.id);
    // `enter` is recreated every render; the ref guards a single run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single]);

  const leave = async () => {
    setLeaving(true);
    await signOut();
    router.replace("/auth/login");
  };

  const email = session?.email ?? null;

  return (
    <AuthScreen art={false}>
      <BrandLine className="mb-7" />
      {!session ? (
        <div aria-busy="true" aria-label="Loading workspaces" className="grid gap-3" role="status">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="mt-3 h-[72px] w-full" />
        </div>
      ) : single ? (
        switchError ? (
          <Callout
            actions={
              <Button onClick={() => void enter(single.id)} size="sm" variant="secondary">
                Retry
              </Button>
            }
            tone="err"
          >
            {switchError}
          </Callout>
        ) : (
          <p className="flex items-center gap-3 text-body text-text-secondary" role="status">
            <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            Opening {single.name}…
          </p>
        )
      ) : session.workspaces.length ? (
        <>
          <h1 className="text-title font-semibold tracking-[-0.02em] text-text-primary">Choose a workspace</h1>
          <p className="mb-5 mt-1.5 text-body text-text-secondary">You can switch any time from the sidebar.</p>
          {switchError && (
            <Callout className="mb-3" tone="err">
              {switchError}
            </Callout>
          )}
          <ul aria-label="Your workspaces" className="grid gap-2">
            {session.workspaces.map((workspace) => (
              <li key={workspace.id}>
                <button
                  aria-busy={switchingId === workspace.id || undefined}
                  className={cn(
                    "flex w-full items-center gap-3.5 rounded-lg border border-border-subtle bg-surface-base px-4 py-3.5 text-left",
                    "hover:border-border-default hover:shadow-(--shadow-2) disabled:cursor-wait",
                    ui.motion,
                    ui.focus,
                  )}
                  disabled={Boolean(switchingId)}
                  onClick={() => void enter(workspace.id)}
                  type="button"
                >
                  <WorkspaceMark name={workspace.name} size="lg" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-text-primary">{workspace.name}</span>
                    <span className="text-[0.8125rem] text-text-tertiary">{accessLabel(workspace)}</span>
                  </span>
                  {switchingId === workspace.id ? (
                    <Loader2 aria-hidden="true" className="size-4 animate-spin text-text-tertiary motion-reduce:animate-none" />
                  ) : (
                    <ChevronRight aria-hidden="true" className="size-4 text-text-tertiary" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <NoWorkspace email={email} leaving={leaving} onSignOut={() => void leave()} />
      )}
      {session && (
        <p className="mt-6 text-meta text-text-tertiary">
          Signed in as {email ?? session.display_name ?? "your account"}
          {/* The empty state carries its own Sign out button. */}
          {session.workspaces.length > 0 && (
            <>
              {" · "}
              <Button disabled={leaving} onClick={() => void leave()} size="sm" variant="link">
                Sign out
              </Button>
            </>
          )}
        </p>
      )}
    </AuthScreen>
  );
}

function NoWorkspace({
  email,
  leaving,
  onSignOut,
}: {
  email: string | null;
  leaving: boolean;
  onSignOut: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<"still-empty" | "error" | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [copied, setCopied] = useState(false);

  const message = `Hi, please add me to our ${appBrand.productName} workspace. My account email is ${email ?? "(the email I sign in with)"}.`;

  const checkAgain = async () => {
    setChecking(true);
    setResult(null);
    try {
      const fresh = await refreshSession();
      // A membership re-renders the picker above (the session store changed).
      if (!fresh.workspaces.length) setResult("still-empty");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSignOut();
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : "Your workspaces couldn’t be checked.");
      setResult("error");
    } finally {
      setChecking(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div>
      <EmptyState
        className="-mx-6"
        description={
          <>
            Ask your workspace admin to add{" "}
            <strong className="font-semibold text-text-primary">{email ?? "the email you sign in with"}</strong>. It
            appears here as soon as they do.
          </>
        }
        icon={<Building2 />}
        size="sm"
        title="You’re not in a workspace yet"
      />
      <div className={cn(ui.insetPanel, "flex items-start gap-2 p-3")}>
        <p className="min-w-0 flex-1 text-body text-text-secondary" id="admin-message">
          {message}
        </p>
        <Button
          aria-describedby="admin-message"
          icon={copied ? <Check /> : <Copy />}
          onClick={() => void copy()}
          size="sm"
          variant="secondary"
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {copied ? "Message copied" : ""}
      </p>
      {result === "still-empty" && (
        <Callout className="mt-3" tone="info">
          No workspace yet. Your admin hasn’t added you.
        </Callout>
      )}
      {result === "error" && (
        <Callout className="mt-3" tone="err">
          {errorMessage}
        </Callout>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button icon={<RefreshCw />} loading={checking} onClick={() => void checkAgain()}>
          Check again
        </Button>
        <Button disabled={leaving} onClick={onSignOut} variant="secondary">
          Sign out
        </Button>
      </div>
    </div>
  );
}
