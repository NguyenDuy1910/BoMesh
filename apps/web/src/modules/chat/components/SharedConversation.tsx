"use client";

import { Lock } from "lucide-react";
import { useMemo } from "react";

import { NoAccess } from "@/components/shell/NoAccess";
import { NotFoundState } from "@/components/shell/NotFoundState";
import { PageChrome } from "@/components/shell/page-chrome";
import { Callout } from "@/components/ui/Callout";
import { ErrorState } from "@/components/ui/ErrorState";
import { ApiError } from "@/lib/api/client";
import { fmtDateTime } from "@/lib/format";
import { openDocumentPreview } from "@/modules/knowledge/preview/store";

import { sourcesFromCitations } from "../citations";
import { useShare } from "../queries";
import type { AnswerView } from "../thread";
import { Answer, UserMessage } from "./ThreadMessages";

const noop = () => {};

/**
 * `/chat/<c>/shares/<s>`: a shared conversation, read-only (GetShare snapshot, conversation_loop.md "Sharing"). It
 * reuses the thread's messages and answers; citations open the shared document preview like in a thread. Turns the
 * reader can't open are withheld by the server and shown as the no-access call-out.
 */
export function SharedConversation({ conversation, share }: { conversation: string; share: string }) {
  const query = useShare(conversation, share);
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

  if (query.error instanceof ApiError && query.error.status === 403) return <NoAccess />;
  if (query.error instanceof ApiError && query.error.status === 404) return <NotFoundState />;

  /** A citation opens the shared document preview on the cited passage, stepping through this answer's sources. */
  const openCite = (n: number, answer: AnswerView) => {
    const sources = answer.sources.filter((s) => s.available);
    if (!sources.length) return;
    openDocumentPreview({
      n,
      citations: sources.flatMap((s) =>
        s.passages.length ? s.passages.map((pg) => ({ item: s.item, passage: pg.passage, excerpt: pg.excerpt, page: pg.page ?? undefined, n: s.n })) : [{ item: s.item, n: s.n }],
      ),
    });
  };

  return (
    <div className="split chat-split">
      <PageChrome
        title={title}
        crumbs={[{ label: "AI Chat", href: "/chat" }]}
        meta={snapshot ? `Shared conversation${snapshot.snapshotTime ? ` · ${fmtDateTime(snapshot.snapshotTime)}` : ""}` : undefined}
      />
      <div className="split__main chat-main">
        <div className="chat-scroll">
          <div className="chat-thread">
            {query.isPending ? (
              <div aria-busy="true" aria-label="Loading" />
            ) : query.error ? (
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : (
              rows.map((row) => {
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
                    activeCite={null}
                    activeArtifact={null}
                    onCite={openCite}
                    onOpenArtifact={noop}
                    onRetry={noop}
                    onFeedback={noop}
                    onFeedbackComment={noop}
                    onOpenSource={noop}
                  />
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
