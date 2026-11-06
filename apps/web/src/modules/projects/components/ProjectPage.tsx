"use client";

import { Button, buttonVariants } from "@heroui/react";
import { Folder, Plus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { Page } from "@/components/ui/Page";
import { PreviewChip } from "@/components/ui/PreviewChip";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { KnowledgePicker } from "@/modules/artifacts";
import { NewChatComposer } from "@/modules/chat/components/NewChatComposer";

import { useProjectActions } from "../actions";
import {
  DEV_DATA_TOOLTIP,
  projectsAdapter,
  projectsAvailable,
} from "../adapter";
import {
  conversationTime,
  conversationTitle,
  type Conversation,
} from "../conversations";
import {
  useConversationModel,
  useLastAnswer,
  useProjectReferences,
  type ProjectView,
} from "../queries";
import { MAX_PROJECT_REFERENCES } from "../types";
import { ConversationMenu } from "./ConversationMenu";
import { ProjectMenu } from "./ProjectMenu";

function HomeButton() {
  return (
    <Link href="/home" className={buttonVariants({ variant: "primary" })}>
      Home
    </Link>
  );
}

function ChatRow({ conversation }: { conversation: Conversation }) {
  const last = useLastAnswer(conversation);
  const title = conversationTitle(conversation);
  return (
    <div className="proj-chat">
      <Link
        className="proj-chat__link"
        href={`/chat/${resourceId(conversation.name)}`}
      >
        <span
          className="proj-chat__title truncate"
          translate={conversation.displayName ? "no" : undefined}
        >
          {title}
        </span>
        {last ? (
          <span className="proj-chat__last truncate" translate="no">
            {last}
          </span>
        ) : null}
      </Link>
      <span className="proj-chat__at">
        {rel(conversationTime(conversation))}
      </span>
      <ConversationMenu conversation={conversation} />
    </div>
  );
}

function Knowledge({ view }: { view: ProjectView }) {
  const { project } = view;
  const actions = useProjectActions();
  const refs = useProjectReferences(project.id);
  const room = MAX_PROJECT_REFERENCES - project.references.length;
  const [picking, setPicking] = useState(false);
  return (
    <section className="proj-sec" aria-labelledby="proj-docs-h">
      <div className="proj-sec__head">
        <h2 className="proj-sec__title" id="proj-docs-h">
          Knowledge
        </h2>
        <span className="proj-sec__note">
          {refs.items.length ? "Attached to every new chat here" : ""}
        </span>
        <span className="grow" />
        {room > 0 ? (
          <Button variant="ghost" size="sm" onPress={() => setPicking(true)}>
            <Plus className="i" aria-hidden />
            Add
          </Button>
        ) : null}
      </div>
      {refs.isPending && project.references.length ? (
        <SkeletonRows rows={1} />
      ) : refs.items.length ? (
        <div className="proj-docs">
          {refs.items.map((item) => {
            const name = item.displayName ?? item.document?.fileName ?? "";
            return (
              <span className="proj-doc" key={item.name}>
                <Link
                  className="proj-doc__link"
                  href={`/doc/${resourceId(item.name)}`}
                  title={name}
                >
                  <FileIcon
                    size="sm"
                    name={item.document?.fileName ?? name}
                    mime={item.document?.mimeType}
                  />
                  <span className="truncate" translate="no">
                    {name.replace(/\.[a-z0-9]{1,5}$/i, "")}
                  </span>
                </Link>
                <IconButton
                  icon={X}
                  tip={`Remove ${name} from this project`}
                  size="sm"
                  className="proj-doc__x"
                  onPress={() =>
                    void actions.removeReference(project, item.name ?? "")
                  }
                />
              </span>
            );
          })}
        </div>
      ) : (
        <p className="proj-empty">
          Add documents from Knowledge to use them in every chat in this
          project. Nothing is copied; access rules still apply.
        </p>
      )}
      {picking ? (
        <KnowledgePicker
          isOpen
          onOpenChange={setPicking}
          title={`Add knowledge to ${project.displayName}`}
          description="Every new chat in this project starts with these. Nothing is copied, and access rules still apply."
          exclude={project.references.map(resourceId)}
          room={room}
          roomFullText={`This project already has ${MAX_PROJECT_REFERENCES} documents`}
          onAdd={(items) => {
            setPicking(false);
            void actions.addReferences(project, items);
          }}
        />
      ) : null}
    </section>
  );
}

/** `/project/{id}` (preview `P.project`): start a chat in the project, its Knowledge references, its chats. */
export function ProjectPage({ id }: { id: string }) {
  const model = useConversationModel();

  if (!projectsAvailable) {
    return (
      <Page>
        <PageChrome crumbs={[{ label: "Project" }]} />
        <EmptyState
          icon={Folder}
          title="Projects aren’t available yet"
          description="This workspace can’t keep projects yet. Your chats are in Recent and in All conversations."
          actions={
            <Link
              href="/chats"
              className={buttonVariants({ variant: "primary" })}
            >
              All conversations
            </Link>
          }
          boxed
        />
      </Page>
    );
  }
  if (model.isPending) {
    return (
      <Page narrow className="proj">
        <PageChrome crumbs={[{ label: "Project" }]} />
        <SkeletonRows rows={4} />
      </Page>
    );
  }
  if (model.isError) {
    return (
      <Page narrow className="proj">
        <PageChrome crumbs={[{ label: "Project" }]} />
        <ErrorState error={model.error} onRetry={model.refetch} />
      </Page>
    );
  }
  const view = model.projects.find((p) => p.project.id === id);
  if (!view) {
    return (
      <Page>
        <PageChrome crumbs={[{ label: "Project not found" }]} />
        <EmptyState
          icon={Folder}
          title="This project isn’t available"
          description="It may have been deleted, or it belongs to someone else."
          actions={<HomeButton />}
          boxed
        />
      </Page>
    );
  }
  const { project, conversations } = view;
  return (
    <Page narrow className="proj">
      <PageChrome crumbs={[{ label: project.displayName }]} />
      <header className="proj-head">
        <span className="proj-head__icon" aria-hidden>
          <Folder className="i" />
        </span>
        <h1 className="proj-head__title" translate="no">
          {project.displayName}
        </h1>
        {projectsAdapter.status === "development" ? (
          <PreviewChip label="Development data" tooltip={DEV_DATA_TOOLTIP} />
        ) : null}
        <ProjectMenu
          project={project}
          conversationCount={conversations.length}
          label="Project options"
          size="md"
        />
      </header>
      <div className="proj-ask chat-drop">
        <NewChatComposer
          key={project.id}
          placeholder={`New chat in ${project.displayName}`}
          project={project.id}
          lg
        />
      </div>
      <Knowledge view={view} />
      <section className="proj-sec" aria-labelledby="proj-chats-h">
        <div className="proj-sec__head">
          <h2 className="proj-sec__title" id="proj-chats-h">
            Chats
          </h2>
        </div>
        {conversations.length ? (
          <div className="proj-chats">
            {conversations.map((c) => (
              <ChatRow key={c.name} conversation={c} />
            ))}
          </div>
        ) : (
          <p className="proj-empty">
            Chats you start here stay in this project. You can also move a chat
            here from its ⋯ menu.
          </p>
        )}
      </section>
    </Page>
  );
}
