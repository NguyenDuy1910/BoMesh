"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import clsx from "clsx";
import { ChevronDown, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";

import type { SavedSearch } from "../api";
import { useSavedSearchMutations } from "../queries";
import { savedSearchParams, setKey, type BrowseParams } from "./catalog";
import { RenameViewDialog, SaveViewDialog } from "./SaveViewDialog";

export interface ViewsMenuProps {
  p: BrowseParams;
  views: readonly SavedSearch[];
  onApply: (next: BrowseParams) => void;
  /** Suggested name and the set in words, for Save this view…. */
  suggestion: string;
  summary: string;
}

/**
 * Saved views (preview `MENUS['cat-views']`), the only home of saved views: open one, save this set, rename or
 * delete the one you're on (Undo). The button shows the active view's name.
 */
export function ViewsMenu({ p, views, onApply, suggestion, summary }: ViewsMenuProps) {
  const { create, remove } = useSavedSearchMutations();
  const [dialog, setDialog] = useState<"save" | "rename" | null>(null);
  const key = setKey(p);
  const on = views.find((v) => setKey(savedSearchParams(v)) === key);
  const saveable = !!(p.q || Object.values(p.filters).some((v) => v?.length));
  if (!on && !saveable && !views.length && !dialog) return null;

  const del = async (v: SavedSearch) => {
    if (!v.name) return;
    try {
      await remove.mutateAsync(v.name);
      toast(`Đã xóa “${v.displayName}”`, {
        undo: () => create.mutate({ displayName: v.displayName, query: v.query, filter: v.filter, orderBy: v.orderBy, layout: v.layout }),
      });
    } catch (err) {
      toast(errorMessage(err), { tone: "danger" });
    }
  };
  const run = (k: string) => {
    if (k === "save") return setDialog("save");
    if (k === "rename") return setDialog("rename");
    if (k === "delete") return on && void del(on);
    const v = views.find((x) => x.name === k);
    if (v) onApply(savedSearchParams(v));
  };

  return (
    <>
      <Dropdown>
        <Button variant="ghost" size="sm" className={clsx("cat-views", on && "is-set")} aria-label={on ? `Chế độ xem đã lưu: ${on.displayName}` : "Chế độ xem đã lưu"}>
          <Layers aria-hidden className="i" />
          <span translate={on ? "no" : undefined}>{on ? on.displayName : "Chế độ xem"}</span>
          <ChevronDown aria-hidden className="i" />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label="Chế độ xem đã lưu" onAction={(k) => run(String(k))} selectionMode="single" selectedKeys={on?.name ? [on.name] : []}>
            {views.length ? (
              <Dropdown.Section>
                <Header>Chế độ xem đã lưu</Header>
                {views.map((v) => (
                  <Dropdown.Item key={v.name} id={v.name} textValue={v.displayName}>
                    <Label translate="no">{v.displayName}</Label>
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            ) : null}
            {views.length && (on || saveable) ? <Separator /> : null}
            {saveable && !on ? (
              <Dropdown.Item id="save" textValue="Lưu chế độ xem này…">
                <Plus className="i" aria-hidden />
                <Label>Lưu chế độ xem này…</Label>
              </Dropdown.Item>
            ) : null}
            {on ? (
              <Dropdown.Item id="rename" textValue="Đổi tên…">
                <Pencil className="i" aria-hidden />
                <Label>Đổi tên…</Label>
              </Dropdown.Item>
            ) : null}
            {on ? <Separator /> : null}
            {on ? (
              <Dropdown.Item id="delete" textValue="Xóa chế độ xem" variant="danger">
                <Trash2 className="i" aria-hidden />
                <Label>Xóa chế độ xem</Label>
              </Dropdown.Item>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      {dialog === "save" ? <SaveViewDialog onClose={() => setDialog(null)} params={p} suggestion={suggestion} summary={summary} /> : null}
      {dialog === "rename" && on ? <RenameViewDialog view={on} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
