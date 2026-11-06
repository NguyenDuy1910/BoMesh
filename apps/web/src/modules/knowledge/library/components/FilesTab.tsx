"use client";

import { Button } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, Play, Share2, Upload } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Gate } from "@/components/ui/Gate";
import { NoMatches } from "@/components/ui/NoMatches";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { toast } from "@/components/ui/Toast";
import { useWorkspace } from "@/lib/workspace";

import type { Item } from "../../api";
import { openContribute } from "../../components/Contribute";
import { LifecycleChip } from "../../components/LifecycleChip";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import { tokens, type Resource } from "../../model";
import { invalidateKnowledge, useContributionTargets, useKnowledgeModel, useMyContributions } from "../../queries";
import { processDocuments } from "../api";
import { useMyFiles } from "../queries";
import { ShareFileDialog } from "./ShareFileDialog";
import { matchesWords } from "./SavedTab";

const OPEN_STATES: Readonly<Record<string, true>> = { ANALYZING: true, IN_REVIEW: true, CHANGES_REQUESTED: true };
const PROCESSABLE: Readonly<Record<string, true>> = { PENDING: true, FAILED: true, OUTDATED: true };

/** My files (the member's personal collection): upload, process, share as knowledge (preview `filesTab`). */
export function FilesTab() {
  const { id: ws, can } = useWorkspace();
  const qc = useQueryClient();
  const files = useMyFiles();
  const { toResource } = useKnowledgeModel();
  const targets = useContributionTargets();
  const contributions = useMyContributions({ view: "FULL" });
  const [q, setQ] = useState("");
  const [sharing, setSharing] = useState<Resource | null>(null);
  const [processing, setProcessing] = useState<ReadonlySet<string>>(new Set());

  const canShare = can("contributions.create") && targets.data.length > 0;
  const inReview = useMemo(
    () => new Map((contributions.data ?? []).filter((c) => OPEN_STATES[c.state ?? ""] && c.item).map((c) => [c.item!, c])),
    [contributions.data],
  );

  async function process(r: Resource) {
    setProcessing((s) => new Set(s).add(r.id));
    try {
      await processDocuments(ws, [r.name]);
      invalidateKnowledge(qc, ws);
      toast(`Processing “${r.title}”`);
    } catch {
      toast("This file can’t be processed", { tone: "danger" });
    } finally {
      setProcessing((s) => {
        const next = new Set(s);
        next.delete(r.id);
        return next;
      });
    }
  }

  const upload = (variant: "primary" | "tertiary") => (
    <Button variant={variant} onPress={() => openContribute({ mode: "private" })}>
      <Upload className="i" aria-hidden />
      Upload
    </Button>
  );

  return (
    <>
      <Gate<Item[]>
        query={files}
        skeleton={<SkeletonRows rows={4} />}
        isEmpty={(data) => !data.length}
        empty={<EmptyState icon={Upload} title="No files yet" description="Upload notes or drafts to ask about them. Only you can see them." actions={upload("primary")} boxed />}
      >
        {(data) => {
          const words = tokens(q);
          const rows = data.map((item) => toResource(item)).filter((r) => matchesWords(r, words));
          return (
            <>
              <div className="toolbar">
                <SearchInput value={q} onChange={setQ} placeholder="Search my files" />
                <span className="t-sm muted row gap-4">
                  <Lock className="i i-sm" aria-hidden />
                  Only you can see these
                </span>
                <div className="toolbar__end">{upload("tertiary")}</div>
              </div>
              {rows.length ? (
                <ResourceList>
                  {rows.map((r) => {
                    const open = inReview.get(r.name);
                    const state = r.item.document?.indexingState ?? "";
                    return (
                      <ResourceRow
                        key={r.id}
                        resource={r}
                        q={q}
                        trail={
                          <>
                            {PROCESSABLE[state] || r.item.document?.contentState === "FAILED" ? (
                              <Button size="sm" variant="ghost" isPending={processing.has(r.id)} onPress={() => void process(r)}>
                                <Play className="i" aria-hidden />
                                Process
                              </Button>
                            ) : null}
                            {open ? (
                              <LifecycleChip contribution={open} />
                            ) : canShare ? (
                              <Button size="sm" variant="ghost" className="lib-share" aria-label="Share as knowledge" onPress={() => setSharing(r)}>
                                <Share2 className="i" aria-hidden />
                                <span>Share as knowledge…</span>
                              </Button>
                            ) : null}
                          </>
                        }
                      />
                    );
                  })}
                </ResourceList>
              ) : (
                <NoMatches what="files" onClear={() => setQ("")} />
              )}
            </>
          );
        }}
      </Gate>
      {sharing ? <ShareFileDialog resource={sharing} onClose={() => setSharing(null)} /> : null}
    </>
  );
}
