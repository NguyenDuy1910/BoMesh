"use client";

import { Button, buttonVariants } from "@heroui/react";
import { BookOpen, Folder, MessageSquarePlus, Plus, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { redirect } from "next/navigation";
import { useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState, ErrorState, FileIcon, IconButton, Page, PreviewChip, SkeletonRows, Tip } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtNum, rel } from "@/lib/format";
import { KnowledgePicker } from "@/modules/artifacts";
import { NewChatComposer } from "@/modules/chat/components/NewChatComposer";

import { useProjectActions } from "../actions";
import { DEV_DATA_TOOLTIP, projectsAdapter, projectsAvailable } from "../adapter";
import { answerFirstLine, conversationTime, conversationTitle, type Conversation } from "../conversations";
import { useConversationModel, useProjectReferences, type ProjectView } from "../queries";
import { MAX_PROJECT_REFERENCES } from "../types";
import { ConversationMenu } from "./ConversationMenu";
import { ProjectMenu } from "./ProjectMenu";

/** Loads on first open: the name dialog is never on screen at first paint. */
const ProjectDialogs = dynamic(() => import("./ProjectDialogs").then((m) => m.ProjectDialogs), { ssr: false });

const bare = (n: string) => n.replace(/\.[a-z0-9]{1,5}$/i, "");

function ChatRow({ conversation }: { conversation: Conversation }) {
  const last = answerFirstLine(conversation.lastAnswerSnippet);
  return (
    <div className="proj-chat">
      <Link className="proj-chat__link" href={`/chat/${resourceId(conversation.name)}`}>
        <span className="proj-chat__title truncate" translate={conversation.displayName ? "no" : undefined}>
          {conversationTitle(conversation)}
        </span>
        {last ? (
          <span className="proj-chat__last truncate" translate="no">
            {last}
          </span>
        ) : null}
      </Link>
      <span className="proj-chat__at">{rel(conversationTime(conversation))}</span>
      <span className="reveal-on-hover">
        <ConversationMenu conversation={conversation} className="proj-chat__more" />
      </span>
    </div>
  );
}

/** Project documents (preview `knowledge`): references to Knowledge attached to every new chat here, ≤ 10. */
function ProjectDocuments({ view }: { view: ProjectView }) {
  const { project } = view;
  const actions = useProjectActions();
  const refs = useProjectReferences(project.id);
  const room = MAX_PROJECT_REFERENCES - project.references.length;
  const [picking, setPicking] = useState(false);
  const docs = refs.items;
  return (
    <section className="proj-sec" aria-labelledby="proj-docs-h">
      <div className="proj-sec__head">
        <h2 className="proj-sec__title" id="proj-docs-h">
          Tài liệu dự án
        </h2>
        <span className="proj-sec__note">{docs.length ? "Mọi cuộc trò chuyện mới ở đây đều bắt đầu với các tài liệu này" : ""}</span>
        <span className="grow" />
        {docs.length && room > 0 ? (
          <Button variant="ghost" size="sm" onPress={() => setPicking(true)}>
            <Plus className="i" aria-hidden />
            Thêm
          </Button>
        ) : docs.length ? (
          <span className="proj-sec__note">{`${MAX_PROJECT_REFERENCES}/${MAX_PROJECT_REFERENCES}`}</span>
        ) : null}
      </div>
      {refs.isPending && project.references.length ? (
        <SkeletonRows rows={1} />
      ) : docs.length ? (
        <div className="proj-docs">
          {docs.map((item) => {
            const name = item.displayName ?? item.document?.fileName ?? "";
            return (
              <span className="proj-doc" key={item.name}>
                <Tip content={name}>
                  <Link className="proj-doc__link" href={`/doc/${resourceId(item.name)}`}>
                    <FileIcon size="sm" name={item.document?.fileName ?? name} mime={item.document?.mimeType} />
                    <span className="truncate" translate="no">
                      {bare(name)}
                    </span>
                  </Link>
                </Tip>
                <span className="reveal-on-hover">
                  <IconButton icon={X} tip={`Gỡ ${name} khỏi dự án này`} size="sm" className="proj-doc__x" onPress={() => void actions.removeReference(project, item.name ?? "")} />
                </span>
              </span>
            );
          })}
        </div>
      ) : (
        // Empty: one clear, clickable invitation instead of a hint plus a separate button.
        <button type="button" className="proj-add" onClick={() => setPicking(true)}>
          <span className="proj-add__icon" aria-hidden>
            <BookOpen className="i" />
          </span>
          <span className="proj-add__body">
            <span className="proj-add__title">Thêm tài liệu từ mục Tài liệu</span>
            <span className="proj-add__desc">Mọi cuộc trò chuyện mới ở đây sẽ bắt đầu với các tài liệu này. Không có gì bị sao chép; quy tắc truy cập vẫn được áp dụng.</span>
          </span>
          <Plus className="i proj-add__go" aria-hidden />
        </button>
      )}
      {picking ? (
        <KnowledgePicker
          isOpen
          onOpenChange={setPicking}
          title={`Thêm tài liệu vào ${project.displayName}`}
          description="Các cuộc trò chuyện mới trong dự án này sẽ bắt đầu với những tài liệu này. Không có gì bị sao chép; quy tắc truy cập vẫn được áp dụng."
          exclude={project.references.map(resourceId)}
          room={room}
          roomFullText={`Dự án này đã có ${MAX_PROJECT_REFERENCES} tài liệu.`}
          onAdd={(items) => {
            setPicking(false);
            void actions.addReferences(project, items);
          }}
        />
      ) : null}
    </section>
  );
}

const PROJECTS_CRUMB = { label: "Dự án", href: "/projects" };

/** `/project/{id}` (preview `P.project`): start a chat with the project documents attached, its documents, its conversations. Without projects (production API) → New chat. */
export function ProjectPage({ id }: { id: string }) {
  if (!projectsAvailable) redirect("/chat");
  return <ProjectBody id={id} />;
}

function ProjectBody({ id }: { id: string }) {
  const model = useConversationModel(true);
  if (model.isPending || model.isError) {
    return (
      <Page width="narrow" className="proj">
        <PageChrome title="Dự án" crumbs={[PROJECTS_CRUMB]} />
        {model.isError ? <ErrorState error={model.error} onRetry={model.refetch} /> : <SkeletonRows rows={4} />}
      </Page>
    );
  }
  const view = model.projects.find((p) => p.project.id === id);
  if (!view) {
    return (
      <Page>
        <PageChrome title="Không tìm thấy dự án" crumbs={[PROJECTS_CRUMB]} />
        <EmptyState
          icon={Folder}
          title="Không có dự án này"
          description="Có thể nó đã bị xóa hoặc thuộc về người khác."
          actions={
            <>
              <Link href="/projects" className={buttonVariants({ variant: "primary" })}>
                Dự án
              </Link>
              <Link href="/chat" className={buttonVariants({ variant: "secondary" })}>
                <MessageSquarePlus className="i" aria-hidden />
                Trò chuyện mới
              </Link>
            </>
          }
          boxed
        />
      </Page>
    );
  }
  const { project, conversations } = view;
  return (
    <Page width="narrow" className="proj">
      <PageChrome title={project.displayName} crumbs={[PROJECTS_CRUMB]} hero />
      <header className="proj-head">
        <span className="proj-head__icon" aria-hidden>
          <Folder className="i" />
        </span>
        <h1 className="proj-head__title" translate="no">
          {project.displayName}
        </h1>
        {projectsAdapter.status === "development" ? <PreviewChip label="Dữ liệu phát triển" tooltip={DEV_DATA_TOOLTIP} /> : null}
        <ProjectMenu project={project} conversationCount={conversations.length} label="Tùy chọn dự án" size="md" />
      </header>
      <div className="proj-ask chat-drop">
        <NewChatComposer key={project.id} placeholder={`Trò chuyện mới trong ${project.displayName}`} project={project.id} lg />
      </div>
      <ProjectDocuments view={view} />
      <section className="proj-sec" aria-labelledby="proj-chats-h">
        <div className="proj-sec__head">
          <h2 className="proj-sec__title" id="proj-chats-h">
            Cuộc trò chuyện
          </h2>
          {conversations.length ? <span className="proj-sec__count num">{fmtNum(conversations.length)}</span> : null}
        </div>
        {conversations.length ? (
          <div className="proj-chats">
            {conversations.map((c) => (
              <ChatRow key={c.name} conversation={c} />
            ))}
          </div>
        ) : (
          <p className="proj-empty">Các cuộc trò chuyện bạn bắt đầu ở đây sẽ nằm trong dự án này. Bạn cũng có thể chuyển một cuộc trò chuyện vào đây từ menu ⋯ của nó.</p>
        )}
      </section>
      <ProjectDialogs />
    </Page>
  );
}
