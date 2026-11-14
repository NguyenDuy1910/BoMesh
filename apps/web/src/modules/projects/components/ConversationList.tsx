"use client";

import { BookOpen, Folder, MessageSquare } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { ClearFilters, EmptyState, ErrorState, FilterButton, List, ListItem, NoMatches, Pager, paginate, SearchInput, SkeletonRows, StatusChip, Tip } from "@/components/ui";
import { fmtDateTime, fmtNum, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { spaceType, useMySpaces } from "@/modules/spaces";

import { projectsAvailable } from "../adapter";
import { answerFirstLine, conversationTime, conversationTitle, type Conversation } from "../conversations";
import { useConversationModel } from "../queries";
import { ConversationMenu } from "./ConversationMenu";

const PER = 20;
/** Search and the Project filter appear once the list needs them (preview `needsTools`). */
const TOOLS_MIN = 7;
const NO_PROJECT = "none";

/**
 * AI Chat's list, below the composer (preview `conversations.js` `listHtml()`): title, where it lives (project, space or
 * collection), last answer, when. The whole row opens the conversation; ⋯ (on hover) renames, moves or deletes it.
 */
export function ConversationList() {
  const { hasModule, settings, member } = useWorkspace();
  const model = useConversationModel();
  const spaces = useMySpaces();
  const bases = useKnowledgeBases();
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [page, setPage] = useState(1);

  const all = model.conversations;
  const projects = projectsAvailable ? model.projects.map((p) => p.project) : [];
  const projectFilter = project && (project === NO_PROJECT || projects.some((p) => p.id === project)) ? project : "";
  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      all.filter((c) => {
        const inProject = model.projectOf.get(c.name ?? "");
        if (projectFilter && (projectFilter === NO_PROJECT ? inProject : inProject?.id !== projectFilter)) return false;
        return !needle || conversationTitle(c).toLowerCase().includes(needle) || answerFirstLine(c.lastAnswerSnippet).toLowerCase().includes(needle);
      }),
    [all, model.projectOf, projectFilter, needle],
  );
  const filtering = !!needle || !!projectFilter;
  const tools = !model.isPending && (all.length >= TOOLS_MIN || filtering);
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / PER)));
  const clear = () => {
    setQ("");
    setProject("");
    setPage(1);
  };

  /** Where a conversation lives: its project, else its space, else the one collection it searched. */
  const context = (c: Conversation): ReactNode => {
    const p = model.projectOf.get(c.name ?? "");
    if (p) return <StatusChip label={p.displayName} icon={Folder} size="sm" />;
    const spaceName = hasModule("spaces") ? c.scope?.spaces?.[0] : undefined;
    const space = spaceName ? (spaces.data ?? []).find((s) => s.name === spaceName) : undefined;
    if (space) return <StatusChip label={space.displayName} icon={spaceType(space.spaceType, settings ?? undefined).icon} size="sm" />;
    const base = (bases.data ?? []).find((b) => b.access !== "LOCKED" && c.scope?.collections?.includes(b.name ?? ""));
    if (!base) return null;
    return <StatusChip label={base.name === member.personalCollection ? "My files" : (base.displayName ?? "")} icon={BookOpen} size="sm" />;
  };

  let body: ReactNode;
  if (model.isPending) body = <SkeletonRows rows={4} />;
  else if (model.isError && !all.length) body = <ErrorState error={model.error} onRetry={model.refetch} />;
  else if (!all.length) body = <EmptyState icon={MessageSquare} title="No conversations yet" description="Ask a question above. Your conversations stay here, so you can pick one up later." compact />;
  else if (!rows.length) body = <NoMatches what="conversations" onClear={clear} />;
  else
    body = (
      <>
        <List className="conv-list">
          {paginate(rows, current, PER).map((c) => {
            const last = answerFirstLine(c.lastAnswerSnippet);
            const at = conversationTime(c);
            return (
              <ListItem
                key={c.name}
                className="conv-row"
                title={conversationTitle(c)}
                contentTitle={!!c.displayName}
                titleExtra={context(c)}
                description={last ? <span translate="no">{last}</span> : undefined}
                meta={
                  <Tip content={fmtDateTime(at)}>
                    <span className="num">{rel(at)}</span>
                  </Tip>
                }
                href={`/chat/${c.name?.split("/").pop() ?? ""}`}
                actions={
                  <span className="reveal-on-hover">
                    <ConversationMenu conversation={c} />
                  </span>
                }
              />
            );
          })}
        </List>
        {rows.length > PER ? <Pager page={current} pageSize={PER} total={rows.length} onPageChange={setPage} /> : null}
      </>
    );

  return (
    <section className="conv-sec" aria-labelledby="conv-h">
      <div className="conv-head">
        <h2 className="conv-head__title" id="conv-h">
          Conversations
        </h2>
        {!model.isPending && all.length ? <span className="conv-head__count num">{fmtNum(all.length)}</span> : null}
        <span className="grow" />
        {tools ? (
          <div className="conv-tools">
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder="Search conversations"
              label="Search conversations"
            />
            {projects.length ? (
              <FilterButton
                label="Project"
                value={projectFilter}
                onChange={(v) => {
                  setProject(v);
                  setPage(1);
                }}
                options={[{ value: NO_PROJECT, label: "No project" }, ...projects.map((p) => ({ value: p.id, label: p.displayName }))]}
              />
            ) : null}
            <ClearFilters isActive={filtering} onClear={clear} />
          </div>
        ) : null}
      </div>
      {body}
    </section>
  );
}
