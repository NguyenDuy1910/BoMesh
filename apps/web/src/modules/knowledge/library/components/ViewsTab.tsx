"use client";

import { Button, buttonVariants, Dropdown, Label, Separator, TextField, Input, FieldError } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Filter, Pencil, Search, Trash2 } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Gate } from "@/components/ui/Gate";
import { ItemIcon } from "@/components/ui/ItemIcon";
import { List, ListItem } from "@/components/ui/List";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createSavedSearch, deleteSavedSearch, updateSavedSearch, type SavedSearch } from "../../api";
import { savedSearchHref, savedSearchParams, viewSummary } from "../../browse/catalog";
import { useFacetLabel } from "../../browse/labels";
import { KnowledgeModal } from "../../components/KnowledgeModal";
import { knowledgeKeys, useSavedSearches, useTopics } from "../../queries";

/** Saved Browse views: open, rename, delete with Undo (preview `viewsTab`). */
export function ViewsTab() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const views = useSavedSearches();
  const topics = useTopics();
  const [renaming, setRenaming] = useState<SavedSearch | null>(null);
  const parsed = useMemo(() => (views.data ?? []).map((v) => ({ view: v, params: savedSearchParams(v, topics.data) })), [views.data, topics.data]);
  const label = useFacetLabel({
    owners: parsed.flatMap((p) => (p.params.filters.owner ?? []).map((o) => `workspaces/${ws}/members/${o}`)),
    sources: parsed.flatMap((p) => (p.params.filters.src ?? []).filter((s) => s !== "upload")),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: knowledgeKeys.savedSearches(ws) });

  async function remove(v: SavedSearch) {
    try {
      await deleteSavedSearch(ws, v.name ?? "");
      void refresh();
      toast(`Deleted “${v.displayName}”`, {
        undo: () =>
          void createSavedSearch(ws, { displayName: v.displayName, query: v.query, filter: v.filter, orderBy: v.orderBy, layout: v.layout }).then(
            () => refresh(),
            (e: unknown) => toast(errorMessage(e), { tone: "danger" }),
          ),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  const relLow = (at?: string) => rel(at).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());

  return (
    <>
      <Gate
        query={views}
        skeleton={<SkeletonRows rows={3} />}
        isEmpty={(data) => !data.length}
        empty={
          <EmptyState
            icon={Filter}
            title="No saved views"
            description="In Browse, save a search and its filters to come back to it."
            actions={
              <NextLink href="/knowledge" className={buttonVariants({ variant: "primary" })}>
                Go to Browse
              </NextLink>
            }
            boxed
          />
        }
      >
        <List className="lib-list">
          {parsed.map(({ view: v, params }) => {
            const href = savedSearchHref(v, topics.data);
            return (
              <ListItem
                key={v.name}
                lead={<ItemIcon icon={Filter} size="sm" />}
                title={v.displayName}
                contentTitle
                description={<span className="truncate">{viewSummary(params, label)}</span>}
                meta={v.createTime ? `Created ${relLow(v.createTime)}` : undefined}
                href={href}
                actions={
                  <Dropdown>
                    <Button isIconOnly size="sm" variant="ghost" aria-label="View options" className="button--muted">
                      <Ellipsis aria-hidden />
                    </Button>
                    <Dropdown.Popover placement="bottom end">
                      <Dropdown.Menu
                        aria-label={`Options for ${v.displayName}`}
                        onAction={(key) => {
                          if (key === "open") router.push(href);
                          else if (key === "rename") setRenaming(v);
                          else if (key === "delete") void remove(v);
                        }}
                      >
                        <Dropdown.Item id="open" textValue="Open">
                          <Search className="i" aria-hidden />
                          <Label>Open</Label>
                        </Dropdown.Item>
                        <Dropdown.Item id="rename" textValue="Rename">
                          <Pencil className="i" aria-hidden />
                          <Label>Rename</Label>
                        </Dropdown.Item>
                        <Separator />
                        <Dropdown.Item id="delete" textValue="Delete" variant="danger">
                          <Trash2 className="i" aria-hidden />
                          <Label>Delete</Label>
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                }
              />
            );
          })}
        </List>
      </Gate>
      {renaming ? <RenameViewDialog key={resourceId(renaming.name)} view={renaming} onClose={() => setRenaming(null)} /> : null}
    </>
  );
}

function RenameViewDialog({ view, onClose }: { view: SavedSearch; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const [name, setName] = useState(view.displayName);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const err = touched && !name.trim() ? "Enter a name." : "";

  async function save() {
    setTouched(true);
    if (!name.trim()) return;
    setBusy(true);
    try {
      await updateSavedSearch(ws, view.name ?? "", { displayName: name.trim() }, ["displayName"]);
      void qc.invalidateQueries({ queryKey: knowledgeKeys.savedSearches(ws) });
      onClose();
      toast("View renamed");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="sm"
      title="Rename view"
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isPending={busy} onPress={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField value={name} onChange={setName} maxLength={60} isRequired isInvalid={!!err} autoFocus>
          <Label>Name</Label>
          <Input />
          <FieldError>{err}</FieldError>
        </TextField>
      </form>
    </KnowledgeModal>
  );
}
