"use client";

import { Button, buttonVariants, Skeleton } from "@heroui/react";
import { Archive, ArrowUpRight, Check, Copy, GitCompare } from "lucide-react";
import NextLink from "next/link";
import { useMemo, useState } from "react";

import { DataTable, EmptyState, FileIcon, StatusChip, Tip, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtDate, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { undeleteItem } from "@/modules/knowledge/api";
import { ResourceDetails } from "@/modules/knowledge/components/ResourceDetails";
import type { Resource } from "@/modules/knowledge/model";

import { mergeItem } from "../../api";
import type { DuplicatePair } from "../../governance";
import { useInvalidateCuration } from "../../queries";
import { CurationDrawer } from "../CurationDrawer";
import { firstPageText, useFirstPage } from "../FirstPage";
import { DocCell, useQualityAbilities } from "./parts";

const EXCERPT = 420;

/** Possible duplicates (preview `tabDups`): pairs flagged by processing; compare, then keep one. */
export function DuplicatesSegment({ pairs }: { pairs: readonly DuplicatePair[] }) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const [open, setOpen] = useState<{ key: string; swap: boolean } | null>(null);
  const [merging, setMerging] = useState(false);
  const can = useQualityAbilities(useMemo(() => pairs.flatMap((p) => [p.keep.name, p.dup.name]), [pairs]));

  if (!pairs.length) {
    return <EmptyState icon={Copy} tone="success" title="No duplicates found" description="Each document you look after appears once." boxed />;
  }

  const current = open ? pairs.find((p) => p.key === open.key) : undefined;

  /** Archive one copy into the other (references resolve to the kept copy). Undo restores it. */
  async function merge(p: DuplicatePair, swap: boolean) {
    const keep = swap ? p.dup : p.keep;
    const dup = swap ? p.keep : p.dup;
    setMerging(true);
    try {
      await mergeItem(ws, dup.name, keep.name, dup.item.etag);
      invalidate();
      setOpen(null);
      toast(`Archived “${dup.title}”`, {
        undo: () =>
          void undeleteItem(ws, dup.name).then(
            () => {
              invalidate();
              toast("Merge undone", { tone: "accent" });
            },
            (error: unknown) => toast(errorMessage(error), { tone: "danger" }),
          ),
      });
    } catch (error) {
      invalidate();
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setMerging(false);
    }
  }

  return (
    <>
      <DataTable
        label="Possible duplicates"
        rows={pairs}
        getRowId={(p) => p.key}
        onRowAction={(p) => setOpen({ key: p.key, swap: false })}
        columns={[
          {
            id: "docs",
            header: "Documents",
            primary: true,
            cell: (p) => (
              <div className="kh-dup-pair">
                <DocCell r={p.keep} size="sm" className="kh-dup-doc" sub={<DupSub label="Newer" r={p.keep} />} />
                <DocCell r={p.dup} size="sm" className="kh-dup-doc" sub={<DupSub label="Older" r={p.dup} />} />
              </div>
            ),
          },
          { id: "reason", header: "Reason", className: "kh-reason", cell: (p) => p.reason },
          {
            id: "updated",
            header: "Updated",
            hideOnMobile: true,
            cell: (p) => (
              <div className="kh-dup-dates">
                <span className="res-nowrap">{rel(p.keep.updated)}</span>
                <span className="res-nowrap muted">{rel(p.dup.updated)}</span>
              </div>
            ),
          },
        ]}
        rowActionLead={(p) => (
          <Button size="sm" variant="tertiary" onPress={() => setOpen({ key: p.key, swap: false })}>
            <GitCompare className="i" aria-hidden />
            Compare
          </Button>
        )}
        rowActions={(p) => [
          { id: "compare", label: "Compare", icon: GitCompare, onAction: () => setOpen({ key: p.key, swap: false }) },
          { id: "merge", label: "Keep newer, archive the other", icon: Archive, isDisabled: !can(p.dup.name, "items.delete"), onAction: () => void merge(p, false) },
        ]}
      />
      <CompareDrawer
        pair={open ? (current ?? null) : null}
        isOpen={!!open}
        swap={open?.swap ?? false}
        canMerge={(r) => can(r.name, "items.delete")}
        merging={merging}
        onSwap={() => setOpen((o) => (o ? { ...o, swap: !o.swap } : o))}
        onMerge={(p, swap) => void merge(p, swap)}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

function DupSub({ label, r }: { label: string; r: Resource }) {
  return (
    <>
      {label} · <span translate="no">{r.base?.displayName}</span>
    </>
  );
}

interface CompareDrawerProps {
  pair: DuplicatePair | null;
  isOpen: boolean;
  swap: boolean;
  canMerge: (dup: Resource) => boolean;
  merging: boolean;
  onSwap: () => void;
  onMerge: (pair: DuplicatePair, swap: boolean) => void;
  onClose: () => void;
}

/** Compare drawer (preview `DR['kh-dup']`): the kept copy and the one to archive side by side. */
function CompareDrawer({ pair, isOpen, swap, canMerge, merging, onSwap, onMerge, onClose }: CompareDrawerProps) {
  if (!pair) {
    return (
      <CurationDrawer isOpen={isOpen} onClose={onClose} title="Compare" footer={<Button onPress={onClose}>Close</Button>}>
        <EmptyState icon={Check} tone="success" title="Already resolved" description="This pair was merged or marked as not duplicates." compact />
      </CurationDrawer>
    );
  }
  const keep = swap ? pair.dup : pair.keep;
  const dup = swap ? pair.keep : pair.dup;
  const allowed = canMerge(dup);
  const action = (
    <Button variant="primary" isDisabled={!allowed} isPending={merging} onPress={() => onMerge(pair, swap)}>
      <Archive className="i" aria-hidden />
      {swap ? "Keep older, archive the newer" : "Keep newer, archive the other"}
    </Button>
  );
  return (
    <CurationDrawer
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      title="Compare possible duplicates"
      description={pair.reason}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          {allowed ? action : <Tip content={`You can’t edit ${dup.base?.displayName ?? "that knowledge base"}`}>{action}</Tip>}
        </>
      }
    >
      <div className="kh-cmp">
        <CompareColumn r={keep} keep newer={!swap} onSwap={onSwap} />
        <CompareColumn r={dup} keep={false} newer={swap} onSwap={onSwap} />
      </div>
    </CurationDrawer>
  );
}

function CompareColumn({ r, keep, newer, onSwap }: { r: Resource; keep: boolean; newer: boolean; onSwap: () => void }) {
  const page = useFirstPage(r.item);
  const text = firstPageText(page.data);
  const excerpt = text.length > EXCERPT ? `${text.slice(0, EXCERPT).replace(/\s+\S*$/, "")}…` : text;
  return (
    <section className="kh-cmp__col">
      <div className="kh-cmp__top">
        <StatusChip
          label={`${keep ? "Keep" : "Archive"} · ${newer ? "newer" : "older"}`}
          size="sm"
          tone={keep ? "success" : "default"}
          icon={keep ? Check : Archive}
        />
        <span className="grow" />
        {keep ? null : (
          <Button size="sm" variant="ghost" onPress={onSwap}>
            Keep this one
          </Button>
        )}
        <NextLink href={`/doc/${r.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowUpRight className="i" aria-hidden />
          Open
        </NextLink>
      </div>
      <div className="row gap-12">
        <FileIcon name={r.fileName} mime={r.mime} />
        <div className="grow kh-min">
          <div className="kh-cmp__title" translate="no">
            {r.title}
          </div>
          <div className="t-xs muted">Updated {fmtDate(r.updated)}</div>
        </div>
      </div>
      <div className="kh-cmp__block">
        <h3 className="t-label">Details</h3>
        <ResourceDetails resource={r} />
      </div>
      <div className="kh-cmp__block">
        <h3 className="t-label">Opening text</h3>
        {page.isPending ? (
          <div className="stack gap-6">
            <Skeleton className="skeleton--line" />
            <Skeleton className="skeleton--line" style={{ width: "70%" }} />
          </div>
        ) : excerpt ? (
          <p className="kh-cmp__text" translate="no">
            {excerpt}
          </p>
        ) : (
          <p className="t-sm muted">No text yet. It hasn’t been published.</p>
        )}
      </div>
    </section>
  );
}
