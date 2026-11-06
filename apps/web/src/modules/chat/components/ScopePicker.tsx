"use client";

import { Dropdown, Header, Separator, Tooltip, type Selection } from "@heroui/react";
import clsx from "clsx";
import { BookOpen, Check, ChevronDown, Layers, User } from "lucide-react";
import { useMemo } from "react";

import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { spaceType, useMySpaces, type Space } from "@/modules/spaces";

import type { ConversationScope } from "../api";

const ALL = "all";

/**
 * "Search in" picker (preview `scopeBtn` + `MENUS['chat-scope']`): the whole
 * workspace, one of my spaces, or chosen knowledge bases. A checkbox menu that
 * stays open while toggling. Spaces are offered only with the Spaces module on
 * and when they hold knowledge the caller can read.
 */
export function ScopePicker({ scope, onChange }: { scope: ConversationScope; onChange: (scope: ConversationScope) => void }) {
  const { workspace, hasModule, settings, member } = useWorkspace();
  const bases = useKnowledgeBases();
  const spaces = useMySpaces();
  // Readable bases; personal ones only when they're mine (admins can read others' "My files").
  const readable = useMemo(
    () => (bases.data ?? []).filter((b) => b.access !== "LOCKED" && (b.collection?.kind !== "PERSONAL" || b.name === member.personalCollection)),
    [bases.data, member.personalCollection],
  );
  const readableNames = useMemo(() => new Set(readable.map((b) => b.name ?? "")), [readable]);
  const scopeSpaces = useMemo(
    () => (hasModule("spaces") ? (spaces.data ?? []).filter((s) => s.callerRole && (s.collections ?? []).some((c) => readableNames.has(c))) : []),
    [hasModule, spaces.data, readableNames],
  );

  const spaceName = scope.spaces?.[0];
  const space = spaceName && hasModule("spaces") ? (spaces.data ?? []).find((s) => s.name === spaceName) ?? null : null;
  const chosen = (scope.collections ?? []).map((c) => readable.find((b) => b.name === c)).filter((b) => !!b);
  const isPersonal = (name?: string) => !!name && name === member.personalCollection;

  const selected = space ? [`space:${space.name}`] : chosen.length ? chosen.map((b) => `kb:${b.name}`) : [ALL];

  const onSelectionChange = (keys: Selection) => {
    const next = keys === "all" ? [] : [...keys].map(String);
    const toggled = next.find((k) => !selected.includes(k)) ?? selected.find((k) => !next.includes(k));
    if (!toggled) return;
    if (toggled === ALL) return onChange({});
    if (toggled.startsWith("space:")) {
      const name = toggled.slice(6);
      return onChange(space?.name === name ? {} : { spaces: [name] });
    }
    const kb = toggled.slice(3);
    const current = space ? [] : (scope.collections ?? []).filter((c) => readableNames.has(c));
    onChange({ collections: current.includes(kb) ? current.filter((c) => c !== kb) : [...current, kb] });
  };

  let label: string;
  let Icon = chosen.length ? BookOpen : Layers;
  let tip = "Choose what to search";
  if (space) {
    label = space.displayName;
    Icon = spaceType(space.spaceType, settings).icon;
    tip = `Searching ${space.displayName}. Change what to search`;
  } else {
    const names = chosen.map((b) => (isPersonal(b.name) ? "My files" : b.displayName ?? ""));
    label = !names.length ? "All knowledge" : names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`;
  }
  const on = !!space || chosen.length > 0;

  const row = (key: string, text: string, RowIcon: typeof Layers) => (
    <Dropdown.Item key={key} id={key} textValue={text}>
      <span className={clsx("chat-check", selected.includes(key) && "is-on")} aria-hidden>
        <Check className="i" />
      </span>
      <RowIcon className="i" aria-hidden />
      <span className="grow truncate" translate="no">
        {text}
      </span>
    </Dropdown.Item>
  );

  return (
    <Dropdown>
      <Tooltip>
        <Dropdown.Trigger id="chat-scope" className={clsx("button button--ghost button--sm chat-scope", on && "chat-scope--on")}>
          <Icon className="i" aria-hidden />
          <span translate={on ? "no" : undefined}>{label}</span>
          <ChevronDown className="i" aria-hidden />
        </Dropdown.Trigger>
        <Tooltip.Content>{tip}</Tooltip.Content>
      </Tooltip>
      <Dropdown.Popover placement="bottom start" className="chat-scope-menu">
        <Dropdown.Menu aria-label="Search in" selectionMode="multiple" selectedKeys={selected} onSelectionChange={onSelectionChange}>
          <Dropdown.Section>
            <Header>Search in</Header>
            {row(ALL, `All of ${workspace.displayName ?? "this workspace"}`, Layers)}
          </Dropdown.Section>
          <Separator />
          {scopeSpaces.length ? (
            <Dropdown.Section>
              <Header>My spaces</Header>
              {scopeSpaces.map((s: Space) => row(`space:${s.name}`, s.displayName, spaceType(s.spaceType, settings).icon))}
            </Dropdown.Section>
          ) : null}
          {scopeSpaces.length ? <Separator /> : null}
          <Dropdown.Section>
            {scopeSpaces.length ? <Header>Knowledge bases</Header> : null}
            {readable.map((b) => row(`kb:${b.name}`, isPersonal(b.name) ? "My files" : b.displayName ?? "", isPersonal(b.name) ? User : BookOpen))}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
