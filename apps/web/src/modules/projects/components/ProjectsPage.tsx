"use client";

import { Button } from "@heroui/react";
import { Folder, FolderPlus } from "lucide-react";
import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { useState } from "react";

import { EmptyState, Gate, ItemIcon, List, ListItem, NoMatches, Page, PageHeader, PreviewChip, SearchInput, SkeletonRows } from "@/components/ui";
import { plural, rel } from "@/lib/format";
import { useMessages } from "@/lib/i18n";

import { DEV_DATA_TOOLTIP, projectsAdapter, projectsAvailable } from "../adapter";
import { useConversationModel } from "../queries";
import { openProjectDialog } from "../store";
import { ProjectMenu } from "./ProjectMenu";

/** Loads on first open: the name dialog is never on screen at first paint. */
const ProjectDialogs = dynamic(() => import("./ProjectDialogs").then((m) => m.ProjectDialogs), { ssr: false });

/** Search appears once the list needs it (preview `needsTools`). */
const TOOLS_MIN = 7;

function NewProjectButton() {
  return (
    <Button variant="primary" onPress={() => openProjectDialog({ kind: "new-project" })}>
      <FolderPlus className="i" aria-hidden />
      Dự án mới
    </Button>
  );
}

/** `/projects` (preview `P.projects`): your project folders, most recently used first; ⋯ Rename / Delete (Undo). Without projects (production API) → New chat. */
export function ProjectsPage() {
  if (!projectsAvailable) redirect("/chat");
  return <ProjectsList />;
}

function ProjectsList() {
  const msg = useMessages();
  const model = useConversationModel(true);
  const [q, setQ] = useState("");

  const projects = model.projects;
  const needle = q.trim().toLowerCase();
  const rows = needle ? projects.filter((p) => p.project.displayName.toLowerCase().includes(needle)) : projects;
  const tools = projects.length >= TOOLS_MIN || !!q;
  const dev = projectsAdapter.status === "development" ? <PreviewChip label="Dữ liệu phát triển" tooltip={DEV_DATA_TOOLTIP} /> : null;

  return (
    <Page width="narrow">
      {/* The empty state carries the one New project; with folders it moves to the header. */}
      <PageHeader title={msg.nav.projects} chips={dev} actions={projects.length ? <NewProjectButton /> : null} />
      <Gate
        query={{ ...model, data: model.isPending ? undefined : projects }}
        skeleton={<SkeletonRows rows={4} />}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            icon={Folder}
            title="Chưa có dự án nào"
            description="Dự án gom các cuộc trò chuyện liên quan lại với nhau, kèm các tài liệu mà mọi cuộc trò chuyện mới trong dự án đều dùng. Chỉ bạn thấy được dự án của mình."
            actions={<NewProjectButton />}
            boxed
          />
        }
      >
        {tools ? (
          <div className="toolbar">
            <SearchInput value={q} onChange={setQ} placeholder="Tìm dự án" label="Tìm dự án" />
          </div>
        ) : null}
        {rows.length ? (
          <List className="proj-list">
            {rows.map(({ project, conversations, lastAt }) => (
              <ListItem
                key={project.id}
                lead={<ItemIcon icon={Folder} size="sm" />}
                title={project.displayName}
                contentTitle
                description={`${plural(conversations.length, "conversation")} · ${plural(project.references.length, "document")}`}
                meta={rel(lastAt)}
                href={`/project/${project.id}`}
                actions={
                  <span className="reveal-on-hover">
                    <ProjectMenu project={project} conversationCount={conversations.length} />
                  </span>
                }
              />
            ))}
          </List>
        ) : (
          <NoMatches what="dự án" onClear={() => setQ("")} />
        )}
      </Gate>
      <ProjectDialogs />
    </Page>
  );
}
