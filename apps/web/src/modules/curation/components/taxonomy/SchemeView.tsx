"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import { Archive, Bot, ChevronDown, ChevronRight, Download, History, MoreHorizontal, Plus, Upload } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { IconButton, SearchInput, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { freeDomainColor } from "@/lib/tones";
import { useWorkspace } from "@/lib/workspace";
import { conceptIcon } from "@/modules/home/domainIcon";
import type { Concept, ConceptScheme } from "@/modules/knowledge/api";
import { fold } from "@/modules/knowledge/model";
import {
  ancestorsOf,
  authoritySchemes,
  conceptLabel,
  conceptLabels,
  conceptLook,
  conceptNameOf,
  conceptsOf,
  conceptState,
  narrowerOf,
  normLabel,
  resourceKey,
  schemeIconName,
  schemeLabel,
  schemeOfConcept,
  type Taxonomy,
  topConcepts,
} from "@/modules/knowledge/taxonomy";

import { holdDecision, useHeldDecisions } from "../../decisions";
import { newNotation, schemeNotations, sharedLabelsOf } from "../../governance";
import { taxonomyHref } from "../../model";
import { useInvalidateTaxonomy, useRememberConcept, useSchemePreview, useSharedLabels } from "../../queries";
import { createConcept, deleteConcept, deprecateConcept, exportSchemeVersion, updateConcept } from "../../taxonomyApi";
import { ConceptDetail, type ConceptActions } from "./ConceptDetail";
import { ConceptDraftDialog, ReplaceDialog } from "./ConceptDialogs";
import { ImportDialog } from "./ImportDialog";
import { DOT, saveText, type TaxonomyAccess } from "./parts";
import { PromptDrawer } from "./PromptDrawer";
import { PublishDialog } from "./PublishDialog";
import { VersionsDrawer } from "./VersionsDrawer";

const RETIRED = "__retired";

/**
 * A scheme's view (preview `schemeView`): its header (name, description, published version, a quiet “Nhãn trùng (n)”
 * link, the single primary “Công bố (k thay đổi)” while the working copy has unpublished edits, and ⋯) over two panes —
 * the concept tree and the selected concept's detail (`?node=`). Edits change the working copy at once; Publish checks
 * and publishes it. Merge, split, retire and delete a draft are held for the Undo window, then sent.
 */
export function SchemeView({ taxonomy: t, scheme, access, node, onSelect }: { taxonomy: Taxonomy; scheme: ConceptScheme; access: TaxonomyAccess; node: string; onSelect: (id: string) => void }) {
  const { id: ws } = useWorkspace();
  const held = useHeldDecisions();
  const refresh = useInvalidateTaxonomy();
  const remember = useRememberConcept();
  const sname = scheme.name ?? "";
  const [adding, setAdding] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<{ concept: Concept; mode: "merge" | "split" } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [versions, setVersions] = useState(false);
  const [importing, setImporting] = useState(false);
  const [prompt, setPrompt] = useState(false);

  const live = conceptsOf(t, sname).filter((c) => !held.has(c.name ?? ""));
  const roots = live.filter((c) => !parentsOf(t, c).length);
  const picked = node ? t.byName.get(conceptNameOf(sname, node)) : undefined;
  const selected = picked && !held.has(picked.name ?? "") ? picked : roots[0];

  const preview = useSchemePreview(scheme, { enabled: access.publish });
  const changed = new Set((preview.data?.changes ?? []).map((c) => c.concept ?? ""));
  const shared = useSharedLabels();
  const dup = (() => {
    const s = sharedLabelsOf(shared.data ?? [], sname);
    return s.within.length + s.across.length;
  })();
  const k = scheme.unpublishedChanges ?? 0;

  /* ── Held concept decisions (preview: act at once with Undo) ── */
  const holdConcept = (c: Concept, message: string, undone: string, send: (init: { keepalive?: boolean }) => Promise<unknown>) => {
    const up = parentsOf(t, c)[0];
    onSelect(up ? resourceKey(up) : "");
    holdDecision({
      names: [c.name ?? ""],
      message,
      undoneMessage: undone,
      send: (init) => send(init).then(() => undefined),
      onSent: refresh,
      onFailed: refresh,
      onUndo: () => onSelect(resourceKey(c.name)),
    });
  };
  const label = (c: Concept | string) => conceptLabel(t, typeof c === "string" ? c : c.name);
  const actions: ConceptActions = {
    onSelect,
    onNew: (broader) => setAdding(broader),
    onReplace: (concept, mode) => setReplacing({ concept, mode }),
    onRetire: (c) => {
      const kids = narrowerOf(t, c.name ?? "").length;
      if (kids) {
        toast(`Hãy chuyển ${plural(kids, "concept")} con của “${label(c)}” sang chỗ khác trước khi ngừng dùng.`, { tone: "accent" });
        return;
      }
      holdConcept(c, `Đã ngừng dùng “${label(c)}” · có hiệu lực khi bạn công bố`, `Đã khôi phục “${label(c)}”`, (init) => deprecateConcept(c, [], init));
    },
    onDeleteDraft: (c) => holdConcept(c, `Đã xóa “${label(c)}”`, `Đã khôi phục “${label(c)}”`, (init) => deleteConcept(c.name ?? "", init)),
  };
  const replace = (c: Concept, mode: "merge" | "split", targets: string[], keepName: boolean) => {
    const names = targets.map(label).join(", ");
    const keep = mode === "merge" && keepName ? t.byName.get(targets[0]) : undefined;
    const vi = label(c);
    const known = keep ? conceptLabels(keep).some((l) => normLabel(l.text) === normLabel(vi)) : true;
    holdConcept(
      c,
      mode === "merge" ? `Đã gộp “${vi}” vào ${names} · có hiệu lực khi bạn công bố` : `Đã tách “${vi}” thành ${names} · có hiệu lực khi bạn công bố`,
      `Đã khôi phục “${vi}”`,
      async (init) => {
        await deprecateConcept(c, targets, init);
        if (keep && !known) await updateConcept(keep, { altLabels: [...(keep.altLabels ?? []), { languageCode: "vi", text: vi }] });
      },
    );
  };
  const create = async (draft: { name: string; broader: string; definition: string }) => {
    const top = !draft.broader;
    try {
      const c = await createConcept(sname, newNotation(draft.name, schemeNotations(t, sname)), {
        prefLabels: [{ languageCode: "vi", text: draft.name }],
        broader: top ? [] : [draft.broader],
        ...(draft.definition ? { definition: draft.definition } : {}),
        ...(top ? { color: freeDomainColor(topConcepts(t, sname).map((x) => x.color)), icon: schemeIconName(sname) } : {}),
      });
      remember(c);
      refresh();
      onSelect(resourceKey(c.name));
      toast(`Đã tạo bản nháp “${draft.name}”`, {
        undo: () =>
          void deleteConcept(c.name ?? "").then(
            () => {
              remember(c, { removed: true });
              refresh();
              onSelect(draft.broader ? resourceKey(draft.broader) : "");
            },
            (error: unknown) => toast(errorMessage(error), { tone: "danger" }),
          ),
      });
      return true;
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      return false;
    }
  };
  const exportSkos = async () => {
    if (!scheme.publishedVersion) return;
    try {
      const r = await exportSchemeVersion(sname, scheme.publishedVersion, "TURTLE");
      saveText(`${ws}-${resourceKey(sname)}.ttl`, r.content ?? "", r.mimeType ?? "text/turtle;charset=utf-8");
      toast(`Đã xuất ${schemeLabel(scheme)} dạng SKOS`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  const head = (
    <SchemeHeader
      scheme={scheme}
      taxonomy={t}
      access={access}
      changes={k}
      duplicates={dup}
      onPublish={() => setPublishing(true)}
      menu={{
        onImport: access.update || access.create ? () => setImporting(true) : undefined,
        onExport: () => void exportSkos(),
        onVersions: () => setVersions(true),
        onPrompt: access.scheme ? () => setPrompt(true) : undefined,
      }}
    />
  );

  return (
    <>
      <div className={`tx${node ? " tx--picked" : ""}`}>
        {head}
        <div className="tx-panes">
          <ConceptTree taxonomy={t} scheme={scheme} live={live} selected={selected?.name ?? ""} changed={changed} access={access} onSelect={onSelect} onNew={(b) => setAdding(b)} />
          <div className="tx-main" id="tx-main">
            <ConceptDetail key={selected?.name ?? ""} taxonomy={t} scheme={scheme} concept={selected ?? null} access={access} actions={actions} />
          </div>
        </div>
      </div>
      {adding != null ? (
        <ConceptDraftDialog
          taxonomy={t}
          scheme={scheme}
          initial={{ name: "", broader: adding, definition: "" }}
          title="Khái niệm mới"
          description={`Một bản nháp trong ${schemeLabel(scheme)}. Tài liệu được phân loại theo khái niệm này khi bạn công bố.`}
          submitLabel="Tạo bản nháp"
          onSubmit={create}
          onClose={() => setAdding(null)}
        />
      ) : null}
      {replacing ? (
        <ReplaceDialog
          taxonomy={t}
          concept={replacing.concept}
          mode={replacing.mode}
          onConfirm={(targets, keep) => replace(replacing.concept, replacing.mode, targets, keep)}
          onClose={() => setReplacing(null)}
        />
      ) : null}
      {publishing ? <PublishDialog taxonomy={t} scheme={scheme} onClose={() => setPublishing(false)} onOpenConcept={(c) => onSelect(resourceKey(c))} /> : null}
      <VersionsDrawer isOpen={versions} onClose={() => setVersions(false)} taxonomy={t} scheme={scheme} preview={access.publish ? preview.data : undefined} />
      {importing ? <ImportDialog taxonomy={t} scheme={scheme} onClose={() => setImporting(false)} /> : null}
      <PromptDrawer isOpen={prompt} onClose={() => setPrompt(false)} taxonomy={t} />
    </>
  );
}

/** Broader concepts in the concept's own scheme (a program's broader org unit belongs to another list). */
function parentsOf(t: Taxonomy, c: Concept): string[] {
  const s = schemeOfConcept(c.name ?? "");
  return (c.broader ?? []).filter((b) => schemeOfConcept(b) === s && t.byName.has(b) && conceptState(t.byName.get(b)) !== "DEPRECATED");
}

/* ═══════════════ Header ═══════════════ */

interface SchemeMenu {
  onImport?: () => void;
  onExport: () => void;
  onVersions: () => void;
  onPrompt?: () => void;
}

function SchemeHeader({
  scheme,
  taxonomy: t,
  access,
  changes,
  duplicates,
  onPublish,
  menu,
}: {
  scheme: ConceptScheme;
  taxonomy: Taxonomy;
  access: TaxonomyAccess;
  changes: number;
  duplicates: number;
  onPublish: () => void;
  menu: SchemeMenu;
}) {
  const router = useRouter();
  const refs = authoritySchemes(t).filter((a) => a.name !== scheme.name);
  const meta: ReactNode[] = [
    <span key="v">{scheme.publishedVersion ? `Phiên bản ${scheme.publishedVersion}` : "Chưa công bố"}</span>,
    changes && !access.publish ? <span key="k">{`${fmtNum(changes)} thay đổi chưa công bố`}</span> : null,
    duplicates ? (
      <NextLink key="d" className="link" href={taxonomyHref(resourceKey(scheme.name), { conflicts: "1" })}>
        {`Nhãn trùng (${fmtNum(duplicates)})`}
      </NextLink>
    ) : null,
  ].filter(Boolean);
  const items = [
    ...(menu.onImport ? [{ id: "import", label: "Nhập CSV", icon: Upload, run: menu.onImport }] : []),
    { id: "export", label: "Xuất SKOS", icon: Download, run: menu.onExport, disabled: !scheme.publishedVersion },
    { id: "versions", label: "Lịch sử phiên bản", icon: History, run: menu.onVersions },
    ...(menu.onPrompt ? [{ id: "prompt", label: "Xem cách trợ lý phân loại", icon: Bot, run: menu.onPrompt }] : []),
  ];
  const act = (key: string) => {
    const item = items.find((x) => x.id === key);
    if (item) item.run();
    else router.push(taxonomyHref(key));
  };
  return (
    <header className="tx-scheme">
      <div className="tx-scheme__main">
        <h2 className="tx-scheme__name" translate="no">
          {schemeLabel(scheme)}
        </h2>
        {scheme.description ? (
          <p className="tx-scheme__desc" translate="no">
            {scheme.description}
          </p>
        ) : null}
        <p className="tx-scheme__meta">
          {meta.map((m, i) => (
            <span key={i}>
              {i ? DOT : null}
              {m}
            </span>
          ))}
        </p>
      </div>
      <div className="tx-scheme__acts">
        {access.publish && changes ? (
          <Button variant="primary" onPress={onPublish}>
            <Upload className="i" aria-hidden />
            {`Công bố (${fmtNum(changes)} thay đổi)`}
          </Button>
        ) : null}
        <Dropdown>
          <IconButton icon={MoreHorizontal} tip="Thao tác khác cho trục phân loại này" showTip={false} />
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu aria-label="Thao tác khác cho trục phân loại này" onAction={(key) => act(String(key))} disabledKeys={items.filter((x) => x.disabled).map((x) => x.id)}>
              <Dropdown.Section>
                {items.map(({ id, label, icon: Icon }) => (
                  <Dropdown.Item key={id} id={id} textValue={label}>
                    <Icon className="i" aria-hidden />
                    <Label>{label}</Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
              {refs.length ? <Separator /> : null}
              {refs.length ? (
                <Dropdown.Section>
                  <Header>Danh mục tham chiếu</Header>
                  {refs.map((a) => {
                    const Icon = conceptIcon(schemeIconName(a.name));
                    const id = resourceKey(a.name);
                    return (
                      <Dropdown.Item key={id} id={id} textValue={schemeLabel(a)}>
                        <Icon className="i" aria-hidden />
                        <Label translate="no">{schemeLabel(a)}</Label>
                      </Dropdown.Item>
                    );
                  })}
                </Dropdown.Section>
              ) : null}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    </header>
  );
}

/* ═══════════════ Tree ═══════════════ */

interface TreeItem {
  key: string;
  id: string;
  level: number;
  expanded?: boolean;
  cls?: string;
  inner: ReactNode;
  children: TreeItem[];
}

/**
 * The concept tree (preview `treePane`): search over every label; a poly-hierarchy — a concept with several broader
 * concepts sits under each, marked “Cũng nằm dưới …” under the others; drafts badged; an unpublished change dotted;
 * document counts that include narrower concepts; retired concepts last behind “Ngừng dùng (n)”. One row grid:
 * [chevron 16] [icon 20] [name] [trailing]. Small schemes start open; larger ones open along the selection. ↑↓ Home End
 * move, → opens or enters, ← closes or goes to the parent, Enter/Space selects.
 */
function ConceptTree({
  taxonomy: t,
  scheme,
  live,
  selected,
  changed,
  access,
  onSelect,
  onNew,
}: {
  taxonomy: Taxonomy;
  scheme: ConceptScheme;
  live: readonly Concept[];
  selected: string;
  changed: ReadonlySet<string>;
  access: TaxonomyAccess;
  onSelect: (id: string) => void;
  onNew: (broader: string) => void;
}) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [retiredOpen, setRetiredOpen] = useState(false);
  const ref = useRef<HTMLUListElement>(null);
  const sname = scheme.name ?? "";
  const needle = fold(q).trim();
  const retired = conceptsOf(t, sname, { deprecated: true }).filter((c) => conceptState(c) === "DEPRECATED");
  const liveNames = new Set(live.map((c) => c.name ?? ""));
  const kidsOf = (name: string) => live.filter((c) => parentsOf(t, c).includes(name));
  const roots = live.filter((c) => !parentsOf(t, c).length);
  let show: Set<string> | null = null;
  if (needle) {
    show = new Set();
    for (const c of live) {
      if (!conceptLabels(c).some((l) => fold(l.text).includes(needle))) continue;
      show.add(c.name ?? "");
      for (const a of ancestorsOf(t, c.name ?? "")) show.add(a);
    }
  }
  const along = new Set(selected ? ancestorsOf(t, selected) : []);
  const small = live.length <= 30;
  const isOpen = (name: string) => (needle ? true : name in closed ? !closed[name] : small || along.has(name));
  const maxDepth = scheme.maxDepth || 9;

  const chev = (open: boolean, toggle: () => void) => (
    <span
      className="tx-row__chev"
      aria-hidden="true"
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
    >
      {open ? <ChevronDown className="i i-sm" /> : <ChevronRight className="i i-sm" />}
    </span>
  );
  const noChev = <span className="tx-row__chev tx-row__chev--none" aria-hidden="true" />;
  const glyph = (c: Concept, top: boolean) => {
    const look = conceptLook(t, c.name ?? "");
    const Icon = conceptIcon(look.icon);
    return (
      <span className={top ? "tx-row__tile" : "tx-row__glyph"} style={{ "--tone": look.color } as CSSProperties} aria-hidden="true">
        <Icon className={top ? "i" : "i i-sm"} />
      </span>
    );
  };
  const nameOf = (c: Concept, also: readonly string[]) => {
    const label = conceptLabel(t, c.name);
    const where = also.length ? `Cũng nằm dưới ${also.map((a) => conceptLabel(t, a)).join(", ")}` : "";
    return (
      <span className="tx-row__label">
        <span className="tx-row__name" translate="no" title={label}>
          {label}
        </span>
        {where ? (
          <span className="tx-row__also" title={where}>
            {where}
          </span>
        ) : null}
      </span>
    );
  };
  const trail = (c: Concept, level: number) => {
    const st = conceptState(c);
    const n = c.documentCount ?? 0;
    const addLabel = `Thêm khái niệm dưới ${conceptLabel(t, c.name)}`;
    return (
      <span className="tx-row__trail">
        {st === "DRAFT" ? <span className="tx-row__badge">Nháp</span> : st === "DEPRECATED" ? <span className="tx-row__badge">Ngừng dùng</span> : null}
        {st === "PUBLISHED" && changed.has(c.name ?? "") ? <span className="tx-row__dot" role="img" aria-label="Thay đổi chưa công bố" title="Thay đổi chưa công bố" /> : null}
        <span className="tx-row__count">{n ? fmtNum(n) : ""}</span>
        {access.create && st !== "DEPRECATED" && level < maxDepth ? (
          <button
            type="button"
            className="tx-row__add"
            tabIndex={-1}
            aria-label={addLabel}
            title={addLabel}
            onClick={(e) => {
              e.stopPropagation();
              onNew(c.name ?? "");
            }}
          >
            <Plus className="i i-sm" aria-hidden />
          </button>
        ) : null}
      </span>
    );
  };
  const build = (c: Concept, level: number, path: readonly string[], parent: string): TreeItem | null => {
    const name = c.name ?? "";
    if ((show && !show.has(name)) || path.includes(name)) return null;
    const kids = kidsOf(name);
    const open = kids.length ? isOpen(name) : undefined;
    const ps = parentsOf(t, c);
    // Under a parent that isn't its first, a concept names where else it sits.
    const also = parent && ps[0] !== parent ? ps.filter((p) => p !== parent && liveNames.has(p)) : [];
    const next = [...path, name];
    return {
      key: next.map(resourceKey).join("~"),
      id: name,
      level,
      expanded: open,
      inner: (
        <>
          {kids.length ? chev(!!open, () => setClosed((x) => ({ ...x, [name]: !!open }))) : noChev}
          {glyph(c, !ps.length)}
          {nameOf(c, also)}
          {trail(c, level)}
        </>
      ),
      children: open ? kids.map((k) => build(k, level + 1, next, name)).filter((x): x is TreeItem => !!x) : [],
    };
  };
  const items = roots.map((c) => build(c, 1, [], "")).filter((x): x is TreeItem => !!x);
  if (retired.length && !needle) {
    items.push({
      key: RETIRED,
      id: RETIRED,
      level: 1,
      expanded: retiredOpen,
      cls: "tx-item--retired-group",
      inner: (
        <>
          {chev(retiredOpen, () => setRetiredOpen((o) => !o))}
          <Archive className="i i-sm tx-row__icon" aria-hidden />
          <span className="tx-row__name muted">{`Ngừng dùng (${fmtNum(retired.length)})`}</span>
          <span className="tx-row__trail" />
        </>
      ),
      children: retiredOpen
        ? retired.map((c) => ({ key: `${RETIRED}~${resourceKey(c.name)}`, id: c.name ?? "", level: 2, cls: "tx-item--retired", inner: <>{noChev}{glyph(c, false)}{nameOf(c, [])}{trail(c, 99)}</>, children: [] }))
        : [],
    });
  }
  const flat: TreeItem[] = [];
  const walk = (list: readonly TreeItem[]) => list.forEach((x) => (flat.push(x), walk(x.children)));
  walk(items);
  const focusKey = (flat.find((x) => x.id === selected) ?? flat[0])?.key;

  const select = (id: string) => (id === RETIRED ? setRetiredOpen((o) => !o) : onSelect(resourceKey(id)));
  const toggle = (id: string, close?: boolean) => {
    if (id === RETIRED) setRetiredOpen((o) => (close == null ? !o : !close));
    else setClosed((x) => ({ ...x, [id]: close == null ? isOpen(id) : close }));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!it || e.target !== it || e.metaKey || e.ctrlKey || e.altKey) return;
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
    const i = all.indexOf(it);
    const id = it.dataset.id ?? "";
    const exp = it.getAttribute("aria-expanded");
    const focus = (el: HTMLElement | null | undefined) => {
      if (!el) return;
      all.forEach((x) => (x.tabIndex = -1));
      el.tabIndex = 0;
      el.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        focus(all[i + 1]);
        break;
      case "ArrowUp":
        focus(all[i - 1]);
        break;
      case "Home":
        focus(all[0]);
        break;
      case "End":
        focus(all.at(-1));
        break;
      case "ArrowRight":
        if (exp === "false") toggle(id, false);
        else if (exp === "true") focus(all[i + 1]);
        break;
      case "ArrowLeft":
        if (exp === "true") toggle(id, true);
        else focus(it.parentElement?.closest<HTMLElement>('[role="treeitem"]'));
        break;
      case "Enter":
      case " ":
        select(id);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  const row = (x: TreeItem): ReactNode => (
    <li
      key={x.key}
      role="treeitem"
      id={`tx-n-${x.key}`}
      className={`tx-item${x.cls ? ` ${x.cls}` : ""}`}
      aria-level={x.level}
      aria-selected={x.id === selected}
      aria-expanded={x.expanded}
      tabIndex={x.key === focusKey ? 0 : -1}
      data-id={x.id}
    >
      <div className={`tx-row${x.id === selected ? " is-selected" : ""}`} onClick={() => select(x.id)}>
        {x.inner}
      </div>
      {x.children.length ? (
        <ul role="group" className="tx-group">
          {x.children.map(row)}
        </ul>
      ) : null}
    </li>
  );

  return (
    <div className="tx-side" id="tx-side">
      <div className="tx-side__tools">
        <SearchInput value={q} onChange={setQ} placeholder="Tìm theo nhãn" label="Tìm khái niệm theo bất kỳ nhãn nào" fullWidth />
        {access.create ? <IconButton icon={Plus} tip="Khái niệm mới" size="sm" onPress={() => onNew("")} /> : null}
      </div>
      {items.length ? (
        <ul role="tree" className="tx-tree" aria-label={schemeLabel(scheme)} ref={ref} onKeyDown={onKeyDown}>
          {items.map(row)}
        </ul>
      ) : (
        <p className="tx-side__empty">{needle ? `Không có khái niệm nào mang nhãn “${q}”.` : "Chưa có khái niệm nào."}</p>
      )}
    </div>
  );
}
