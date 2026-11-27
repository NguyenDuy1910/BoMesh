"use client";

import { Lock } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout } from "@/components/ui/Callout";
import { resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useMember } from "@/modules/knowledge/queries";

import type { Conversation, Message } from "../api";
import { sourcesFromCitations } from "../citations";
import { openAnswerCitation } from "../open";
import type { AnswerView } from "../thread";
import { Answer, UserMessage } from "./ThreadMessages";

const noop = () => {};

/**
 * `/chat/[id]` for someone a live share of the conversation is for (preview `sharedThread`, "Resource shares"):
 * read-only, re-filtered by the server on every read — a turn built on knowledge the reader can't open comes back
 * `available: false`, citations they can't open come back unavailable. No composer, feedback, retry, next steps or
 * files; only the owner continues it.
 */
export interface SharedThreadProps {
  conversation: Conversation;
  /** Undefined while loading. */
  messages: readonly Message[] | undefined;
  title: string;
  /** The thread's skeleton and its load error (ChatThread's). */
  loading: ReactNode;
  error: ReactNode;
}

export function SharedThread({ conversation, messages, title, loading, error }: SharedThreadProps) {
  const owner = useMember(conversation.owner).data;
  const ownerName = owner?.displayName || owner?.email || "Ai đó";

  const rows = useMemo(
    () =>
      (messages ?? [])
        .filter((m) => m.role === "USER" || m.available === false || (m.state ?? "COMPLETED") === "COMPLETED")
        .map((m, i) => {
          const key = m.name ? resourceId(m.name) : `m${i}`;
          if (m.role === "USER") return { kind: "user" as const, key, text: m.text ?? "" };
          if (m.available === false) return { kind: "withheld" as const, key };
          const text = m.text ?? "";
          const answer: AnswerView = {
            key,
            questionText: "",
            text,
            sources: sourcesFromCitations(text, m.citations ?? []),
            artifacts: [],
            steps: [],
            state: "COMPLETED",
            earlier: [],
            files: [],
          };
          return { kind: "answer" as const, key, answer };
        }),
    [messages],
  );

  const updated = conversation.lastMessageTime || conversation.updateTime;
  return (
    <div className="split chat-split">
      <PageChrome title={title} meta={`Được chia sẻ bởi ${ownerName}${updated ? ` · ${rel(updated)}` : ""}`} />
      <div className="split__main chat-main">
        <div className="chat-scroll" id="chat-scroll">
          {error ? (
            <div className="chat-thread">{error}</div>
          ) : !messages ? (
            loading
          ) : (
          <div className="chat-thread">
            {rows.map((row) => {
              if (row.kind === "user") {
                return <UserMessage key={row.key} id={row.key} text={row.text} files={[]} canEdit={false} editing={false} onEdit={noop} onCancel={noop} onSave={noop} />;
              }
              if (row.kind === "withheld") {
                return (
                  <div key={row.key} className="chat-msg chat-msg--ai">
                    <Callout icon={Lock} title="Câu trả lời này dùng tài liệu bạn không có quyền truy cập" description="Hãy hỏi quản trị viên không gian làm việc nếu bạn cần." />
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
                  onCite={(n: number, answer: AnswerView) => openAnswerCitation(answer.sources, n, resourceId(conversation.name ?? ""))}
                  onOpenArtifact={noop}
                  onRetry={noop}
                  onFeedback={noop}
                  onFeedbackComment={noop}
                  onOpenSource={noop}
                />
              );
            })}
          </div>
          )}
        </div>
        <div className="chat-dock">
          <div className="chat-dock__inner">
            <p className="chat-hint chat-hint--readonly">
              <Lock className="i i-xs" aria-hidden />
              <span>{`Chỉ đọc. Chỉ ${ownerName} mới tiếp tục được cuộc trò chuyện này.`}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
