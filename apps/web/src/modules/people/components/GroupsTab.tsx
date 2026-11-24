"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import { Check, Pencil, Plus, Users } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { EmptyState, Gate, NoMatches, SearchInput, SkeletonCards, UserAvatar, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";

import { createGroup, updateGroup, type Group } from "../api";
import { groupNameError, memberFilter, needsTools } from "../model";
import { useMemberPages, usePeopleClient, type Directory } from "../queries";
import { Dialog } from "./Dialog";
import { ALL_MEMBERS_VIA, useKnowledgeAccess } from "./KnowledgeAccess";

type DirQuery = { data?: Directory; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

function GroupCard({ group, dir, fresh, onOpen }: { group: Group; dir: Directory; fresh: boolean; onOpen: () => void }) {
  const count = group.memberCount ?? 0;
  // The card's faces: the group's first four members (its count is the group's own).
  const faces = useMemberPages(dir, memberFilter({ group: group.name ?? "" }), { pageSize: 4, enabled: count > 0 }).rows ?? [];
  const access = useKnowledgeAccess({ groups: [group.name ?? ""], groupLabel: () => group.displayName });
  const shared = access.data?.filter((a) => a.via !== ALL_MEMBERS_VIA).length ?? 0;
  return (
    <div
      className={fresh ? "card card--action ppl-group ppl-fresh" : "card card--action ppl-group"}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen();
      }}
    >
      <span className="card__title truncate" translate="no">
        {group.displayName}
      </span>
      <p className="t-sm muted clamp-2 ppl-group__desc" translate={group.description ? "no" : undefined}>
        {group.description || "Không có mô tả"}
      </p>
      <div className="row between gap-8">
        {count ? (
          <span className="row gap-8">
            <span className="avatar-group">
              {faces.map((m) => (
                <UserAvatar key={m.id} name={m.displayName} size="sm" />
              ))}
            </span>
            <span className="t-xs muted num">{plural(count, "member")}</span>
          </span>
        ) : (
          <span className="t-xs muted">Chưa có thành viên</span>
        )}
        <span className="t-xs muted">{shared ? plural(shared, "collection") : ""}</span>
      </div>
    </div>
  );
}

/** Groups (preview `groupsTab`): reusable teams as cards; New group lives in the page header. */
export function GroupsTab({ query, fresh, onOpen }: { query: DirQuery; fresh: ReadonlySet<string>; onOpen: (group: Group) => void }) {
  const [q, setQ] = useState("");
  return (
    <Gate
      query={query}
      skeleton={<SkeletonCards cards={6} />}
      isEmpty={(d) => d.groups.length === 0}
      empty={<EmptyState icon={Users} boxed title="Chưa có nhóm" description="Nhóm giúp bạn chia sẻ tài liệu với cả nhóm chỉ trong một bước." />}
    >
      {(dir) => {
        const needle = q.trim().toLowerCase();
        const rows = dir.groups.filter((g) => !needle || g.displayName.toLowerCase().includes(needle) || (g.description ?? "").toLowerCase().includes(needle));
        return (
          <>
            {needsTools(dir.groups.length, Boolean(needle)) ? (
              <div className="toolbar">
                <SearchInput value={q} onChange={setQ} placeholder="Tìm kiếm nhóm" label="Tìm kiếm nhóm" />
              </div>
            ) : null}
            {rows.length ? (
              <div className="grid cols-3">
                {rows.map((g) => (
                  <GroupCard key={g.name} group={g} dir={dir} fresh={fresh.has(g.name ?? "")} onOpen={() => onOpen(g)} />
                ))}
              </div>
            ) : (
              <NoMatches what="nhóm" onClear={() => setQ("")} />
            )}
          </>
        );
      }}
    </Gate>
  );
}

/**
 * Create a group, or edit its name and description (preview `M['ppl-group-form']`): a two-field form in a dialog.
 * `group` null = create.
 */
export function GroupFormDialog({
  state,
  dir,
  onClose,
  onCreated,
}: {
  state: { group: Group | null } | null;
  dir: Directory | undefined;
  onClose: () => void;
  onCreated: (group: Group) => void;
}) {
  return state ? <GroupForm key={state.group?.name ?? "new"} group={state.group} dir={dir} onClose={onClose} onCreated={onCreated} /> : null;
}

function GroupForm({ group, dir, onClose, onCreated }: { group: Group | null; dir: Directory | undefined; onClose: () => void; onCreated: (group: Group) => void }) {
  const { ws, refresh } = usePeopleClient();
  const [name, setName] = useState(group?.displayName ?? "");
  const [desc, setDesc] = useState(group?.description ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = (dir?.groups ?? []).filter((g) => g.name !== group?.name).map((g) => g.displayName);
  const changed = name.trim() !== (group?.displayName ?? "");
  const err = touched || (name.trim() && changed) ? groupNameError(name, others) : "";

  async function save() {
    setTouched(true);
    if (busy || groupNameError(name, others)) {
      document.getElementById("ppl-gn-name")?.focus();
      return;
    }
    setBusy(true);
    try {
      if (group) {
        const saved = await updateGroup(ws, group.name ?? "", { displayName: name.trim(), description: desc.trim() });
        await refresh();
        onClose();
        toast(`Đã lưu ${saved.displayName}`);
      } else {
        const created = await createGroup(ws, { displayName: name.trim(), description: desc.trim() });
        await refresh();
        onClose();
        toast(`Đã tạo ${created.displayName}`);
        onCreated(created);
      }
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      setBusy(false);
    }
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") void save();
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      guard={busy}
      icon={group ? Pencil : Users}
      title={group ? "Sửa thông tin nhóm" : "Tạo nhóm"}
      description={group ? "Đổi tên hoặc mô tả ai thuộc nhóm. Thành viên và quyền truy cập giữ nguyên." : "Chia sẻ tài liệu với cả nhóm chỉ trong một bước."}
      footerStart={group ? undefined : "Tiếp theo, bạn sẽ thêm người vào nhóm."}
      footer={
        <>
          <Button variant="ghost" isDisabled={busy} onPress={onClose}>
            Hủy
          </Button>
          <Button variant="primary" isPending={busy} onPress={() => void save()}>
            {group ? <Check className="i" aria-hidden /> : <Plus className="i" aria-hidden />}
            {group ? "Lưu thay đổi" : "Tạo nhóm"}
          </Button>
        </>
      }
    >
      <TextField value={name} onChange={setName} isRequired isInvalid={Boolean(err)} isDisabled={busy} maxLength={40} autoFocus>
        <Label>Tên</Label>
        <Input id="ppl-gn-name" placeholder="VD: Chăm sóc khách hàng" onKeyDown={onEnter} />
        <FieldError>{err}</FieldError>
      </TextField>
      <TextField value={desc} onChange={setDesc} isDisabled={busy} maxLength={80}>
        <Label>
          Mô tả <span className="label__opt">(không bắt buộc)</span>
        </Label>
        <Input placeholder="Ai thuộc nhóm này" onKeyDown={onEnter} />
      </TextField>
    </Dialog>
  );
}
