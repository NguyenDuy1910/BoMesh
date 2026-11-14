"use client";

import { Button, Checkbox } from "@heroui/react";
import { CircleAlert, ListPlus, Plus } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { ErrorState } from "@/components/ui/ErrorState";
import { FileIcon } from "@/components/ui/FileIcon";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { plural } from "@/lib/format";

import { KnowledgeModal } from "../../components/KnowledgeModal";
import { ResDot } from "../../components/ResourceRow";
import type { Resource } from "../../model";
import { useKnowledgeModel, useSearchItems } from "../../queries";

/**
 * Add resources to a reading list (preview `M['col-add']`). `have` = item names already in it. A shared list never
 * offers the member's private My files (nobody else could open them): only a list for them alone (`personal`) can.
 * Chosen resources stay at the top while searching for more.
 */
export function AddResourcesDialog({
  listName,
  have,
  personal,
  onAdd,
  onClose,
}: {
  listName: string;
  have: ReadonlySet<string>;
  personal: boolean;
  onAdd: (items: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const { toResource } = useKnowledgeModel();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const [picked, setPicked] = useState<Resource[]>([]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const search = useSearchItems({ query: query || undefined, filter: "itemType = DOCUMENT", orderBy: query ? undefined : "updateTime desc", pageSize: 40 });
  const chosen = new Set(picked.map((r) => r.name));
  const found = (search.data?.results ?? [])
    .flatMap((r) => (r.item && r.item.state !== "DELETED" ? [toResource(r.item)] : []))
    .filter((r) => r.readable && (personal || !r.isPersonal) && !have.has(r.name) && !chosen.has(r.name))
    .slice(0, 25);
  const n = picked.length;
  const err = touched && !n ? "Pick at least one resource." : "";

  const toggle = (r: Resource) => {
    setPicked((p) => (p.some((x) => x.name === r.name) ? p.filter((x) => x.name !== r.name) : [...p, r]));
    setTouched(false);
  };

  async function add() {
    if (!n) {
      setTouched(true);
      return;
    }
    setBusy(true);
    try {
      await onAdd(picked.map((r) => r.name));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const row = (r: Resource, on: boolean) => (
    <Checkbox key={r.name} isSelected={on} onChange={() => toggle(r)}>
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        <span className="res-opt res-opt--mark">
          <FileIcon type={r.ext} mime={r.mime} size="sm" />
          <span className="res-opt__text">
            <span className="res-opt__name" translate="no">
              {r.title}
            </span>
            <span className="res-opt__meta">
              {r.typeLabel}
              <ResDot />
              <span className="truncate" translate={r.base?.personal ? undefined : "no"}>
                {r.base?.displayName ?? ""}
              </span>
            </span>
          </span>
        </span>
      </Checkbox.Content>
    </Checkbox>
  );

  let list;
  if (search.isError && !search.data) list = <ErrorState error={search.error} onRetry={() => void search.refetch()} />;
  else if (search.isPending && !n) list = <SkeletonRows rows={4} />;
  else if (n || found.length) {
    list = (
      <div className="option-list lib-add" role="group" aria-label="Resources">
        {picked.map((r) => row(r, true))}
        {found.map((r) => row(r, false))}
      </div>
    );
  } else {
    list = <p className="lib-add-none">{q.trim() ? `No resources match “${q.trim()}”.` : "Everything you can open is already in this reading list."}</p>;
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="md"
      guard={busy}
      title="Add resources"
      icon={ListPlus}
      description={`Pick what belongs in “${listName}”.`}
      footerStart={n ? `${plural(n, "resource")} selected` : "Documents keep their own access."}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" isPending={busy} onPress={() => void add()}>
            <Plus className="i" aria-hidden />
            {n ? `Add ${plural(n, "resource")}` : "Add resources"}
          </Button>
        </>
      }
    >
      <div className="stack gap-12">
        <SearchInput value={q} onChange={setQ} placeholder="Search by title, topic or collection" size="md" fullWidth autoFocus />
        {err ? (
          <div className="field-error" role="alert">
            <CircleAlert className="i" aria-hidden />
            <span>{err}</span>
          </div>
        ) : null}
        {list}
      </div>
    </KnowledgeModal>
  );
}
