"use client";

import { Button, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Check, ClipboardList, Link as LinkIcon, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ChoiceGroup, Disclosure, FormSection, ItemIcon, List, ListItem, SaveBar, Segmented, SkeletonRows, SwitchRow, confirm, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { createMaterial, deleteMaterial, materialsOf } from "@/modules/knowledge/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { slaDays } from "@/modules/requests/model";

import { createRequestType, deleteRequestType, deleteSpace, undeleteRequestType, undeleteSpace, updateRequestType, updateSpace, type RequestType } from "../api";
import { invalidateSpaces, useLinkableBases, useRequestTypes, useSpaces, type LinkableBase } from "../queries";
import { MAX_NAME, POLICY_OF, visibilityOf, type Space, type Visibility } from "../types";
import type { SpaceView } from "./context";
import { Menu } from "./Menu";
import { spaceNameError } from "./CreateSpaceDialog";

interface Form {
  name: string;
  desc: string;
  visibility: Visibility;
  bases: string[];
}

const formOf = (space: Space, linked: readonly string[]): Form => ({
  name: space.displayName ?? "",
  desc: space.description ?? "",
  visibility: visibilityOf(space.joinPolicy),
  bases: [...linked],
});

/** Settings (preview `settingsTab`, leads and admins): details, linked collections, request types, who can find it, archive. */
export function SettingsTab({ view }: { view: SpaceView }) {
  const bases = useLinkableBases();
  if (!bases.data) return <SkeletonRows rows={4} />;
  const linked = view.space.collections ?? [];
  return <SettingsForm key={`${view.space.etag}-${linked.join(",")}`} view={view} linked={linked} />;
}

/** One collection to link (preview `kbRow`): a collection among the space's materials. */
function CollectionSwitch({ entry, on, disabled, onChange }: { entry: LinkableBase; on: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const { base, readable } = entry;
  return (
    <SwitchRow
      title={<span translate="no">{base.displayName}</span>}
      label={base.displayName}
      description={readable ? plural(base.collection?.documentCount ?? 0, "document") : "Bạn không thể đọc mục này"}
      isDisabled={disabled}
      isSelected={on}
      onChange={onChange}
    />
  );
}

function SettingsForm({ view, linked }: { view: SpaceView; linked: string[] }) {
  const { id: ws, workspace, hasModule } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const { space, type, sid } = view;
  const spaces = useSpaces();
  const bases = useLinkableBases();
  const catalog = useRequestTypes(sid);
  const [f, setF] = useState<Form>(() => formOf(space, linked));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const initial = formOf(space, linked);
  const nameErr = tried || f.name.trim() !== initial.name ? spaceNameError(f.name, spaces.data ?? [], space.name) : "";
  const dirty =
    f.name.trim() !== initial.name ||
    f.desc.trim() !== initial.desc ||
    f.visibility !== initial.visibility ||
    [...f.bases].sort().join() !== [...initial.bases].sort().join();

  const cands = (bases.data ?? []).filter((b) => b.readable || initial.bases.includes(b.base.name ?? ""));
  const saved = cands.filter((b) => initial.bases.includes(b.base.name ?? ""));
  const rest = cands.filter((b) => !initial.bases.includes(b.base.name ?? ""));
  const picked = rest.filter((b) => f.bases.includes(b.base.name ?? "")).length;
  // Same pattern as Create: a Switch per collection, linked ones first.
  const toggleBase = (name: string, on: boolean) => setF({ ...f, bases: on ? [...f.bases, name] : f.bases.filter((b) => b !== name) });
  const takesRequests = hasModule("requests") && type.key !== "course";
  const visibility: { value: Visibility; title: string; description: string }[] = [
    {
      value: "open",
      title: "Mở",
      description: `Mọi thành viên trong ${workspace.displayName ?? "không gian làm việc"} đều có thể mở${catalog.data?.length ? " và gửi yêu cầu" : ""}.`,
    },
    { value: "discoverable", title: "Tìm thấy được", description: "Bất kỳ ai cũng có thể tìm thấy và yêu cầu tham gia." },
    {
      value: "members",
      title: "Hiển thị công khai, chỉ thành viên",
      description: type.join === "enrolled" ? "Mọi người có thể tìm thấy; chỉ thành viên đã đăng ký mới vào được." : "Mọi người có thể tìm thấy; chỉ thành viên mới vào được.",
    },
  ];

  async function save() {
    setTried(true);
    if (spaceNameError(f.name, spaces.data ?? [], space.name)) return;
    setBusy(true);
    try {
      const mask: string[] = [];
      if (f.name.trim() !== initial.name) mask.push("displayName");
      if (f.desc.trim() !== initial.desc) mask.push("description");
      if (f.visibility !== initial.visibility && f.visibility !== "private") mask.push("joinPolicy");
      if (mask.length)
        await updateSpace(
          ws,
          sid,
          { displayName: f.name.trim(), description: f.desc.trim(), joinPolicy: f.visibility === "private" ? undefined : POLICY_OF[f.visibility], etag: space.etag },
          mask,
        );
      const add = f.bases.filter((b) => !initial.bases.includes(b));
      const drop = initial.bases.filter((b) => !f.bases.includes(b));
      const dropped = await materialsOf(ws, sid, drop);
      await Promise.all([
        ...add.map((b) => createMaterial(ws, sid, b)),
        ...dropped.map((m) => deleteMaterial(ws, m.name ?? "")),
      ]);
      await invalidateSpaces(qc, ws);
      void qc.invalidateQueries({ queryKey: [ws, "items"] });
      toast("Đã cập nhật cộng đồng");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  // Archiving hides the space from everyone who depends on it, so it asks first (no typed name: that's for workspaces).
  async function archive() {
    const ok = await confirm({
      title: `Lưu trữ ${space.displayName}?`,
      description: "Thành viên sẽ mất trang cộng đồng, thông báo và hàng đợi. Kho tài liệu được liên kết và công việc đã lưu vẫn giữ nguyên.",
      confirmLabel: "Lưu trữ cộng đồng",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteSpace(ws, sid, space.etag);
      await invalidateSpaces(qc, ws);
      router.push("/spaces");
      toast(`Đã lưu trữ ${space.displayName}`, {
        undo: () =>
          void undeleteSpace(ws, sid)
            .then(() => invalidateSpaces(qc, ws))
            .catch((e) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  return (
    <>
      <div className="sp-settings">
        <FormSection title="Chi tiết" description="Hiển thị trên trang cộng đồng, trong Cộng đồng và trong tìm kiếm.">
          <TextField value={f.name} onChange={(name) => setF({ ...f, name })} isRequired isInvalid={!!nameErr} maxLength={MAX_NAME}>
            <Label>Tên</Label>
            <Input />
            <FieldError>{nameErr}</FieldError>
          </TextField>
          <TextField value={f.desc} onChange={(desc) => setF({ ...f, desc })} maxLength={200}>
            <Label>
              Mô tả <span className="label__opt">(không bắt buộc)</span>
            </Label>
            <TextArea rows={2} />
          </TextField>
        </FormSection>
        <FormSection title="Tài liệu" description="Thành viên có thể đọc và hỏi về kho tài liệu được liên kết. Quyền truy cập của từng kho tài liệu vẫn được áp dụng.">
          <div className="stack gap-4">
            {saved.map((b) => (
              <CollectionSwitch key={b.base.name} entry={b} on={f.bases.includes(b.base.name ?? "")} disabled={busy} onChange={(on) => toggleBase(b.base.name ?? "", on)} />
            ))}
            {rest.length ? (
              <div className="mt-8">
                <Disclosure title="Liên kết kho tài liệu có sẵn" icon={LinkIcon} summary={picked ? `Đã chọn ${fmtNum(picked)}` : `${fmtNum(rest.length)} có thể liên kết`}>
                  <div className="stack gap-4">
                    {rest.map((b) => (
                      <CollectionSwitch key={b.base.name} entry={b} on={f.bases.includes(b.base.name ?? "")} disabled={busy} onChange={(on) => toggleBase(b.base.name ?? "", on)} />
                    ))}
                  </div>
                </Disclosure>
              </div>
            ) : null}
            {!cands.length ? <p className="t-sm muted">Chưa có kho tài liệu để liên kết.</p> : null}
          </div>
        </FormSection>
        {takesRequests ? (
          <FormSection title="Yêu cầu" description="Những gì mọi người có thể yêu cầu và bạn thường trả lời trong bao lâu. Thay đổi áp dụng ngay.">
            <RequestTypes view={view} types={catalog.data} />
          </FormSection>
        ) : null}
        <FormSection title="Ai có thể tìm thấy">
          <ChoiceGroup label="Ai có thể tìm thấy" value={f.visibility} onChange={(visibility) => setF({ ...f, visibility })} options={visibility} isDisabled={busy} />
        </FormSection>
        <FormSection title="Lưu trữ">
          {view.can("spaces.delete") ? (
            <div className="card sp-danger">
              <div className="card__header">
                <span className="item-icon item-icon--danger" aria-hidden>
                  <Archive className="i" />
                </span>
                <div className="grow">
                  <h3 className="card__title">Lưu trữ cộng đồng</h3>
                  <p className="card__description">Ẩn với mọi người. Kho tài liệu được liên kết và công việc đã lưu vẫn giữ nguyên.</p>
                </div>
                <Button variant="danger-soft" onPress={() => void archive()}>
                  <Archive aria-hidden />
                  Lưu trữ
                </Button>
              </div>
            </div>
          ) : (
            <p className="t-sm muted">Chỉ trưởng cộng đồng mới lưu trữ được cộng đồng này.</p>
          )}
        </FormSection>
      </div>
      <SaveBar isDirty={dirty} isSaving={busy} saveLabel="Lưu thay đổi" onSave={() => void save()} onDiscard={() => setF(initial)} />
    </>
  );
}

const slaWords = (d: number | null) => (d === null ? "" : d <= 1 ? "Ngày làm việc tiếp theo" : `${d} ngày làm việc`);

/** Request types (preview `requestTypesSection`): what people can ask this office or team for. Delete is immediate with Undo. */
function RequestTypes({ view, types }: { view: SpaceView; types: RequestType[] | undefined }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ type?: RequestType } | null>(null);
  const canCreate = view.can("requestTypes.create");
  const canEdit = view.can("requestTypes.update");
  const canDelete = view.can("requestTypes.delete");
  if (!types) return <SkeletonRows rows={2} />;

  async function remove(t: RequestType) {
    try {
      await deleteRequestType(t.name ?? "", t.etag);
      void invalidateSpaces(qc, ws);
      toast(`Đã xóa “${t.displayName}”`, {
        undo: () =>
          void undeleteRequestType(t.name ?? "")
            .then(() => invalidateSpaces(qc, ws))
            .catch((e) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  const add = canCreate ? (
    <Button variant="tertiary" onPress={() => setEditing({})}>
      <Plus aria-hidden />
      Loại yêu cầu mới
    </Button>
  ) : null;

  return (
    <>
      {types.length ? (
        <>
          <List>
            {types.map((t) => (
              <ListItem
                key={t.name}
                lead={<ItemIcon icon={ClipboardList} size="sm" />}
                title={t.displayName}
                contentTitle
                description={[slaWords(slaDays(t)), plural(t.fields?.length ?? 0, "field"), t.rules?.length ? plural(t.rules.length, "quy tắc kiểm tra") : ""].filter(Boolean).join(" · ")}
                actions={
                  canEdit || canDelete ? (
                    <span className="reveal-on-hover">
                      <Menu
                        label={`Tùy chọn cho ${t.displayName}`}
                        nodes={[
                          ...(canEdit ? [{ id: "edit", label: "Chỉnh sửa", icon: Pencil, run: () => setEditing({ type: t }) }] : []),
                          ...(canEdit && canDelete ? [{ sep: "1" }] : []),
                          ...(canDelete ? [{ id: "delete", label: "Xóa", icon: Trash2, danger: true, run: () => void remove(t) }] : []),
                        ]}
                      >
                        <Button isIconOnly size="sm" variant="ghost" aria-label={`Tùy chọn cho ${t.displayName}`} className="button--muted">
                          <MoreHorizontal aria-hidden />
                        </Button>
                      </Menu>
                    </span>
                  ) : undefined
                }
              />
            ))}
          </List>
          {add ? <div className="mt-12">{add}</div> : null}
        </>
      ) : (
        <div className="stack gap-12">
          <p className="t-sm muted">{`${view.space.displayName} chưa nhận yêu cầu. Thêm một loại và nó sẽ xuất hiện trong Yêu cầu → Yêu cầu mới.`}</p>
          {add ? <div>{add}</div> : null}
        </div>
      )}
      {editing ? <RequestTypeDialog view={view} type={editing.type} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

const SLA_OPTS = [
  { value: "1", label: "Ngày hôm sau" },
  { value: "2", label: "2 ngày" },
  { value: "3", label: "3 ngày" },
  { value: "5", label: "5 ngày" },
];

/** New or edit request type (preview `M['sp-rt']`). */
function RequestTypeDialog({ view, type, onClose }: { view: SpaceView; type?: RequestType; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const [name, setName] = useState(type?.displayName ?? "");
  const [desc, setDesc] = useState(type?.description ?? "");
  const [sla, setSla] = useState(String(slaDays(type) ?? 2));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const err = tried && !name.trim() ? "Đặt tên cho điều mọi người có thể yêu cầu." : "";
  const kept = type ? [plural(type.fields?.length ?? 0, "field"), type.rules?.length ? plural(type.rules.length, "quy tắc kiểm tra") : ""].filter(Boolean).join(" · ") : "";

  async function save() {
    setTried(true);
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    const data = { displayName: n, description: desc.trim(), slaDuration: `${Number(sla) * 86_400}s` };
    try {
      if (type?.name) {
        await updateRequestType(type.name, { ...data, etag: type.etag }, ["displayName", "description", "slaDuration"]);
        toast("Đã cập nhật loại yêu cầu");
      } else {
        const made = await createRequestType(ws, view.sid, { ...data, fields: [{ key: "details", displayName: "Chi tiết", type: "TEXT", required: true }] });
        toast(`Mọi người giờ có thể yêu cầu “${n}”`, {
          undo: () =>
            void deleteRequestType(made.name ?? "", made.etag)
              .then(() => invalidateSpaces(qc, ws))
              .catch((e) => toast(errorMessage(e), { tone: "danger" })),
        });
      }
      void invalidateSpaces(qc, ws);
      onClose();
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="md"
      icon={ClipboardList}
      title={type ? "Sửa loại yêu cầu" : "Loại yêu cầu mới"}
      description="Loại này xuất hiện trong Yêu cầu → Yêu cầu mới, và các yêu cầu sẽ vào hàng chờ của cộng đồng này."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {type ? <Check aria-hidden /> : <Plus aria-hidden />}
            {type ? "Lưu thay đổi" : "Thêm loại yêu cầu"}
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <TextField value={name} onChange={setName} isRequired isInvalid={!!err} maxLength={60} autoFocus>
          <Label>Tên</Label>
          <Input placeholder="VD: Laptop mới" />
          <FieldError>{err}</FieldError>
        </TextField>
        <TextField value={desc} onChange={setDesc} maxLength={160}>
          <Label>
            Dùng để làm gì <span className="label__opt">(không bắt buộc)</span>
          </Label>
          <TextArea rows={2} placeholder="Một dòng mọi người đọc trước khi chọn." />
        </TextField>
        <div className="field">
          <span className="label">Thời gian xử lý thường lệ</span>
          <Segmented label="Thời gian xử lý thường lệ" value={sla} onChange={setSla} options={SLA_OPTS} />
          <div className="description">Ngày làm việc. Nhân viên thấy đây là SLA trong hàng chờ.</div>
        </div>
        <p className="t-sm muted">
          {type
            ? `${kept} giữ nguyên.`
            : "Mọi người mô tả nhu cầu trong một trường Chi tiết. Trợ lý kiểm tra chính sách của cộng đồng trước khi gửi."}
        </p>
      </div>
    </KnowledgeModal>
  );
}
