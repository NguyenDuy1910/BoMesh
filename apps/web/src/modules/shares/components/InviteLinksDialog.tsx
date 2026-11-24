"use client";

import { Button, Description, InputGroup, Label, ListBox, Select, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Ellipsis, Link, Plus, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";

import { IconButton, ItemIcon, List, ListItem, SkeletonRows, toast } from "@/components/ui";
import { useLazyOptions } from "@/components/ui/useLazyOptions";
import { errorMessage } from "@/lib/api/client";
import { fmtDate, plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useMemberNames } from "@/modules/knowledge/queries";
import { Menu } from "@/modules/spaces/components/Menu";

import { createShare, deleteShare, shareKeys, type Share } from "../api";
import { expireTimeAfter, INVITE_EXPIRY, INVITE_USES, parseTarget, shareUrl, usesLine } from "../model";
import { useLiveShares } from "../queries";

/** A role an invite can grant at its scope: `roles/{role}` or `workspaces/{w}/roles/{role}`. */
export interface InviteRole {
  name: string;
  label: string;
  /** Shown under the Role select (workspace roles). */
  description?: string;
}

export interface InviteLinksDialogProps {
  /** `workspaces/{w}`, `workspaces/{w}/spaces/{s}` or `workspaces/{w}/items/{collection}`. */
  target: string;
  /** The workspace, space or collection people join. */
  scopeName: string;
  /** Roles the caller may hand out there; the server refuses others (ROLE_ESCALATION). */
  roles: readonly InviteRole[];
  /** Preselected for a new link. */
  defaultRole: string;
  isOpen: boolean;
  onClose: () => void;
}

type Step = "list" | "new" | "made";
const expiresLine = (s: Share) => (s.expireTime ? `Expires ${fmtDate(s.expireTime)}` : "Never expires");

/**
 * Invite links (preview `M['sh-invite']`) for People → Members, a space's People and a collection's Access:
 * the scope's active links (reset, revoke), a new one (role, lifetime, how many can join), and the link made —
 * shown once, since the server keeps only its token's hash.
 */
export function InviteLinksDialog({ target, scopeName, roles, defaultRole, isOpen, onClose }: InviteLinksDialogProps) {
  const { id: ws, workspace } = useWorkspace();
  const invites = useLiveShares(target, "INVITE", { enabled: isOpen });
  const qc = useQueryClient();
  const creators = useMemberNames((invites.data ?? []).map((s) => s.creator));
  const [step, setStep] = useState<Step | null>(null);
  const [role, setRole] = useState(defaultRole);
  const [expiry, setExpiry] = useState("7");
  const [uses, setUses] = useState("");
  const [made, setMade] = useState<{ share: Share; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setStep(null);
      setRole(defaultRole);
      setExpiry("7");
      setUses("");
      setMade(null);
    }
  }

  const live = invites.data ?? [];
  const current: Step | null = step ?? (invites.isPending ? null : live.length ? "list" : "new");
  const roleLabel = (name: string | undefined) => roles.find((r) => r.name === name)?.label ?? name?.split("/").pop() ?? "";
  const desc =
    parseTarget(target)?.kind === "workspace"
      ? `Anyone with the link can join ${scopeName} with the role you choose. They sign in, or create an account, first.`
      : `People in ${workspace.displayName ?? ""} who open the link join ${scopeName} with the role you choose.`;

  async function create(body: Pick<Share, "role" | "expireTime" | "maxUses">) {
    const share = await createShare(ws, { kind: "INVITE", target, ...body });
    const url = shareUrl(window.location.origin, share.uri);
    if (!url) throw new Error("The invite has no link.");
    setMade({ share, url });
    setStep("made");
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: shareKeys.all(ws) });
    }
  }

  const createNew = () => run(() => create({ role, expireTime: expireTimeAfter(expiry, Date.now()), maxUses: uses ? Number(uses) : undefined }));

  /** Reset = revoke, then a new invite with the same role, limit and expiry (its remaining lifetime); the old URL stops working. */
  const reset = (s: Share) =>
    run(async () => {
      await deleteShare(s.name ?? "");
      await create({ role: s.role, expireTime: s.expireTime, maxUses: s.maxUses });
    });

  const revoke = (s: Share) =>
    run(async () => {
      await deleteShare(s.name ?? "");
      if (!live.some((x) => x.name !== s.name)) setStep("new");
      toast("Link revoked. It no longer works.");
    });

  const copyMade = async () => {
    try {
      await navigator.clipboard.writeText(made?.url ?? "");
      toast("Invite link copied");
    } catch {
      toast("Couldn’t copy the link", { tone: "danger" });
    }
  };

  if (current === "made" && made) {
    const s = made.share;
    return (
      <KnowledgeModal
        isOpen={isOpen}
        onClose={onClose}
        icon={Link}
        tone="success"
        title="Copy your invite link"
        description="Copy it now: for security, BoMesh shows an invite link only once. Reset it later to get a new one."
        footer={
          <>
            <Button variant="ghost" onPress={onClose}>
              Done
            </Button>
            <Button variant="primary" onPress={() => void copyMade()}>
              <Copy aria-hidden />
              Copy link
            </Button>
          </>
        }
      >
        <TextField value={made.url} isReadOnly aria-label="Invite link">
          <InputGroup fullWidth className="sh-url">
            <InputGroup.Input className="mono" />
            <InputGroup.Suffix>
              <IconButton icon={Copy} tip="Copy link" size="sm" onPress={() => void copyMade()} />
            </InputGroup.Suffix>
          </InputGroup>
          <Description>{`${roleLabel(s.role)} · ${s.maxUses ? `Up to ${plural(s.maxUses, "person", "people")}` : "No limit"} · ${expiresLine(s)}`}</Description>
        </TextField>
      </KnowledgeModal>
    );
  }

  if (current === "list" || current === null) {
    return (
      <KnowledgeModal
        isOpen={isOpen}
        onClose={onClose}
        guard={busy}
        icon={Link}
        title="Invite links"
        description={desc}
        footer={
          <>
            <Button variant="ghost" onPress={onClose} isDisabled={busy}>
              Close
            </Button>
            <Button variant="primary" onPress={() => setStep("new")} isDisabled={busy || current === null}>
              <Plus aria-hidden />
              New link
            </Button>
          </>
        }
      >
        <div className="field">
          <span className="label">Active links</span>
          {current === null ? (
            <SkeletonRows rows={2} unboxed />
          ) : (
            <List>
              {live.map((s) => (
                <ListItem
                  key={s.name}
                  lead={<ItemIcon icon={Link} size="sm" />}
                  title={roleLabel(s.role)}
                  description={
                    <>
                      <span className="sh-line">{`${usesLine(s.useCount, s.maxUses)} · ${expiresLine(s)}`}</span>
                      <span className="sh-line">{`${creators.get(s.creator ?? "") || "Someone"} · ${rel(s.createTime)}`}</span>
                    </>
                  }
                  actions={
                    <Menu
                      label="Link actions"
                      nodes={[
                        { id: "reset", label: "Reset link", icon: RefreshCw, run: () => void reset(s) },
                        { sep: "revoke" },
                        { id: "revoke", label: "Revoke link", icon: XCircle, danger: true, run: () => void revoke(s) },
                      ]}
                    >
                      <Button isIconOnly size="sm" variant="ghost" aria-label="Link actions" isDisabled={busy}>
                        <Ellipsis aria-hidden />
                      </Button>
                    </Menu>
                  }
                />
              ))}
            </List>
          )}
          <div className="description">A link shows only when it’s made. To share one again, reset it.</div>
        </div>
      </KnowledgeModal>
    );
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      guard={busy}
      icon={Link}
      title="New invite link"
      description={desc}
      footer={
        <>
          {live.length ? (
            <Button variant="ghost" onPress={() => setStep("list")} isDisabled={busy}>
              Back
            </Button>
          ) : (
            <Button variant="ghost" onPress={onClose} isDisabled={busy}>
              Cancel
            </Button>
          )}
          <Button variant="primary" isPending={busy} isDisabled={!role} onPress={() => void createNew()}>
            <Link aria-hidden />
            Create link
          </Button>
        </>
      }
    >
      <div className="sh-form">
        <ChoiceSelect
          label="Role"
          value={role}
          options={roles.map((r) => [r.name, r.label] as const)}
          onChange={setRole}
          description={roles.find((r) => r.name === role)?.description}
        />
        <div className="sh-form__row">
          <ChoiceSelect label="Expires after" value={expiry} options={INVITE_EXPIRY} onChange={setExpiry} />
          <ChoiceSelect label="People who can join" value={uses} options={INVITE_USES} onChange={setUses} />
        </div>
      </div>
    </KnowledgeModal>
  );
}

interface ChoiceSelectProps {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  description?: string;
}

/** A labelled select over `[value, label]` choices (preview `field({ control: select(...) })`). `""` is a real choice. */
function ChoiceSelect({ label, value, options, onChange, description }: ChoiceSelectProps) {
  const key = (v: string) => v || "none";
  const [shown, onOpenChange] = useLazyOptions(options, ([v]) => v === value);
  return (
    <Select value={key(value)} onChange={(k) => k != null && onChange(options.find(([v]) => key(v) === String(k))?.[0] ?? "")} onOpenChange={onOpenChange} fullWidth>
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      {description ? <Description>{description}</Description> : null}
      <Select.Popover>
        <ListBox>
          {shown.map(([v, l]) => (
            <ListBox.Item key={key(v)} id={key(v)} textValue={l}>
              {l}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
