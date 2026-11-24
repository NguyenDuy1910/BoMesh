"use client";

import { Button, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { CircleAlert, Folder, FolderPlus, Lock, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

import { IconButton } from "@/components/ui/IconButton";
import { List, ListItem } from "@/components/ui/List";
import { SearchInput } from "@/components/ui/SearchInput";
import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { KnowledgeModal } from "../../components/KnowledgeModal";
import { useWhoCanSeeAt } from "../../components/ResourceDetails";
import { useFolderOperations } from "../operations";
import { DESC_MAX, FOLDER_NAME_MAX, folderNameError, hasOwnAccess, ROLE_LABEL, ROLES, sharesOf, whereLabel, type FolderIndex, type Item, type Share } from "../model";
import { useBasePolicy } from "../queries";
import { InlineSelect } from "./InlineSelect";
import { ShareLead, useSharePeople, useShareOptions } from "./ShareDialog";

export interface FolderDialogProps {
  collection: Item;
  index: FolderIndex;
  /** Edit this folder; without it a new folder is made under `parent`. */
  folder?: Item;
  /** The collection or folder a new folder goes in. */
  parent: string;
  onClose: () => void;
  /** Opens a folder (the new one, from its toast). */
  onOpen: (folder: Item) => void;
}

/** Preview `M['kb-folder']`: a new folder, or a folder's details (name, description). */
export function FolderDialog({ collection, index, folder, parent, onClose, onOpen }: FolderDialogProps) {
  const ops = useFolderOperations();
  const [name, setName] = useState(folder?.displayName ?? "");
  const [desc, setDesc] = useState(folder?.collection?.description ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const at = folder ? (folder.parentItem ?? collection.name ?? "") : parent;
  const err = folderNameError(name, index.children.get(at) ?? [], folder?.name);
  const shown = touched || err.includes("already") ? err : "";
  const who = useWhoCanSeeAt(collection, index, at === collection.name ? null : at);
  const WhoIcon = who.icon;

  async function save() {
    setTouched(true);
    if (err || busy) return;
    setBusy(true);
    const values = { displayName: name.trim(), description: desc.trim() };
    const ok = folder ? await ops.save(folder, values) : await ops.create(parent, values, onOpen);
    setBusy(false);
    if (ok) onClose();
  }

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void save();
  };
  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="md"
      icon={Folder}
      title={folder ? "Chi tiết thư mục" : "Thư mục mới"}
      description={`Trong ${whereLabel(collection.displayName ?? "", index, at === collection.name ? null : at)}`}
      footerStart={
        folder ? undefined : (
          <span className="row gap-6 t-xs muted">
            <WhoIcon className="i i-sm" aria-hidden />
            {`Người đọc được: ${who.label}`}
          </span>
        )
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {folder || busy ? null : <FolderPlus className="i" aria-hidden />}
            {folder ? "Lưu" : "Tạo thư mục"}
          </Button>
        </>
      }
    >
      <div className="kn-form">
        <TextField className="field" value={name} onChange={setName} isRequired isInvalid={!!shown} isDisabled={busy} maxLength={FOLDER_NAME_MAX} autoFocus>
          <Label>Tên</Label>
          <Input placeholder="VD: Khiếu nại giao dịch" onKeyDown={onEnter} />
          {shown ? <FieldError>{shown}</FieldError> : null}
        </TextField>
        <TextField className="field" value={desc} onChange={setDesc} isDisabled={busy} maxLength={DESC_MAX}>
          <Label>
            Mô tả <span className="label__opt">(không bắt buộc)</span>
          </Label>
          <Input placeholder="VD: Bộ chứng từ và mã lý do cho tra soát thẻ" onKeyDown={onEnter} />
          <Description>Hiện trên Trang chủ khi có người chọn nó.</Description>
        </TextField>
      </div>
    </KnowledgeModal>
  );
}

export interface FolderAccessDialogProps {
  collection: Item;
  index: FolderIndex;
  folder: Item;
  onClose: () => void;
}

/**
 * Preview `M['kb-folder-access']`: a folder's own access (`inheritAccess = false`). Only the people and groups
 * listed read it and everything in it; restricting starts from the collection's owners (and you), so whoever
 * manages it keeps reading it. *Use the collection's access* goes back to inheriting.
 */
export function FolderAccessDialog({ collection, index, folder, onClose }: FolderAccessDialogProps) {
  const { member, can } = useWorkspace();
  const ops = useFolderOperations();
  const own = hasOwnAccess(folder);
  const basePolicy = useBasePolicy(collection);
  const folderPolicy = useBasePolicy(own ? folder : null);
  const me = `user:${resourceId(member.user)}`;
  const [edited, setEdited] = useState<Share[] | null>(null);
  const [q, setQ] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const up = folder.parentItem && folder.parentItem !== collection.name ? index.byName.get(folder.parentItem) : undefined;
  const upName = up?.displayName ?? collection.displayName ?? "";
  const whoAbove = useWhoCanSeeAt(collection, index, up?.name);

  const start = useMemo(() => {
    if (own) return folderPolicy.data ? sharesOf(folderPolicy.data) : null;
    if (!basePolicy.data) return null;
    const owners = sharesOf(basePolicy.data).filter((s) => s.role === "owner");
    if (!can("workspaces.update") && !owners.some((s) => s.principal === me)) owners.push({ principal: me, kind: "user", id: resourceId(member.user), role: "owner" });
    return owners;
  }, [own, folderPolicy.data, basePolicy.data, can, me, member.user]);
  const shares = edited ?? start ?? [];
  const people = useSharePeople(shares.map((s) => s.principal));
  const taken = useMemo(() => new Set(shares.map((s) => s.principal)), [shares]);
  const options = useShareOptions(q, taken, 5, { enabled: !!q.trim() });

  const error = tried && !shares.length ? "Thêm ít nhất một người hoặc nhóm." : "";
  const nameOf = (s: Share) => people.get(s.principal)?.name ?? (s.kind === "group" ? "Nhóm" : "Ai đó");

  async function save() {
    if (!shares.length) return setTried(true);
    setBusy(true);
    const ok = await ops.restrict(folder, shares);
    setBusy(false);
    if (ok) onClose();
  }
  async function inherit() {
    setBusy(true);
    const ok = await ops.inherit(folder, upName, whoAbove.label);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="md"
      icon={Lock}
      title={own ? `Ai đọc được “${folder.displayName}”` : `Đặt quyền truy cập riêng cho “${folder.displayName}”`}
      description={`Chỉ những người và nhóm dưới đây đọc được thư mục này và mọi thứ bên trong. Người đọc được ${upName} không xem được bên trong nếu chưa được thêm vào đây. Quản trị viên không gian làm việc luôn xem được.`}
      footerStart={
        own ? (
          <Button variant="ghost" onPress={() => void inherit()} isDisabled={busy}>
            Dùng quyền truy cập của kho tài liệu
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy} isDisabled={!start}>
            {busy ? null : <Lock className="i" aria-hidden />}
            {own ? "Lưu" : "Giới hạn thư mục"}
          </Button>
        </>
      }
    >
      <div className="kn-form">
        {shares.length ? (
          <List>
            {shares.map((s, i) => {
              const who = nameOf(s);
              return (
                <ListItem
                  key={s.principal}
                  className="kb-share-row"
                  lead={<ShareLead who={{ kind: s.kind, name: who }} size="sm" />}
                  title={who}
                  actions={
                    <>
                      <InlineSelect
                        label={`Vai trò của ${who}`}
                        value={s.role}
                        isDisabled={busy}
                        options={ROLES.map((r) => [r, ROLE_LABEL[r]] as const)}
                        onChange={(role) => setEdited(shares.map((x, j) => (j === i ? { ...x, role } : x)))}
                      />
                      <IconButton icon={X} tip={`Gỡ ${who}`} size="sm" isDisabled={busy} onPress={() => setEdited(shares.filter((_, j) => j !== i))} />
                    </>
                  }
                />
              );
            })}
          </List>
        ) : null}
        {error ? (
          <div className="field-error" role="alert">
            <CircleAlert className="i" aria-hidden />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="field">
          <SearchInput className="kb-share-q" value={q} onChange={setQ} label="Thêm người hoặc nhóm" placeholder="Thêm người hoặc nhóm" size="md" fullWidth />
          {q.trim() ? (
            options.length ? (
              <List className="kb-share-list">
                {options.map((o) => (
                  <ListItem
                    key={o.principal}
                    lead={<ShareLead who={o} size="sm" />}
                    title={o.name}
                    description={o.sub}
                    actions={<Plus className="i i-sm muted" aria-hidden />}
                    onPress={() => {
                      const [kind, id] = o.principal.split(":") as ["user" | "group", string];
                      setEdited([...shares, { principal: o.principal, kind, id, role: "viewer" }]);
                      setQ("");
                      setTried(false);
                    }}
                    label={`Thêm ${o.name}`}
                  />
                ))}
              </List>
            ) : (
              <p className="kb-share-none">{`Không có ai tên “${q.trim()}” trong không gian làm việc này.`}</p>
            )
          ) : null}
        </div>
      </div>
    </KnowledgeModal>
  );
}
