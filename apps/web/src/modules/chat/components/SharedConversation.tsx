"use client";

import { Lock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NoAccess } from "@/components/shell/NoAccess";
import { NotFoundState } from "@/components/shell/NotFoundState";
import { PageChrome } from "@/components/shell/page-chrome";
import { Callout } from "@/components/ui/Callout";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { ApiError } from "@/lib/api/client";
import { fmtDateTime } from "@/lib/format";

import { sourcesFromCitations } from "../citations";
import { useShare } from "../queries";
import type { AnswerView } from "../thread";
import { CitationPanel } from "./CitationPanel";
import { Answer, UserMessage } from "./ThreadMessages";

const noop = () => {};

/**
 * `/chat/<c>/shares/<s>`: a shared conversation, read-only (GetShare snapshot,
 * conversation_loop.md "Sharing"). Not in the preview, which never opens a
 * share link: it reuses the thread's messages, answer and source panel.
 * Turns the reader can't open are withheld by the server and shown as the
 * no-access call-out.
 */
export function SharedConversation({ conversation, share }: { conversation: string; share: string }) {
  const query = useShare(conversation, share);
  const [cite, setCite] = useState<{ answer: string; n: number } | null>(null);
  /* No composer here: closing the panel returns focus to the marker or chip that opened it. */
  const opener = useRef<HTMLElement | null>(null);
  const closeCite = useCallback(() => {
    setCite(null);
    opener.current?.focus();
  }, []);
  const snapshot = query.data?.snapshot;
  const title = snapshot?.displayName || "Shared conversation";

  const rows = useMemo(
    () =>
      (snapshot?.messages ?? []).map((m, i) => {
        if (m.role === "USER") return { kind: "user" as const, key: `q${i}`, text: m.text ?? "" };
        if (m.available === false) return { kind: "withheld" as const, key: `a${i}` };
        const text = m.text ?? "";
        const answer: AnswerView = {
          key: `a${i}`,
          questionText: "",
          text,
          sources: sourcesFromCitations(text, m.citations ?? []),
          artifacts: [],
          steps: [],
          state: "COMPLETED",
          earlier: [],
          files: [],
        };
        return { kind: "answer" as const, key: answer.key, answer };
      }),
    [snapshot],
  );

  useEffect(() => {
    if (!cite) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[role=dialog], [role=menu]")) closeCite();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cite, closeCite]);

  if (query.error instanceof ApiError && query.error.status === 403) return <NoAccess />;
  if (query.error instanceof ApiError && query.error.status === 404) return <NotFoundState />;

  const panelSources = cite ? rows.find((r) => r.kind === "answer" && r.key === cite.answer) : undefined;
  const sources = panelSources?.kind === "answer" ? panelSources.answer.sources.filter((s) => s.available) : [];

  return (
    <div className="split chat-split">
      <PageChrome crumbs={[{ label: "Conversations", href: "/chats" }, { label: title }]} />
      <div className="split__main chat-main">
        <div className="chat-scroll">
          <div className="chat-thread">
            {query.isPending ? (
              <div aria-busy="true" aria-label="Loading" />
            ) : query.error ? (
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : (
              <>
                <PageHeader
                  title={<span translate="no">{title}</span>}
                  description={`Shared conversation${snapshot?.snapshotTime ? ` · ${fmtDateTime(snapshot.snapshotTime)}` : ""}`}
                />
                {rows.map((row) => {
                  if (row.kind === "user") {
                    return <UserMessage key={row.key} id={row.key} text={row.text} files={[]} canEdit={false} editing={false} onEdit={noop} onCancel={noop} onSave={noop} />;
                  }
                  if (row.kind === "withheld") {
                    return (
                      <div key={row.key} className="chat-msg chat-msg--ai">
                        <Callout icon={Lock} title="This answer uses knowledge you can’t access" description="Ask a workspace admin if you need it." />
                      </div>
                    );
                  }
                  return (
                    <Answer
                      key={row.key}
                      answer={row.answer}
                      title={title}
                      showSteps={false}
                      busy
                      scoped={false}
                      activeCite={cite?.answer === row.key ? cite.n : null}
                      activeArtifact={null}
                      onCite={(n) => {
                        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                        setCite({ answer: row.key, n });
                      }}
                      onOpenArtifact={noop}
                      onRetry={noop}
                      onFeedback={noop}
                      onFeedbackComment={noop}
                    />
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>
      {cite && sources.length ? (
        <CitationPanel sources={sources} n={cite.n} onShow={(n) => setCite({ ...cite, n })} onClose={closeCite} />
      ) : null}
    </div>
  );
}
