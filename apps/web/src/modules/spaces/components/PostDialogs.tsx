"use client";

import { Button, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Check, Megaphone, Pencil, Plus, Send } from "lucide-react";
import { useState } from "react";

import { SwitchRow, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { createAnnouncement, createSpaceEvent, updateAnnouncement, updateSpaceEvent, type Announcement, type SpaceEvent } from "../api";
import { invalidateSpaces } from "../queries";
import type { Space } from "../types";

/** Post or edit an announcement (preview `M['sp-ann']`). */
export function AnnouncementDialog({ space, announcement, onClose }: { space: Space; announcement?: Announcement; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const [title, setTitle] = useState(announcement?.title ?? "");
  const [text, setText] = useState(announcement?.body ?? "");
  const [pinned, setPinned] = useState(!!announcement?.pinned);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = tried && !title.trim() ? "Nhập tiêu đề." : "";

  async function save() {
    setTried(true);
    if (!title.trim()) return;
    setBusy(true);
    try {
      const data = { title: title.trim(), body: text.trim(), pinned };
      if (announcement?.name) await updateAnnouncement(announcement.name, { ...data, etag: announcement.etag }, ["title", "body", "pinned"]);
      else await createAnnouncement(ws, space.name ?? "", data);
      void invalidateSpaces(qc, ws);
      onClose();
      toast(announcement ? "Đã cập nhật thông báo" : `Đã đăng lên ${space.displayName}`);
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
      icon={announcement ? Pencil : Megaphone}
      title={announcement ? "Sửa thông báo" : "Đăng thông báo"}
      description={
        announcement ? (
          "Thay đổi hiển thị ngay trên trang cộng đồng."
        ) : (
          `Mọi người trong ${space.displayName} sẽ thấy thông báo này đầu tiên trên trang cộng đồng.`
        )
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {announcement ? <Check aria-hidden /> : <Send aria-hidden />}
            {announcement ? "Lưu thay đổi" : "Đăng thông báo"}
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <TextField value={title} onChange={setTitle} isRequired isInvalid={!!error} maxLength={100} autoFocus>
          <Label>Tiêu đề</Label>
          <Input placeholder="VD: Buổi thực hành chuyển sang thứ Năm" />
          <FieldError>{error}</FieldError>
        </TextField>
        <TextField value={text} onChange={setText} maxLength={1000}>
          <Label>
            Tin nhắn <span className="label__opt">(không bắt buộc)</span>
          </Label>
          <TextArea rows={4} placeholder="Những gì thành viên cần biết: thay đổi gì, khi nào, cần làm gì." />
        </TextField>
        <SwitchRow
          title="Ghim lên đầu"
          description="Luôn nằm trên các thông báo mới hơn cho đến khi bạn bỏ ghim."
          isSelected={pinned}
          onChange={setPinned}
          isDisabled={busy}
        />
      </div>
    </KnowledgeModal>
  );
}

/** `datetime-local` value for an ISO time (local clock). */
function localValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Add or edit a space event; events feed Up next for members (SpaceEvent). */
export function EventDialog({ space, event, onClose }: { space: Space; event?: SpaceEvent; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const [title, setTitle] = useState(event?.title ?? "");
  const [start, setStart] = useState(localValue(event?.startTime));
  const [end, setEnd] = useState(localValue(event?.endTime));
  const [location, setLocation] = useState(event?.location ?? "");
  const [desc, setDesc] = useState(event?.description ?? "");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleError = tried && !title.trim() ? "Nhập tiêu đề." : "";
  const startError = tried && !start ? "Chọn thời điểm bắt đầu." : "";
  const endError = start && end && end < start ? "Thời điểm kết thúc không được sớm hơn thời điểm bắt đầu." : "";

  async function save() {
    setTried(true);
    if (!title.trim() || !start || endError) return;
    setBusy(true);
    try {
      const data: SpaceEvent = {
        title: title.trim(),
        startTime: new Date(start).toISOString(),
        endTime: end ? new Date(end).toISOString() : undefined,
        location: location.trim() || undefined,
        description: desc.trim() || undefined,
      };
      if (event?.name) await updateSpaceEvent(event.name, { ...data, etag: event.etag }, ["title", "startTime", "endTime", "location", "description"]);
      else await createSpaceEvent(ws, space.name ?? "", data);
      void invalidateSpaces(qc, ws);
      onClose();
      toast(event ? "Đã cập nhật sự kiện" : "Đã thêm sự kiện");
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
      icon={event ? Pencil : CalendarPlus}
      title={event ? "Chỉnh sửa sự kiện" : "Thêm sự kiện"}
      description={
        event ? undefined : (
          `Thành viên của ${space.displayName} sẽ thấy trong mục Tiếp theo.`
        )
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {event ? <Check aria-hidden /> : <Plus aria-hidden />}
            {event ? "Lưu thay đổi" : "Thêm sự kiện"}
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <TextField value={title} onChange={setTitle} isRequired isInvalid={!!titleError} maxLength={300} autoFocus>
          <Label>Tiêu đề</Label>
          <Input placeholder="Ví dụ: Ôn tập giữa kỳ" />
          <FieldError>{titleError}</FieldError>
        </TextField>
        <div className="sp-create-row">
          <TextField value={start} onChange={setStart} isRequired isInvalid={!!startError}>
            <Label>Bắt đầu</Label>
            <Input type="datetime-local" />
            <FieldError>{startError}</FieldError>
          </TextField>
          <TextField value={end} onChange={setEnd} isInvalid={!!endError}>
            <Label>
              Kết thúc <span className="label__opt">(không bắt buộc)</span>
            </Label>
            <Input type="datetime-local" />
            <FieldError>{endError}</FieldError>
          </TextField>
        </div>
        <TextField value={location} onChange={setLocation} maxLength={120}>
          <Label>
            Địa điểm <span className="label__opt">(không bắt buộc)</span>
          </Label>
          <Input placeholder="Ví dụ: A5-302 hoặc đường dẫn cuộc họp" />
        </TextField>
        <TextField value={desc} onChange={setDesc} maxLength={1000}>
          <Label>
            Chi tiết <span className="label__opt">(không bắt buộc)</span>
          </Label>
          <TextArea rows={3} />
        </TextField>
      </div>
    </KnowledgeModal>
  );
}
