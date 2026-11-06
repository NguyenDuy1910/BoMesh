"use client";

import { buttonVariants } from "@heroui/react";
import { BookOpen, MessageSquare, MessageSquarePlus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSort,
} from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Gate } from "@/components/ui/Gate";
import { NoMatches } from "@/components/ui/NoMatches";
import { Page } from "@/components/ui/Page";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pager, paginate } from "@/components/ui/Pager";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { StatusChip } from "@/components/ui/StatusChip";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { useSpaces } from "@/modules/spaces/queries";
import { spaceType } from "@/modules/spaces/types";

import {
  conversationTime,
  conversationTitle,
  type Conversation,
} from "../conversations";
import { useConversationModel, useLastAnswer } from "../queries";
import { ConversationMenu } from "./ConversationMenu";

const PER = 20;

function NewChatButton() {
  return (
    <Link href="/chat" className={buttonVariants({ variant: "primary" })}>
      <MessageSquarePlus className="i" aria-hidden />
      New chat
    </Link>
  );
}

/** Space or knowledge base the conversation is grounded in (preview row chip). */
function useContext() {
  const { hasModule, settings } = useWorkspace();
  const spaces = useSpaces();
  const bases = useKnowledgeBases();
  return (conversation: Conversation) => {
    const spaceName = conversation.scope?.spaces?.[0];
    const space =
      spaceName && hasModule("spaces")
        ? spaces.data?.find((s) => s.name === spaceName)
        : undefined;
    if (space)
      return (
        <StatusChip
          label={space.displayName ?? ""}
          icon={spaceType(space.spaceType, settings ?? undefined).icon}
        />
      );
    const base = (bases.data ?? []).find(
      (b) =>
        b.access !== "LOCKED" &&
        conversation.scope?.collections?.includes(b.name ?? ""),
    );
    return base ? (
      <StatusChip label={base.displayName ?? ""} icon={BookOpen} />
    ) : null;
  };
}

function TitleCell({
  conversation,
  context,
}: {
  conversation: Conversation;
  context: ReactNode;
}) {
  const last = useLastAnswer(conversation);
  return (
    <>
      <div className="row gap-8">
        <span
          className="cell-title truncate"
          translate={conversation.displayName ? "no" : undefined}
        >
          {conversationTitle(conversation)}
        </span>
        {context}
      </div>
      {last ? (
        <div className="cell-sub truncate conv-sub" translate="no">
          {last}
        </div>
      ) : null}
    </>
  );
}

function LastAnswerCell({ conversation }: { conversation: Conversation }) {
  const last = useLastAnswer(conversation);
  return (
    <span className="muted truncate" translate="no">
      {last}
    </span>
  );
}

/** `/chats` (preview `P.chats`): every conversation of the caller, searchable and sortable, with rename, move to project and delete. */
export function ChatsPage() {
  const params = useSearchParams();
  const model = useConversationModel();
  const contextOf = useContext();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const [page, setPage] = useState(1);

  /** Search lives in `?q=` so the list can be linked (⌘K "See all"). */
  const search = (value: string) => {
    setQ(value);
    setPage(1);
    const url = new URL(window.location.href);
    if (value.trim()) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", url);
  };

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const found = needle
      ? model.conversations.filter((c) =>
          conversationTitle(c).toLowerCase().includes(needle),
        )
      : model.conversations;
    if (!sort) return found;
    const sign = sort.direction === "ascending" ? 1 : -1;
    return [...found].sort((a, b) =>
      sort.column === "title"
        ? sign *
          conversationTitle(a)
            .toLowerCase()
            .localeCompare(conversationTitle(b).toLowerCase())
        : sign * (conversationTime(a) - conversationTime(b)),
    );
  }, [model.conversations, q, sort]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PER));
  const current = Math.min(page, pageCount);

  const columns: DataTableColumn<Conversation>[] = [
    {
      id: "title",
      header: "Title",
      primary: true,
      className: "conv-title-cell",
      sortValue: (c) => conversationTitle(c).toLowerCase(),
      cell: (c) => <TitleCell conversation={c} context={contextOf(c)} />,
    },
    {
      id: "last",
      header: "Last answer",
      hideOnMobile: true,
      className: "conv-preview",
      cell: (c) => <LastAnswerCell conversation={c} />,
    },
    {
      id: "at",
      header: "Updated",
      className: "conv-updated",
      sortValue: conversationTime,
      cell: (c) => (
        <span className="muted num">{rel(conversationTime(c))}</span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "table__cell--actions",
      cell: (c) => <ConversationMenu conversation={c} />,
    },
  ];

  const none = (
    <EmptyState
      icon={MessageSquare}
      title="No conversations yet"
      description="Ask a question and your conversations appear here."
      actions={<NewChatButton />}
      boxed
    />
  );

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Conversations" }]} />
      <PageHeader title="Conversations" actions={<NewChatButton />} />
      <div className="toolbar">
        <SearchInput
          value={q}
          onChange={search}
          placeholder="Search conversations"
          label="Search conversations"
        />
      </div>
      <Gate
        query={{ ...model, data: model.conversations }}
        skeleton={<SkeletonRows rows={6} />}
        isEmpty={(list) => list.length === 0}
        empty={none}
      >
        {rows.length ? (
          <DataTable
            label="Conversations"
            rows={paginate(rows, current, PER)}
            columns={columns}
            getRowId={(c) => c.name ?? ""}
            sort={sort}
            onSortChange={(next) => {
              setSort(next);
              setPage(1);
            }}
            rowHref={(c) => `/chat/${c.name?.split("/").pop() ?? ""}`}
            footer={
              rows.length > PER ? (
                <Pager
                  page={current}
                  pageSize={PER}
                  total={rows.length}
                  onPageChange={setPage}
                />
              ) : null
            }
          />
        ) : (
          <NoMatches what="conversations" onClear={() => search("")} />
        )}
      </Gate>
    </Page>
  );
}
