"use client";

import { Button, Chip, SearchField } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Building, ChevronRight, Layers, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, ErrorState, List, ListItem, NoMatches, SkeletonRows, toast, WorkspaceMark } from "@/components/ui";
import { api, call, resourceId, type Schema } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { isPlatformOperator, useSession } from "@/lib/session";
import { listMyWorkspaces } from "@/lib/workspace";
import { openWorkspace, roleDisplayName, signOut, TEMPLATE_LABEL, workspacesOpened } from "@/modules/auth/api";
import { AuthLayout } from "@/modules/auth/components/AuthLayout";

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
  // Re-render on a language switch so "Last opened …" follows it (`rel` reads the interface language).
  useLanguage();
  const [signedOutChecked, setSignedOutChecked] = useState(false);
  const [q, setQ] = useState("");
  const [opening, setOpening] = useState<string | null>(null);

  // useSession is null during server render; check after mount before redirecting.
  useEffect(() => setSignedOutChecked(true), []);
  useEffect(() => {
    if (signedOutChecked && !session) router.replace("/signin");
  }, [signedOutChecked, session, router]);

  const query = useQuery({
    queryKey: ["my-workspaces", session?.user.name],
    queryFn: loadChoices,
    enabled: !!session,
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

  async function open(id: string) {
    if (opening) return;
    setOpening(id);
    router.replace(await openWorkspace(id, next));
  }

  async function checkAgain() {
    const result = await query.refetch();
    const found = result.data ?? [];
    if (found.length) toast(`You were added to ${found[0].workspace.displayName}`, { tone: "success" });
    else toast("Not yet. Your admin hasn’t added you.", { tone: "accent" });
  }

  async function leave() {
    await signOut();
    router.replace("/signin");
    toast("Signed out", { tone: "accent" });
  }

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
            Ask your workspace admin to add <strong>{session.user.email}</strong>. It shows up here as soon as they do.
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
        {all.length > 3 ? (
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
            {rows.map((c) => (
              <ListItem
                key={c.id}
                lead={<WorkspaceMark name={c.workspace.displayName} size={36} />}
                title={c.workspace.displayName}
                contentTitle
                titleExtra={
                  c.workspace.template ? (
                    <Chip size="sm">{TEMPLATE_LABEL[c.workspace.template]}</Chip>
                  ) : undefined
                }
                description={`${c.role} · ${c.workspace.memberCount ?? 0} ${c.workspace.memberCount === 1 ? "member" : "members"}`}
                meta={c.opened ? `Last opened ${rel(c.opened).toLowerCase()}` : undefined}
                actions={<ChevronRight className="i au-chev" aria-hidden />}
                onPress={() => void open(c.id)}
              />
            ))}
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
      {body}
      {isPlatformOperator(session) ? (
        <div className="mt-12">
          <List>
            <ListItem
              lead={
                <span className="ws-mark au-console-mark" style={{ width: 36, height: 36 }}>
                  <Layers className="i i-sm" aria-hidden />
                </span>
              }
              title="Platform console"
              description="All workspaces"
              actions={<ChevronRight className="i au-chev" aria-hidden />}
              href="/p/workspaces"
            />
          </List>
        </div>
      ) : null}
      <p className="au-foot au-foot--start">
        Signed in as {session.user.email} ·{" "}
        <button type="button" className="link link-button" onClick={() => void leave()}>
          Sign out
        </button>
      </p>
    </AuthLayout>
  );
}
