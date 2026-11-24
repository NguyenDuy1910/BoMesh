"use client";

import clsx from "clsx";
import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSyncExternalStore, type ReactNode } from "react";

import { Tip } from "@/components/ui/Tip";
import { useWorkspace } from "@/lib/workspace";
import { useComposerFiles, useFileDrop } from "@/modules/artifacts";
import { useMemberHome } from "@/modules/home/queries";
import { useMySpaces } from "@/modules/spaces";
import { newWorkHref, workflowsFor } from "@/modules/work/kinds";

import type { ConversationScope } from "../api";
import { sentFiles } from "../runtime";
import { useStartConversation } from "../useStartConversation";
import { Composer, useDraft } from "./Composer";
import { useScope } from "./ScopePicker";

/* The new-chat composer's scope and project survive navigation like its draft (preview `composer('home')`): Home and New chat
   show the same box. */
interface HomeStart {
  scope: ConversationScope;
  project: string | null;
}
let homeStart: HomeStart = { scope: {}, project: null };
const listeners = new Set<() => void>();

/** Sets the new-chat composer's scope and project (URL entry on `/chat`). */
export function setHomeStart(next: Partial<HomeStart>) {
  homeStart = { ...homeStart, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useHomeStart(): HomeStart {
  return useSyncExternalStore(subscribe, () => homeStart, () => homeStart);
}

/** Puts the caret at the end of the composer's text. */
export function focusComposer() {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLTextAreaElement>("#chat-input");
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
}

export interface NewChatBoxProps {
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * Starts a conversation (Home and New chat): the large composer with its scope and attachments, a drop zone for files, then one
 * row of suggestions. Sending creates the conversation and opens its thread.
 */
export function NewChatBox({ placeholder, autoFocus = false, className }: NewChatBoxProps) {
  const files = useComposerFiles("home");
  const drop = useFileDrop(files);
  const [draft, setDraft] = useDraft("home");
  const { scope, project } = useHomeStart();
  const { start, pending } = useStartConversation();

  const send = async () => {
    const question = draft.trim();
    if (!question || !files.ready || pending) return;
    const ok = await start({ question, scope, attachments: files.attachments, files: sentFiles(files.files), project });
    if (!ok) return;
    setDraft("");
    files.clear();
    setHomeStart({ scope: {}, project: null });
  };

  return (
    <div className={clsx("chat-start chat-drop", className)} {...drop.dropProps}>
      {drop.overlay}
      <Composer
        lg
        draft={draft}
        onDraftChange={setDraft}
        attachments={files}
        scope={scope}
        onScopeChange={(next) => setHomeStart({ scope: next })}
        placeholder={scope.spaces?.length || scope.collections?.length ? undefined : placeholder}
        autoFocus={autoFocus}
        onSend={() => void send()}
      />
      <Suggestions
        scope={scope}
        onPrompt={(prompt) => {
          setDraft(prompt);
          focusComposer();
        }}
      />
    </div>
  );
}

/**
 * One suggestion area under the composer, as short labels (preview `suggestions`): a chosen space (or one collection that a
 * space of yours has among its materials) with AI workflows shows its workflows; otherwise the starter prompts for your role.
 * A starter fills the box without sending; its full prompt shows on hover.
 */
function Suggestions({ scope, onPrompt }: { scope: ConversationScope; onPrompt: (prompt: string) => void }) {
  const { settings, hasModule } = useWorkspace();
  const where = useScope(scope);
  const spaces = useMySpaces();
  const home = useMemberHome();
  const router = useRouter();

  const one = where.chosen.length === 1 ? where.chosen[0]?.name : undefined;
  const scopeSpace = where.space ?? (one ? ((spaces.data ?? []).find((s) => s.callerRole && s.collections?.includes(one)) ?? null) : null);
  const workflows = hasModule("work") && settings && scopeSpace ? workflowsFor(settings, scopeSpace).slice(0, 3) : [];

  if (workflows.length && scopeSpace)
    return (
      <div className="chat-starters" id="chat-starters" role="group" aria-label={`Bắt đầu công việc trong ${scopeSpace.displayName}`}>
        {workflows.map((w) => (
          <Pill key={w.id} tip={w.desc} onClick={() => router.push(newWorkHref({ workflow: w.id, space: scopeSpace.name }))}>
            <w.icon className="i i-sm" aria-hidden />
            <span className="truncate">{w.label}</span>
          </Pill>
        ))}
      </div>
    );

  const starters = (home.data?.starterPrompts ?? []).filter((s) => s.prompt?.trim()).slice(0, 4);
  if (!starters.length) return null;
  return (
    <div className="chat-starters" id="chat-starters" role="group" aria-label="Câu hỏi gợi ý">
      {starters.map((s, i) => (
        <Pill key={`${s.title}-${i}`} tip={s.title ? s.prompt : undefined} onClick={() => onPrompt(s.prompt!.trim())}>
          <Sparkles className="i i-sm" aria-hidden />
          <span className="truncate" translate="no">
            {s.title || s.prompt}
          </span>
        </Pill>
      ))}
    </div>
  );
}

function Pill({ tip, onClick, children }: { tip?: string; onClick: () => void; children: ReactNode }) {
  const button = (
    <button type="button" className="chat-starter" onClick={onClick}>
      {children}
    </button>
  );
  return tip ? <Tip content={tip}>{button}</Tip> : button;
}
