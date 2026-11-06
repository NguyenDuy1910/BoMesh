"use client";

import { Button, Input, Label, Modal, TextField, FieldError } from "@heroui/react";
import { Plus, Users } from "lucide-react";
import { useState } from "react";

import { EmptyState, Gate, ItemIcon, NoMatches, SearchInput, SkeletonCards, UserAvatar, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createGroup, type Group } from "../api";
import { groupNameError } from "../model";
import { usePeopleClient, type Directory } from "../queries";
import { useKnowledgeAccess } from "./KnowledgeAccess";

type DirQuery = { data?: Directory; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

function GroupCard({ group, dir, fresh, onOpen }: { group: Group; dir: Directory; fresh: boolean; onOpen: () => void }) {
  const members = dir.people.filter((p) => p.groups.includes(group.name ?? ""));
  const access = useKnowledgeAccess({ groups: [group.name ?? ""], groupLabel: () => group.displayName });
  const bases = access.data?.filter((a) => a.via !== "Everyone").length ?? 0;
  return (
    <div className={fresh ? "card card--action ppl-group ppl-fresh" : "card card--action ppl-group"} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}>
      <div className="row gap-12">
        <ItemIcon icon={Users} tone="accent" size="sm" />
        <span className="grow stack" style={{ minWidth: 0 }}>
          <span className="card__title truncate" translate="no">
            {group.displayName}
          </span>
        </span>
      </div>
      <p className="t-sm muted clamp-2 ppl-group__desc" translate={group.description ? "no" : undefined}>
        {group.description || "No description"}
      </p>
      <div className="row between gap-8">
        {members.length ? (
          <span className="row gap-8">
            <span className="avatar-group">
              {members.slice(0, 4).map((m) => (
                <UserAvatar key={m.id} name={m.displayName} size="sm" />
              ))}
            </span>
            <span className="t-xs muted num">{plural(members.length, "member")}</span>
          </span>
        ) : (
          <span className="t-xs muted">No members</span>
        )}
        <span className="t-xs muted">{bases ? plural(bases, "knowledge base") : ""}</span>
      </div>
    </div>
  );
}

export function GroupsTab({ query, fresh, onOpen, onCreate }: { query: DirQuery; fresh: ReadonlySet<string>; onOpen: (group: Group) => void; onCreate: () => void }) {
  const { can } = useWorkspace();
  const [q, setQ] = useState("");
  const manage = can("groups.create");
  const createButton = (primary: boolean) => (
    <Button variant={primary ? "primary" : "secondary"} size={primary ? "md" : "sm"} onPress={onCreate}>
      <Plus className="i" aria-hidden />
      Create group
    </Button>
  );
  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search groups" label="Search groups" />
        {manage ? <span className="toolbar__end">{createButton(false)}</span> : null}
      </div>
      <Gate
        query={query}
        skeleton={<SkeletonCards cards={6} />}
        isEmpty={(d) => d.groups.length === 0}
        empty={
          <EmptyState icon={Users} boxed title="No groups yet" description="Groups let you share knowledge with a whole team in one step." actions={manage ? createButton(true) : null} />
        }
      >
        {(dir) => {
          const needle = q.trim().toLowerCase();
          const rows = dir.groups.filter((g) => !needle || g.displayName.toLowerCase().includes(needle) || (g.description ?? "").toLowerCase().includes(needle));
          if (!rows.length) return <NoMatches what="groups" onClear={() => setQ("")} />;
          return (
            <div className="grid cols-3">
              {rows.map((g) => (
                <GroupCard key={g.name} group={g} dir={dir} fresh={fresh.has(g.name ?? "")} onOpen={() => onOpen(g)} />
              ))}
            </div>
          );
        }}
      </Gate>
    </>
  );
}

/** Create group (preview `M['ppl-group-new']`). */
export function CreateGroupDialog({ isOpen, onClose, dir, onCreated }: { isOpen: boolean; onClose: () => void; dir: Directory | undefined; onCreated: (group: Group) => void }) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Container size="sm">
        <Modal.Dialog>{isOpen ? <CreateGroupForm dir={dir} onClose={onClose} onCreated={onCreated} /> : null}</Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function CreateGroupForm({ dir, onClose, onCreated }: { dir: Directory | undefined; onClose: () => void; onCreated: (group: Group) => void }) {
  const { ws, refresh } = usePeopleClient();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const err = touched ? groupNameError(name, dir?.groups.map((g) => g.displayName) ?? []) : "";

  async function save() {
    setTouched(true);
    if (busy || groupNameError(name, dir?.groups.map((g) => g.displayName) ?? [])) return;
    setBusy(true);
    try {
      const group = await createGroup(ws, { displayName: name.trim(), description: desc.trim() });
      await refresh();
      onClose();
      toast(`Created ${group.displayName}`);
      onCreated(group);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal.CloseTrigger aria-label="Close" />
      <Modal.Header>
        <Modal.Heading>Create group</Modal.Heading>
      </Modal.Header>
      <Modal.Body className="stack gap-16">
        <TextField value={name} onChange={setName} isRequired isInvalid={Boolean(err)} maxLength={40} autoFocus>
          <Label>Name</Label>
          <Input placeholder="e.g. Marketing" onKeyDown={(e) => e.key === "Enter" && void save()} />
          <FieldError>{err}</FieldError>
        </TextField>
        <TextField value={desc} onChange={setDesc} maxLength={80}>
          <Label>
            Description <span className="label__opt">(optional)</span>
          </Label>
          <Input placeholder="Who belongs in this group" onKeyDown={(e) => e.key === "Enter" && void save()} />
        </TextField>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="tertiary" slot="close">
          Cancel
        </Button>
        <Button variant="primary" isPending={busy} onPress={() => void save()}>
          Create group
        </Button>
      </Modal.Footer>
    </>
  );
}
