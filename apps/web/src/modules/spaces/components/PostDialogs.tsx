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
  const error = tried && !title.trim() ? "Enter a title." : "";

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
      toast(announcement ? "Announcement updated" : `Posted to ${space.displayName}`);
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
      title={announcement ? "Edit announcement" : "Post announcement"}
      description={
        announcement ? (
          "Changes show on the space page right away."
        ) : (
          `Everyone in ${space.displayName} sees it first on the space page.`
        )
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {announcement ? <Check aria-hidden /> : <Send aria-hidden />}
            {announcement ? "Save changes" : "Post announcement"}
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <TextField value={title} onChange={setTitle} isRequired isInvalid={!!error} maxLength={100} autoFocus>
          <Label>Title</Label>
          <Input placeholder="e.g. Lab moved to Thursday" />
          <FieldError>{error}</FieldError>
        </TextField>
        <TextField value={text} onChange={setText} maxLength={1000}>
          <Label>
            Message <span className="label__opt">(optional)</span>
          </Label>
          <TextArea rows={4} placeholder="The details members need: what changes, when, what to do." />
        </TextField>
        <SwitchRow
          title="Pin to the top"
          description="Stays above newer announcements until you unpin it."
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
  const titleError = tried && !title.trim() ? "Enter a title." : "";
  const startError = tried && !start ? "Choose when it starts." : "";
  const endError = start && end && end < start ? "It can’t end before it starts." : "";

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
      toast(event ? "Event updated" : "Event added");
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
      title={event ? "Edit event" : "Add event"}
      description={
        event ? undefined : (
          `Members of ${space.displayName} see it in Up next.`
        )
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {event ? <Check aria-hidden /> : <Plus aria-hidden />}
            {event ? "Save changes" : "Add event"}
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <TextField value={title} onChange={setTitle} isRequired isInvalid={!!titleError} maxLength={300} autoFocus>
          <Label>Title</Label>
          <Input placeholder="e.g. Midterm review" />
          <FieldError>{titleError}</FieldError>
        </TextField>
        <div className="sp-create-row">
          <TextField value={start} onChange={setStart} isRequired isInvalid={!!startError}>
            <Label>Starts</Label>
            <Input type="datetime-local" />
            <FieldError>{startError}</FieldError>
          </TextField>
          <TextField value={end} onChange={setEnd} isInvalid={!!endError}>
            <Label>
              Ends <span className="label__opt">(optional)</span>
            </Label>
            <Input type="datetime-local" />
            <FieldError>{endError}</FieldError>
          </TextField>
        </div>
        <TextField value={location} onChange={setLocation} maxLength={120}>
          <Label>
            Place <span className="label__opt">(optional)</span>
          </Label>
          <Input placeholder="e.g. A5-302 or a meeting link" />
        </TextField>
        <TextField value={desc} onChange={setDesc} maxLength={1000}>
          <Label>
            Details <span className="label__opt">(optional)</span>
          </Label>
          <TextArea rows={3} />
        </TextField>
      </div>
    </KnowledgeModal>
  );
}
