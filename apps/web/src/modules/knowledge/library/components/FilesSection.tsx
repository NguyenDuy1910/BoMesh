"use client";

import { Button } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, Play, Share, Upload } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { NoMatches } from "@/components/ui/NoMatches";
import { Pager } from "@/components/ui/Pager";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { toast } from "@/components/ui/Toast";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { useWorkspace } from "@/lib/workspace";
import { createIngestionRun } from "@/modules/curation/api";
import { nameSearch } from "@/modules/curation/docFilter";

import { itemName } from "../../api";
import { openContribute } from "../../components/contribute-store";
import { LifecycleChip } from "../../components/LifecycleChip";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import { type Resource } from "../../model";
import { invalidateKnowledge, useContributionTargets, useKnowledgeModel } from "../../queries";
import { originParam } from "../../reader/links";
import { LIBRARY_PAGE, useMyFiles, useMyOpenContributions } from "../queries";
import { needsTools } from "./parts";
import { ShareFileDialog } from "./ShareFileDialog";

const PROCESSABLE: Readonly<Record<string, true>> = { PENDING: true, FAILED: true, OUTDATED: true };

/**
 * My files (the member's personal collection, preview `filesTab`): upload, process, share as knowledge, one server
 * page at a time (search matches the name). The section's one action, Upload, ends its toolbar.
 */
export function FilesSection() {
  const { id: ws, can } = useWorkspace();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const search = nameSearch(useDebounced(q, SEARCH_PAUSE_MS));
  const files = useMyFiles(search);
  const items = files.data?.items ?? [];
  const { toResource } = useKnowledgeModel();
  const targets = useContributionTargets();
  const inReview = useMyOpenContributions(items.map((i) => i.name ?? "")).data;
  const [sharing, setSharing] = useState<Resource | null>(null);
  const [processing, setProcessing] = useState<ReadonlySet<string>>(new Set());

  const canShare = can("contributions.create") && targets.data.length > 0;

  async function process(r: Resource) {
    setProcessing((s) => new Set(s).add(r.id));
    try {
      await createIngestionRun(ws, { selector: { items: [itemName(ws, r.name)] } });
      invalidateKnowledge(qc, ws);
      toast(`Đang xử lý “${r.title}”`);
    } catch {
      toast("Không thể xử lý tệp này", { tone: "danger" });
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
      Tải lên
    </Button>
  );

  if (files.data === undefined) return files.isError ? <ErrorState error={files.error} onRetry={() => void files.refetch()} /> : <SkeletonRows rows={4} />;
  const total = files.total ?? items.length;
  if (!total && !search && files.page === 1)
    return <EmptyState icon={Upload} title="Chưa có tệp" description="Tải lên ghi chú hoặc bản nháp để đặt câu hỏi. Chỉ bạn có thể xem." actions={upload()} boxed />;
  const rows = items.map((item) => toResource(item));

  return (
    <>
      <div className="toolbar lib-bar">
        {needsTools(total, q) ? <SearchInput value={q} onChange={setQ} placeholder="Tìm kiếm tệp của tôi" /> : null}
        <span className="t-sm muted row gap-4 lib-private">
          <Lock className="i i-sm" aria-hidden />
          Chỉ bạn có thể xem
        </span>
        <div className="toolbar__end">{upload("sm")}</div>
      </div>
      {rows.length ? (
        <>
          <ResourceList>
            {rows.map((r) => {
              const open = inReview?.get(r.name);
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
                          Xử lý
                        </Button>
                      ) : null}
                      {open ? <LifecycleChip contribution={open} /> : null}
                    </>
                  }
                  reveal={!open && canShare ? <IconButton icon={Share} tip="Chia sẻ vào kho tài liệu…" size="sm" onPress={() => setSharing(r)} /> : undefined}
                />
              );
            })}
          </ResourceList>
          {files.hasNext || files.page > 1 ? <Pager page={files.page} pageSize={LIBRARY_PAGE} total={files.total} pageCount={items.length} hasNext={files.hasNext} onPageChange={files.setPage} /> : null}
        </>
      ) : (
        <NoMatches what="tệp" onClear={() => setQ("")} />
      )}
      {sharing ? <ShareFileDialog resource={sharing} onClose={() => setSharing(null)} /> : null}
    </>
  );
}
