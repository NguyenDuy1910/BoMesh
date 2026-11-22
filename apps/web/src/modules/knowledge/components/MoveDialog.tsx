"use client";

import { Button, Radio, RadioGroup } from "@heroui/react";
import clsx from "clsx";
import { AlertTriangle, CircleAlert, Folder, Lock } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { SearchInput } from "@/components/ui/SearchInput";
import { plural } from "@/lib/format";

import type { Item } from "../api";
import { BaseMark } from "../bases/components/BaseMark";
import { EMPTY_FOLDERS, folderSubtree, hasOwnAccess, whereLabel } from "../bases/model";
import { useFolderOperations } from "../bases/operations";
import { useFolderIndexes } from "../bases/queries";
import { fold } from "../model";
import { useDocumentOperations } from "../operations";
import { useItem, useKnowledgeBases } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";
import { useWhoCanSeeAt } from "./ResourceDetails";

export interface MoveDialogProps {
  /** Item names to move (one folder when `folder`). */
  items: string[];
  /** Current parent collection or folder (for the description and Undo). */
  from?: string;
  /** Moving a folder: only inside its own collection (a folder is part of its collection's structure). */
  folder?: boolean;
  isOpen: boolean;
  onClose: () => void;
}

/** One destination: a collection's top level or one of its folders (preview `destinations`). */
interface Dest {
  key: string;
  root: Item;
  folder: Item | null;
  depth: number;
}

/** Whole sentences per subject (it · them · a folder's contents), so each one translates as a unit. */
const SAY = {
  it: { change: "Who can see it changes: {0}", same: "Who can see it stays the same: {0}" },
  them: { change: "Who can see them changes: {0}", same: "Who can see them stays the same: {0}" },
  folder: { change: "Who can see what’s in it changes: {0}", same: "Who can see what’s in it stays the same: {0}" },
} as const;

/**
 * Move documents, or a folder, to a collection or folder the caller edits (preview `X.move` / `M['doc-move']`,
 * `M['kb-folder-move']`): one filterable destination tree, the current place marked, and who will see what moves.
 * The current collection comes first with its folders open; another collection's folders open once it's chosen
 * (or when searching).
 */
export function MoveDialog({ items, from, folder: movingFolder = false, isOpen, onClose }: MoveDialogProps) {
  const ops = useDocumentOperations();
  const folderOps = useFolderOperations();
  const bases = useKnowledgeBases();
  const first = useItem(items[0] ?? null);
  const current = from ?? first.data?.parentItem ?? "";
  const currentItem = useItem(current || null);
  const editable = (bases.data ?? []).filter((b) => b.itemType !== "PERSONAL" && (b.access === "EDITOR" || b.access === "OWNER"));
  const rootNames = new Set(editable.map((b) => b.name ?? ""));
  const hereRoot = rootNames.has(current) ? current : ((currentItem.data?.ancestors ?? []).map((a) => a.name ?? "").find((n) => rootNames.has(n)) ?? "");
  const hereRootItem = editable.find((b) => b.name === hereRoot);
  const scope = movingFolder ? editable.filter((b) => b.name === hereRoot) : editable;

  const [to, setTo] = useState<{ key: string; root: string } | null>(null);
  const [q, setQ] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const needle = fold(q.trim());

  const indexes = useFolderIndexes(needle ? scope.map((b) => b.name ?? "") : [...new Set([hereRoot, to?.root ?? ""].filter(Boolean))]);
  const indexOf = (root: string) => indexes.get(root) ?? EMPTY_FOLDERS;
  const exclude = new Set(movingFolder && items[0] ? folderSubtree(indexOf(hereRoot), items[0]) : []);
  const dests: Dest[] = [];
  for (const root of [...scope].sort((a, b) => Number(b.name === hereRoot) - Number(a.name === hereRoot))) {
    const rn = root.name ?? "";
    dests.push({ key: rn, root, folder: null, depth: 0 });
    const index = indexes.get(rn);
    if (!index || !(needle || rn === hereRoot || rn === to?.root)) continue;
    const walk = (parent: string, depth: number) => {
      for (const f of index.children.get(parent) ?? []) {
        if (exclude.has(f.name ?? "")) continue;
        dests.push({ key: f.name ?? "", root, folder: f, depth });
        walk(f.name ?? "", depth + 1);
      }
    };
    walk(rn, 1);
  }
  const labelOf = (d: Dest) => whereLabel(d.root.displayName ?? "", indexOf(d.root.name ?? ""), d.folder?.name);
  const shown = needle ? dests.filter((d) => fold(labelOf(d)).includes(needle)) : dests;
  const target = dests.find((d) => d.key === to?.key);
  const hereFolder = current && current !== hereRoot ? current : null;
  const where = hereRootItem ? whereLabel(hereRootItem.displayName ?? "", indexOf(hereRoot), hereFolder) : "";

  const who = useWhoCanSeeAt(target?.root, target ? indexOf(target.root.name ?? "") : undefined, target?.folder?.name ?? null);
  const was = useWhoCanSeeAt(hereRootItem, indexOf(hereRoot), hereFolder);
  const changes = !!target && !!hereRootItem && who.label !== was.label;

  const n = items.length;
  const noun = movingFolder ? "folder" : n === 1 ? "it" : "them";
  const name = first.data?.displayName ?? "";
  const title = movingFolder ? `Move “${name}”` : n === 1 ? "Move document" : `Move ${plural(n, "document")}`;
  const error = tried && !target ? "Choose where to move it." : "";

  async function move() {
    if (!target) return setTried(true);
    const destination = labelOf(target);
    setBusy(true);
    const ok =
      movingFolder && first.data
        ? await folderOps.move(first.data, target.key, destination)
        : await ops.move(
            items.map((item) => ({ name: item, title: item })),
            { name: target.key, displayName: destination },
            current || undefined,
          );
    setBusy(false);
    if (ok) onClose();
  }

  if (!bases.isPending && !dests.some((d) => d.key !== current)) {
    return (
      <KnowledgeModal isOpen={isOpen} onClose={onClose} size="sm" title={title} icon={Folder} footer={<Button variant="primary" onPress={onClose}>Close</Button>}>
        <EmptyState compact icon={Folder} title="Nowhere to move it" description="There’s no other collection or folder you can edit." />
      </KnowledgeModal>
    );
  }

  const description = movingFolder
    ? `With everything in it · in ${where}`
    : n === 1
      ? `“${name}”${where ? ` · in ${where}` : ""}`
      : where
        ? `From ${where}`
        : undefined;
  const WhoIcon = changes ? AlertTriangle : who.icon;
  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      guard={busy}
      title={title}
      icon={Folder}
      description={description}
      footerStart="You can undo right after."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void move()} isPending={busy}>
            <Folder className="i" aria-hidden />
            Move
          </Button>
        </>
      }
    >
      <div className="field">
        {dests.length > 8 ? <SearchInput value={q} onChange={setQ} placeholder="Find a collection or folder" label="Find a destination" size="md" fullWidth autoFocus /> : null}
        <RadioGroup
          aria-label="Move to"
          className="option-list mv-list"
          value={to?.key ?? ""}
          onChange={(key) => {
            const d = dests.find((x) => x.key === key);
            setTo(d ? { key: d.key, root: d.root.name ?? "" } : null);
            setTried(false);
          }}
          isDisabled={busy}
          isInvalid={!!error}
        >
          {shown.map((d) => {
            const here = d.key === current;
            return (
              <Radio key={d.key} value={d.key} isDisabled={here} className={clsx("mv-opt", here && "is-here")} style={{ "--depth": needle ? 0 : d.depth } as CSSProperties}>
                <Radio.Content className="row gap-8 grow">
                  <Radio.Control>
                    <Radio.Indicator />
                  </Radio.Control>
                  {d.folder ? (
                    <span className="mv-opt__icon" aria-hidden>
                      {hasOwnAccess(d.folder) ? <Lock className="i i-sm" /> : <Folder className="i i-sm" />}
                    </span>
                  ) : (
                    <BaseMark base={d.root} size={22} />
                  )}
                  <span className="grow mv-opt__name truncate" translate="no">
                    {needle ? labelOf(d) : (d.folder ?? d.root).displayName}
                  </span>
                  {here ? <span className="mv-opt__here">Current</span> : null}
                </Radio.Content>
              </Radio>
            );
          })}
          {shown.length ? null : <p className="mv-none">{`Nothing called “${q.trim()}”.`}</p>}
        </RadioGroup>
        {error ? (
          <div className="field-error" role="alert">
            <CircleAlert className="i" aria-hidden />
            <span>{error}</span>
          </div>
        ) : target ? (
          <div className={clsx("mv-who", changes && "mv-who--change")}>
            <WhoIcon className="i i-sm" aria-hidden />
            <span>{(changes ? SAY[noun].change : SAY[noun].same).replace("{0}", who.label)}</span>
          </div>
        ) : (
          <div className="description">What moves takes the access of where it goes.</div>
        )}
      </div>
    </KnowledgeModal>
  );
}
