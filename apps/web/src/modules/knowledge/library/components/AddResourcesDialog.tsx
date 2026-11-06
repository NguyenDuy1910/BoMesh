"use client";

import { Button, Checkbox, SearchField } from "@heroui/react";
import { useDeferredValue, useState } from "react";

import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { plural } from "@/lib/format";

import { KnowledgeModal } from "../../components/KnowledgeModal";
import { useKnowledgeModel, useSearchItems } from "../../queries";

/** Add resources from the catalog to a collection (preview `M['col-add']`). `have` = item names already in it. */
export function AddResourcesDialog({
  listName,
  have,
  onAdd,
  onClose,
}: {
  listName: string;
  have: ReadonlySet<string>;
  onAdd: (items: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const { toResource } = useKnowledgeModel();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const search = useSearchItems({ query: query || undefined, filter: "itemType = DOCUMENT", orderBy: query ? undefined : "updateTime desc", pageSize: 40 });
  const found = (search.data?.results ?? [])
    .flatMap((r) => (r.item && r.item.name && !have.has(r.item.name) && r.item.state !== "DELETED" ? [toResource(r.item)] : []))
    .slice(0, 25);

  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));

  async function add() {
    if (!picked.length) return;
    setBusy(true);
    try {
      await onAdd(picked);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="md"
      guard={busy}
      title="Add resources"
      description={<span translate="no">{listName}</span>}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" isDisabled={!picked.length} isPending={busy} onPress={() => void add()}>
            {picked.length ? `Add ${plural(picked.length, "resource")}` : "Add"}
          </Button>
        </>
      }
    >
      <SearchField value={q} onChange={setQ} aria-label="Search the catalog" autoFocus>
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Search the catalog" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
      <div className="res-picks mt-12 lib-add">
        {search.isError && !search.data ? (
          <ErrorState error={search.error} onRetry={() => void search.refetch()} />
        ) : search.isPending ? (
          <SkeletonRows rows={4} />
        ) : found.length ? (
          found.map((r) => (
            <div key={r.name} className="res-pick">
              <Checkbox isSelected={picked.includes(r.name)} onChange={() => toggle(r.name)}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="stack">
                    <span className="medium" translate="no">
                      {r.title}
                    </span>
                    <span className="t-xs muted">
                      {r.kindMeta.label} · <span translate="no">{r.base?.displayName ?? ""}</span>
                    </span>
                  </span>
                </Checkbox.Content>
              </Checkbox>
            </div>
          ))
        ) : (
          <p className="t-sm muted">{q ? "No resources match." : "Nothing left to add."}</p>
        )}
      </div>
    </KnowledgeModal>
  );
}
