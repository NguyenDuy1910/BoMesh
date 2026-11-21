"use client";

import { Button, Checkbox, Description, FieldError, Input, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, SlidersHorizontal, Tag } from "lucide-react";
import { useState } from "react";

import { Disclosure } from "@/components/ui/Disclosure";
import { toast } from "@/components/ui/Toast";
import { api, call, errorMessage, listAll } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { updateItem, type Item } from "../api";
import { LANGS, languageName, toResource, topicTree } from "../model";
import { invalidateKnowledge, knowledgeKeys, useItem, useKnowledgeModel } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";

export interface EditDetailsDialogProps {
  item: string;
  isOpen: boolean;
  onClose: () => void;
}

/** Edit details (preview `M['res-edit']`): title, summary, topics, language and owner. Editors only (`items.update`). */
export function EditDetailsDialog({ item, isOpen, onClose }: EditDetailsDialogProps) {
  const query = useItem(item);
  return query.data ? <EditDetailsForm key={query.data.etag} item={query.data} isOpen={isOpen} onClose={onClose} /> : null;
}

function EditDetailsForm({ item, isOpen, onClose }: { item: Item; isOpen: boolean; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const { ctx, topics } = useKnowledgeModel();
  const r = toResource(item, ctx);
  const members = useQuery({
    queryKey: [ws, "members", "all"],
    queryFn: () => listAll((pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/members", { params: { path: { workspace: ws }, query: { pageSize: 200, pageToken } } })), (p) => p.members),
    staleTime: 5 * 60_000,
  });
  // People edit the title; the file keeps its extension (the format badge already says PDF/MD).
  const ext = /\.[a-z0-9]{1,5}$/i.exec(item.displayName ?? "")?.[0] ?? "";
  const [title, setTitle] = useState((item.displayName ?? "").slice(0, (item.displayName ?? "").length - ext.length));
  const [lang, setLang] = useState(r.language.split("-")[0]);
  const [owner, setOwner] = useState(item.document?.owner ?? "");
  const [summary, setSummary] = useState(item.document?.summary ?? "");
  const [picked, setPicked] = useState<string[]>(item.document?.topics ?? []);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleError = touched && !title.trim() ? "Enter a title." : "";

  const langs: [string, string][] = Object.entries(LANGS);
  if (!langs.some(([code]) => code === lang)) langs.push([lang, languageName(lang)]);
  const tree = topicTree(topics);
  const names = picked.map((t) => ctx.topicNames?.get(t) ?? "Untitled topic");
  const topicSummary = names.length ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "") : "None yet";
  const ownerName = members.data?.find((m) => m.name === owner)?.displayName;
  const moreSummary = [languageName(lang), ownerName].filter(Boolean).join(" · ");

  async function save() {
    if (busy) return;
    setTouched(true);
    if (!title.trim()) return;
    const doc = item.document;
    const next = {
      displayName: title.trim() + ext,
      languageCode: lang,
      owner: owner || undefined,
      summary: summary.trim(),
      topics: picked,
    };
    const mask: string[] = [];
    if (next.displayName !== item.displayName) mask.push("displayName");
    if (lang !== (doc?.languageCode ?? "")) mask.push("document.languageCode");
    if (owner !== (doc?.owner ?? "")) mask.push("document.owner");
    if (next.summary !== (doc?.summary ?? "")) mask.push("document.summary");
    const before = new Set(doc?.topics ?? []);
    if (picked.length !== before.size || picked.some((t) => !before.has(t))) mask.push("document.topics");
    if (!mask.length) return onClose();
    const patchOf = (v: typeof next, etag: string | undefined): Item => ({
      displayName: v.displayName,
      etag,
      document: { purpose: doc?.purpose ?? "KNOWLEDGE", languageCode: v.languageCode, owner: v.owner, summary: v.summary, topics: v.topics },
    });
    const prev = {
      displayName: item.displayName ?? "",
      languageCode: doc?.languageCode ?? "",
      owner: doc?.owner,
      summary: doc?.summary ?? "",
      topics: doc?.topics ?? [],
    };
    const refresh = () => {
      invalidateKnowledge(qc, ws);
      void qc.invalidateQueries({ queryKey: knowledgeKeys.item(ws, r.id) });
    };
    setBusy(true);
    try {
      const saved = await updateItem(ws, item.name ?? "", patchOf(next, item.etag), mask);
      refresh();
      onClose();
      toast("Details saved", {
        undo: () => void updateItem(ws, item.name ?? "", patchOf(prev, saved.etag), mask).then(refresh, (e: unknown) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      guard={busy}
      title="Edit details"
      icon={Pencil}
      description="What people see in search results, previews and the reader."
      footerStart="Changes show for everyone right away."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            <Check className="i" aria-hidden />
            Save changes
          </Button>
        </>
      }
    >
      <div className="kn-form">
        <TextField
          value={title}
          onChange={(v) => {
            setTitle(v);
            if (v.trim()) setTouched(false);
          }}
          isRequired
          isInvalid={!!titleError}
          isDisabled={busy}
          maxLength={160}
          autoFocus
        >
          <Label>Title</Label>
          {/* On the Input (native event): React Aria's TextField onKeyDown stops propagation, so Esc never reached the modal. */}
          <Input onKeyDown={(e) => e.key === "Enter" && void save()} />
          <FieldError>{titleError}</FieldError>
        </TextField>
        <TextField value={summary} onChange={setSummary} maxLength={280} isDisabled={busy}>
          <Label>
            Summary <span className="label__opt">(optional)</span>
          </Label>
          <TextArea rows={2} />
          <Description>One or two sentences shown in results and previews.</Description>
        </TextField>
        <div className="stack gap-8">
          {tree.length ? (
            <Disclosure title="Topics" icon={Tag} summary={topicSummary} defaultOpen={!picked.length}>
              <div className="res-tgroups">
                {tree.map((domain) => (
                  <div key={domain.name} className="res-tgroup">
                    <div className="res-tgroup__title">{domain.displayName}</div>
                    <div className="res-tgroup__items">
                      {domain.children.map((t) => (
                        <Checkbox
                          key={t.name}
                          isDisabled={busy}
                          isSelected={picked.includes(t.name ?? "")}
                          onChange={(on) => setPicked(on ? [...picked, t.name ?? ""] : picked.filter((x) => x !== t.name))}
                        >
                          <Checkbox.Content>
                            <Checkbox.Control>
                              <Checkbox.Indicator />
                            </Checkbox.Control>
                            {t.displayName}
                          </Checkbox.Content>
                        </Checkbox>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Disclosure>
          ) : (
            <p className="t-sm muted">This workspace has no topics yet.</p>
          )}
          <Disclosure title="Language and owner" icon={SlidersHorizontal} summary={moreSummary}>
            <div className="grid cols-2 res-more">
              <Select value={lang} onChange={(v) => setLang(String(v))} isDisabled={busy}>
                <Label>Language</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {langs.map(([code, label]) => (
                      <ListBox.Item key={code} id={code} textValue={label}>
                        {label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <Select value={owner || "none"} onChange={(v) => setOwner(v === "none" ? "" : String(v))} isDisabled={busy}>
                <Label>
                  Owner <span className="label__opt">(optional)</span>
                </Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Description>The person who keeps it accurate.</Description>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="none" textValue="No owner">
                      No owner
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    {(members.data ?? []).map((m) => (
                      <ListBox.Item key={m.name} id={m.name ?? ""} textValue={m.displayName ?? m.email ?? ""}>
                        {m.displayName ?? m.email}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          </Disclosure>
        </div>
      </div>
    </KnowledgeModal>
  );
}
