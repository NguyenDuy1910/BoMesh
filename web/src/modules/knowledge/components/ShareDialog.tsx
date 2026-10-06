"use client";

import { Users, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { invalidateApiData } from "@/lib/api/revision";
import { cn } from "@/lib/cn";
import { knowledgeApi, type CollectionGrant, type CollectionRole } from "@/modules/knowledge/knowledge-api";
import { matchesSearch } from "@/modules/knowledge/model";
import { principalKey, usePrincipals, type Principal } from "@/modules/knowledge/queries";
import { pluralize } from "@/lib/format";

export const ROLE_OPTIONS: readonly { value: CollectionRole; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
  { value: "owner", label: "Owner" },
];

/** What each role lets someone do, in their words. */
export const ROLE_HINT: Record<CollectionRole, string> = {
  viewer: "Can search and read documents.",
  editor: "Can also add, move and archive documents.",
  owner: "Can also manage access and settings.",
};

const MAX_OPTIONS = 6;

export function PrincipalAvatar({ type, name, size = "md" }: { type: "user" | "group"; name: string; size?: "sm" | "md" | "lg" }) {
  if (type === "group") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-full bg-[var(--surface-inset)] text-[var(--text-secondary)]",
          size === "sm" ? "size-6 [&_svg]:size-3.5" : size === "md" ? "size-7 [&_svg]:size-3.5" : "size-9 [&_svg]:size-4",
        )}
      >
        <Users />
      </span>
    );
  }
  return <Avatar name={name} size={size} />;
}

/**
 * Share a knowledge base: pick people and groups with the keyboard (type,
 * arrows, Enter; Backspace removes the last pick), choose one role for them,
 * and grant it.
 */
export function ShareDialog({
  open,
  onClose,
  collectionId,
  collectionTitle,
  grants,
}: {
  open: boolean;
  onClose: () => void;
  collectionId: string;
  collectionTitle: string;
  grants: readonly CollectionGrant[];
}) {
  const toast = useToast();
  const principals = usePrincipals(open);
  const inputId = useId();
  const listId = useId();
  const roleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Principal[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [role, setRole] = useState<CollectionRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPicked([]);
    setHighlight(0);
    setRole("viewer");
    setFailure(null);
  }, [open]);

  const options = useMemo(() => {
    const taken = new Set([...grants.map(principalKey), ...picked.map((principal) => principal.key)]);
    return (principals.data ?? [])
      .filter((principal) => !taken.has(principal.key) && matchesSearch(query, principal.name, principal.detail))
      .slice(0, MAX_OPTIONS);
  }, [grants, picked, principals.data, query]);
  const active = Math.min(highlight, Math.max(0, options.length - 1));

  const pick = (principal: Principal) => {
    setPicked((current) => [...current, principal]);
    setQuery("");
    setHighlight(0);
    inputRef.current?.focus();
  };

  const share = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setFailure(null);
    const results = await Promise.allSettled(
      picked.map((principal) => knowledgeApi.setAccess(collectionId, { principal_type: principal.type, principal_id: principal.id, role })),
    );
    setBusy(false);
    const refused = picked.filter((_, index) => results[index].status === "rejected");
    const added = picked.filter((_, index) => results[index].status === "fulfilled");
    if (added.length) invalidateApiData();
    if (refused.length) {
      const reason = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
      setPicked(refused);
      setFailure(`${refused.map((principal) => principal.name).join(", ")} couldn’t be added. ${reason?.reason instanceof Error ? reason.reason.message : ""}`.trim());
      return;
    }
    const people = added.filter((principal) => principal.type === "user").length;
    const groups = added.length - people;
    toast.show({
      message: `Shared with ${[people && pluralize(people, "person", "people"), groups && pluralize(groups, "group")].filter(Boolean).join(" and ")}`,
    });
    onClose();
  };

  const unavailable = principals.data === null;

  return (
    <Dialog
      busy={busy}
      footer={(
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">Cancel</Button>
          <Button disabled={!picked.length} loading={busy} onClick={() => void share()} variant="primary">Share</Button>
        </>
      )}
      initialFocusRef={inputRef}
      onClose={onClose}
      open={open}
      title={`Share ${collectionTitle}`}
    >
      <div className="grid gap-4">
        {failure && <Callout tone="err">{failure}</Callout>}
        {unavailable ? (
          <Callout tone="neutral">
            Your role can’t list the workspace’s people and groups. Ask a workspace admin to share it.
          </Callout>
        ) : (
          <div className="grid gap-1.5">
            <label className="text-[length:var(--text-size-meta)] font-medium text-[var(--text-primary)]" htmlFor={inputId}>
              People or groups
            </label>
            <div
              className={cn(
                "flex min-h-[var(--control-md)] cursor-text flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-base)] px-2 py-1",
                "transition-[border-color,box-shadow] duration-[var(--duration-fast)] hover:border-[var(--border-strong)]",
                "focus-within:border-[var(--accent-primary)] focus-within:shadow-[var(--shadow-focus)]",
              )}
              onClick={(event) => {
                if (event.target === event.currentTarget) inputRef.current?.focus();
              }}
            >
              {picked.map((principal) => (
                <span
                  className="inline-flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--surface-inset)] pl-1 pr-0.5 text-[length:var(--text-size-meta)] text-[var(--text-primary)]"
                  key={principal.key}
                >
                  <PrincipalAvatar name={principal.name} size="sm" type={principal.type} />
                  {principal.name}
                  <button
                    aria-label={`Remove ${principal.name}`}
                    className="inline-grid size-5 place-items-center rounded-[var(--radius-xs)] text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                    disabled={busy}
                    onClick={() => {
                      setPicked((current) => current.filter((candidate) => candidate.key !== principal.key));
                      inputRef.current?.focus();
                    }}
                    type="button"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </span>
              ))}
              <input
                aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
                aria-autocomplete="list"
                aria-controls={listId}
                aria-expanded={options.length > 0}
                autoComplete="off"
                className="h-[26px] min-w-[140px] flex-1 border-0 bg-transparent px-1 text-[length:var(--text-size-body)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
                disabled={busy || principals.loading}
                id={inputId}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHighlight(0);
                }}
                onKeyDown={(event) => {
                  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
                    event.preventDefault();
                    setHighlight((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    if (options[active] && (query.trim() || !picked.length)) pick(options[active]);
                    else if (picked.length && !query.trim()) void share();
                  } else if (event.key === "Backspace" && !query && picked.length) {
                    setPicked((current) => current.slice(0, -1));
                  }
                }}
                placeholder={principals.loading ? "Loading people…" : picked.length ? "Add more" : "Search by name or email"}
                ref={inputRef}
                role="combobox"
                value={query}
              />
            </div>
            <div
              aria-label="People and groups"
              className="max-h-60 overflow-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-1 shadow-[var(--shadow-2)] empty:hidden"
              id={listId}
              role="listbox"
            >
              {options.map((principal, index) => (
                <div
                  aria-selected={index === active}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left",
                    index === active && "bg-[var(--surface-hover)]",
                  )}
                  id={`${listId}-${index}`}
                  key={principal.key}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(principal)}
                  onMouseEnter={() => setHighlight(index)}
                  role="option"
                >
                  <PrincipalAvatar name={principal.name} type={principal.type} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-[var(--text-primary)]">{principal.name}</span>
                    <span className="block truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{principal.detail}</span>
                  </span>
                </div>
              ))}
            </div>
            {!principals.loading && !options.length && (
              <p className="px-0.5 py-1 text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
                {query.trim()
                  ? `No one called “${query.trim()}”. Only members of this workspace can be added.`
                  : "Everyone in this workspace already has access."}
              </p>
            )}
          </div>
        )}
        <FormField help={ROLE_HINT[role]} htmlFor={roleId} label="Role" required>
          <Select
            disabled={busy}
            id={roleId}
            onChange={(event) => setRole(event.target.value as CollectionRole)}
            options={ROLE_OPTIONS}
            value={role}
          />
        </FormField>
      </div>
    </Dialog>
  );
}
