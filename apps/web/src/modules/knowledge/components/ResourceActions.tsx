"use client";

import { Button, Dropdown, Header, Label, Separator, Tooltip } from "@heroui/react";
import clsx from "clsx";
import {
  Archive,
  BookOpen,
  Bookmark,
  Download,
  Ellipsis,
  Files,
  Folder,
  Library,
  Link,
  Link2,
  ListChecks,
  Pencil,
  Settings,
  ShieldCheck,
  Sparkles,
  Table,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { useWorkspace } from "@/lib/workspace";

import type { Resource } from "../model";
import { useDocumentOperations } from "../operations";
import { useItemPermissions, useSavedItems } from "../queries";
import { readerHref } from "../reader/links";
import { openContribute } from "./contribute-store";
import { openEditDetails, openLinkToSpaces, openMoveItems } from "./dialogs";

/* ═══════════════ Save toggle ═══════════════ */

export interface SaveButtonProps {
  resource: Resource;
  size?: "sm" | "md";
  /** Labelled button ("Save" / "Saved") instead of the icon-only bookmark. */
  label?: boolean;
}

/**
 * Bookmark toggle (preview `X.res.saveBtn`): toast with Undo, `aria-pressed`. Your own files already live
 * in My files, so they have none (saving would only make a second copy) — unless one is saved already
 * (saved before it moved, or from another client): then it stays so Saved can drop it.
 */
export function SaveButton({ resource, size = "sm", label = false }: SaveButtonProps) {
  const saved = useSavedItems();
  const ops = useDocumentOperations();
  const on = saved.isSaved(resource.id);
  if (resource.isPersonal && !on) return null;
  const icon = <Bookmark aria-hidden fill={on ? "currentColor" : "none"} />;
  const press = () => void ops.setSaved(resource, !on);
  if (label) {
    return (
      <Button size={size} variant="secondary" aria-pressed={on} className={clsx("res-save", on && "is-on")} onPress={press}>
        {icon}
        {on ? "Đã lưu" : "Lưu"}
      </Button>
    );
  }
  return (
    <Tooltip>
      <Button
        isIconOnly
        size={size}
        variant="ghost"
        aria-label={on ? "Bỏ lưu" : "Lưu"}
        aria-pressed={on}
        className={clsx("res-save", !on && "button--muted", on && "is-on")}
        onPress={press}
      >
        {icon}
      </Button>
      <Tooltip.Content>{on ? "Bỏ lưu" : "Lưu"}</Tooltip.Content>
    </Tooltip>
  );
}

/* ═══════════════ ⋯ menu ═══════════════ */

const WORKFLOWS: Readonly<Record<string, { label: string; icon: LucideIcon }>> = {
  EVIDENCE_REVIEW: { label: "Tổng hợp bằng chứng", icon: Table },
  DRAFT: { label: "Soạn tài liệu", icon: Pencil },
  STUDY_GUIDE: { label: "Tài liệu ôn tập", icon: BookOpen },
  QUIZ: { label: "Bài luyện tập", icon: ListChecks },
};

/** One action in a resource menu. */
export interface MenuEntry {
  id: string;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  run: () => void;
}

/** A menu holds at most this many actions (preview `MENU_MAX`); past it, Manage folds into one "Manage…" entry. */
const MENU_MAX = 8;

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
  if (!workflows.length) return [{ id: "use-work", label: "Công việc mới…", icon: Files, run: () => router.push(`/work/new?docs=${r.id}`) }];
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
  /**
   * The surface the menu sits on, so it leaves out what that surface already shows: `reader` (the Reader
   * header has Save and Ask), `peek` (the quick preview has Ask). Open is never in the menu: the row or
   * card itself opens the document.
   */
  context?: "reader" | "peek";
  /** Surface-specific reading entries, appended to the reading group (e.g. the Reader's panels). */
  extra?: readonly MenuEntry[];
  /** Query Ask should start from. */
  q?: string;
}

const entryItem = (e: MenuEntry): ReactNode => (
  <Dropdown.Item key={e.id} id={e.id} textValue={e.label} variant={e.danger ? "danger" : undefined} onAction={e.run}>
    <e.icon className="i" aria-hidden />
    <Label>{e.label}</Label>
  </Dropdown.Item>
);

/**
 * A resource's ⋯ (preview `MENUS['res-more']`): reading (Ask, Copy link, Download),
 * Use in, then Manage for editors, Archive last — at most 8 entries; when Manage would push it past 8 it
 * becomes one "Manage…" entry with its own menu. Item permissions load when the menu first opens.
 */
export function ResourceMenu({ resource: r, size = "sm", context, extra = [], q = "" }: ResourceMenuProps) {
  const router = useRouter();
  const { can, hasModule, memberId, member } = useWorkspace();
  const [opened, setOpened] = useState(false);
  const perms = useItemPermissions(r.name, { enabled: opened && r.editable });
  const ops = useDocumentOperations();
  const useIn = useUseInEntries(r);

  const published = r.item.document?.publicationState !== "UNPUBLISHED";
  const mine = r.item.creator === member.name || !!r.item.creator?.endsWith(`/members/${memberId}`);
  const edit = perms.can("items.update");
  const askShown = context === "reader" || context === "peek";

  const reading = [
    !askShown && r.readable && { id: "ask", label: "Hỏi về tài liệu này", icon: Sparkles, run: () => router.push(readerHref({ item: r.id, ask: true, q: q || undefined })) },
    { id: "link", label: "Sao chép liên kết", icon: Link, run: () => void ops.copyLink(r) },
    { id: "download", label: "Tải xuống", icon: Download, run: () => void ops.download(r) },
    ...extra,
  ].filter(Boolean) as MenuEntry[];
  const use = r.readable ? useIn : [];
  const manage = [
    edit && { id: "edit", label: "Sửa chi tiết…", icon: Pencil, run: () => openEditDetails(r.name) },
    edit && hasModule("spaces") && { id: "spaces", label: "Liên kết với cộng đồng…", icon: Link2, run: () => openLinkToSpaces(r.name) },
    edit && !r.isPersonal && perms.can("items.verify") && {
      id: "verify",
      label: r.trust.state === "verified" ? "Gia hạn xác minh" : "Đánh dấu đã xác minh",
      icon: ShieldCheck,
      run: () => void ops.verify(r),
    },
    // A new file only for uploads: synced documents are updated at their source.
    can("contributions.create") && !r.isPersonal && (edit || mine) && r.source.isUpload && published && {
      id: "version",
      label: "Gửi phiên bản mới…",
      icon: Upload,
      run: () => openContribute({ item: r.name }),
    },
    !r.isPersonal && r.source.isUpload && perms.can("items.move") && { id: "move", label: "Di chuyển…", icon: Folder, run: () => openMoveItems([r.name], r.item.parentItem) },
    can("contributions.review") && !r.isPersonal && perms.can("contributions.review") && {
      id: "studio",
      label: "Mở trong Quản trị tài liệu",
      icon: Library,
      run: () => router.push(`/studio?${new URLSearchParams({ tab: "documents", q: r.title })}`),
    },
  ].filter(Boolean) as MenuEntry[];
  const archive: MenuEntry | null = perms.can("items.delete") ? { id: "archive", label: "Lưu trữ", icon: Archive, danger: true, run: () => void ops.archive(r) } : null;
  const fold = reading.length + use.length + manage.length + (archive ? 1 : 0) > MENU_MAX;

  const manageSection = manage.length ? (
    <Dropdown.Section key="manage">
      <Header>Quản trị</Header>
      {manage.map(entryItem)}
    </Dropdown.Section>
  ) : null;
  const archiveSection = archive ? <Dropdown.Section key="archive">{entryItem(archive)}</Dropdown.Section> : null;

  return (
    <Dropdown onOpenChange={(open) => open && setOpened(true)}>
      <Button isIconOnly size={size} variant="ghost" aria-label="Thao tác khác" className="button--muted">
        <Ellipsis aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={`Thao tác cho ${r.title}`}>
          <Dropdown.Section key="reading">{reading.map(entryItem)}</Dropdown.Section>
          {use.length ? (
            <Dropdown.Section key="use">
              <Header>Dùng trong</Header>
              {use.map(entryItem)}
            </Dropdown.Section>
          ) : null}
          {fold ? (
            <>
              <Separator />
              <Dropdown.SubmenuTrigger>
                <Dropdown.Item id="manage" textValue="Quản trị…">
                  <Settings className="i" aria-hidden />
                  <Label className="grow">Quản trị…</Label>
                </Dropdown.Item>
                <Dropdown.Popover>
                  <Dropdown.Menu aria-label="Quản trị">
                    {manageSection}
                    {manage.length && archive ? <Separator /> : null}
                    {archiveSection}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.SubmenuTrigger>
            </>
          ) : (
            <>
              {manageSection}
              {archive ? <Separator /> : null}
              {archiveSection}
            </>
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

/** Save toggle + ⋯ menu, the trailing actions of rows and cards. */
export function ResourceActions({ resource, size = "sm", saveLabel, ...menu }: ResourceActionsProps) {
  return (
    <>
      <SaveButton resource={resource} size={size} label={saveLabel} />
      <ResourceMenu resource={resource} size={size} {...menu} />
    </>
  );
}
