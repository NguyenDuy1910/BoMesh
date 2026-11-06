"use client";

import { Button, Checkbox, Description, FieldError, Input, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { toast } from "@/components/ui/Toast";
import { api, call, errorMessage, listAll } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { updateItem, type Item } from "../api";
import { LANGS, RESOURCE_KINDS, toResource, topicTree } from "../model";
import { invalidateKnowledge, knowledgeKeys, useItem, useKnowledgeModel } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";

export interface EditDetailsDialogProps {
  item: string;
  isOpen: boolean;
  onClose: () => void;
}

/** Edit details (preview `M['res-edit']`): title, type, language, owner, summary and topics. Editors only (`items.update`). */
export function EditDetailsDialog({ item, isOpen, onClose }: EditDetailsDialogProps) {
  const query = useItem(item);
  return query.data ? <EditDetailsForm key={query.data.etag} item={query.data} isOpen={isOpen} onClose={onClose} /> : null;
}

function EditDetailsForm({ item, isOpen, onClose }: { item: Item; isOpen: boolean; onClose: () => void }) {
  const { id: ws, settings } = useWorkspace();
  const qc = useQueryClient();
  const { ctx, topics } = useKnowledgeModel();
  const r = toResource(item, ctx);
  const members = useQuery({
    queryKey: [ws, "members", "all"],
    queryFn: () => listAll((pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/members", { params: { path: { workspace: ws }, query: { pageSize: 200, pageToken } } })), (p) => p.members),
    staleTime: 5 * 60_000,
  });
  const [title, setTitle] = useState(item.displayName ?? "");
  const [kind, setKind] = useState(r.kind);
  const [lang, setLang] = useState(r.language.split("-")[0]);
  const [owner, setOwner] = useState(item.document?.owner ?? "");
  const [summary, setSummary] = useState(item.document?.summary ?? "");
  const [picked, setPicked] = useState<string[]>(item.document?.topics ?? []);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleError = touched && !title.trim() ? "Enter a title." : "";

  const configured = settings?.documentTypes ?? [];
  const kinds: [string, string][] = configured.length
    ? configured.map((t) => [t.key ?? "", `${RESOURCE_KINDS[t.key ?? ""]?.group ?? "Reference"} · ${t.displayName ?? t.key}`])
    : Object.entries(RESOURCE_KINDS).map(([key, k]) => [key, `${k.group} · ${k.label}`]);
  if (!kinds.some(([k]) => k === kind)) kinds.push([kind, r.kindMeta.label]);
  const tree = topicTree(topics);

  async function save() {
    setTouched(true);
    if (!title.trim()) return;
    const mask: string[] = [];
    if (title.trim() !== item.displayName) mask.push("displayName");
    if (kind !== item.document?.documentType) mask.push("document.documentType");
    if (lang !== (item.document?.languageCode ?? "")) mask.push("document.languageCode");
    if (owner !== (item.document?.owner ?? "")) mask.push("document.owner");
    if (summary.trim() !== (item.document?.summary ?? "")) mask.push("document.summary");
    const before = new Set(item.document?.topics ?? []);
    if (picked.length !== before.size || picked.some((t) => !before.has(t))) mask.push("document.topics");
    if (!mask.length) return onClose();
    setBusy(true);
    try {
      await updateItem(
        ws,
        item.name ?? "",
        {
          displayName: title.trim(),
          etag: item.etag,
          document: {
            purpose: item.document?.purpose ?? "KNOWLEDGE",
            documentType: kind,
            languageCode: lang,
            owner: owner || undefined,
            summary: summary.trim(),
            topics: picked,
          },
        },
        mask,
      );
      invalidateKnowledge(qc, ws);
      void qc.invalidateQueries({ queryKey: knowledgeKeys.item(ws, r.id) });
      onClose();
      toast("Details saved");
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
      title="Edit details"
      description={<span translate="no">{item.displayName}</span>}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <TextField value={title} onChange={setTitle} isRequired isInvalid={!!titleError} maxLength={160}>
          <Label>Title</Label>
          <Input />
          <FieldError>{titleError}</FieldError>
        </TextField>
        <div className="grid cols-2">
          <Select value={kind} onChange={(v) => setKind(String(v))}>
            <Label>Type</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {kinds.map(([key, label]) => (
                  <ListBox.Item key={key} id={key} textValue={label}>
                    {label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <Select value={lang} onChange={(v) => setLang(String(v))}>
            <Label>Language</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {Object.entries(LANGS).map(([code, label]) => (
                  <ListBox.Item key={code} id={code} textValue={label}>
                    {label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
        <Select value={owner || "none"} onChange={(v) => setOwner(v === "none" ? "" : String(v))}>
          <Label>
            Owner <span className="label__opt">(optional)</span>
          </Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>The person accountable for keeping it accurate.</Description>
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
        <TextField value={summary} onChange={setSummary} maxLength={280}>
          <Label>
            Summary <span className="label__opt">(optional)</span>
          </Label>
          <TextArea rows={2} />
          <Description>One or two sentences people see in results and previews.</Description>
        </TextField>
        <div className="field">
          <span className="label">Topics</span>
          <div className="res-tgroups">
            {tree.length ? (
              tree.map((domain) => (
                <div key={domain.name} className="res-tgroup">
                  <div className="t-label">{domain.displayName}</div>
                  <div className="res-tgroup__items">
                    {domain.children.map((t) => (
                      <Checkbox
                        key={t.name}
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
              ))
            ) : (
              <p className="t-sm muted">This workspace has no topics yet.</p>
            )}
          </div>
        </div>
      </div>
    </KnowledgeModal>
  );
}
