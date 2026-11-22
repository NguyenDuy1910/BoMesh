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
import { createMaterial, deleteMaterial, listMaterials } from "@/modules/knowledge/api";
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
      description={readable ? plural(base.collection?.documentCount ?? 0, "document") : "You can’t read this one"}
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
      title: "Open",
      description: `Anyone in ${workspace.displayName ?? "the workspace"} can open it${catalog.data?.length ? " and send requests" : ""}.`,
    },
    { value: "discoverable", title: "Discoverable", description: "Anyone can find it and ask to join." },
    {
      value: "members",
      title: "Listed, members only",
      description: type.join === "enrolled" ? "People can find it; only enrolled members get in." : "People can find it; only members get in.",
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
      const materials = drop.length ? await listMaterials(ws, sid) : [];
      const dropped = materials.filter((m) => drop.includes(m.item ?? ""));
      await Promise.all([
        ...add.map((b) => createMaterial(ws, sid, b)),
        ...dropped.map((m) => deleteMaterial(ws, m.name ?? "")),
      ]);
      await invalidateSpaces(qc, ws);
      void qc.invalidateQueries({ queryKey: [ws, "items"] });
      toast("Space updated");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  // Archiving hides the space from everyone who depends on it, so it asks first (no typed name: that's for workspaces).
  async function archive() {
    const ok = await confirm({
      title: `Archive ${space.displayName}?`,
      description: "Members lose the space page, its announcements and queue. Linked collections and saved work stay where they are.",
      confirmLabel: "Archive space",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteSpace(ws, sid, space.etag);
      await invalidateSpaces(qc, ws);
      router.push("/spaces");
      toast(`Archived ${space.displayName}`, {
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
        <FormSection title="Details" description="Shown on the space page, in Spaces and in search.">
          <TextField value={f.name} onChange={(name) => setF({ ...f, name })} isRequired isInvalid={!!nameErr} maxLength={MAX_NAME}>
            <Label>Name</Label>
            <Input />
            <FieldError>{nameErr}</FieldError>
          </TextField>
          <TextField value={f.desc} onChange={(desc) => setF({ ...f, desc })} maxLength={200}>
            <Label>
              Description <span className="label__opt">(optional)</span>
            </Label>
            <TextArea rows={2} />
          </TextField>
        </FormSection>
        <FormSection title="Knowledge" description="Members can read and ask about linked collections. Access to each collection still applies.">
          <div className="stack gap-4">
            {saved.map((b) => (
              <CollectionSwitch key={b.base.name} entry={b} on={f.bases.includes(b.base.name ?? "")} disabled={busy} onChange={(on) => toggleBase(b.base.name ?? "", on)} />
            ))}
            {rest.length ? (
              <div className="mt-8">
                <Disclosure title="Link existing collections" icon={LinkIcon} summary={picked ? `${fmtNum(picked)} selected` : `${fmtNum(rest.length)} available`}>
                  <div className="stack gap-4">
                    {rest.map((b) => (
                      <CollectionSwitch key={b.base.name} entry={b} on={f.bases.includes(b.base.name ?? "")} disabled={busy} onChange={(on) => toggleBase(b.base.name ?? "", on)} />
                    ))}
                  </div>
                </Disclosure>
              </div>
            ) : null}
            {!cands.length ? <p className="t-sm muted">No collections to link yet.</p> : null}
          </div>
        </FormSection>
        {takesRequests ? (
          <FormSection title="Requests" description="What people can ask for, and how soon you usually answer. Changes apply right away.">
            <RequestTypes view={view} types={catalog.data} />
          </FormSection>
        ) : null}
        <FormSection title="Who can find it">
          <ChoiceGroup label="Who can find it" value={f.visibility} onChange={(visibility) => setF({ ...f, visibility })} options={visibility} isDisabled={busy} />
        </FormSection>
        <FormSection title="Archive">
          {view.can("spaces.delete") ? (
            <div className="card sp-danger">
              <div className="card__header">
                <span className="item-icon item-icon--danger" aria-hidden>
                  <Archive className="i" />
                </span>
                <div className="grow">
                  <h3 className="card__title">Archive space</h3>
                  <p className="card__description">Hides it for everyone. Linked collections and saved work stay where they are.</p>
                </div>
                <Button variant="danger-soft" onPress={() => void archive()}>
                  <Archive aria-hidden />
                  Archive
                </Button>
              </div>
            </div>
          ) : (
            <p className="t-sm muted">Only leads of this space can archive it.</p>
          )}
        </FormSection>
      </div>
      <SaveBar isDirty={dirty} isSaving={busy} saveLabel="Save changes" onSave={() => void save()} onDiscard={() => setF(initial)} />
    </>
  );
}

const slaWords = (d: number | null) => (d === null ? "" : d <= 1 ? "Next working day" : `${d} working days`);

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
      toast(`Deleted “${t.displayName}”`, {
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
      New request type
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
                description={[slaWords(slaDays(t)), plural(t.fields?.length ?? 0, "field"), t.rules?.length ? plural(t.rules.length, "rule check") : ""].filter(Boolean).join(" · ")}
                actions={
                  canEdit || canDelete ? (
                    <span className="reveal-on-hover">
                      <Menu
                        label={`Options for ${t.displayName}`}
                        nodes={[
                          ...(canEdit ? [{ id: "edit", label: "Edit", icon: Pencil, run: () => setEditing({ type: t }) }] : []),
                          ...(canEdit && canDelete ? [{ sep: "1" }] : []),
                          ...(canDelete ? [{ id: "delete", label: "Delete", icon: Trash2, danger: true, run: () => void remove(t) }] : []),
                        ]}
                      >
                        <Button isIconOnly size="sm" variant="ghost" aria-label={`Options for ${t.displayName}`} className="button--muted">
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
          <p className="t-sm muted">
            <span translate="no">{view.space.displayName}</span> doesn’t take requests yet. Add a type and it shows up in Requests → New request.
          </p>
          {add ? <div>{add}</div> : null}
        </div>
      )}
      {editing ? <RequestTypeDialog view={view} type={editing.type} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

const SLA_OPTS = [
  { value: "1", label: "Next day" },
  { value: "2", label: "2 days" },
  { value: "3", label: "3 days" },
  { value: "5", label: "5 days" },
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
  const err = tried && !name.trim() ? "Name what people can ask for." : "";
  const kept = type ? [plural(type.fields?.length ?? 0, "field"), type.rules?.length ? plural(type.rules.length, "rule check") : ""].filter(Boolean).join(" · ") : "";

  async function save() {
    setTried(true);
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    const data = { displayName: n, description: desc.trim(), slaDuration: `${Number(sla) * 86_400}s` };
    try {
      if (type?.name) {
        await updateRequestType(type.name, { ...data, etag: type.etag }, ["displayName", "description", "slaDuration"]);
        toast("Request type updated");
      } else {
        const made = await createRequestType(ws, view.sid, { ...data, fields: [{ key: "details", displayName: "Details", type: "TEXT", required: true }] });
        toast(`People can now request “${n}”`, {
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
      title={type ? "Edit request type" : "New request type"}
      description="It shows up in Requests → New request, and requests land in this space’s queue."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {type ? <Check aria-hidden /> : <Plus aria-hidden />}
            {type ? "Save changes" : "Add request type"}
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <TextField value={name} onChange={setName} isRequired isInvalid={!!err} maxLength={60} autoFocus>
          <Label>Name</Label>
          <Input placeholder="e.g. New laptop" />
          <FieldError>{err}</FieldError>
        </TextField>
        <TextField value={desc} onChange={setDesc} maxLength={160}>
          <Label>
            What it’s for <span className="label__opt">(optional)</span>
          </Label>
          <TextArea rows={2} placeholder="One line people read before they choose it." />
        </TextField>
        <div className="field">
          <span className="label">Usual turnaround</span>
          <Segmented label="Usual turnaround" value={sla} onChange={setSla} options={SLA_OPTS} />
          <div className="description">Working days. Staff see it as the SLA in their queue.</div>
        </div>
        <p className="t-sm muted">
          {type
            ? `${kept} stay as they are.`
            : "People describe what they need in one Details field. The assistant checks your space’s policies before they send."}
        </p>
      </div>
    </KnowledgeModal>
  );
}
