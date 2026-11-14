"use client";

import { Button, Checkbox } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { BookOpen, ChevronDown, CircleAlert, Files, Library, Link2, Plus, Sparkles, Upload, X } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { BulkBar, EmptyState, ErrorState, FileIcon, IconButton, ItemIcon, NoMatches, SearchInput, SkeletonRows, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { createMaterial, deleteMaterial, listAllItems, quote, type Item } from "@/modules/knowledge/api";
import { BaseMark } from "@/modules/knowledge/bases/components/BaseMark";
import { openContribute } from "@/modules/knowledge/components/contribute-store";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { ResourceList, ResourceRow } from "@/modules/knowledge/components/ResourceRow";
import { useKnowledgeModel } from "@/modules/knowledge/queries";
import { catalogHref } from "@/modules/knowledge/model";
import { originParam, readerHref } from "@/modules/knowledge/reader/links";
import { newWorkHref, workflowsFor } from "@/modules/work";

import { invalidateSpaces, useSpaceBases, useSpaceMaterials } from "../queries";
import { TOOLS_MIN, type SpaceView } from "./context";
import { Menu, type MenuNode } from "./Menu";

const isEditor = (b: Item) => b.access === "EDITOR" || b.access === "OWNER";

/** Materials (preview `materialsTab`): documents of the linked collections, plus documents linked from other collections. */
export function MaterialsTab({ view }: { view: SpaceView }) {
  const { space, sid, manage, can } = view;
  const { id: ws, settings, hasModule } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
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
  const workflows = hasModule("work") && !view.visitor ? workflowsFor(settings, space) : [];
  const pick = workflows.length > 0;
  const needle = q.trim().toLowerCase();
  const linkedMatches = needle ? linked.filter((m) => (m.item.displayName ?? "").toLowerCase().includes(needle)) : linked;
  const total = readable.reduce((n, b) => n + (b.collection?.documentCount ?? 0), 0) + linked.length;
  const openDoc = (item: string) => router.push(readerHref({ item, from: originParam({ kind: "space", id: sid }) }));

  /** Add materials ▾ (preview `addMaterials`): contribute to a linked collection, link a collection, link documents. */
  function addMaterials(variant: "primary" | "tertiary"): ReactNode {
    if (!manage)
      return editable.length === 1 ? (
        <Button variant={variant} onPress={() => openContribute({ collection: editable[0].name })}>
          <Upload aria-hidden />
          Contribute
        </Button>
      ) : null;
    const nodes: MenuNode[] = editable.map((b) => ({
      id: `contribute-${b.name}`,
      label: editable.length === 1 ? "Contribute documents" : `Contribute to ${b.displayName}`,
      icon: Upload,
      run: () => openContribute({ collection: b.name }),
    }));
    nodes.push({ id: "link-collection", label: "Link a collection", icon: Library, run: () => router.push(`/space/${sid}?tab=settings`) });
    if (can("materials.create")) nodes.push({ id: "link-docs", label: "Link documents", icon: Link2, run: () => setLinking(true) });
    return (
      <Menu label="Add materials" nodes={nodes}>
        <Button variant={variant}>
          <Plus aria-hidden />
          Add materials
          <ChevronDown aria-hidden />
        </Button>
      </Menu>
    );
  }

  const dialog = linking ? <LinkDocumentsDialog view={view} exclude={new Set(linked.map((m) => m.item.name ?? ""))} ownBases={own} onClose={() => setLinking(false)} /> : null;

  if (bases.isError && !bases.data) return <ErrorState error={bases.error} onRetry={bases.refetch} />;
  if (bases.isPending || materials.isPending) return <SkeletonRows rows={6} />;

  if (!readable.length && !linked.length)
    return (
      <>
        <EmptyState
          icon={BookOpen}
          boxed
          title="No materials yet"
          description={manage ? "Link a collection or single documents so members can read and ask about them." : "Nothing has been shared here yet."}
          actions={addMaterials("primary")}
        />
        {dialog}
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

  const add = addMaterials("tertiary");
  const search = total >= TOOLS_MIN || q ? <SearchInput value={q} onChange={setQ} placeholder="Search materials" /> : null;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  return (
    <>
      {search || add ? (
        <div className="toolbar">
          {search}
          <div className="toolbar__end">{add}</div>
        </div>
      ) : null}
      <div className={clsx("sp-mats", pick && selected.size > 0 && "has-sel")}>
        {readable.map((b) => (
          <CollectionGroup key={b.name} base={b} q={needle} pick={pick} selected={selected} onToggle={toggle} onOpen={openDoc} />
        ))}
        {linkedMatches.length ? (
          <section className="sp-mat">
            <div className="sp-mat__head">
              <ItemIcon icon={Link2} size="sm" />
              <span className="sp-mat__name truncate">Linked from other collections</span>
              <span className="t-sm muted none">{plural(linked.length, "document")}</span>
            </div>
            <ResourceList>
              {linkedMatches.map((m) => {
                const id = resourceId(m.item.name);
                return (
                  <ResourceRow
                    key={m.material}
                    resource={model.toResource(m.item)}
                    compact
                    onOpen={() => openDoc(id)}
                    selected={selected.has(id)}
                    onSelectChange={pick ? (on) => toggle(id, on) : undefined}
                    trail={
                      can("materials.delete") ? (
                        <span className="reveal-on-hover">
                          <IconButton icon={X} tip="Unlink from this space" size="sm" onPress={() => void unlink(m.material, m.item)} />
                        </span>
                      ) : undefined
                    }
                  />
                );
              })}
            </ResourceList>
          </section>
        ) : null}
        {needle && !linkedMatches.length && !readable.length ? <NoMatches what="documents" onClear={() => setQ("")} /> : null}
      </div>
      {pick ? (
        <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
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
        </BulkBar>
      ) : null}
      {dialog}
    </>
  );
}

interface CollectionGroupProps {
  base: Item;
  q: string;
  pick: boolean;
  selected: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onOpen: (id: string) => void;
}

/** One linked collection: its documents as shared resource rows (preview `group`). */
function CollectionGroup({ base, q, pick, selected, onToggle, onOpen }: CollectionGroupProps) {
  const { id: ws } = useWorkspace();
  const model = useKnowledgeModel();
  const edit = isEditor(base);
  const docs = useQuery({
    queryKey: [ws, "items", "spaceMaterials", base.name],
    queryFn: () => listAllItems(ws, { filter: `ancestors:${quote(base.name ?? "")} AND itemType = DOCUMENT`, orderBy: "updateTime desc", view: "FULL" }, 500),
  });
  const all = docs.data ?? [];
  const rows = q ? all.filter((d) => (d.displayName ?? "").toLowerCase().includes(q)) : all;
  if (q && docs.isSuccess && !rows.length) return null;

  const head = (
    <div className="sp-mat__head">
      <BaseMark base={base} size={24} />
      <NextLink className="sp-mat__name truncate" href={catalogHref({ filters: { kb: [resourceId(base.name)] } })} translate="no">
        {base.displayName}
      </NextLink>
      <span className="t-sm muted none">{plural(docs.data?.length ?? base.collection?.documentCount ?? 0, "document")}</span>
    </div>
  );

  let body: ReactNode;
  if (docs.isError && !docs.data) body = <ErrorState error={docs.error} onRetry={docs.refetch} />;
  else if (!docs.data) body = <SkeletonRows rows={3} />;
  else if (!all.length)
    body = (
      <EmptyState
        icon={Files}
        compact
        boxed
        title="No documents yet"
        description={edit ? "Contribute slides, readings or reports. They’re published after review." : undefined}
        actions={
          edit ? (
            <Button variant="tertiary" onPress={() => openContribute({ collection: base.name })}>
              <Upload aria-hidden />
              Contribute
            </Button>
          ) : null
        }
      />
    );
  else
    body = (
      <ResourceList>
        {rows.map((d) => {
          const id = resourceId(d.name);
          return (
            <ResourceRow
              key={d.name}
              resource={model.toResource(d)}
              compact
              onOpen={() => onOpen(id)}
              selected={selected.has(id)}
              onSelectChange={pick ? (on) => onToggle(id, on) : undefined}
            />
          );
        })}
      </ResourceList>
    );

  return (
    <section className="sp-mat">
      {head}
      {body}
    </section>
  );
}

interface LinkDocumentsDialogProps {
  view: SpaceView;
  /** Items already linked. */
  exclude: Set<string>;
  /** The space's own collections (their documents are already materials). */
  ownBases: Set<string | undefined>;
  onClose: () => void;
}

/** Link documents (preview `M['sp-link-res']`): show documents from other collections in Materials; access doesn't change. */
function LinkDocumentsDialog({ view, exclude, ownBases, onClose }: LinkDocumentsDialogProps) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const model = useKnowledgeModel();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState("");
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
  const n = picked.length;

  async function link() {
    if (!n) {
      setErr("Select at least one document.");
      return;
    }
    setBusy(true);
    try {
      const made = await Promise.all(picked.map((item) => createMaterial(ws, view.sid, resourceId(item))));
      void invalidateSpaces(qc, ws);
      onClose();
      toast(`Linked ${plural(made.length, "document")} to ${view.space.displayName}`, {
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
      size="lg"
      icon={Link2}
      title="Link documents"
      description="Show documents from other collections in Materials and use them in workflows. Who can open them doesn’t change."
      footerStart={<span>{n ? `${plural(n, "document")} selected` : "They stay in their collection."}</span>}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void link()} isPending={busy}>
            <Link2 aria-hidden />
            {n ? `Link ${plural(n, "document")}` : "Link documents"}
          </Button>
        </>
      }
    >
      <SearchInput value={q} onChange={setQ} placeholder="Search by title or topic" fullWidth autoFocus />
      {catalog.isPending ? (
        <div className="mt-12">
          <SkeletonRows rows={4} />
        </div>
      ) : catalog.isError ? (
        <ErrorState error={catalog.error} onRetry={catalog.refetch} boxed={false} />
      ) : found.length ? (
        <div className="option-list sp-options mt-12" role="group" aria-label="Documents">
          {found.map((d) => {
            const r = model.toResource(d);
            return (
              <Checkbox
                key={d.name}
                className="checkbox"
                isSelected={picked.includes(d.name ?? "")}
                onChange={(on) => {
                  setErr("");
                  setPicked(on ? [...picked, d.name ?? ""] : picked.filter((x) => x !== d.name));
                }}
              >
                <Checkbox.Content className="checkbox__label">
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="sp-opt">
                    <FileIcon name={d.displayName} mime={d.document?.mimeType} size="sm" />
                    <span className="sp-opt__text">
                      <span className="sp-opt__title truncate" translate="no">
                        {r.title}
                      </span>
                      <span className="sp-opt__meta truncate">
                        {r.typeLabel} · <span translate="no">{r.base?.displayName ?? ""}</span>
                      </span>
                    </span>
                  </span>
                </Checkbox.Content>
              </Checkbox>
            );
          })}
        </div>
      ) : (
        <p className="t-sm muted sp-options__empty">{needle ? "No documents match. Try another word." : "Every document you can read is already here."}</p>
      )}
      {err ? (
        <div className="field-error mt-8" role="alert">
          <CircleAlert className="i" aria-hidden />
          <span>{err}</span>
        </div>
      ) : null}
    </KnowledgeModal>
  );
}
