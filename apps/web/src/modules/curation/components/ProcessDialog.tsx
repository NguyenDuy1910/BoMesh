"use client";

import { Button, Label, TextArea, TextField } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Play } from "lucide-react";
import { useState } from "react";

import { LinkButton, Segmented, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtSize, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { TopicPicker } from "@/modules/knowledge/components/TopicPicker";
import { topicTree } from "@/modules/knowledge/model";
import { useKnowledgeModel } from "@/modules/knowledge/queries";

import { collectionTopicUse, createIngestionRun, type IngestionRun } from "../api";
import { aipString } from "../docFilter";
import type { DocRow } from "../model";
import { useInvalidateCuration } from "../queries";

/** A run selects at most this many explicit documents; more go as a filter by name. */
const MAX_ITEMS = 1000;
/** "Use {collection}'s topics" loads at most this many. */
const USUAL_TOPICS = 8;
const NOTE_MAX = 1000;

export interface ProcessRequest {
  /** Checked documents that can be processed (explicit selection). */
  rows: readonly DocRow[];
  /** "Select all matching": the list's document filter (no count, no estimate). */
  filter?: string;
  /** Collections the selection comes from (full item names), for "Use {collection}'s topics". */
  collections: readonly string[];
}

/**
 * The Process dialog (preview `M['cur-process']`): one decision — which topics the AI may suggest (All topics |
 * Selected) — one optional input (context for the AI) and the action. Starts one ingestion run; it never publishes.
 * `classification` goes along only when topics are chosen or a note is given.
 */
export function ProcessDialog({ request, onClose, onStarted }: { request: ProcessRequest | null; onClose: () => void; onStarted: (run: IngestionRun, total: number | null) => void }) {
  return request ? <ProcessForm request={request} onClose={onClose} onStarted={onStarted} /> : null;
}

function ProcessForm({ request, onClose, onStarted }: { request: ProcessRequest; onClose: () => void; onStarted: (run: IngestionRun, total: number | null) => void }) {
  const { id: ws } = useWorkspace();
  const { ctx, topics } = useKnowledgeModel();
  const invalidate = useInvalidateCuration();
  const [scope, setScope] = useState<"all" | "chosen">("all");
  const [chosen, setChosen] = useState<string[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  const all = !!request.filter;
  const n = request.rows.length;
  const bytes = request.rows.reduce((s, r) => s + Number(r.item?.document?.sizeBytes ?? 0), 0);
  const leaves = topicTree(topics).flatMap((d) => d.children);
  const live = new Set(leaves.map((t) => t.name ?? ""));

  // The collections' usual topics: what their documents carry most (active topics only, at most eight each).
  const usual = useQuery({
    queryKey: [ws, "items", "collection-topics", ...request.collections] as const,
    queryFn: async () => (await Promise.all(request.collections.map((c) => collectionTopicUse(ws, c)))).map((list) => list.filter((t) => live.has(t)).slice(0, USUAL_TOPICS)),
    enabled: scope === "chosen" && request.collections.length > 0 && leaves.length > 0,
    staleTime: 60_000,
  });
  const usualTopics = [...new Set((usual.data ?? []).flat())];
  const loadable = (usual.data ?? []).some((list) => list.some((t) => !chosen.includes(t)));
  const one = request.collections.length === 1 ? ctx.collectionNames?.get(request.collections[0]) || "the collection" : "";

  const pickScope = (v: "all" | "chosen") => {
    setScope(v);
    setTried(false);
  };
  // Selected starts from the collection's usual topics when the selection comes from one collection.
  const [seeded, setSeeded] = useState(false);
  if (scope === "chosen" && !seeded && request.collections.length === 1 && usual.data) {
    setSeeded(true);
    if (!chosen.length) setChosen(usualTopics);
  }

  const hint =
    scope === "chosen"
      ? chosen.length
        ? `The AI suggests only from these ${plural(chosen.length, "topic")}.`
        : "Pick the topics the AI may suggest."
      : `The AI suggests from all ${plural(leaves.length, "topic")}.`;
  const error = scope === "chosen" && tried && !chosen.length ? "Select at least one topic, or use all topics." : "";
  const title = all ? "Process the matching documents" : `Process ${plural(n, "document")}`;
  const desc = all
    ? "The AI reads each file and suggests topics. You can keep working."
    : `The AI reads each file and suggests topics${bytes ? ` (${fmtSize(bytes)} in all)` : ""}. You can keep working.`;

  const submit = async () => {
    setTried(true);
    if (scope === "chosen" && !chosen.length) return;
    const text = note.trim();
    const classification = scope === "chosen" || text ? { topics: scope === "chosen" ? chosen : [], note: text } : undefined;
    const items = request.rows.flatMap((r) => (r.item?.name ? [r.item.name] : []));
    const selector = all
      ? { filter: request.filter }
      : items.length > MAX_ITEMS
        ? { filter: items.map((name) => `name = ${aipString(name)}`).join(" OR ") }
        : { items };
    setBusy(true);
    try {
      const run = await createIngestionRun(ws, { selector, classification });
      invalidate();
      onStarted(run, all ? null : items.length);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="md"
      icon={Play}
      title={title}
      description={desc}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void submit()} isPending={busy}>
            <Play className="i" aria-hidden />
            {all ? "Process" : `Process ${plural(n, "document")}`}
          </Button>
        </>
      }
    >
      <div className="proc">
        <section className="proc-sec">
          <div className="proc-sec__head">
            <h3 className="proc-sec__label">Topics</h3>
            <Segmented
              value={scope}
              onChange={pickScope}
              label="Topics the AI may suggest"
              options={[
                { value: "all", label: "All topics" },
                { value: "chosen", label: "Selected" },
              ]}
            />
          </div>
          <p className="proc-sec__hint">
            <span>{hint}</span>
            {scope === "chosen" && loadable ? (
              <LinkButton
                size="sm"
                onPress={() => {
                  setChosen([...new Set([...chosen, ...usualTopics])]);
                  setTried(false);
                }}
              >
                {one ? `Use ${one}’s topics` : "Use their collections’ topics"}
              </LinkButton>
            ) : null}
          </p>
          {scope === "chosen" ? (
            <TopicPicker
              value={chosen}
              onChange={(next) => {
                setChosen(next);
                setTried(false);
              }}
              topics={topics}
              label="Selected topics"
              domains
              limit={5}
              quiet
              isDisabled={busy}
            />
          ) : null}
          {error ? (
            <div className="field-error" role="alert">
              <AlertCircle className="i" aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}
        </section>
        <section className="proc-sec">
          <div className="proc-sec__head">
            <h3 className="proc-sec__label">
              Context for the AI<span className="label__opt">(optional)</span>
            </h3>
            {noteOpen || note ? null : (
              <LinkButton size="sm" onPress={() => setNoteOpen(true)}>
                Add
              </LinkButton>
            )}
          </div>
          {noteOpen || note ? (
            <TextField value={note} onChange={setNote} maxLength={NOTE_MAX} isDisabled={busy} aria-label="Context for the AI">
              <Label className="sr-only">Context for the AI</Label>
              <TextArea rows={2} autoFocus placeholder="e.g. Scanned decisions and notices, 2015–2024" />
            </TextField>
          ) : null}
        </section>
      </div>
    </KnowledgeModal>
  );
}
