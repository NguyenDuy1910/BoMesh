"use client";

import { Dropdown, Header, Input, Kbd, Label } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDown, Filter, Globe, MessageSquare, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { FileIcon } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { searchItems } from "@/modules/knowledge/api";
import { HighlightText } from "@/modules/knowledge/components/HighlightText";
import { catalogHref, fold, tokens } from "@/modules/knowledge/model";
import { useKnowledgeBases, useKnowledgeModel } from "@/modules/knowledge/queries";
import { useMyConversations } from "@/modules/search/queries";
import { useMySpaces, type Space } from "@/modules/spaces";

import { homeOptions, type DocHit, type HomeOption, type PastQuestion } from "../intent";

/** Scope of Ask and Find: the whole workspace, one readable knowledge base, or one of my spaces. */
export type HomeScope = { kind: "all" } | { kind: "kb"; id: string; name: string } | { kind: "space"; id: string; name: string; collections: string[] };

const relLow = (t?: string) => rel(t).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * The box (preview `hero()` + `options()`): an ARIA combobox offering Find documents / Ask AI for the
 * typed text (the likely one first and highlighted; Enter runs it), matching documents and earlier
 * questions; on an empty box recent and suggested questions. The scope menu sits inside the box.
 */
export function HomeBox({ starters }: { starters: readonly string[] }) {
  const router = useRouter();
  const ws = useWorkspace();
  const model = useKnowledgeModel();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [scope, setScope] = useState<HomeScope>({ kind: "all" });

  const bases = useKnowledgeBases();
  const readableBases = (bases.data ?? []).filter((b) => b.access !== "LOCKED" && b.collection?.kind !== "PERSONAL");
  const spaces = useMySpaces();
  const mySpaces: Space[] = ws.hasModule("spaces") ? (spaces.data ?? []).filter((s) => !!s.callerRole) : [];
  const scoped = readableBases.length + mySpaces.length > 1;
  const scopeLabel = scope.kind === "all" ? `All of ${ws.workspace.displayName}` : scope.name;

  /* Suggestions: catalog search for the text (same ranking/permissions as Knowledge) and the caller's conversations. */
  const q = useDebounced(text.trim(), 200);
  const scopeCollections = scope.kind === "kb" ? [scope.id] : scope.kind === "space" ? scope.collections.map(resourceId) : [];
  const scopeFilter = scopeCollections.length ? `(${scopeCollections.map((c) => `ancestors:"workspaces/${ws.id}/items/${c}"`).join(" OR ")})` : "";
  const docSearch = useQuery({
    queryKey: [ws.id, "items", "search", "home-box", q, scopeFilter],
    enabled: open && !!q,
    retry: false,
    staleTime: 60_000,
    queryFn: () => searchItems(ws.id, { query: q, filter: ["itemType = DOCUMENT", scopeFilter].filter(Boolean).join(" AND "), pageSize: 6 }),
  });
  const convs = useMyConversations();
  const docs: DocHit[] = useMemo(
    () =>
      q && q === text.trim()
        ? (docSearch.data?.results ?? [])
            .map((r) => r.item)
            .filter((i): i is NonNullable<typeof i> => !!i)
            .map((i) => model.toResource(i))
            .filter((r) => !r.isPersonal)
            .map((r) => ({ id: r.id, title: r.title, fileName: r.fileName, mime: r.mime, kindLabel: r.kindMeta.label }))
        : [],
    [q, text, docSearch.data, model],
  );
  const questions: PastQuestion[] = useMemo(
    () => (convs.data ?? []).filter((c) => c.displayName).map((c) => ({ id: resourceId(c.name), title: c.displayName ?? "", at: c.lastMessageTime ?? c.updateTime })),
    [convs.data],
  );
  const options = homeOptions({ text, docs, questions, starters, tokens, fold });
  const shown = open && options.length > 0;
  const current = Math.min(active, Math.max(0, options.length - 1));

  const reset = () => {
    setText("");
    setOpen(false);
  };
  const ask = (question: string) => {
    if (!question) return inputRef.current?.focus();
    reset();
    const p = new URLSearchParams({ q: question, send: "1" });
    if (scope.kind === "kb") p.append("scope", scope.id);
    if (scope.kind === "space") p.set("space", scope.id);
    router.push(`/chat?${p.toString()}`);
  };
  const find = (query: string) => {
    reset();
    router.push(catalogHref({ q: query, filters: scopeCollections.length ? { kb: scopeCollections } : {} }));
  };
  const pick = (o: HomeOption | undefined) => {
    if (!o) return;
    if (o.kind === "ask") ask(o.q);
    else if (o.kind === "find") find(o.q);
    else if (o.kind === "doc") {
      reset();
      router.push(`/doc/${o.doc.id}${o.q ? `?q=${encodeURIComponent(o.q)}` : ""}`);
    } else {
      setOpen(false);
      router.push(`/chat/${o.conv.id}`);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
      } else if (options.length) setActive((current + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!text.trim() && !open) return;
      pick(options[open ? current : 0]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  useEffect(() => {
    if (shown) document.getElementById(`${listId}-opt-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [shown, current, listId]);

  const setScopeAndFocus = (next: HomeScope) => {
    setScope(next);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const scopeKey = scope.kind === "all" ? "all" : `${scope.kind}:${scope.id}`;

  let lastGroup = "";
  return (
    <div className="home-search">
      <div className="home-box" role="search">
        <Search className="i home-box__icon" aria-hidden />
        <Input
          ref={inputRef}
          type="search"
          className="home-box__input"
          value={text}
          placeholder="Ask a question or find a document"
          aria-label="Ask a question or find a document"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={listId}
          aria-activedescendant={shown ? `${listId}-opt-${current}` : undefined}
          enterKeyHint="go"
          autoComplete="off"
          autoFocus
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onMouseDown={() => {
            if (!open) {
              setOpen(true);
              setActive(0);
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
        />
        {scoped ? (
          <Dropdown>
            <Dropdown.Trigger className="home-box__scope" aria-label={`Search in: ${scopeLabel}`}>
              {scope.kind === "all" ? <Globe className="i i-xs" aria-hidden /> : <Filter className="i i-xs" aria-hidden />}
              <span className="truncate" translate={scope.kind === "all" ? undefined : "no"}>
                {scopeLabel}
              </span>
              <ChevronDown className="i i-xs" aria-hidden />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label="Search and answer from"
                selectionMode="single"
                selectedKeys={[scopeKey]}
                disallowEmptySelection
                onAction={(key) => {
                  const k = String(key);
                  if (k === "all") return setScopeAndFocus({ kind: "all" });
                  const [kind, id] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
                  if (kind === "kb") {
                    const b = readableBases.find((x) => resourceId(x.name) === id);
                    if (b) setScopeAndFocus({ kind: "kb", id, name: b.displayName ?? "" });
                  } else {
                    const s = mySpaces.find((x) => resourceId(x.name) === id);
                    if (s) setScopeAndFocus({ kind: "space", id, name: s.displayName, collections: s.collections ?? [] });
                  }
                }}
              >
                <Dropdown.Section>
                  <Header>Search and answer from</Header>
                  <Dropdown.Item id="all" textValue={`All of ${ws.workspace.displayName}`}>
                    <Globe className="i" aria-hidden />
                    <Label>All of {ws.workspace.displayName}</Label>
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                </Dropdown.Section>
                {readableBases.length ? (
                  <Dropdown.Section>
                    <Header>Knowledge bases</Header>
                    {readableBases.map((b) => (
                      <Dropdown.Item key={b.name} id={`kb:${resourceId(b.name)}`} textValue={b.displayName ?? ""}>
                        <Label translate="no">{b.displayName}</Label>
                        <Dropdown.ItemIndicator />
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Section>
                ) : null}
                {mySpaces.length ? (
                  <Dropdown.Section>
                    <Header>My spaces</Header>
                    {mySpaces.map((s) => (
                      <Dropdown.Item key={s.name} id={`space:${resourceId(s.name)}`} textValue={s.displayName}>
                        <Label translate="no">{s.displayName}</Label>
                        <Dropdown.ItemIndicator />
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Section>
                ) : null}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : null}
      </div>
      <div className="home-sug" hidden={!shown} onMouseDown={(e) => e.preventDefault()}>
        {shown ? (
          <div className="home-sug__list" role="listbox" id={listId} aria-label="Suggestions">
            {options.map((o, i) => {
              const group = o.group ?? "";
              const head =
                group && group !== lastGroup ? (
                  <div className="home-opt__group" role="presentation">
                    {group}
                  </div>
                ) : null;
              lastGroup = group;
              return (
                <OptionRow key={i} head={head} option={o} query={text} id={`${listId}-opt-${i}`} active={i === current} onPick={() => pick(o)} onHover={() => setActive(i)} />
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function OptionRow({ head, option: o, query, id, active, onPick, onHover }: { head: ReactNode; option: HomeOption; query: string; id: string; active: boolean; onPick: () => void; onHover: () => void }) {
  const Icon = o.kind === "ask" ? Sparkles : o.kind === "find" ? Search : MessageSquare;
  const body =
    o.kind === "ask" && !o.group ? (
      <>
        <span className="home-opt__main">
          Ask AI <span className="home-opt__q" translate="no">“{o.q}”</span>
        </span>
        <span className="home-opt__hint">Answer with sources</span>
      </>
    ) : o.kind === "find" ? (
      <>
        <span className="home-opt__main">
          Find documents for <span className="home-opt__q" translate="no">“{o.q}”</span>
        </span>
        <span className="home-opt__hint">Open in Knowledge</span>
      </>
    ) : o.kind === "ask" ? (
      <span className="home-opt__main" translate="no">
        {o.q}
      </span>
    ) : o.kind === "doc" ? (
      <>
        <span className="home-opt__main" translate="no">
          <HighlightText text={o.doc.title} q={o.q} />
        </span>
        <span className="home-opt__hint">{o.doc.kindLabel}</span>
      </>
    ) : (
      <>
        <span className="home-opt__main" translate="no">
          <HighlightText text={o.conv.title} q={o.group === "You asked" ? query : ""} />
        </span>
        <span className="home-opt__hint">{relLow(o.conv.at)}</span>
      </>
    );
  return (
    <>
      {head}
      <div className={clsx("home-opt", `home-opt--${o.kind}`, active && "is-active")} role="option" id={id} aria-selected={active} onClick={onPick} onMouseMove={active ? undefined : onHover}>
        {o.kind === "doc" ? (
          <FileIcon name={o.doc.fileName} mime={o.doc.mime} size="sm" />
        ) : (
          <span className="home-opt__icon" aria-hidden>
            <Icon className="i i-sm" />
          </span>
        )}
        <span className="home-opt__body">{body}</span>
        {active ? (
          <span className="home-opt__key" aria-hidden>
            <Kbd>
              <Kbd.Content>↵</Kbd.Content>
            </Kbd>
          </span>
        ) : null}
      </div>
    </>
  );
}

