"use client";

import { Button, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ChoiceGroup, FormSection, SaveBar, SkeletonRows, SwitchRow, confirm, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { updateItem } from "@/modules/knowledge/api";

import { deleteSpace, undeleteSpace, updateSpace } from "../api";
import { invalidateSpaces, useLinkableBases, useSpaces } from "../queries";
import { MAX_NAME, POLICY_OF, visibilityOf, type Space, type Visibility } from "../types";
import type { SpaceView } from "./context";
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

/** Settings (preview `settingsTab`, leads and admins): details, linked knowledge, who can find it, archive. */
export function SettingsTab({ view }: { view: SpaceView }) {
  const bases = useLinkableBases();
  if (!bases.data) return <SkeletonRows rows={4} />;
  const linked = bases.data.filter((b) => b.base.collection?.space === view.space.name).map((b) => b.base.name ?? "");
  return <SettingsForm key={`${view.space.etag}-${linked.join(",")}`} view={view} linked={linked} />;
}

function SettingsForm({ view, linked }: { view: SpaceView; linked: string[] }) {
  const { id: ws, workspace } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const { space, type, sid } = view;
  const spaces = useSpaces();
  const bases = useLinkableBases();
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
  const visibility: { value: Visibility; title: string; description: string }[] = [
    { value: "open", title: "Open", description: `Anyone in ${workspace.displayName ?? "the workspace"} can open it and send requests.` },
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
      await Promise.all([
        ...add.map((b) => updateItem(ws, b, { collection: { space: space.name } }, ["collection.space"])),
        ...drop.map((b) => updateItem(ws, b, { collection: { space: "" } }, ["collection.space"])),
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

  async function archive() {
    const ok = await confirm({
      title: `Archive ${space.displayName}?`,
      description: "Members lose the space page, its announcements and queue. Linked knowledge bases and saved work stay where they are.",
      confirmLabel: "Archive space",
      tone: "danger",
      typed: space.displayName,
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
        <FormSection title="Knowledge" description="Members can read and ask about linked knowledge bases. Access to each base still applies.">
          <div className="stack gap-4">
            {cands.length ? (
              cands.map(({ base, readable, editable }) => {
                const elsewhere = base.collection?.space && base.collection.space !== space.name;
                return (
                  <SwitchRow
                    key={base.name}
                    title={<span translate="no">{base.displayName}</span>}
                    label={base.displayName}
                    description={
                      !readable
                        ? "You can’t read this one"
                        : !editable
                          ? "Only its editors can link it"
                          : elsewhere
                            ? `${plural(base.collection?.documentCount ?? 0, "document")} · linked to another space`
                            : plural(base.collection?.documentCount ?? 0, "document")
                    }
                    isDisabled={!editable || busy}
                    isSelected={f.bases.includes(base.name ?? "")}
                    onChange={(on) => setF({ ...f, bases: on ? [...f.bases, base.name ?? ""] : f.bases.filter((b) => b !== base.name) })}
                  />
                );
              })
            ) : (
              <p className="t-sm muted">No knowledge bases to link yet.</p>
            )}
          </div>
        </FormSection>
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
                  <p className="card__description">Hides it for everyone. Linked knowledge bases and saved work stay where they are.</p>
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
      <SaveBar isDirty={dirty} isSaving={busy} onSave={() => void save()} onDiscard={() => setF(initial)} />
    </>
  );
}
