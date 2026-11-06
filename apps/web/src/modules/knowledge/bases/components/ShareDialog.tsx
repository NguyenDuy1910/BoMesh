"use client";

import { Button, Chip, Description, Label, ListBox, Select } from "@heroui/react";
import { Users, X } from "lucide-react";
import { useMemo, useState } from "react";

import { ItemIcon } from "@/components/ui/ItemIcon";
import { List, ListItem } from "@/components/ui/List";
import { SearchInput } from "@/components/ui/SearchInput";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";

import { KnowledgeModal } from "../../components/KnowledgeModal";
import { ROLE_DESC, ROLE_LABEL, ROLES, type Share, type ShareRole } from "../model";
import { useSharePrincipals } from "../queries";

export interface SharePrincipal {
  principal: string;
  kind: "user" | "group";
  name: string;
  sub: string;
}

/** Members and groups as share principals (`user:{id}` / `group:{id}`) with display names. */
export function useSharePeople({ enabled = true }: { enabled?: boolean } = {}) {
  const { members, groups } = useSharePrincipals({ enabled });
  return useMemo(() => {
    const out = new Map<string, SharePrincipal>();
    for (const g of groups.data ?? []) {
      const principal = `group:${resourceId(g.name)}`;
      out.set(principal, { principal, kind: "group", name: g.displayName || "Group", sub: plural(g.memberCount ?? 0, "member") });
    }
    for (const m of members.data ?? []) {
      const principal = `user:${resourceId(m.user)}`;
      out.set(principal, { principal, kind: "user", name: m.displayName || m.email || "Someone", sub: m.email ?? "" });
    }
    return out;
  }, [members.data, groups.data]);
}

/** Lead for a share row: avatar for people, group icon for groups. */
export function ShareLead({ who, size = "md" }: { who: Pick<SharePrincipal, "kind" | "name">; size?: "sm" | "md" }) {
  return who.kind === "group" ? <ItemIcon icon={Users} size={size === "sm" ? "sm" : "md"} /> : <UserAvatar name={who.name} size={size === "sm" ? "sm" : "md"} />;
}

export interface ShareDialogProps {
  baseName: string;
  shares: readonly Share[];
  isOpen: boolean;
  onClose: () => void;
  /** Adds the picked principals with `role`; resolves true when saved. */
  onShare: (principals: string[], role: ShareRole, names: string[]) => Promise<boolean>;
}

/** Preview `M['kb-share']`: pick people or groups, choose a role, share. */
export function ShareDialog({ baseName, shares, isOpen, onClose, onShare }: ShareDialogProps) {
  const people = useSharePeople({ enabled: isOpen });
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [role, setRole] = useState<ShareRole>("viewer");
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => {
    const taken = new Set([...shares.map((s) => s.principal), ...picked]);
    const needle = q.trim().toLowerCase();
    return [...people.values()]
      .filter((o) => !taken.has(o.principal) && (!needle || o.name.toLowerCase().includes(needle) || o.sub.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.kind === "group") - Number(a.kind === "group"))
      .slice(0, 6);
  }, [people, shares, picked, q]);

  function close() {
    onClose();
    setQ("");
    setPicked([]);
    setRole("viewer");
  }
  function pick(principal: string) {
    setPicked((p) => [...p, principal]);
    setQ("");
  }
  async function share() {
    if (busy || !picked.length) return;
    setBusy(true);
    const ok = await onShare(picked, role, picked.map((p) => people.get(p)?.name ?? "Someone"));
    setBusy(false);
    if (ok) close();
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={close}
      guard={busy}
      title={
        <>
          Share <span translate="no">{baseName}</span>
        </>
      }
      footer={
        <>
          <Button variant="tertiary" onPress={close} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void share()} isDisabled={!picked.length} isPending={busy}>
            {picked.length ? `Share with ${picked.length}` : "Share"}
          </Button>
        </>
      }
    >
      <div className="field">
        <span className="label">People or groups</span>
        {picked.length ? (
          <div className="row wrap gap-6">
            {picked.map((p) => {
              const name = people.get(p)?.name ?? "Someone";
              return (
                <Chip key={p} size="sm" variant="soft" className="kb-pick">
                  {name}
                  <button type="button" aria-label={`Remove ${name}`} onClick={() => setPicked((all) => all.filter((x) => x !== p))}>
                    <X className="i i-xs" aria-hidden />
                  </button>
                </Chip>
              );
            })}
          </div>
        ) : null}
        <SearchInput
          className="kb-share-q"
          value={q}
          onChange={setQ}
          label="People or groups"
          placeholder="Search by name or email"
          fullWidth
          autoFocus
          onSubmit={() => {
            if (q.trim() && options[0]) pick(options[0].principal);
            else void share();
          }}
        />
        {options.length ? (
          <List className="kb-share-list">
            {options.map((o) => (
              <ListItem key={o.principal} lead={<ShareLead who={o} size="sm" />} title={o.name} description={o.sub} onPress={() => pick(o.principal)} label={`Add ${o.name}`} />
            ))}
          </List>
        ) : (
          <p className="t-sm muted">{q.trim() ? `No one called “${q.trim()}” in this workspace.` : "Everyone already has access."}</p>
        )}
      </div>
      <Select className="field" value={role} onChange={(v) => v != null && setRole(String(v) as ShareRole)}>
        <Label>Role</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Description>{ROLE_DESC[role]}</Description>
        <Select.Popover>
          <ListBox>
            {ROLES.map((r) => (
              <ListBox.Item key={r} id={r} textValue={ROLE_LABEL[r]}>
                {ROLE_LABEL[r]}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </KnowledgeModal>
  );
}
