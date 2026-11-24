"use client";

import { Button, Checkbox } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { BookOpen, ChevronDown, CircleAlert, Files, Library, Link2, Plus, Sparkles, Upload, X } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { BulkBar, EmptyState, ErrorState, FileIcon, IconButton, ItemIcon, NoMatches, Pager, SearchInput, SkeletonRows, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { plural } from "@/lib/format";
import { useTokenPages } from "@/lib/paging";
import { useWorkspace } from "@/lib/workspace";
import { createMaterial, deleteMaterial, listItems, quote, type Item } from "@/modules/knowledge/api";
import { BaseMark } from "@/modules/knowledge/bases/components/BaseMark";
import { openContribute } from "@/modules/knowledge/components/contribute-store";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { ResourceList, ResourceRow } from "@/modules/knowledge/components/ResourceRow";
import { useKnowledgeModel } from "@/modules/knowledge/queries";
import { catalogHref } from "@/modules/knowledge/model";
import { originParam, readerHref } from "@/modules/knowledge/reader/links";
import { newWorkHref, workflowsFor } from "@/modules/work";

import { invalidateSpaces, useSpaceBases, useSpaceLinkedAmong, useSpaceMaterialPages } from "../queries";
import { TOOLS_MIN, type SpaceView } from "./context";
import { Menu, type MenuNode } from "./Menu";

const isEditor = (b: Item) => b.access === "EDITOR" || b.access === "OWNER";
/** Documents per collection group and per page of linked documents. */
const PAGE = 20;
/** Documents the Link documents dialog offers per search. */
const LINK_PAGE = 25;
/** `displayName` contains `q` (case-insensitive); '' without a query. */
const titleFilter = (q: string) => (q ? `displayName = ${quote(`*${q}*`)}` : "");

/** Materials (preview `materialsTab`): documents of the linked collections, plus documents linked from other collections. */
export function MaterialsTab({ view }: { view: SpaceView }) {
  const { space, sid, manage, can } = view;
  const { id: ws, settings, hasModule } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const bases = useSpaceBases(space);
  const [q, setQ] = useState("");
  const needle = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const materials = useSpaceMaterialPages(sid, PAGE, { filter: titleFilter(needle) });
  const model = useKnowledgeModel();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [linking, setLinking] = useState(false);

  const readable = (bases.data ?? []).filter((b) => b.access !== "LOCKED");
  const editable = readable.filter(isEditor);
  const own = new Set(readable.map((b) => b.name));
  const linked = (materials.rows ?? []).filter((m) => m.item.itemKind === "DOCUMENT" && !m.item.ancestors?.some((a) => own.has(a.name)) && !own.has(m.item.parentItem));
  // A lower bound while the server sends no total: enough for the search threshold, not shown as a count.
  const linkedTotal = materials.total ?? (materials.page - 1) * PAGE + linked.length + (materials.hasNext ? 1 : 0);
  const workflows = hasModule("work") && !view.visitor ? workflowsFor(settings, space) : [];
  const pick = workflows.length > 0;
  const total = readable.reduce((n, b) => n + (b.collection?.documentCount ?? 0), 0) + linkedTotal;
  const openDoc = (item: string) => router.push(readerHref({ item, from: originParam({ kind: "space", id: sid }) }));

  /** Add materials ▾ (preview `addMaterials`): contribute to a linked collection, link a collection, link documents. */
  function addMaterials(variant: "primary" | "tertiary"): ReactNode {
    if (!manage)
      return editable.length === 1 ? (
        <Button variant={variant} onPress={() => openContribute({ collection: editable[0].name })}>
          <Upload aria-hidden />
          Gửi tài liệu
        </Button>
      ) : null;
    const nodes: MenuNode[] = editable.map((b) => ({
      id: `contribute-${b.name}`,
      label: editable.length === 1 ? "Gửi tài liệu" : `Gửi tài liệu vào ${b.displayName}`,
      icon: Upload,
      run: () => openContribute({ collection: b.name }),
    }));
    nodes.push({ id: "link-collection", label: "Liên kết kho tài liệu", icon: Library, run: () => router.push(`/space/${sid}?tab=settings`) });
    if (can("materials.create")) nodes.push({ id: "link-docs", label: "Liên kết tài liệu", icon: Link2, run: () => setLinking(true) });
    return (
      <Menu label="Thêm tài liệu học tập" nodes={nodes}>
        <Button variant={variant}>
          <Plus aria-hidden />
          Thêm tài liệu học tập
          <ChevronDown aria-hidden />
        </Button>
      </Menu>
    );
  }

  const dialog = linking ? <LinkDocumentsDialog view={view} ownBases={own} onClose={() => setLinking(false)} /> : null;

  if (bases.isError && !bases.data) return <ErrorState error={bases.error} onRetry={bases.refetch} />;
  if (bases.isPending || (materials.isPending && !needle) || materials.itemsPending) return <SkeletonRows rows={6} />;

  if (!readable.length && !linked.length && !needle && materials.page === 1)
    return (
      <>
        <EmptyState
          icon={BookOpen}
          boxed
          title="Chưa có tài liệu học tập"
          description={manage ? "Liên kết một kho tài liệu hoặc từng tài liệu để thành viên đọc và hỏi về chúng." : "Chưa có nội dung nào được chia sẻ tại đây."}
          actions={addMaterials("primary")}
        />
        {dialog}
      </>
    );

  async function unlink(material: string, item: Item) {
    try {
      await deleteMaterial(ws, material);
      void invalidateSpaces(qc, ws);
      toast(`Đã gỡ “${item.displayName}”`, {
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
  const search = total >= TOOLS_MIN || q ? <SearchInput value={q} onChange={setQ} placeholder="Tìm kiếm tài liệu học tập" /> : null;
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
        {linked.length ? (
          <section className="sp-mat">
            <div className="sp-mat__head">
              <ItemIcon icon={Link2} size="sm" />
              <span className="sp-mat__name truncate">Liên kết từ kho tài liệu khác</span>
              <span className="t-sm muted none">{materials.total !== undefined || !materials.hasNext ? plural(linkedTotal, "document") : null}</span>
            </div>
            <ResourceList>
              {linked.map((m) => {
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
                          <IconButton icon={X} tip="Gỡ khỏi cộng đồng này" size="sm" onPress={() => void unlink(m.material, m.item)} />
                        </span>
                      ) : undefined
                    }
                  />
                );
              })}
            </ResourceList>
            {materials.page > 1 || materials.hasNext ? (
              <Pager page={materials.page} pageSize={PAGE} total={materials.total} pageCount={linked.length} hasNext={materials.hasNext} onPageChange={materials.setPage} />
            ) : null}
          </section>
        ) : null}
        {needle && !linked.length && !readable.length ? <NoMatches what="tài liệu" onClear={() => setQ("")} /> : null}
      </div>
      {pick ? (
        <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
          <Menu
            label="Dùng trong quy trình"
            placement="bottom start"
            nodes={[
              {
                section: "Bắt đầu với các tài liệu đã chọn",
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
              Dùng trong quy trình
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

/** One linked collection: its documents as shared resource rows (preview `group`), a server page at a time. */
function CollectionGroup({ base, q, pick, selected, onToggle, onOpen }: CollectionGroupProps) {
  const { id: ws } = useWorkspace();
  const model = useKnowledgeModel();
  const edit = isEditor(base);
  const filter = [`ancestors:${quote(base.name ?? "")} AND itemKind = DOCUMENT`, titleFilter(q)].filter(Boolean).join(" AND ");
  const docs = useTokenPages([ws, "items", "spaceMaterials", base.name, filter], (pageToken) => listItems(ws, { filter, orderBy: "updateTime desc", view: "FULL", pageSize: PAGE, pageToken }));
  const rows = docs.data?.items ?? [];
  if (q && docs.isSuccess && !rows.length) return null;

  const head = (
    <div className="sp-mat__head">
      <BaseMark base={base} size={24} />
      <NextLink className="sp-mat__name truncate" href={catalogHref({ filters: { kb: [resourceId(base.name)] } })} translate="no">
        {base.displayName}
      </NextLink>
      <span className="t-sm muted none">{plural(docs.total ?? base.collection?.documentCount ?? 0, "document")}</span>
    </div>
  );

  let body: ReactNode;
  if (docs.isError && !docs.data) body = <ErrorState error={docs.error} onRetry={docs.refetch} />;
  else if (!docs.data) body = <SkeletonRows rows={3} />;
  else if (!rows.length && docs.page === 1)
    body = (
      <EmptyState
        icon={Files}
        compact
        boxed
        title="Chưa có tài liệu"
        description={edit ? "Gửi slide, tài liệu đọc hoặc báo cáo. Tài liệu được công bố sau khi duyệt." : undefined}
        actions={
          edit ? (
            <Button variant="tertiary" onPress={() => openContribute({ collection: base.name })}>
              <Upload aria-hidden />
              Gửi tài liệu
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
  const pager = docs.page > 1 || docs.hasNext ? <Pager page={docs.page} pageSize={PAGE} total={docs.total} pageCount={rows.length} hasNext={docs.hasNext} onPageChange={docs.setPage} /> : null;

  return (
    <section className="sp-mat">
      {head}
      {body}
      {pager}
    </section>
  );
}

interface LinkDocumentsDialogProps {
  view: SpaceView;
  /** The space's own collections (their documents are already materials). */
  ownBases: Set<string | undefined>;
  onClose: () => void;
}

/** Link documents (preview `M['sp-link-res']`): show documents from other collections in Materials; access doesn't change. */
function LinkDocumentsDialog({ view, ownBases, onClose }: LinkDocumentsDialogProps) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const model = useKnowledgeModel();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const needle = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  // Documents outside the space's own collections and the caller's My files, matching the search: one page.
  const outside = [...ownBases, model.ctx.personalCollection].filter((b): b is string => Boolean(b)).map((b) => `NOT ancestors:${quote(b)}`);
  const filter = ["itemKind = DOCUMENT", ...outside, titleFilter(needle)].filter(Boolean).join(" AND ");
  const catalog = useQuery({
    queryKey: [ws, "items", "spaceLinkCatalog", filter],
    queryFn: () => listItems(ws, { filter, orderBy: "updateTime desc", view: "FULL", pageSize: LINK_PAGE }),
    placeholderData: (prev) => prev,
  });
  const page = catalog.data?.items ?? [];
  // Which of them are already linked: one ListMaterials read by item name.
  const linked = useSpaceLinkedAmong(view.sid, page.map((d) => d.name ?? ""));
  const already = linked.data;
  const found = already ? page.filter((d) => !already.has(d.name ?? "")) : [];
  const n = picked.length;

  async function link() {
    if (!n) {
      setErr("Chọn ít nhất một tài liệu.");
      return;
    }
    setBusy(true);
    try {
      const made = await Promise.all(picked.map((item) => createMaterial(ws, view.sid, resourceId(item))));
      void invalidateSpaces(qc, ws);
      onClose();
      toast(`Đã liên kết ${plural(made.length, "document")} với ${view.space.displayName}`, {
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
      title="Liên kết tài liệu"
      description="Hiển thị tài liệu từ các kho tài liệu khác trong Tài liệu học tập và dùng chúng trong quy trình. Quyền mở tài liệu không thay đổi."
      footerStart={<span>{n ? `Đã chọn ${plural(n, "document")}` : "Chúng vẫn nằm trong kho tài liệu của mình."}</span>}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void link()} isPending={busy}>
            <Link2 aria-hidden />
            {n ? `Liên kết ${plural(n, "document")}` : "Liên kết tài liệu"}
          </Button>
        </>
      }
    >
      <SearchInput value={q} onChange={setQ} placeholder="Tìm theo tiêu đề hoặc chủ đề" fullWidth autoFocus />
      {catalog.isPending || (page.length > 0 && linked.isPending) ? (
        <div className="mt-12">
          <SkeletonRows rows={4} />
        </div>
      ) : catalog.isError ? (
        <ErrorState error={catalog.error} onRetry={catalog.refetch} boxed={false} />
      ) : found.length ? (
        <div className="option-list sp-options mt-12" role="group" aria-label="Tài liệu">
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
                        {r.typeMeta.label} · <span translate="no">{r.base?.displayName ?? ""}</span>
                      </span>
                    </span>
                  </span>
                </Checkbox.Content>
              </Checkbox>
            );
          })}
        </div>
      ) : (
        <p className="t-sm muted sp-options__empty">{needle ? "Không có tài liệu phù hợp. Hãy thử từ khác." : "Mọi tài liệu bạn đọc được đã có ở đây."}</p>
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
