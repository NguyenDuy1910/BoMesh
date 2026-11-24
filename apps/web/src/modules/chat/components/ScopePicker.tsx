"use client";

import { Button, Checkbox } from "@heroui/react";
import clsx from "clsx";
import { BookOpen, ChevronDown, Layers, User, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { PopoverSheet } from "@/components/ui";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { spaceType, useMySpaces, type Space } from "@/modules/spaces";

import type { ConversationScope } from "../api";

/**
 * What a scope reads as (preview `scopeLabel` / `scopePlaceholder`): the readable collections and spaces it may hold,
 * its button label and icon, and the composer placeholder ("the placeholder says where the question goes").
 */
export function useScope(scope: ConversationScope) {
  const { workspace, hasModule, settings, member } = useWorkspace();
  const bases = useKnowledgeBases();
  const spaces = useMySpaces();
  // Readable bases; personal ones only when they're mine (admins can read others' "My files").
  const readable = useMemo(
    () => (bases.data ?? []).filter((b) => b.access !== "LOCKED" && (b.itemType !== "PERSONAL" || b.name === member.personalCollection)),
    [bases.data, member.personalCollection],
  );
  const readableNames = useMemo(() => new Set(readable.map((b) => b.name ?? "")), [readable]);
  // Spaces offered as a scope: mine, with knowledge I can read.
  const scopeSpaces = useMemo(
    () => (hasModule("spaces") ? (spaces.data ?? []).filter((s) => s.callerRole && (s.collections ?? []).some((c) => readableNames.has(c))) : []),
    [hasModule, spaces.data, readableNames],
  );
  const spaceName = scope.spaces?.[0];
  const space = spaceName && hasModule("spaces") ? ((spaces.data ?? []).find((s) => s.name === spaceName) ?? null) : null;
  const nameOf = (b: (typeof readable)[number]) => (b.name === member.personalCollection ? "Tệp của tôi" : (b.displayName ?? ""));
  const chosen = (scope.collections ?? []).map((c) => readable.find((b) => b.name === c)).filter((b) => !!b);
  const names = chosen.map(nameOf);
  const wsName = workspace.displayName ?? "không gian làm việc của bạn";
  const allLabel = `Toàn bộ ${wsName}`;

  let label = allLabel;
  let placeholder = hasModule("spaces") ? `Hỏi bất cứ điều gì trong ${wsName}` : "Hỏi bất cứ điều gì về tài liệu của tổ chức";
  let icon: LucideIcon = Layers;
  if (space) {
    label = space.displayName;
    placeholder = `Hỏi về ${space.displayName}`;
    icon = spaceType(space.spaceType, settings ?? undefined).icon;
  } else if (names.length) {
    label = names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`;
    placeholder = names.length === 1 ? `Hỏi về ${names[0]}` : `Hỏi về ${names[0]} và ${names.length - 1} kho tài liệu khác`;
    icon = BookOpen;
  }
  return { readable, readableNames, scopeSpaces, space, chosen, nameOf, allLabel, label, placeholder, icon, on: !!space || names.length > 0 };
}

/**
 * "Search in" (preview `scopeBtn` + `PO['chat-scope']`): one choice — the whole workspace, one of my spaces, or specific
 * collections. Only that last choice reveals the collection checklist (multi-select), so a space and a collection
 * with the same name never sit side by side.
 */
export function ScopePicker({ scope, onChange }: { scope: ConversationScope; onChange: (scope: ConversationScope) => void }) {
  const { settings, member } = useWorkspace();
  const s = useScope(scope);
  // "Specific collections" chosen before any collection is ticked.
  const [pickKbs, setPickKbs] = useState(false);
  const mode = s.space ? `sp:${s.space.name}` : s.chosen.length || pickKbs ? "kbs" : "all";
  const Icon = s.icon;

  const setMode = (value: string) => {
    if (value === "kbs") {
      setPickKbs(true);
      if (s.space) onChange({});
      return;
    }
    setPickKbs(false);
    onChange(value.startsWith("sp:") ? { spaces: [value.slice(3)] } : {});
  };
  const toggleKb = (name: string) => {
    setPickKbs(true);
    const current = s.space ? [] : (scope.collections ?? []).filter((c) => s.readableNames.has(c));
    onChange({ collections: current.includes(name) ? current.filter((c) => c !== name) : [...current, name] });
  };

  const option = (value: string, icon: LucideIcon, label: string, meta: string) => {
    const OptIcon = icon;
    const on = mode === value;
    return (
      <label key={value} className={clsx("chat-opt", on && "is-on")}>
        <input type="radio" name="chat-scope" value={value} checked={on} onChange={() => setMode(value)} />
        <span className="radio__control" aria-hidden />
        <OptIcon className="i i-sm chat-opt__icon" aria-hidden />
        <span className="chat-opt__body">
          <span className="chat-opt__label truncate" translate={value === "all" ? undefined : "no"}>
            {label}
          </span>
          {meta ? <span className="chat-opt__meta truncate">{meta}</span> : null}
        </span>
      </label>
    );
  };

  return (
    <PopoverSheet
      title="Tìm kiếm trong"
      className="chat-scope-popover"
      onOpenChange={(open) => !open && !s.chosen.length && setPickKbs(false)}
      trigger={
        <Button variant="ghost" size="sm" id="chat-scope" className={clsx("chat-scope", s.on && "chat-scope--on")} aria-label={`Tìm trong: ${s.label}`}>
          <Icon className="i" aria-hidden />
          <span title={s.label} translate={s.on ? "no" : undefined}>
            {s.label}
          </span>
          <ChevronDown className="i" aria-hidden />
        </Button>
      }
    >
      <div className="chat-scope-pop">
        <div className="chat-scope-pop__group" role="radiogroup" aria-label="Tìm kiếm trong">
          {option("all", Layers, s.allLabel, plural(s.readable.length, "collection"))}
          {s.scopeSpaces.map((sp: Space) =>
            option(`sp:${sp.name}`, spaceType(sp.spaceType, settings ?? undefined).icon, sp.displayName, `Cộng đồng · ${plural((sp.collections ?? []).filter((c) => s.readableNames.has(c)).length, "collection")}`),
          )}
          {option("kbs", BookOpen, "Chọn kho tài liệu cụ thể", mode === "kbs" && s.chosen.length ? `Đã chọn ${s.chosen.length}` : "Chọn một hoặc nhiều kho tài liệu")}
        </div>
        {mode === "kbs" ? (
          <div className="chat-scope-pop__kbs" role="group" aria-label="Kho tài liệu">
            {[...s.readable].sort((a, b) => Number(b.name === member.personalCollection) - Number(a.name === member.personalCollection)).map((b) => {
              const personal = b.name === member.personalCollection;
              const KbIcon = personal ? User : BookOpen;
              return (
                <Checkbox key={b.name} isSelected={(scope.collections ?? []).includes(b.name ?? "")} onChange={() => toggleKb(b.name ?? "")}>
                  <Checkbox.Content className="checkbox__label">
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <KbIcon className="i i-sm chat-opt__icon" aria-hidden />
                    <span className="chat-opt__body">
                      <span className="chat-opt__label truncate" translate="no">
                        {s.nameOf(b)}
                      </span>
                      <span className="chat-opt__meta">{personal ? "Chỉ bạn" : plural(b.collection?.documentCount ?? 0, "document")}</span>
                    </span>
                  </Checkbox.Content>
                </Checkbox>
              );
            })}
          </div>
        ) : null}
      </div>
    </PopoverSheet>
  );
}
