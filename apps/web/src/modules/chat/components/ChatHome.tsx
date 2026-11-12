"use client";

import { FileText, List as ListIcon, Users } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useComposerFiles, useFileDrop } from "@/modules/artifacts";
import { batchGetItems, itemName } from "@/modules/knowledge/api";
import { useConversations } from "@/modules/projects";
import { ConversationList } from "@/modules/projects/components/ConversationList";
import { useMySpaces } from "@/modules/spaces";
import { newWorkHref, workflowsFor } from "@/modules/work/kinds";

import type { ConversationScope } from "../api";
import { useAssistant } from "../queries";
import { sentFiles } from "../runtime";
import { useStartConversation } from "../useStartConversation";
import { Composer, useDraft } from "./Composer";
import { useScope } from "./ScopePicker";

/** Loads on first open: the conversation name dialogs are never on screen at first paint. */
const ProjectDialogs = dynamic(() => import("@/modules/projects/components/ProjectDialogs").then((m) => m.ProjectDialogs), { ssr: false });

const STARTER_ICONS = [FileText, ListIcon, Users];

/** Home scope survives navigation like the draft (preview `composer('home')`). */
let homeScope: ConversationScope = {};

/** Puts the caret at the end of the composer's text. */
function focusComposer() {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLTextAreaElement>("#chat-input");
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
}

/**
 * `/chat` AI Chat (preview `P.chatHome`): one destination to start a conversation — the published assistant's welcome,
 * the composer with its scope and attachments, one suggestion area — and to pick up any earlier one (the list below).
 *
 * URL entry: `q` drafts the question (`send=1` sends at once), `scope` (collection item IDs, repeatable), `space`
 * (space ID), `doc` (document item IDs, repeatable → attachments) and `project` (project ID).
 */
export function ChatHome() {
  const { id: ws, member, settings, hasModule } = useWorkspace();
  const assistant = useAssistant();
  const conversations = useConversations();
  const spaces = useMySpaces();
  const router = useRouter();
  const params = useSearchParams();
  const files = useComposerFiles("home");
  const drop = useFileDrop(files);
  const [draft, setDraft] = useDraft("home");
  const [scope, setScopeState] = useState<ConversationScope>(homeScope);
  const setScope = (next: ConversationScope) => {
    homeScope = next;
    setScopeState(next);
  };
  const where = useScope(scope);
  const [project, setProject] = useState<string | null>(null);
  const { start, pending } = useStartConversation();

  /* URL entry: consume once, then clear the address. */
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current) return;
    const keys = ["q", "send", "scope", "space", "doc", "project"];
    if (!keys.some((k) => params.has(k))) return;
    consumed.current = true;
    const q = (params.get("q") ?? "").trim();
    const space = params.get("space");
    const next: ConversationScope =
      space && hasModule("spaces")
        ? { spaces: [`workspaces/${ws}/spaces/${space}`] }
        : params.getAll("scope").length
          ? { collections: params.getAll("scope").map((c) => itemName(ws, c)) }
          : {};
    const docIds = [...new Set(params.getAll("doc").flatMap((d) => d.split(",")).filter(Boolean))].slice(0, 10);
    const projectId = params.get("project");
    router.replace("/chat");
    void (async () => {
      const loaded = new Map((await batchGetItems(ws, docIds, { view: "FULL" }).catch(() => [])).map((i) => [resourceId(i.name), i]));
      const items = docIds.map((d) => loaded.get(resourceId(d))).filter((i) => !!i && i.itemType === "DOCUMENT");
      if (q && params.get("send") === "1") {
        await start({
          question: q,
          scope: next,
          attachments: items.map((i) => i!.name ?? ""),
          files: items.map((i) => ({ name: i!.displayName ?? "", item: i!.name, mime: i!.document?.mimeType })),
          project: projectId,
          replaceRunning: true,
        });
        return;
      }
      setScope(next);
      if (q) setDraft(q);
      if (items.length) files.addRefs(items.map((i) => i!));
      setProject(projectId);
      focusComposer();
    })();
  }, [params, router, ws, hasModule, start, setDraft, files]);

  const send = async () => {
    const question = draft.trim();
    if (!question || !files.ready || pending) return;
    const ok = await start({ question, scope, attachments: files.attachments, files: sentFiles(files.files), project });
    if (!ok) return;
    setDraft("");
    files.clear();
    setScope({});
    setProject(null);
  };

  /* One suggestion area: a chosen space (or one collection of a space) with AI workflows shows its workflows; otherwise
     the starter questions, only before the first conversation. A starter fills the box without sending. */
  const a = assistant.data;
  const scopeSpace =
    where.space ?? (where.chosen.length === 1 && where.chosen[0]?.collection?.space ? ((spaces.data ?? []).find((s) => s.name === where.chosen[0]!.collection!.space) ?? null) : null);
  const workflows = hasModule("work") && settings && scopeSpace ? workflowsFor(settings, scopeSpace).slice(0, 3) : [];
  const first = conversations.isSuccess && !conversations.data.length;
  const roles = member.roles ?? [];
  const starters = first ? (a?.starterPrompts ?? []).filter((s) => s.prompt && (!s.roles?.length || s.roles.some((r) => roles.includes(r)))).slice(0, 3) : [];

  let suggestions: ReactNode = null;
  if (workflows.length && scopeSpace)
    suggestions = (
      <div className="chat-starters" id="chat-starters" role="group" aria-label={`Start work in ${scopeSpace.displayName}`}>
        {workflows.map((w) => (
          <button key={w.id} type="button" className="chat-starter" onClick={() => router.push(newWorkHref({ workflow: w.id, space: scopeSpace.name }))}>
            <span className="chat-starter__title">
              <w.icon className="i i-sm" aria-hidden />
              <span className="truncate">{w.label}</span>
            </span>
            {w.desc ? <span className="chat-starter__prompt clamp-2">{w.desc}</span> : null}
          </button>
        ))}
      </div>
    );
  else if (starters.length)
    suggestions = (
      <div className="chat-starters" id="chat-starters" role="group" aria-label="Suggested questions">
        {starters.map((s, i) => {
          const Icon = STARTER_ICONS[i % 3]!;
          return (
            <button
              key={`${s.title}-${i}`}
              type="button"
              className="chat-starter"
              onClick={() => {
                setDraft(s.prompt!.trim());
                focusComposer();
              }}
            >
              <span className="chat-starter__title">
                <Icon className="i i-sm" aria-hidden />
                <span className="truncate">{s.title || s.prompt}</span>
              </span>
              {s.title ? <span className="chat-starter__prompt clamp-2">{s.prompt}</span> : null}
            </button>
          );
        })}
      </div>
    );

  return (
    <div className="chat-home chat-drop" {...drop.dropProps}>
      {/* The welcome is this page's heading: the top row stays empty. */}
      <PageChrome hero />
      {drop.overlay}
      <div className="chat-home__inner">
        <div className="chat-home__start">
          <h1 className="chat-home__title">{a?.welcomeMessage || "What can I help you find?"}</h1>
          <Composer lg draft={draft} onDraftChange={setDraft} attachments={files} scope={scope} onScopeChange={setScope} onSend={() => void send()} />
          {suggestions}
        </div>
        <ConversationList />
      </div>
      <ProjectDialogs />
    </div>
  );
}
