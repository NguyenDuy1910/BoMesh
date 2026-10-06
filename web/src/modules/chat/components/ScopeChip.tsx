"use client";

import { BookOpen, ChevronDown, Layers, User } from "lucide-react";

import { Menu, MenuCheckboxItem, MenuLabel, MenuRadioItem, MenuSeparator } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import type { Collection } from "../api";
import { CHAT_LIMITS } from "../attachments";
import type { ConversationCollection } from "../types";

/**
 * "Search in": all knowledge, or the knowledge bases picked here. The menu
 * stays open while toggling so several can be picked in one go. Only
 * knowledge bases the caller can read are offered or shown.
 */
export function ScopeChip({
  collections,
  personalCollectionId,
  scope,
  onChange,
  loading,
}: {
  collections: Collection[];
  personalCollectionId?: string | null;
  scope: ConversationCollection[];
  onChange: (scope: ConversationCollection[]) => void;
  loading?: boolean;
}) {
  const readable = new Set(collections.map((collection) => collection.id));
  const visible = loading ? scope : scope.filter((collection) => readable.has(collection.id));
  const label = !visible.length
    ? "All knowledge"
    : visible.length === 1 ? visible[0]!.title : `${visible[0]!.title} +${visible.length - 1}`;
  const selected = new Set(visible.map((collection) => collection.id));

  return (
    <Menu
      trigger={(props, open) => (
        <button
          {...props}
          aria-label={`Search in: ${label}`}
          className={cn(
            "inline-flex h-(--control-sm) max-w-full items-center gap-1.5 rounded-full border px-2.5 text-[0.8125rem] font-medium",
            "focus-visible:shadow-(--shadow-focus) focus-visible:outline-none",
            visible.length
              ? "border-accent-primary bg-surface-selected text-text-accent"
              : "border-border-default text-text-secondary hover:bg-surface-hover hover:text-text-primary",
            open && !visible.length && "bg-surface-hover text-text-primary",
          )}
          data-tour="scope"
        >
          {visible.length ? <BookOpen aria-hidden="true" size={15} /> : <Layers aria-hidden="true" size={15} />}
          <span className="max-w-[220px] truncate">{label}</span>
          <ChevronDown aria-hidden="true" size={13} />
        </button>
      )}
    >
      <MenuLabel>Search in</MenuLabel>
      <MenuRadioItem checked={!visible.length} icon={<Layers />} onSelect={() => onChange([])}>
        All knowledge
      </MenuRadioItem>
      <MenuSeparator />
      {loading && !collections.length ? (
        <MenuLabel>Loading knowledge…</MenuLabel>
      ) : !collections.length ? (
        <MenuLabel>No knowledge bases you can open yet</MenuLabel>
      ) : (
        collections.map((collection) => {
          const checked = selected.has(collection.id);
          return (
            <MenuCheckboxItem
              checked={checked}
              disabled={!checked && selected.size >= CHAT_LIMITS.collections}
              icon={collection.id === personalCollectionId ? <User /> : <BookOpen />}
              key={collection.id}
              onCheckedChange={(next) => onChange(next
                ? [...visible, { id: collection.id, title: collection.title }]
                : visible.filter((item) => item.id !== collection.id))}
              textValue={collection.title}
            >
              {collection.title}
            </MenuCheckboxItem>
          );
        })
      )}
    </Menu>
  );
}
