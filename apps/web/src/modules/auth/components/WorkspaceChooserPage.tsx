"use client";

import { Button, Chip, SearchField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building, ChevronRight, Layers, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, ErrorState, List, ListItem, NoMatches, SkeletonRows, StatusChip, toast, WorkspaceMark } from "@/components/ui";
import { api, call, errorMessage, resourceId, type Schema } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { isPlatformOperator, useSession, useSessionExpired } from "@/lib/session";
import { joinWorkspace, listMyWorkspaces, listPublicWorkspaces, workspaceQueryKey } from "@/lib/workspace";
import { openWorkspace, roleDisplayName, signOut, TEMPLATE_LABEL, workspacesOpened } from "@/modules/auth/api";
import { AuthLayout } from "@/modules/auth/components/AuthLayout";
import { signInHref } from "@/modules/auth/next";

/** Search appears once the list is long enough to need it (preview `TOOLS_MIN`). */
const TOOLS_MIN = 7;

/** "Last opened 5 h ago" / "Last opened Sep 27": lower-case relative words, keep month names as written. */
function openedLabel(at: number): string {
  const r = rel(at);
  return `Last opened ${/^\p{Lu}\p{Ll}+ \d/u.test(r) ? r : r.toLowerCase()}`;
}

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
  // Re-render on a language switch so "Last opened …" follows it (`rel` reads the interface language).
  useLanguage();
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
    router.replace(await openWorkspace(id, next));
    toast(`You joined ${workspace.displayName}`);
  }

  async function checkAgain() {
    const result = await query.refetch();
    const found = result.data ?? [];
    if (found.length) toast(`You were added to ${found[0].workspace.displayName}`, { tone: "success" });
    else toast("Not yet. No workspace has added or invited you.", { tone: "accent" });
  }

  async function leave() {
    await signOut();
    router.replace("/signin");
    toast("Signed out", { tone: "accent" });
  }

  // The template only helps tell workspaces apart when they differ.
  const mixed = new Set(all.map((c) => c.workspace.template ?? "ENTERPRISE")).size > 1;

  let body: React.ReactNode;
  if (query.isPending) body = <SkeletonRows rows={3} />;
  else if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (fresh) {
    body = (
      <EmptyState
        icon={Building}
        title="No workspace yet"
        description={
          <>
            When a workspace admin adds or invites <strong>{session.user.email}</strong>, the workspace shows up here.
          </>
        }
        actions={
          <Button variant="primary" isPending={query.isFetching} onPress={() => void checkAgain()}>
            <RefreshCw className="i" aria-hidden />
            Check again
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
            <SearchField value={q} onChange={setQ} aria-label="Search workspaces" fullWidth>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Search workspaces" />
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
                  lead={<WorkspaceMark name={c.workspace.displayName} size={36} />}
                  title={c.workspace.displayName}
                  contentTitle
                  titleExtra={<StatusChip label="Archived" tone="default" size="sm" />}
                  description="Archived. Ask a platform admin to restore it."
                />
              ) : (
                <ListItem
                  key={c.id}
                  lead={<WorkspaceMark name={c.workspace.displayName} size={36} />}
                  title={c.workspace.displayName}
                  contentTitle
                  titleExtra={mixed && c.workspace.template ? <Chip size="sm">{TEMPLATE_LABEL[c.workspace.template]}</Chip> : undefined}
                  description={`${c.role} · ${plural(c.workspace.memberCount ?? 0, "member")}`}
                  meta={c.opened ? openedLabel(c.opened) : undefined}
                  actions={<ChevronRight className="i au-chev" aria-hidden />}
                  onPress={() => void open(c.id)}
                />
              ),
            )}
          </List>
        ) : (
          <NoMatches what="workspaces" onClear={() => setQ("")} />
        )}
      </>
    );
  }

  return (
    <AuthLayout single innerClassName="au-ws">
      <h1 className="t-title au-title">{fresh ? "Welcome to BoMesh" : "Choose a workspace"}</h1>
      <p className="muted au-sub au-who">
        Signed in as <span className="medium au-who__email">{session.user.email}</span> ·{" "}
        <button type="button" className="link link-button" onClick={() => void leave()}>
          Sign out
        </button>
      </p>
      {body}
      {isPlatformOperator(session) ? (
        <div className="au-group">
          <div className="t-label au-group__label">Administration</div>
          <List>
            <ListItem
              lead={
                <span className="ws-mark au-console-mark" style={{ width: 36, height: 36 }}>
                  <Layers className="i i-sm" aria-hidden />
                </span>
              }
              title="Platform console"
              description="Workspaces, users, connectors and system health"
              actions={<ChevronRight className="i au-chev" aria-hidden />}
              href="/p/workspaces"
            />
          </List>
        </div>
      ) : null}
      {toJoin.length ? (
        <div className="au-group">
          <div className="t-label au-group__label">Public workspaces</div>
          <List>
            {toJoin.map((w) => (
              <ListItem
                key={w.name}
                lead={<WorkspaceMark name={w.displayName} size={36} />}
                title={w.displayName}
                contentTitle
                actions={
                  <Button variant="secondary" size="sm" isPending={joining === resourceId(w.name)} isDisabled={Boolean(joining)} onPress={() => void join(w)}>
                    Join
                  </Button>
                }
              />
            ))}
          </List>
          <p className="t-xs muted au-group__note">Anyone with a BoMesh account can join these and becomes a member.</p>
        </div>
      ) : null}
    </AuthLayout>
  );
}
