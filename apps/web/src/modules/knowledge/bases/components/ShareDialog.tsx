"use client";

import { Button, Chip } from "@heroui/react";
import { CircleAlert, Eye, Pencil, Plus, Shield, UserPlus, Users, X, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ItemIcon } from "@/components/ui/ItemIcon";
import { List, ListItem } from "@/components/ui/List";
import { SearchInput } from "@/components/ui/SearchInput";
import { Segmented } from "@/components/ui/Segmented";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { KnowledgeModal } from "../../components/KnowledgeModal";
import { useMembersByName } from "../../queries";
import type { Group, Member } from "../api";
import { ROLE_DESC, ROLE_LABEL, ROLES, type Share, type ShareRole } from "../model";
import { useShareGroups, useShareMemberSearch } from "../queries";

/** Preview `KB_ROLES[role].icon`. */
const ROLE_ICON: Record<ShareRole, LucideIcon> = { viewer: Eye, editor: Pencil, owner: Shield };
const focusSearch = () => requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".kb-share-q input")?.focus());

export interface SharePrincipal {
  principal: string;
  kind: "user" | "group";
  name: string;
  sub: string;
}

const groupPrincipal = (g: Group): SharePrincipal => ({ principal: `group:${resourceId(g.name)}`, kind: "group", name: g.displayName || "Nhóm", sub: plural(g.memberCount ?? 0, "member") });
const memberPrincipal = (m: Member): SharePrincipal => ({ principal: `user:${resourceId(m.user)}`, kind: "user", name: m.displayName || m.email || "Ai đó", sub: m.email ?? "" });

/** Share principals (`user:{id}` / `group:{id}`) with display names: groups from the workspace's groups, people from one batched member read. */
export function useSharePeople(principals: readonly string[], { enabled = true }: { enabled?: boolean } = {}): ReadonlyMap<string, SharePrincipal> {
  const { id } = useWorkspace();
  const groups = useShareGroups({ enabled: enabled && principals.some((p) => p.startsWith("group:")) });
  const users = useMembersByName(enabled ? principals.filter((p) => p.startsWith("user:")).map((p) => `workspaces/${id}/members/${p.slice("user:".length)}`) : []);
  return useMemo(() => {
    const out = new Map<string, SharePrincipal>();
    for (const g of groups.data ?? []) out.set(`group:${resourceId(g.name)}`, groupPrincipal(g));
    for (const m of users.values()) out.set(`user:${resourceId(m.user)}`, memberPrincipal(m));
    return out;
  }, [groups.data, users]);
}

/**
 * What a share picker offers for `q`: matching groups first, then one server page of matching members (name or
 * email), without the `taken` principals; at most `limit`. A blank `q` offers the first ones by name.
 */
export function useShareOptions(q: string, taken: ReadonlySet<string>, limit: number, { enabled = true }: { enabled?: boolean } = {}): SharePrincipal[] {
  const term = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const groups = useShareGroups({ enabled });
  const members = useShareMemberSearch(term, Math.min(50, limit + taken.size), { enabled });
  return useMemo(() => {
    const needle = term.toLowerCase();
    const fromGroups = (groups.data ?? []).filter((g) => !needle || (g.displayName ?? "").toLowerCase().includes(needle)).map(groupPrincipal);
    return [...fromGroups, ...(members.data ?? []).map(memberPrincipal)].filter((o) => !taken.has(o.principal)).slice(0, limit);
  }, [groups.data, members.data, taken, term, limit]);
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
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<SharePrincipal[]>([]);
  const [role, setRole] = useState<ShareRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const taken = useMemo(() => new Set([...shares.map((s) => s.principal), ...picked.map((p) => p.principal)]), [shares, picked]);
  const options = useShareOptions(q, taken, 6, { enabled: isOpen });

  function close() {
    onClose();
    setQ("");
    setPicked([]);
    setRole("viewer");
    setTouched(false);
  }
  function pick(principal: SharePrincipal) {
    setPicked((p) => [...p, principal]);
    setQ("");
    setTouched(false);
    focusSearch();
  }
  async function share() {
    if (busy) return;
    if (!picked.length) {
      setTouched(true);
      focusSearch();
      return;
    }
    setBusy(true);
    const ok = await onShare(
      picked.map((p) => p.principal),
      role,
      picked.map((p) => p.name),
    );
    setBusy(false);
    if (ok) close();
  }

  const err = touched && !picked.length ? "Thêm ít nhất một người hoặc nhóm." : "";
  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={close}
      guard={busy}
      icon={UserPlus}
      title={
        <>
          Chia sẻ <span translate="no">{baseName}</span>
        </>
      }
      description="Cấp quyền cho người hoặc nhóm. Họ mở được ngay."
      footerStart={<span className="t-xs muted">Quản trị viên luôn quản lý được.</span>}
      footer={
        <>
          <Button variant="ghost" onPress={close} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void share()} isPending={busy}>
            {busy ? null : <UserPlus className="i" aria-hidden />}
            {picked.length > 1 ? `Chia sẻ với ${picked.length}` : "Chia sẻ"}
          </Button>
        </>
      }
    >
      <div className="kn-form">
        <div className="field">
          <span className="label">Người hoặc nhóm</span>
          {picked.length ? (
            <div className="kb-picks">
              {picked.map((p) => {
                const name = p.name;
                return (
                  <Chip key={p.principal} variant="soft" color="accent" className="kb-pick">
                    {name}
                    <button type="button" aria-label={`Gỡ ${name}`} disabled={busy} onClick={() => setPicked((all) => all.filter((x) => x.principal !== p.principal))}>
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
            label="Người hoặc nhóm"
            placeholder="Tìm theo tên hoặc email"
            fullWidth
            autoFocus
            onSubmit={() => {
              if (q.trim() && options[0]) pick(options[0]);
              else void share();
            }}
          />
          {err ? (
            <div className="field-error" role="alert">
              <CircleAlert className="i" aria-hidden />
              <span>{err}</span>
            </div>
          ) : null}
          {options.length ? (
            <List className="kb-share-list">
              {options.map((o) => (
                <ListItem
                  key={o.principal}
                  lead={<ShareLead who={o} size="sm" />}
                  title={o.name}
                  description={o.sub}
                  actions={<Plus className="i i-sm muted" aria-hidden />}
                  onPress={() => pick(o)}
                  label={`Thêm ${o.name}`}
                />
              ))}
            </List>
          ) : (
            <p className="kb-share-none">{q.trim() ? `Không có ai tên “${q.trim()}” trong không gian làm việc này.` : "Mọi thành viên đều đã có quyền truy cập."}</p>
          )}
        </div>
        <div className="field">
          <span className="label">Vai trò</span>
          <Segmented label="Vai trò" full value={role} onChange={setRole} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], icon: ROLE_ICON[r] }))} />
          <div className="description">{ROLE_DESC[role]}</div>
        </div>
      </div>
    </KnowledgeModal>
  );
}
