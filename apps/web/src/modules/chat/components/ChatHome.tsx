"use client";

import { Button, Tooltip } from "@heroui/react";
import { FileText, List as ListIcon, Users } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { useWorkspace } from "@/lib/workspace";
import { useComposerFiles, useFileDrop } from "@/modules/artifacts";
import { getItem, itemName } from "@/modules/knowledge/api";
import { useMySpaces } from "@/modules/spaces";
import { newWorkHref, workflowsFor } from "@/modules/work/kinds";

import type { ConversationScope } from "../api";
import { useAssistant } from "../queries";
import { sentFiles } from "../runtime";
import { useStartConversation } from "../useStartConversation";
import { Composer, useDraft } from "./Composer";

const STARTER_ICONS = [FileText, ListIcon, Users];

/** Home scope survives navigation like the draft (preview `composer('home')`). */
let homeScope: ConversationScope = {};

/**
 * `/chat` (preview `P.chatHome`): the published assistant's welcome, the big
 * composer with quick starts, and up to three starters for the caller's role.
 *
 * URL entry (wave-2 contract): `q` drafts the question (`send=1` sends at once),
 * `scope` (collection item IDs, repeatable), `space` (space ID), `doc`
 * (document item IDs, repeatable → attachments) and `project` (project ID).
 */
export function ChatHome() {
  const { id: ws, workspace, member, settings, hasModule } = useWorkspace();
  const assistant = useAssistant();
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
    const next: ConversationScope = space && hasModule("spaces")
      ? { spaces: [`workspaces/${ws}/spaces/${space}`] }
      : params.getAll("scope").length
        ? { collections: params.getAll("scope").map((c) => itemName(ws, c)) }
        : {};
    const docIds = [...new Set(params.getAll("doc").flatMap((d) => d.split(",")).filter(Boolean))].slice(0, 10);
    const projectId = params.get("project");
    router.replace("/chat");
    void (async () => {
      const items = (await Promise.all(docIds.map((d) => getItem(ws, d).catch(() => null)))).filter((i) => !!i && i.itemType === "DOCUMENT");
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
    })();
  }, [params, router, ws, hasModule, start, setDraft, files]);

  const send = async (question = draft.trim()) => {
    if (!question || !files.ready || pending) return;
    const ok = await start({ question, scope, attachments: files.attachments, files: sentFiles(files.files), project });
    if (!ok) return;
    setDraft("");
    files.clear();
    setScope({});
    setProject(null);
  };

  const a = assistant.data;
  const roles = member.roles ?? [];
  const starters = (a?.starterPrompts ?? []).filter((s) => s.prompt && (!s.roles?.length || s.roles.some((r) => roles.includes(r)))).slice(0, 3);
  const placeholder = hasModule("spaces") ? `Ask anything in ${workspace.displayName ?? "your workspace"}` : "Ask anything about your company knowledge";

  // Quick starts: AI workflows fitting what's being searched (a space, or everywhere).
  const space = scope.spaces?.[0] ? (spaces.data ?? []).find((s) => s.name === scope.spaces![0]) ?? null : null;
  const workflows = hasModule("work") && settings ? workflowsFor(settings, space).slice(0, 3) : [];

  return (
    <div className="chat-home chat-drop" {...drop.dropProps}>
      <PageChrome crumbs={[{ label: "New chat" }]} />
      {drop.overlay}
      <div className="chat-home__inner">
        <h1 className="chat-home__title">{a?.welcomeMessage || "What can I help you find?"}</h1>
        <div className="chat-home__ask">
          <Composer
            lg
            draft={draft}
            onDraftChange={setDraft}
            attachments={files}
            scope={scope}
            onScopeChange={setScope}
            placeholder={placeholder}
            onSend={() => void send()}
          />
          {workflows.length ? (
            <div className="chat-quick" role="group" aria-label={space ? `Start work in ${space.displayName}` : "Start work"}>
              {workflows.map((w) => (
                <Tooltip key={w.id}>
                  <Button variant="tertiary" size="sm" onPress={() => router.push(newWorkHref({ workflow: w.id, space: space?.name }))}>
                    <w.icon className="i" aria-hidden />
                    {w.label}
                  </Button>
                  <Tooltip.Content>{w.desc}</Tooltip.Content>
                </Tooltip>
              ))}
            </div>
          ) : null}
        </div>
        {starters.length ? (
          <div className="chat-starters" id="chat-starters">
            {starters.map((s, i) => {
              const Icon = STARTER_ICONS[i % 3]!;
              return (
                <button key={`${s.title}-${i}`} type="button" className="card card--action chat-starter" onClick={() => void send(s.prompt!.trim())} disabled={pending}>
                  <span className="chat-starter__title">
                    <Icon className="i i-sm" aria-hidden />
                    {s.title || s.prompt}
                  </span>
                  <span className="chat-starter__prompt clamp-2">{s.prompt}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
