"use client";

import { Button, Tooltip } from "@heroui/react";
import { FilePlus, Info, Plus, Tag } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { batchGetItems } from "@/modules/knowledge/api";

import { dismissTopicCorrection, updateTopic, type Topic, type TopicCorrection } from "../../api";
import { holdDecision } from "../../decisions";
import { correctionsWith, type CorrectionSuggestion } from "../../governance";
import { topicsHref } from "../../model";
import { useInvalidateCuration, useRememberTopic } from "../../queries";

const MAX_EXAMPLES = 5;

/**
 * Topics → Suggestions → Keywords from reviewers’ corrections (preview `learnCard`): one card per topic reviewers moved
 * documents to, in whole sentences. A keyword or examples are saved at once; the corrections they used then leave the
 * list, held for the Undo window (Undo also takes the keyword or examples back). Dismiss is held the same way.
 */
export function CorrectionCard({ s, topics }: { s: CorrectionSuggestion; topics: readonly Topic[] }) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const remember = useRememberTopic();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const t = s.topic;
  const n = s.corrections.length;
  const nameOf = (name: string) => topics.find((x) => x.name === name)?.displayName ?? "";
  const fromNames = s.from.map(nameOf).filter(Boolean);
  const from = fromNames.length
    ? `Quy trình xử lý đã xếp ${n === 1 ? "nó" : "chúng"} vào ${fromNames.join(", ")}.`
    : n === 1
      ? "Quy trình xử lý không tìm được chủ đề cho nó."
      : "Quy trình xử lý không tìm được chủ đề cho chúng.";
  // Titles are omitted for documents the caller can't see; those only count.
  const shown = s.corrections.filter((c) => c.item && c.itemDisplayName).slice(0, 3);
  const more = n - shown.length;

  /** Takes `used` out of the list for the Undo window, then dismisses them; Undo runs `revert` and keeps them. */
  const hold = (used: readonly TopicCorrection[], message: string, undoneMessage: string, revert?: () => Promise<unknown>) =>
    holdDecision({
      names: used.map((c) => c.name ?? ""),
      message,
      undoneMessage,
      send: (init) => Promise.all(used.map((c) => dismissTopicCorrection(ws, c.name ?? "", init))).then(() => undefined),
      onSent: invalidate,
      onFailed: invalidate,
      onUndo: revert
        ? () =>
            void revert().then(invalidate, (error: unknown) => {
              invalidate();
              toast(errorMessage(error), { tone: "danger" });
            })
        : undefined,
    });

  /** Saves a topic change at once, then holds the corrections it used. */
  async function save(run: () => Promise<void>) {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      invalidate();
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const addKeyword = (kw: string) =>
    save(async () => {
      const before = t.keywords ?? [];
      const saved = await updateTopic(ws, t, { keywords: [...before, kw] });
      remember(saved);
      hold(correctionsWith(s.corrections, kw), `Đã thêm “${kw}” vào ${t.displayName}`, `Đã gỡ “${kw}”`, () => updateTopic(ws, saved, { keywords: before }).then(remember));
    });

  const addExamples = () =>
    save(async () => {
      const have = t.examples ?? [];
      const items = await batchGetItems(ws, [...new Set(s.corrections.map((c) => c.item ?? "").filter(Boolean))]);
      const ids = items.filter((it) => it.document?.publicationState === "PUBLISHED" && !have.includes(it.name ?? "")).map((it) => it.name ?? "");
      if (!ids.length) {
        toast("Các tài liệu này chưa được công bố. Hãy duyệt trước.", { tone: "accent" });
        return;
      }
      const add = ids.slice(0, Math.max(0, MAX_EXAMPLES - have.length));
      if (!add.length) {
        toast(`${t.displayName} đã có năm ví dụ`, { tone: "accent" });
        return;
      }
      const saved = await updateTopic(ws, t, { examples: [...have, ...add] });
      remember(saved);
      hold(
        s.corrections.filter((c) => add.includes(c.item ?? "")),
        `Đã thêm ${plural(add.length, "example")} vào ${t.displayName}`,
        `Đã gỡ ${plural(add.length, "example")} khỏi ${t.displayName}`,
        () => updateTopic(ws, saved, { examples: have }).then(remember),
      );
    });

  const dismiss = () => hold(s.corrections, `Đã bỏ qua ${plural(n, "correction")}`, "Đã hoàn tác");

  return (
    <li className="md-learn">
      <div className="md-learn__title medium">{`Người duyệt đã chuyển ${plural(n, "document")} sang ${t.displayName}`}</div>
      <p className="md-learn__note">{from}</p>
      {shown.length ? (
        <div className="md-learn__docs">
          {shown.map((c, i) => (
            <span key={c.name}>
              {i ? <span aria-hidden="true">, </span> : null}
              <NextLink className="link" href={`/doc/${resourceId(c.item)}`} translate="no">
                {c.itemDisplayName}
              </NextLink>
            </span>
          ))}
          {more > 0 ? (
            <>
              {" "}
              <span className="muted">{`+${more} nữa`}</span>
            </>
          ) : null}
        </div>
      ) : null}
      {s.phrases.length ? (
        <div className="md-learn__row">
          <span className="t-label">Thêm làm từ khóa</span>
          <div className="md-learn__chips">
            {s.phrases.map((p) => (
              <Tooltip key={p.text}>
                <button type="button" className="chip chip--soft chip--accent md-learn__kw" disabled={busy} onClick={() => void addKeyword(p.text)}>
                  <Plus className="i" aria-hidden />
                  <span translate="no">{p.text}</span>
                </button>
                <Tooltip.Content>{`Có trong ${p.n} tiêu đề này`}</Tooltip.Content>
              </Tooltip>
            ))}
          </div>
        </div>
      ) : (
        <p className="md-learn__note">{n === 1 ? "Một lần sửa chưa thành quy luật. Hãy thêm tài liệu làm ví dụ, hoặc chờ thêm." : "Tiêu đề của chúng không có từ chung mới. Hãy thêm chúng làm ví dụ."}</p>
      )}
      {s.misled.map((m) => (
        <p key={m.text} className="md-learn__why">
          <Info className="i" aria-hidden />
          <span>{`Nhầm do “${m.text}”, một từ khóa của ${nameOf(m.elsewhere)}.`}</span>
        </p>
      ))}
      <div className="md-learn__acts">
        <Button variant="ghost" size="sm" onPress={() => router.push(topicsHref("topics", { node: resourceId(t.name) }))}>
          <Tag className="i" aria-hidden />
          Mở chủ đề
        </Button>
        <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => void addExamples()}>
          <FilePlus className="i" aria-hidden />
          Thêm làm ví dụ
        </Button>
        <Button variant="ghost" size="sm" isDisabled={busy} onPress={dismiss}>
          Bỏ qua
        </Button>
      </div>
    </li>
  );
}
