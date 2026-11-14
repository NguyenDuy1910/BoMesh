"use client";

import { buttonVariants } from "@heroui/react";
import { BookOpen, Clock, MessageSquare } from "lucide-react";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FileIcon } from "@/components/ui/FileIcon";
import { ItemIcon } from "@/components/ui/ItemIcon";
import { List, ListItem } from "@/components/ui/List";
import { NoMatches } from "@/components/ui/NoMatches";
import { Page } from "@/components/ui/Page";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { conversationTitle, useConversations } from "@/modules/projects";
import { useSpaces } from "@/modules/spaces/queries";
import { isSpaceStaff, useWorkList } from "@/modules/work";
import { WorkStatusChip, WorkTile } from "@/modules/work/components/parts";

import { fold, tokens } from "../../model";
import { useItemsByName, useKnowledgeModel, useRecentItems } from "../../queries";
import { openDocumentPreview } from "../../preview/store";
import { originParam } from "../../reader/links";
import { needsTools } from "./parts";

type Kind = "documents" | "conversations" | "work";

const KINDS: ReadonlyArray<readonly [Kind, string]> = [
  ["documents", "Documents"],
  ["conversations", "Conversations"],
  ["work", "Work"],
];
const DAY = 86_400_000;

interface Entry {
  key: string;
  kind: Kind;
  at: number;
  title: string;
  row: ReactNode;
}

/**
 * Your work → Recent (`/recent`, preview `features/recent.js`): documents the member opened, their conversations
 * and the work they own or edit, newest first, grouped Today · This week · Earlier. `?kind=` filters it; a row
 * opens its object (documents in the document preview, conversations in AI Chat, work on its page).
 */
export function RecentPage() {
  const { member, hasModule } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const workOn = hasModule("work");

  const recent = useRecentItems();
  const items = useItemsByName((recent.data ?? []).map((r) => r.item));
  const { toResource } = useKnowledgeModel();
  const conversations = useConversations();
  const work = useWorkList({ enabled: workOn });
  const spaces = useSpaces();

  const all = useMemo(() => {
    const out: Entry[] = [];
    for (const r of recent.data ?? []) {
      const item = r.item ? items.items.get(r.item) : undefined;
      const at = Date.parse(r.viewTime ?? "") || 0;
      if (!item || item.state === "DELETED" || !at) continue;
      const res = toResource(item);
      out.push({
        key: `d:${res.id}`,
        kind: "documents",
        at,
        title: res.title,
        row: (
          <ListItem
            key={`d:${res.id}`}
            // File icons are narrower than icon tiles: centred in the tile's width so every title starts on one line.
            lead={
              <span className="lib-recent__lead">
                <FileIcon type={res.ext} mime={res.mime} size="sm" />
              </span>
            }
            title={res.title}
            contentTitle
            // Separate nodes: the localizer translates "Document" alone, the collection name only when it's a UI label (“My files”).
            description={
              res.base?.displayName ? (
                <>
                  {"Document"}
                  {" · "}
                  <span translate={res.base.personal ? undefined : "no"}>{res.base.displayName}</span>
                </>
              ) : (
                "Document"
              )
            }
            meta={rel(at)}
            onPress={() => openDocumentPreview({ item: res.name, from: originParam({ kind: "recent" }) })}
          />
        ),
      });
    }
    for (const c of conversations.data ?? []) {
      const at = Date.parse(c.lastMessageTime || c.createTime || "") || 0;
      if (!at) continue;
      const id = resourceId(c.name);
      const title = conversationTitle(c);
      out.push({
        key: `c:${id}`,
        kind: "conversations",
        at,
        title,
        row: <ListItem key={`c:${id}`} lead={<ItemIcon icon={MessageSquare} size="sm" />} title={title} contentTitle description="Conversation" meta={rel(at)} href={`/chat/${id}`} />,
      });
    }
    if (workOn) {
      const spaceOf = new Map((spaces.data ?? []).map((s) => [s.name ?? "", s]));
      for (const a of work.data ?? []) {
        const space = a.space ? spaceOf.get(a.space) : undefined;
        // Work the member owns, or staff work shared to a space they run (a quiz); someone else's draft is reviewed, not edited.
        const edits = a.owner === member.name || (a.audience === "SPACE" && a.kind === "QUIZ" && isSpaceStaff(space));
        const at = Date.parse(a.updateTime || a.createTime || "") || 0;
        if (!edits || !at) continue;
        const id = resourceId(a.name);
        const title = a.displayName ?? "";
        out.push({
          key: `w:${id}`,
          kind: "work",
          at,
          title,
          row: (
            <ListItem
              key={`w:${id}`}
              lead={<WorkTile kind={a.kind} size="sm" />}
              title={title}
              contentTitle
              titleExtra={<WorkStatusChip artifact={a} />}
              description={
                space?.displayName ? (
                  <>
                    {"Work"}
                    {" · "}
                    <span translate="no">{space.displayName}</span>
                  </>
                ) : (
                  "Work"
                )
              }
              meta={rel(at)}
              href={`/work/${id}`}
            />
          ),
        });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }, [recent.data, items.items, toResource, conversations.data, work.data, spaces.data, workOn, member.name]);

  const present = KINDS.filter(([k]) => all.some((e) => e.kind === k));
  const requested = params.get("kind");
  const kind = present.some(([k]) => k === requested) ? (requested as Kind) : "all";
  const ofKind = kind === "all" ? all : all.filter((e) => e.kind === kind);
  const words = tokens(q);
  const rows = ofKind.filter((e) => words.every((w) => fold(e.title).includes(w)));

  const setKind = (value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === "all") next.delete("kind");
    else next.set("kind", value);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const loading = recent.isPending || (items.isPending && !!recent.data?.length) || conversations.isPending || (workOn && work.isPending);
  const failed = recent.isError && conversations.isError && (!workOn || work.isError);

  let body: ReactNode;
  if (failed && !all.length) {
    body = (
      <ErrorState
        error={recent.error}
        onRetry={() => {
          void recent.refetch();
          void conversations.refetch();
          if (workOn) void work.refetch();
        }}
      />
    );
  } else if (loading && !all.length) body = <SkeletonRows rows={6} />;
  else if (!all.length) {
    body = (
      <EmptyState
        icon={Clock}
        title="Nothing here yet"
        description="Documents you open, your conversations and your work show up here, newest first."
        actions={
          <>
            <NextLink href="/knowledge" className={buttonVariants({ variant: "primary" })}>
              <BookOpen className="i" aria-hidden />
              Browse knowledge
            </NextLink>
            <NextLink href="/chat" className={buttonVariants({ variant: "secondary" })}>
              <MessageSquare className="i" aria-hidden />
              Start a chat
            </NextLink>
          </>
        }
        boxed
      />
    );
  } else {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = start.getTime();
    const week = today - 6 * DAY;
    const groups = (
      [
        ["Today", (e: Entry) => e.at >= today],
        ["This week", (e: Entry) => e.at >= week && e.at < today],
        ["Earlier", (e: Entry) => e.at < week],
      ] as const
    )
      .map(([label, test]) => [label, rows.filter(test)] as const)
      .filter(([, list]) => list.length);
    const filter = present.length > 1 ? <Segmented value={kind} label="Show" onChange={setKind} options={[{ value: "all", label: "All" }, ...present.map(([value, label]) => ({ value, label }))]} /> : null;
    const search = needsTools(ofKind.length, q) ? <SearchInput value={q} onChange={setQ} placeholder="Search recent" /> : null;
    body = (
      <>
        {filter || search ? (
          <div className="toolbar">
            {filter}
            {search}
          </div>
        ) : null}
        {rows.length ? (
          <div className="stack gap-24">
            {groups.map(([label, list], i) => (
              <section key={label} aria-labelledby={`recent-g${i}`}>
                <h2 className="t-label mb-8" id={`recent-g${i}`}>
                  {label}
                </h2>
                <List>{list.map((e) => e.row)}</List>
              </section>
            ))}
          </div>
        ) : (
          <NoMatches what="items" onClear={() => setQ("")} />
        )}
      </>
    );
  }

  return (
    <Page width="narrow">
      <PageHeader title="Recent" />
      {body}
    </Page>
  );
}
