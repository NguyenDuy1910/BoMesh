"use client";

import { Button } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, Play, Share, Upload } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Gate } from "@/components/ui/Gate";
import { IconButton } from "@/components/ui/IconButton";
import { NoMatches } from "@/components/ui/NoMatches";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { toast } from "@/components/ui/Toast";
import { useWorkspace } from "@/lib/workspace";
import { createIngestionRun } from "@/modules/curation/api";

import { itemName, type Item } from "../../api";
import { openContribute } from "../../components/contribute-store";
import { LifecycleChip } from "../../components/LifecycleChip";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import { tokens, type Resource } from "../../model";
import { invalidateKnowledge, useContributionTargets, useKnowledgeModel, useMyContributions } from "../../queries";
import { originParam } from "../../reader/links";
import { useMyFiles } from "../queries";
import { needsTools } from "./parts";
import { matchesWords } from "./SavedSection";
import { ShareFileDialog } from "./ShareFileDialog";

const OPEN_STATES: Readonly<Record<string, true>> = { ANALYZING: true, IN_REVIEW: true, CHANGES_REQUESTED: true };
const PROCESSABLE: Readonly<Record<string, true>> = { PENDING: true, FAILED: true, OUTDATED: true };

/**
 * My files (the member's personal collection, preview `filesTab`): upload, process, share as knowledge.
 * The section's one action, Upload, ends its toolbar.
 */
export function FilesSection() {
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
      await createIngestionRun(ws, { selector: { items: [itemName(ws, r.name)] } });
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

  const upload = (size?: "sm") => (
    <Button variant="primary" size={size} onPress={() => openContribute({ mode: "private" })}>
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
        empty={<EmptyState icon={Upload} title="No files yet" description="Upload notes or drafts to ask about them. Only you can see them." actions={upload()} boxed />}
      >
        {(data) => {
          const words = tokens(q);
          const rows = data.map((item) => toResource(item)).filter((r) => matchesWords(r, words));
          return (
            <>
              <div className="toolbar lib-bar">
                {needsTools(data.length, q) ? <SearchInput value={q} onChange={setQ} placeholder="Search my files" /> : null}
                <span className="t-sm muted row gap-4 lib-private">
                  <Lock className="i i-sm" aria-hidden />
                  Only you can see these
                </span>
                <div className="toolbar__end">{upload("sm")}</div>
              </div>
              {rows.length ? (
                <ResourceList>
                  {rows.map((r) => {
                    const open = inReview.get(r.name);
                    const state = r.item.document?.indexingState ?? "";
                    // Process is the next step for a file that isn't ready (always shown); Share as knowledge is secondary (on hover, with ⋯).
                    return (
                      <ResourceRow
                        key={r.id}
                        resource={r}
                        from={originParam({ kind: "library", tab: "files" })}
                        q={q}
                        hide={["kb"]}
                        trail={
                          <>
                            {PROCESSABLE[state] || r.item.document?.contentState === "FAILED" ? (
                              <Button size="sm" variant="secondary" isPending={processing.has(r.id)} onPress={() => void process(r)}>
                                <Play className="i" aria-hidden />
                                Process
                              </Button>
                            ) : null}
                            {open ? <LifecycleChip contribution={open} /> : null}
                          </>
                        }
                        reveal={!open && canShare ? <IconButton icon={Share} tip="Share as knowledge…" size="sm" onPress={() => setSharing(r)} /> : undefined}
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
