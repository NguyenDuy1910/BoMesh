"use client";

import { Button, Label, Slider, Spinner } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertCircle, AlertTriangle, Building2, ImageIcon, Pencil, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";

import { toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { patchWorkspaceContext, useWorkspace } from "@/lib/workspace";
import { Dialog } from "@/modules/people/components/Dialog";
import { updateMapBackground, uploadMapBackground, type WorkspaceSettings } from "@/modules/workspace-settings/api";
import { MAP_BG, mapBgFileError, mapBgPlan, mapBgSize, mapBgToast, strengthOf, type MapBackground } from "@/modules/workspace-settings/model";

import { useMember } from "../queries";
import { useAtlasTree } from "./queries";

/**
 * The workspace's map background (preview `features/atlas.js` `map-bg`, docs/KNOWLEDGE_MAP.md "Map background"): the image
 * under its wash (the map's canvas, the dialog's preview, the Settings thumbnail), the one dialog that changes it (opened
 * from the Knowledge map's header and from Settings → Workspace setup) and the Settings row.
 */

/** The image under its wash. `--s` (0–1) drives the wash, blur and saturation in CSS, so the slider never re-lays out. */
export function MapBackdrop({ src, strength }: { src: string; strength?: number }) {
  const style = { backgroundImage: `url("${src.replace(/"/g, "%22")}")`, "--s": strengthOf(strength) / 100 } as CSSProperties;
  return <div className="atlas__backdrop" style={style} aria-hidden />;
}

/** The dialog's image: the saved one, or a newly picked one (`blob`, the JPEG to upload). */
interface Draft {
  src: string;
  name: string;
  w: number;
  h: number;
  blob?: Blob;
}

const fromSaved = (bg: MapBackground | undefined): Draft | null =>
  bg?.imageUri ? { src: bg.imageUri, name: bg.fileName ?? "", w: bg.widthPixels ?? 0, h: bg.heightPixels ?? 0 } : null;

/** Reads an image and draws it as a JPEG at most 1920 px wide (SVG rasterized at 1920 px), as the preview stores it. */
async function toBackground(file: File): Promise<Draft> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const { w, h } = mapBgSize(img.naturalWidth || 1600, img.naturalHeight || 900, file.type === "image/svg+xml");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("No canvas");
    // JPEG has no transparency: transparent PNG/SVG areas become white rather than black.
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encode failed"))), "image/jpeg", MAP_BG.quality));
    return { blob, src: URL.createObjectURL(blob), name: file.name, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Keeps the image a Save replaces or removes (it is deleted on the server), so Undo can upload it again. */
async function keepImage(uri: string | undefined): Promise<Blob | null> {
  if (!uri) return null;
  try {
    const response = await fetch(uri);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

export function MapBackgroundDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  // Mounted per opening, so the draft always starts from what's saved.
  return isOpen ? <MapBackgroundForm onClose={onClose} /> : null;
}

function MapBackgroundForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const ws = useWorkspace();
  const saved = ws.settings?.branding?.mapBackground;
  const tree = useAtlasTree();
  const [draft, setDraft] = useState<Draft | null>(() => fromSaved(saved));
  const [strength, setStrength] = useState(() => strengthOf(saved?.strength));
  const [err, setErr] = useState("");
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const name = ws.workspace.displayName ?? "";

  // A picked image lives in an object URL until it's replaced or the dialog closes.
  useEffect(() => {
    const src = draft?.blob ? draft.src : null;
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [draft]);

  async function pick(file: File | undefined) {
    if (!file) return;
    const problem = mapBgFileError(file);
    if (problem) return setErr(problem);
    setErr("");
    setReading(true);
    try {
      setDraft(await toBackground(file));
    } catch {
      setErr("That image couldn’t be read. Try another file.");
    } finally {
      setReading(false);
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void pick(e.dataTransfer.files?.[0]);
  };

  /** Saved for everyone in the workspace, with Undo. */
  async function save() {
    const plan = mapBgPlan(saved, draft && { isNew: !!draft.blob }, strength);
    if (!plan) return onClose();
    setSaving(true);
    let next: WorkspaceSettings | null = null;
    try {
      const kept = saved && (plan.upload || plan.remove) ? await keepImage(saved.imageUri) : null;
      if (plan.remove) next = await updateMapBackground(ws.id, null);
      if (plan.upload && draft?.blob) next = await uploadMapBackground(ws.id, draft.blob, draft.name);
      if (plan.strength !== null) next = await updateMapBackground(ws.id, plan.strength);
      if (next) patchWorkspaceContext(qc, { settings: next });
      onClose();
      const undo = async () => {
        if (!saved) return patchWorkspaceContext(qc, { settings: await updateMapBackground(ws.id, null) });
        const before = strengthOf(saved.strength);
        let restored = kept ? await uploadMapBackground(ws.id, kept, saved.fileName ?? "background") : null;
        // An upload keeps the current strength (25 after a removal); put the old one back when it differs.
        if (!restored || strengthOf(restored.branding?.mapBackground?.strength) !== before) restored = await updateMapBackground(ws.id, before);
        patchWorkspaceContext(qc, { settings: restored });
      };
      // Undo needs the old image back when it was replaced or removed.
      const canUndo = !saved || !(plan.upload || plan.remove) || !!kept;
      toast(mapBgToast(saved, next?.branding?.mapBackground), {
        undo: canUndo ? () => void undo().catch((error: unknown) => toast(errorMessage(error), { tone: "danger" })) : undefined,
      });
    } catch (error) {
      // A step that already landed (the upload before a failed strength change) still shows everywhere.
      if (next) patchWorkspaceContext(qc, { settings: next });
      setErr(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const small = draft && draft.w > 0 && draft.w < MAP_BG.small;
  return (
    <Dialog
      isOpen
      onClose={onClose}
      size="md"
      icon={ImageIcon}
      title="Map background"
      description={`Shown behind the knowledge map for everyone in ${name}. It's softened so the map stays readable.`}
      guard={saving}
      footerStart={
        draft ? (
          <Button variant="ghost" size="sm" isDisabled={saving} onPress={() => (setDraft(null), setErr(""))}>
            <Trash2 className="i" aria-hidden />
            Remove
          </Button>
        ) : null
      }
      footer={
        <>
          <Button variant="ghost" isDisabled={saving} onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isPending={saving} isDisabled={reading} onPress={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="mapbg">
        <input ref={picker} type="file" accept={MAP_BG.types.join(",")} hidden onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ""))} />
        <div
          className={clsx("mapbg-preview", draft && "has-img", over && "is-over")}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          {draft ? <MapBackdrop src={draft.src} strength={strength} /> : null}
          <div className="mapbg-preview__grid" />
          {draft ? (
            // The workspace and its first collections over the image, so the admin sees what people will read.
            <div className="mapbg-preview__map" aria-hidden>
              <span className="mapbg-node mapbg-node--ws">
                <Building2 className="i-sm" />
                <span className="truncate" translate="no">
                  {name}
                </span>
              </span>
              {tree.roots.slice(0, 3).map((c) => (
                <span key={c.name} className="mapbg-node" style={{ "--tone": c.tone } as CSSProperties}>
                  <span className="mapbg-node__dot" />
                  <span className="truncate" translate="no">
                    {c.displayName}
                  </span>
                </span>
              ))}
            </div>
          ) : (
            <div className="mapbg-preview__empty">
              <ImageIcon className="i" aria-hidden />
              <span>Drop an image here</span>
              <Button size="sm" variant="tertiary" onPress={() => picker.current?.click()}>
                <Upload className="i" aria-hidden />
                Choose image
              </Button>
            </div>
          )}
          {reading ? (
            <div className="mapbg-preview__busy">
              <Spinner size="sm" />
            </div>
          ) : null}
        </div>
        {err ? (
          <div className="field-error" role="alert">
            <AlertCircle className="i" aria-hidden />
            <span>{err}</span>
          </div>
        ) : null}
        {draft ? (
          <div className="mapbg-file">
            <ImageIcon className="i-sm" aria-hidden />
            <span className="truncate" translate="no">
              {draft.name || "Background image"}
            </span>
            {draft.w ? <span className="muted num none">{`${draft.w} × ${draft.h}`}</span> : null}
            <span className="grow" />
            <Button variant="ghost" size="sm" isDisabled={reading || saving} onPress={() => picker.current?.click()}>
              <Upload className="i" aria-hidden />
              Replace
            </Button>
          </div>
        ) : null}
        {small ? (
          <p className="mapbg-warn">
            <AlertTriangle className="i-sm" aria-hidden />
            <span>{`This image is ${draft.w} px wide, so it may look soft on large screens.`}</span>
          </p>
        ) : null}
        {draft ? (
          <Slider minValue={0} maxValue={100} step={5} value={strength} onChange={(v) => setStrength(strengthOf(v))} isDisabled={saving}>
            <div className="row">
              <Label className="grow">Strength</Label>
              <Slider.Output className="num t-sm muted">{`${strength}%`}</Slider.Output>
            </div>
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
            <div className="slider__ends" aria-hidden>
              <span>Subtle</span>
              <span>Vivid</span>
            </div>
          </Slider>
        ) : (
          <p className="description">A wide photo or illustration, at least 1600 px wide. JPG, PNG, WebP or SVG, up to 10 MB.</p>
        )}
      </div>
    </Dialog>
  );
}

/** Settings → Workspace setup → Map background (preview `mapbg-setting`): what's set, who changed it and when. */
export function MapBackgroundSetting() {
  const { settings } = useWorkspace();
  const bg = settings?.branding?.mapBackground;
  const updater = useMember(bg?.updater);
  const [open, setOpen] = useState(false);
  const by = updater.data?.displayName;
  const when = bg?.updateTime ? rel(bg.updateTime).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase()) : "";
  return (
    <div className="mapbg-setting">
      <span className="mapbg-thumb">{bg?.imageUri ? <MapBackdrop src={bg.imageUri} strength={bg.strength} /> : <ImageIcon className="i" aria-hidden />}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="medium truncate" translate={bg ? "no" : undefined}>
          {bg ? bg.fileName || "Background image" : "No background"}
        </div>
        <div className="t-xs muted">
          {bg ? (
            <>
              <span>{`Strength ${strengthOf(bg.strength)}%`}</span>
              {when ? (
                <>
                  <span> · </span>
                  <span>{by ? `updated ${when} by ${by}` : `updated ${when}`}</span>
                </>
              ) : null}
            </>
          ) : (
            "The map uses the plain canvas."
          )}
        </div>
      </div>
      <Button size="sm" variant="tertiary" onPress={() => setOpen(true)}>
        {bg ? <Pencil className="i" aria-hidden /> : <ImageIcon className="i" aria-hidden />}
        {bg ? "Change" : "Add background"}
      </Button>
      <MapBackgroundDialog isOpen={open} onClose={() => setOpen(false)} />
    </div>
  );
}
