"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Check, Folder, Pencil, Tag } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { Disclosure, FileIcon, ItemIcon, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { listAllItems, listItems, updateItem, type Item } from "@/modules/knowledge/api";
import { topicTree } from "@/modules/knowledge/model";

import { confirmTopicAssignments, type Topic } from "../../api";
import { holdDecision } from "../../decisions";
import { topicsHref } from "../../model";
import { curationKeys, useInvalidateCuration } from "../../queries";
import { PlainSelect } from "../parts";
import { ActionsMenu } from "../shared";

/** Documents a card shows (newest first). */
const SAMPLE = 5;
/** Move to another topic retags the group's documents one by one, at most this many (read when the move is sent). */
const MOVE_MAX = 1000;

/** One topic the assistant applied: how many documents in scope carry it unconfirmed, and their ListItems filter. */
export interface ConfirmGroup {
  topic: Topic;
  n: number;
  filter: string;
}

/** True once the element comes within 200 px of the viewport (then stays true). */
function useNearView<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/** The held-decision key of a topic's group (hidden while its Confirm or Move is in the Undo window). */
export const confirmKey = (topic: string) => `${topic}#confirm`;

/**
 * Topics → Suggestions → Topics to confirm (preview `topicCard`): the documents carrying one topic the assistant applied.
 * Confirm topic makes the assignments a person's in one call; ⋯ moves them to another topic or opens the topic's
 * keywords. Both are held for the Undo window and only then sent.
 */
export function ConfirmCard({ g, topics }: { g: ConfirmGroup; topics: readonly Topic[] }) {
  const { id: ws } = useWorkspace();
  const [cardRef, near] = useNearView<HTMLElement>();
  // The sample is read only once the card comes near the view.
  const sampleRead = useQuery({
    queryKey: [...curationKeys.assistantTagged(ws), g.filter],
    queryFn: () => listItems(ws, { filter: g.filter, orderBy: "updateTime desc", pageSize: SAMPLE }),
    enabled: near,
    staleTime: 60_000,
  });
  const invalidate = useInvalidateCuration();
  const router = useRouter();
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState("");
  const [err, setErr] = useState("");
  const t = g.topic;
  const n = g.n;
  const domain = topics.find((d) => d.name === t.parentTopic);
  /** Every other topic, this topic's domain first (like Add topic). */
  const options = useMemo(
    () =>
      topicTree(topics)
        .map((d) => ({ ...d, children: d.children.filter((c) => c.name !== t.name) }))
        .filter((d) => d.children.length)
        .sort((a, b) => Number(b.name === t.parentTopic) - Number(a.name === t.parentTopic))
        .flatMap((d) => d.children.map((c) => [c.name ?? "", `${d.displayName} · ${c.displayName}`] as const)),
    [topics, t.name, t.parentTopic],
  );
  const back = `${plural(n, "document")} đã trở lại Chủ đề cần xác nhận`;

  const confirm = () =>
    holdDecision({
      names: [confirmKey(t.name ?? "")],
      message: `Đã xác nhận “${t.displayName}” cho ${plural(n, "document")}`,
      undoneMessage: back,
      send: (init) => confirmTopicAssignments(ws, t.name ?? "", g.filter, init).then(() => undefined),
      onSent: invalidate,
      onFailed: invalidate,
    });

  async function move() {
    const target = topics.find((x) => x.name === to);
    if (!target) {
      setErr("Chọn một chủ đề");
      return;
    }
    // The documents are read now, so the held decision is the updates alone (sent `keepalive` on a page leave).
    let docs: Item[];
    try {
      docs = await listAllItems(ws, { filter: g.filter }, MOVE_MAX);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      return;
    }
    if (docs.length >= MOVE_MAX) toast(`Chỉ bao gồm ${fmtNum(MOVE_MAX)} tài liệu khớp đầu tiên`, { tone: "warning" });
    holdDecision({
      names: [confirmKey(t.name ?? "")],
      message: `Đã chuyển ${plural(docs.length, "document")} sang “${target.displayName}”`,
      undoneMessage: back,
      send: (init) =>
        Promise.all(
          docs.map((it) =>
            updateItem(
              ws,
              it.name ?? "",
              { document: { purpose: it.document?.purpose ?? "KNOWLEDGE", topics: [...new Set([...(it.document?.topics ?? []).filter((x) => x !== t.name), target.name ?? ""])] } },
              ["document.topics"],
              init,
            ),
          ),
        ).then(() => undefined),
      onSent: invalidate,
      onFailed: invalidate,
    });
    setMoving(false);
  }

  const sample = sampleRead.data?.items ?? [];
  // Known before the sample loads, so the summary doesn't change when it arrives.
  const shown = Math.min(SAMPLE, n);
  return (
    <section ref={cardRef} className="cg-card" aria-label={t.displayName}>
      <div className="cg-card__head">
        <ItemIcon icon={Tag} tone="accent" />
        <div className="cg-card__main">
          <div className="cg-card__title">
            <span className="medium" translate="no">
              {t.displayName}
            </span>
            {domain ? (
              <span className="t-sm muted" translate="no">
                {domain.displayName}
              </span>
            ) : null}
          </div>
          <div className="cg-card__meta">
            <span>{plural(n, "document")}</span>
          </div>
        </div>
        <div className="cg-card__acts">
          <Button variant="secondary" size="sm" onPress={confirm}>
            <Check className="i" aria-hidden />
            Xác nhận chủ đề
          </Button>
          <ActionsMenu
            actions={[
              { id: "move", label: "Chuyển sang chủ đề khác…", icon: Folder, isDisabled: !options.length, onAction: () => (setMoving(true), setErr("")) },
              { id: "edit", label: "Sửa từ khóa của chủ đề…", icon: Pencil, onAction: () => router.push(topicsHref("topics", { node: resourceId(t.name) })) },
            ]}
          />
        </div>
      </div>
      {moving ? (
        <div className="cg-move">
          <div className="field">
            <span className="label">Di chuyển đến</span>
            <PlainSelect label="Di chuyển đến" value={to} placeholder="Chọn một chủ đề" options={options} onChange={(v) => (setTo(v), setErr(""))} />
            {err ? <div className="field-error">{err}</div> : null}
          </div>
          <div className="cg-move__acts">
            <Button variant="ghost" size="sm" onPress={() => setMoving(false)}>
              Hủy
            </Button>
            <Button variant="secondary" size="sm" onPress={() => void move()}>
              <Folder className="i" aria-hidden />
              Di chuyển
            </Button>
          </div>
        </div>
      ) : null}
      <Disclosure title="Tài liệu mẫu" summary={shown < n ? `${shown}/${plural(n, "document")}` : plural(n, "document")}>
        <ul className="cg-sample">
          {sample.map((it) => (
            <li key={it.name} className="cg-sample__row">
              <FileIcon name={it.document?.fileName ?? it.displayName} mime={it.document?.mimeType} size="sm" />
              <NextLink className="link truncate" href={`/doc/${resourceId(it.name)}`} translate="no" title={it.displayName}>
                {it.displayName || it.document?.fileName}
              </NextLink>
            </li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}
