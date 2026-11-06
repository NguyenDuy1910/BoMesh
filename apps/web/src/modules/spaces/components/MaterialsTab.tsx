"use client";

import { Button, buttonVariants, Checkbox } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronDown, Files, Link as LinkIcon, Link2, Sparkles, Upload, X } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DataTable, EmptyState, FileIcon, IconButton, ItemIcon, NoMatches, SearchInput, SkeletonRows, ErrorState, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { createMaterial, deleteMaterial, listAllItems, quote, type Item } from "@/modules/knowledge/api";
import { openContribute } from "@/modules/knowledge/components/Contribute";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { ResourceList, ResourceRow } from "@/modules/knowledge/components/ResourceRow";
import { useKnowledgeModel } from "@/modules/knowledge/queries";
import { newWorkHref, workflowsFor } from "@/modules/work/kinds";

import { invalidateSpaces, useSpaceBases, useSpaceMaterials } from "../queries";
import type { SpaceView } from "./context";
import { Menu } from "./Menu";

const isEditor = (b: Item) => b.access === "EDITOR" || b.access === "OWNER";

/** Materials (preview `materialsTab`): documents of the linked bases, plus resources linked from other bases. */
export function MaterialsTab({ view }: { view: SpaceView }) {
  const { space, sid, manage, can } = view;
  const { settings, hasModule } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const { id: ws } = useWorkspace();
  const bases = useSpaceBases(space);
  const materials = useSpaceMaterials(sid);
  const model = useKnowledgeModel();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [linking, setLinking] = useState(false);

  const readable = (bases.data ?? []).filter((b) => b.access !== "LOCKED");
  const editable = readable.filter(isEditor);
  const own = new Set(readable.map((b) => b.name));
  const linked = (materials.data ?? []).filter((m) => m.item.itemType === "DOCUMENT" && !m.item.ancestors?.some((a) => own.has(a.name)) && !own.has(m.item.parentItem));
  const canLink = can("materials.create");
  const workflows = hasModule("work") && view.role ? workflowsFor(settings, space) : [];
  const pick = workflows.length > 0;
  const needle = q.trim().toLowerCase();
  const linkedMatches = needle ? linked.filter((m) => (m.item.displayName ?? "").toLowerCase().includes(needle)) : linked;

  const linkButton = canLink ? (
    <Button variant="tertiary" onPress={() => setLinking(true)}>
      <Link2 aria-hidden />
      Link resources
    </Button>
  ) : null;

  if (bases.isError && !bases.data) return <ErrorState error={bases.error} onRetry={bases.refetch} />;
  if (bases.isPending || materials.isPending) return <SkeletonRows rows={6} />;

  if (!readable.length && !linked.length)
    return (
      <>
        <EmptyState
          icon={BookOpen}
          boxed
          title="No materials yet"
          description={manage ? "Link a knowledge base so members can read and ask about its documents." : "Nothing has been shared here yet."}
          actions={
            <>
              {manage ? (
                <NextLink href={`/space/${sid}?tab=settings`} className={buttonVariants({ variant: "primary" })}>
                  <LinkIcon aria-hidden />
                  Link knowledge
                </NextLink>
              ) : null}
              {linkButton}
            </>
          }
        />
        {linking ? <LinkResourcesDialog view={view} exclude={new Set(linked.map((m) => m.item.name ?? ""))} ownBases={own} onClose={() => setLinking(false)} /> : null}
      </>
    );

  async function unlink(material: string, item: Item) {
    try {
      await deleteMaterial(ws, material);
      void invalidateSpaces(qc, ws);
      toast(`Unlinked “${item.displayName}”`, {
        undo: () =>
          void createMaterial(ws, sid, resourceId(item.name))
            .then(() => invalidateSpaces(qc, ws))
            .catch((e) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search materials" />
        <div className="toolbar__end">
          {linkButton}
          {editable.length === 1 ? (
            <Button variant="tertiary" onPress={() => openContribute({ collection: editable[0].name })}>
              <Upload aria-hidden />
              Add materials
            </Button>
          ) : null}
        </div>
      </div>
      <div className="stack gap-24">
        {readable.map((b) => (
          <BaseGroup
            key={b.name}
            base={b}
            q={needle}
            multi={editable.length > 1}
            pick={pick}
            selected={selected}
            onSelected={setSelected}
          />
        ))}
        {linkedMatches.length ? (
          <div className="sp-mat">
            <div className="sp-mat__head">
              <ItemIcon icon={Link2} size="sm" />
              <span className="sp-mat__name truncate">Linked from other knowledge bases</span>
              <span className="t-sm muted none">{plural(linked.length, "resource")}</span>
            </div>
            <ResourceList>
              {linkedMatches.map((m) => (
                <ResourceRow
                  key={m.material}
                  resource={model.toResource(m.item)}
                  compact
                  trail={
                    can("materials.delete") ? (
                      <Button variant="ghost" size="sm" onPress={() => void unlink(m.material, m.item)}>
                        Unlink
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </ResourceList>
          </div>
        ) : null}
        {needle && !linkedMatches.length && readable.length === 0 ? <NoMatches what="documents" onClear={() => setQ("")} /> : null}
      </div>
      {pick && selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span className="bulk-bar__count">{selected.size} selected</span>
          <Menu
            label="Use in a workflow"
            placement="bottom start"
            nodes={[
              {
                section: "Start with the selected documents",
                items: workflows.map((w) => ({
                  id: w.id,
                  label: w.label,
                  icon: w.icon,
                  run: () => {
                    const docs = [...selected];
                    setSelected(new Set());
                    router.push(newWorkHref({ workflow: w.id, space: sid, docs }));
                  },
                })),
              },
            ]}
          >
            <Button variant="primary" size="sm">
              <Sparkles aria-hidden />
              Use in a workflow
              <ChevronDown aria-hidden />
            </Button>
          </Menu>
          <IconButton icon={X} tip="Clear selection" size="sm" onPress={() => setSelected(new Set())} />
        </div>
      ) : null}
      {linking ? <LinkResourcesDialog view={view} exclude={new Set(linked.map((m) => m.item.name ?? ""))} ownBases={own} onClose={() => setLinking(false)} /> : null}
    </>
  );
}

interface BaseGroupProps {
  base: Item;
  q: string;
  /** More than one editable base: per-group "Add documents". */
  multi: boolean;
  pick: boolean;
  selected: Set<string>;
  onSelected: (ids: Set<string>) => void;
}

/** One linked knowledge base: its published documents (editors also see lifecycle). */
function BaseGroup({ base, q, multi, pick, selected, onSelected }: BaseGroupProps) {
  const { id: ws } = useWorkspace();
  const edit = isEditor(base);
  const docs = useQuery({
    queryKey: [ws, "items", "spaceMaterials", base.name],
    queryFn: () => listAllItems(ws, { filter: `ancestors:${quote(base.name ?? "")} AND itemType = DOCUMENT`, orderBy: "updateTime desc" }, 500),
  });
  const all = docs.data ?? [];
  const rows = q ? all.filter((d) => (d.displayName ?? "").toLowerCase().includes(q)) : all;
  if (q && docs.isSuccess && !rows.length) return null;
  const ids = new Set(rows.map((d) => resourceId(d.name)));

  const head = (
    <div className="sp-mat__head">
      <ItemIcon icon={BookOpen} size="sm" />
      <NextLink className="sp-mat__name truncate" href={`/knowledge/${resourceId(base.name)}`} translate="no">
        {base.displayName}
      </NextLink>
      <span className="t-sm muted none">{plural(docs.data?.length ?? base.collection?.documentCount ?? 0, "document")}</span>
      {edit && multi ? (
        <>
          <span className="grow" />
          <Button variant="ghost" size="sm" onPress={() => openContribute({ collection: base.name })}>
            <Upload aria-hidden />
            Add documents
          </Button>
        </>
      ) : null}
    </div>
  );

  if (docs.isError && !docs.data)
    return (
      <div className="sp-mat">
        {head}
        <ErrorState error={docs.error} onRetry={docs.refetch} />
      </div>
    );
  if (!docs.data)
    return (
      <div className="sp-mat">
        {head}
        <SkeletonRows rows={3} />
      </div>
    );
  if (!all.length)
    return (
      <div className="sp-mat">
        {head}
        <EmptyState
          icon={Files}
          compact
          boxed
          title="No documents yet"
          description={edit ? "Add slides, readings or past papers. They’re published after review." : undefined}
          actions={
            edit ? (
              <Button variant="tertiary" onPress={() => openContribute({ collection: base.name })}>
                <Upload aria-hidden />
                Add documents
              </Button>
            ) : null
          }
        />
      </div>
    );

  return (
    <div className="sp-mat">
      {head}
      <DataTable<Item>
        label={base.displayName ?? "Documents"}
        rows={rows}
        getRowId={(d) => resourceId(d.name)}
        rowHref={(d) => `/doc/${resourceId(d.name)}`}
        selectedIds={pick ? new Set([...selected].filter((i) => ids.has(i))) : undefined}
        onSelectionChange={
          pick
            ? (next) => {
                const merged = new Set([...selected].filter((i) => !ids.has(i)));
                for (const i of next) merged.add(i);
                onSelected(merged);
              }
            : undefined
        }
        rowLabel={(d) => d.displayName ?? ""}
        columns={[
          {
            id: "name",
            header: "Name",
            primary: true,
            cell: (d) => (
              <div className="row gap-12">
                <FileIcon name={d.displayName} mime={d.document?.mimeType} />
                <span className="cell-title truncate" translate="no">
                  {d.displayName}
                </span>
              </div>
            ),
          },
          { id: "updated", header: "Updated", className: "sp-nowrap", mobileLabel: "Updated", cell: (d) => rel(d.updateTime) },
          ...(edit ? [{ id: "status", header: "Status", cell: (d: Item) => <LifecycleChip item={d} size="sm" /> }] : []),
        ]}
      />
    </div>
  );
}

interface LinkResourcesDialogProps {
  view: SpaceView;
  /** Items already linked. */
  exclude: Set<string>;
  /** The space's own bases (their documents are already materials). */
  ownBases: Set<string | undefined>;
  onClose: () => void;
}

/** Link resources (preview `M['sp-link-res']`): pin documents from other bases; access doesn't change. */
function LinkResourcesDialog({ view, exclude, ownBases, onClose }: LinkResourcesDialogProps) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const model = useKnowledgeModel();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const catalog = useQuery({
    queryKey: [ws, "items", "spaceLinkCatalog"],
    queryFn: () => listAllItems(ws, { filter: "itemType = DOCUMENT", orderBy: "updateTime desc", view: "FULL" }, 400),
  });
  const needle = q.trim().toLowerCase();
  const found = (catalog.data ?? [])
    .filter((d) => !exclude.has(d.name ?? "") && !d.ancestors?.some((a) => ownBases.has(a.name)) && !ownBases.has(d.parentItem))
    .filter((d) => !model.ctx.personalCollection || d.ancestors?.[0]?.name !== model.ctx.personalCollection)
    .filter((d) => !needle || (d.displayName ?? "").toLowerCase().includes(needle))
    .slice(0, 25);

  async function link() {
    if (!picked.length) return;
    setBusy(true);
    try {
      const made = await Promise.all(picked.map((item) => createMaterial(ws, view.sid, resourceId(item))));
      void invalidateSpaces(qc, ws);
      onClose();
      toast(`Linked ${plural(made.length, "resource")} to ${view.space.displayName}`, {
        undo: () =>
          void Promise.all(made.map((m) => deleteMaterial(ws, m.name ?? "")))
            .then(() => invalidateSpaces(qc, ws))
            .catch((e) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      title="Link resources"
      description={<span translate="no">{view.space.displayName}</span>}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void link()} isPending={busy} isDisabled={!picked.length}>
            {picked.length ? `Link ${plural(picked.length, "resource")}` : "Link"}
          </Button>
        </>
      }
    >
      <SearchInput value={q} onChange={setQ} placeholder="Search the catalog" fullWidth autoFocus />
      <div className="res-picks mt-12 sp-link-picks">
        {catalog.isPending ? (
          <SkeletonRows rows={4} />
        ) : catalog.isError ? (
          <ErrorState error={catalog.error} onRetry={catalog.refetch} boxed={false} />
        ) : found.length ? (
          found.map((d) => {
            const r = model.toResource(d);
            return (
              <div key={d.name} className="res-pick">
                <Checkbox
                  isSelected={picked.includes(d.name ?? "")}
                  onChange={(on) => setPicked(on ? [...picked, d.name ?? ""] : picked.filter((x) => x !== d.name))}
                >
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
            );
          })
        ) : (
          <p className="t-sm muted" style={{ padding: 12 }}>
            {needle ? "No resources match." : "Nothing left to link."}
          </p>
        )}
      </div>
      <p className="t-xs muted mt-12">Linked resources show in Materials. They stay in their knowledge base, and access doesn’t change.</p>
    </KnowledgeModal>
  );
}
