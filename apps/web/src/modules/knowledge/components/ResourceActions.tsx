"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import clsx from "clsx";
import {
  Archive,
  BookOpen,
  Bookmark,
  Ellipsis,
  Download,
  FileText,
  Files,
  Link,
  Link2,
  ListChecks,
  ListPlus,
  Pencil,
  ShieldCheck,
  Sparkles,
  Table,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Tip } from "@/components/ui/Tip";
import { useWorkspace } from "@/lib/workspace";

import type { Resource } from "../model";
import { useDocumentOperations } from "../operations";
import { useFeaturedIds, useItemPermissions, useSavedItems } from "../queries";
import { openContribute } from "./Contribute";
import { openAddToCollection, openEditDetails, openLinkToSpaces } from "./dialogs";

/* ═══════════════ Save toggle ═══════════════ */

export interface SaveButtonProps {
  resource: Resource;
  size?: "sm" | "md";
  /** Labelled button ("Save" / "Saved") instead of the icon-only bookmark. */
  label?: boolean;
}

/** Bookmark toggle (preview `X.res.saveBtn`): optimistic, toast with Undo, `aria-pressed`. */
export function SaveButton({ resource, size = "sm", label = false }: SaveButtonProps) {
  const saved = useSavedItems();
  const ops = useDocumentOperations();
  const on = saved.isSaved(resource.id);
  const icon = <Bookmark aria-hidden fill={on ? "currentColor" : "none"} />;
  const press = () => void ops.setSaved(resource, !on);
  if (label) {
    return (
      <Button size={size} variant="secondary" aria-pressed={on} className={clsx("res-save", on && "is-on")} onPress={press}>
        {icon}
        {on ? "Saved" : "Save"}
      </Button>
    );
  }
  return (
    <Tip content={on ? "Remove from saved" : "Save"}>
      <Button
        isIconOnly
        size={size}
        variant="ghost"
        aria-label={on ? "Remove from saved" : "Save"}
        aria-pressed={on}
        className={clsx("res-save", !on && "button--muted", on && "is-on")}
        onPress={press}
      >
        {icon}
      </Button>
    </Tip>
  );
}

/* ═══════════════ ⋯ menu ═══════════════ */

const WORKFLOWS: Readonly<Record<string, { label: string; icon: LucideIcon }>> = {
  EVIDENCE_REVIEW: { label: "Evidence review", icon: Table },
  DRAFT: { label: "Draft a document", icon: Pencil },
  STUDY_GUIDE: { label: "Study guide", icon: BookOpen },
  QUIZ: { label: "Practice quiz", icon: ListChecks },
};

/** One action in a resource menu. */
export interface MenuEntry {
  id: string;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  run: () => void;
}
type MenuNode = MenuEntry | { sep: string } | { section: string; items: MenuEntry[] };

/**
 * "Use in…" entries (preview `X.res.useItems` / `MENUS['res-use']`): the workspace's enabled workflows,
 * each starting new work with this document (`/work/new?docs=&workflow=`). Empty when Work is off or the
 * document isn't readable yet; one generic "New work…" when no workflow is configured.
 */
export function useUseInEntries(r: Resource): MenuEntry[] {
  const router = useRouter();
  const { hasModule, settings } = useWorkspace();
  if (!hasModule("work") || !r.readable) return [];
  const workflows = (settings?.workflows ?? []).filter((w) => w.enabled && w.key && WORKFLOWS[w.key]);
  if (!workflows.length) return [{ id: "use-work", label: "New work…", icon: Files, run: () => router.push(`/work/new?docs=${r.id}`) }];
  return workflows.map((w) => ({
    id: `use-${w.key}`,
    label: WORKFLOWS[w.key!].label,
    icon: WORKFLOWS[w.key!].icon,
    run: () => router.push(`/work/new?docs=${r.id}&workflow=${w.key}`),
  }));
}

export interface ResourceMenuProps {
  resource: Resource;
  size?: "sm" | "md";
  /** Hide "Open" (the Reader itself). */
  hideOpen?: boolean;
  /** Query the Reader/Ask should start from. */
  q?: string;
}

/**
 * The ⋯ menu every knowledge surface shows (preview `MENUS['res-more']`). Item permissions are
 * tested when the menu first opens; editor actions appear only for holders.
 */
export function ResourceMenu({ resource: r, size = "sm", hideOpen = false, q = "" }: ResourceMenuProps) {
  const router = useRouter();
  const { can, hasModule, memberId, member } = useWorkspace();
  const [opened, setOpened] = useState(false);
  const perms = useItemPermissions(r.name, { enabled: opened && r.editable });
  const saved = useSavedItems();
  const canFeature = can("readingLists.publish") && !r.isPersonal;
  const featured = useFeaturedIds({ enabled: opened && canFeature });
  const ops = useDocumentOperations();

  const isSaved = saved.isSaved(r.id);
  const published = r.item.document?.publicationState !== "UNPUBLISHED";
  const mine = r.item.creator === member.name || !!r.item.creator?.endsWith(`/members/${memberId}`);
  const edit = perms.can("items.update");
  const useIn = useUseInEntries(r);

  const nodes: (MenuNode | false)[] = [
    !hideOpen && { id: "open", label: "Open", icon: FileText, run: () => router.push(`/doc/${r.id}${q ? `?q=${encodeURIComponent(q)}` : ""}`) },
    { id: "save", label: isSaved ? "Remove from saved" : "Save", icon: Bookmark, run: () => void ops.setSaved(r, !isSaved) },
    { id: "collect", label: "Add to collection…", icon: ListPlus, run: () => openAddToCollection(r.name) },
    r.readable && { id: "ask", label: "Ask about it", icon: Sparkles, run: () => router.push(`/chat?q=${encodeURIComponent(q)}&doc=${r.id}`) },
    useIn.length > 0 && { section: "Use in", items: useIn },
    { sep: "share" },
    { id: "link", label: "Copy link", icon: Link, run: () => void ops.copyLink(r) },
    { id: "download", label: "Download", icon: Download, run: () => void ops.download(r) },
    can("contributions.create") && !r.isPersonal && (edit || mine) && published && {
      id: "version",
      label: "Submit a new version…",
      icon: Upload,
      run: () => openContribute({ item: r.name }),
    },
    can("contributions.review") && perms.can("contributions.review") && {
      id: "manage",
      label: "Manage in Documents",
      icon: Files,
      run: () => router.push(`/documents?tab=all&q=${encodeURIComponent(r.title)}`),
    },
    canFeature && published && featured.isSuccess && {
      id: "feature",
      label: featured.ids.has(r.id) ? "Remove from Home" : "Feature on Home",
      icon: Sparkles,
      run: () => void ops.setFeatured(r, !featured.ids.has(r.id)),
    },
    edit && { sep: "edit" },
    edit && { id: "edit", label: "Edit details…", icon: Pencil, run: () => openEditDetails(r.name) },
    edit && hasModule("spaces") && { id: "spaces", label: "Link to spaces…", icon: Link2, run: () => openLinkToSpaces(r.name) },
    edit && !r.isPersonal && perms.can("items.verify") && {
      id: "verify",
      label: r.trust.state === "verified" ? "Renew verification" : "Mark as verified",
      icon: ShieldCheck,
      run: () => void ops.verify(r),
    },
    perms.can("items.delete") && { id: "archive", label: "Archive", icon: Archive, danger: true, run: () => void ops.archive(r) },
  ];
  const visible = nodes.filter(Boolean) as MenuNode[];
  // Drop separators that would lead, trail or double up.
  const clean = visible.filter((n, i) => !("sep" in n) || (i > 0 && i < visible.length - 1 && !("sep" in visible[i - 1])));
  const entries = new Map<string, MenuEntry>();
  for (const n of clean) {
    if ("run" in n) entries.set(n.id, n);
    if ("section" in n) for (const e of n.items) entries.set(e.id, e);
  }

  const item = (e: MenuEntry): ReactNode => (
    <Dropdown.Item key={e.id} id={e.id} textValue={e.label} variant={e.danger ? "danger" : undefined}>
      <e.icon className="i" aria-hidden />
      <Label>{e.label}</Label>
    </Dropdown.Item>
  );

  return (
    <Dropdown onOpenChange={(open) => open && setOpened(true)}>
      <Button isIconOnly size={size} variant="ghost" aria-label="More actions" className="button--muted">
        <Ellipsis aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={`Actions for ${r.title}`} onAction={(key) => entries.get(String(key))?.run()}>
          {clean.map((n) =>
            "sep" in n ? (
              <Separator key={`sep-${n.sep}`} />
            ) : "section" in n ? (
              <Dropdown.Section key={`section-${n.section}`}>
                <Header>{n.section}</Header>
                {n.items.map(item)}
              </Dropdown.Section>
            ) : (
              item(n)
            ),
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/* ═══════════════ Save + ⋯ ═══════════════ */

export interface ResourceActionsProps extends ResourceMenuProps {
  /** Labelled Save button (Reader header). */
  saveLabel?: boolean;
}

/** Save toggle + ⋯ menu, the trailing actions of rows, cards and the Reader header. Stops clicks reaching the row/card. */
export function ResourceActions({ resource, size = "sm", hideOpen, q, saveLabel }: ResourceActionsProps) {
  return (
    <>
      <SaveButton resource={resource} size={size} label={saveLabel} />
      <ResourceMenu resource={resource} size={size} hideOpen={hideOpen} q={q} />
    </>
  );
}
