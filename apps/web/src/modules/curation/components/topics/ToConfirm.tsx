"use client";

import { Button } from "@heroui/react";
import { Check, Folder, Pencil, Tag } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Disclosure, FileIcon, ItemIcon } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { quote, updateItem } from "@/modules/knowledge/api";
import { topicTree } from "@/modules/knowledge/model";

import { confirmTopicAssignments, type Topic } from "../../api";
import { holdDecision } from "../../decisions";
import type { ConfirmGroup } from "../../governance";
import { topicsHref } from "../../model";
import { useInvalidateCuration } from "../../queries";
import { PlainSelect } from "../parts";
import { ActionsMenu } from "../shared";

const SAMPLE = 5;

/** The held-decision key of a topic's group (hidden while its Confirm or Move is in the Undo window). */
export const confirmKey = (topic: string) => `${topic}#confirm`;

/**
 * Topics → Suggestions → Topics to confirm (preview `topicCard`): the documents carrying one topic the assistant applied.
 * Confirm topic makes the assignments a person's in one call; ⋯ moves them to another topic or opens the topic's
 * keywords. Both are held for the Undo window and only then sent.
 */
export function ConfirmCard({ g, topics }: { g: ConfirmGroup; topics: readonly Topic[] }) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const router = useRouter();
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState("");
  const [err, setErr] = useState("");
  const t = g.topic;
  const n = g.docs.length;
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
  const back = `${plural(n, "document")} are back in Topics to confirm`;

  const confirm = () =>
    holdDecision({
      names: [confirmKey(t.name ?? "")],
      message: `Confirmed “${t.displayName}” for ${plural(n, "document")}`,
      undoneMessage: back,
      send: () => confirmTopicAssignments(ws, t.name ?? "", `itemKind = DOCUMENT AND document.assistantTopics:${quote(t.name ?? "")}`).then(() => undefined),
      onSent: invalidate,
      onFailed: invalidate,
    });

  function move() {
    const target = topics.find((x) => x.name === to);
    if (!target) {
      setErr("Choose a topic");
      return;
    }
    const docs = g.docs;
    holdDecision({
      names: [confirmKey(t.name ?? "")],
      message: `Moved ${plural(n, "document")} to “${target.displayName}”`,
      undoneMessage: back,
      send: () =>
        Promise.all(
          docs.map((it) =>
            updateItem(
              ws,
              it.name ?? "",
              { document: { purpose: it.document?.purpose ?? "KNOWLEDGE", topics: [...new Set([...(it.document?.topics ?? []).filter((x) => x !== t.name), target.name ?? ""])] } },
              ["document.topics"],
            ),
          ),
        ).then(() => undefined),
      onSent: invalidate,
      onFailed: invalidate,
    });
    setMoving(false);
  }

  const sample = g.docs.slice(0, SAMPLE);
  return (
    <section className="cg-card" aria-label={t.displayName}>
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
            Confirm topic
          </Button>
          <ActionsMenu
            actions={[
              { id: "move", label: "Move to another topic…", icon: Folder, isDisabled: !options.length, onAction: () => (setMoving(true), setErr("")) },
              { id: "edit", label: "Edit topic keywords…", icon: Pencil, onAction: () => router.push(topicsHref("topics", { node: resourceId(t.name) })) },
            ]}
          />
        </div>
      </div>
      {moving ? (
        <div className="cg-move">
          <div className="field">
            <span className="label">Move to</span>
            <PlainSelect label="Move to" value={to} placeholder="Choose a topic" options={options} onChange={(v) => (setTo(v), setErr(""))} />
            {err ? <div className="field-error">{err}</div> : null}
          </div>
          <div className="cg-move__acts">
            <Button variant="ghost" size="sm" onPress={() => setMoving(false)}>
              Cancel
            </Button>
            <Button variant="secondary" size="sm" onPress={move}>
              <Folder className="i" aria-hidden />
              Move
            </Button>
          </div>
        </div>
      ) : null}
      <Disclosure title="Sample documents" summary={sample.length < n ? `${sample.length}/${plural(n, "document")}` : plural(n, "document")}>
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
