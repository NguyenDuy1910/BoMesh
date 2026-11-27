/**
 * Workspace settings (preview `features/settings.js`, `core/workspace.js`): name
 * validation, the workspace setup — template defaults, modules, space types and
 * AI workflows — and the Home map background, mapped onto `Workspace` and
 * `WorkspaceSettings`. Pure; covered by `tests/workspace-settings.test.mts`.
 */

import type { Schema } from "@/lib/api/client";

type Settings = Schema<"WorkspaceSettings">;
export type SpaceTypeEntry = NonNullable<Settings["spaceTypes"]>[number];
export type WorkflowKey = NonNullable<NonNullable<Settings["workflows"]>[number]["key"]>;
export type ModuleKey = "spaces" | "work" | "requests";
export type TemplateKey = "ENTERPRISE" | "CAMPUS";

export const MAX_NAME = 60;

/**
 * What General edits: only the name. The web address (`Workspace.code`) is chosen when the workspace is created and
 * never changes, so it is not part of the draft and UpdateWorkspace never carries it.
 */
export interface IdentityDraft {
  name: string;
}

export type IdentityErrors = Partial<Record<keyof IdentityDraft, string>>;

/** Field errors for General (preview `errors`). */
export function identityErrors(draft: IdentityDraft): IdentityErrors {
  const errors: IdentityErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "Nhập tên không gian làm việc.";
  else if (name.length > MAX_NAME) errors.name = `Tên tối đa ${MAX_NAME} ký tự.`;
  return errors;
}

export const identityDirty = (draft: IdentityDraft, current: IdentityDraft) => draft.name.trim() !== current.name;

/** `UpdateWorkspace` body fields and mask for the changed identity fields. */
export function identityPatch(draft: IdentityDraft, current: IdentityDraft): { displayName?: string; updateMask: string } {
  const patch: { displayName?: string } = {};
  if (draft.name.trim() !== current.name) patch.displayName = draft.name.trim();
  return { ...patch, updateMask: Object.keys(patch).join(",") };
}

/* ── Workspace setup ── */

export const MODULES: readonly { key: ModuleKey; label: string; desc: string }[] = [
  { key: "spaces", label: "Cộng đồng", desc: "Tổ chức mọi người, tài liệu và công việc theo nhóm, dự án, văn phòng hoặc khóa học." },
  { key: "work", label: "Công việc", desc: "Quy trình AI tạo bản tổng hợp, bản nháp, tài liệu ôn tập và bài kiểm tra." },
  { key: "requests", label: "Yêu cầu", desc: "Mọi người gửi yêu cầu đến nhóm dịch vụ và văn phòng; nhân viên xử lý theo hàng đợi." },
];

/** Known space type keys in preview order (`SPACE_TYPES`); custom keys follow. */
export const SPACE_TYPE_KEYS = ["course", "research", "office", "team", "project"] as const;
/** Workflow keys in preview order (learning first, then research). */
export const WORKFLOW_KEYS: readonly WorkflowKey[] = ["STUDY_GUIDE", "QUIZ", "EVIDENCE_REVIEW", "DRAFT"];

export interface Setup {
  modules: Record<ModuleKey, boolean>;
  /** Enabled space type keys. */
  spaceTypes: string[];
  /** Enabled workflow keys. */
  workflows: WorkflowKey[];
}

export interface Template extends Setup {
  label: string;
  desc: string;
}

/** Preview `TEMPLATES`: what a workspace starts with. The API stores the template, not its defaults. */
export const TEMPLATES: Readonly<Record<TemplateKey, Template>> = {
  ENTERPRISE: {
    label: "Doanh nghiệp",
    desc: "Tài liệu doanh nghiệp với nguồn dữ liệu và quyền truy cập được quản lý.",
    modules: { spaces: false, work: false, requests: false },
    spaceTypes: ["team", "project"],
    workflows: ["EVIDENCE_REVIEW", "DRAFT"],
  },
  CAMPUS: {
    label: "Trường học",
    desc: "Khóa học, nhóm nghiên cứu và văn phòng: học tập, nghiên cứu và dịch vụ sinh viên trong một không gian làm việc.",
    modules: { spaces: true, work: true, requests: true },
    spaceTypes: ["course", "research", "office"],
    workflows: ["STUDY_GUIDE", "QUIZ", "EVIDENCE_REVIEW", "DRAFT"],
  },
};

export const templateKey = (template: string | undefined): TemplateKey => (template === "CAMPUS" ? "CAMPUS" : "ENTERPRISE");

/** The effective setup the API reports (absent modules are on; an empty workflow list offers all of them). */
export function setupOf(settings: Settings | null | undefined): Setup {
  const m = settings?.modules ?? {};
  const flows = settings?.workflows ?? [];
  return {
    modules: { spaces: m.spaces !== false, work: m.work !== false, requests: m.requests !== false },
    spaceTypes: (settings?.spaceTypes ?? []).filter((t) => t.key && t.enabled !== false).map((t) => t.key!),
    workflows: flows.length ? WORKFLOW_KEYS.filter((k) => flows.some((w) => w.key === k && w.enabled !== false)) : [...WORKFLOW_KEYS],
  };
}

/** Items in one list but not the other. */
const diff = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x)).length + b.filter((x) => !a.includes(x)).length;

/** Whether a module differs from the template default. */
export const moduleChanged = (setup: Setup, template: Template, key: ModuleKey) => setup.modules[key] !== template.modules[key];

/** How many settings differ from the template defaults (preview `setupChanges`; 0 hides "Reset to … defaults"). */
export function setupChanges(setup: Setup, template: Template): number {
  return (
    MODULES.filter((m) => moduleChanged(setup, template, m.key)).length +
    (setup.modules.spaces ? diff(setup.spaceTypes, template.spaceTypes) : 0) +
    (setup.modules.work ? diff(setup.workflows, template.workflows) : 0)
  );
}

/** Space type keys to list: the known ones in preview order, then the workspace's custom keys. */
export function spaceTypeKeys(settings: Settings | null | undefined): string[] {
  const custom = (settings?.spaceTypes ?? []).map((t) => t.key ?? "").filter((k) => k && !(SPACE_TYPE_KEYS as readonly string[]).includes(k));
  return [...SPACE_TYPE_KEYS, ...custom];
}

/** The `spaceTypes` list with `enabled` set from `keys`; known types missing from the list are added. */
export function spaceTypesWith(
  settings: Settings | null | undefined,
  enabled: readonly string[],
  label: (key: string) => { displayName: string; icon: string },
): SpaceTypeEntry[] {
  const list = settings?.spaceTypes ?? [];
  return spaceTypeKeys(settings)
    .filter((key) => list.some((t) => t.key === key) || enabled.includes(key))
    .map((key) => {
      const entry = list.find((t) => t.key === key);
      return { key, displayName: entry?.displayName || label(key).displayName, icon: entry?.icon || label(key).icon, enabled: enabled.includes(key) };
    });
}

export const workflowsWith = (enabled: readonly WorkflowKey[]) => WORKFLOW_KEYS.map((key) => ({ key, enabled: enabled.includes(key) }));

/** Toggles `id` in an enabled list; `null` when the list would become empty (preview keeps at least one). */
export function toggled<T extends string>(current: readonly T[], id: T): T[] | null {
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  return next.length ? next : null;
}

/** The settings body restoring exactly the setup fields of `snapshot` (Undo, Reset). */
export function setupBody(snapshot: Pick<Settings, "modules" | "spaceTypes" | "workflows">): {
  body: Pick<Settings, "modules" | "spaceTypes" | "workflows">;
  updateMask: string;
} {
  return {
    body: { modules: snapshot.modules ?? {}, spaceTypes: snapshot.spaceTypes ?? [], workflows: snapshot.workflows ?? [] },
    updateMask: "modules,spaceTypes,workflows",
  };
}

/** The settings body that resets modules, space types and workflows to the template defaults. */
export function resetBody(settings: Settings | null | undefined, template: Template, label: (key: string) => { displayName: string; icon: string }) {
  return setupBody({
    modules: { ...template.modules },
    spaceTypes: spaceTypesWith(settings, template.spaceTypes, label),
    workflows: workflowsWith(template.workflows),
  });
}

/* ── Map background (preview `features/home.js` `home-bg`, docs/HOME.md "Map background") ── */

export type MapBackground = Schema<"MapBackground">;

/** What the dialog accepts, and what it uploads: photos scaled to at most 1920 px wide as JPEG (SVG rasterized). */
export const MAP_BG = {
  types: ["image/jpeg", "image/png", "image/webp", "image/svg+xml"],
  maxBytes: 10 * 1024 * 1024,
  width: 1920,
  small: 1200,
  quality: 0.75,
  strength: 25,
} as const;

/** A strength from 0 to 100 (the API default, 25, for anything else). */
export const strengthOf = (v: unknown): number => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : MAP_BG.strength;
};

/** Why a picked file can't be used, in the preview's words; null when it can. */
export function mapBgFileError(file: { type: string; size: number }): string | null {
  if (!(MAP_BG.types as readonly string[]).includes(file.type)) return "Hãy dùng ảnh JPG, PNG, WebP hoặc SVG.";
  if (file.size > MAP_BG.maxBytes) return "Ảnh lớn hơn 10 MB. Hãy chọn ảnh nhỏ hơn.";
  return null;
}

/** Pixel size of the uploaded JPEG: photos shrink to 1920 px wide (never grow); SVG is drawn at 1920 px wide. */
export function mapBgSize(width: number, height: number, vector: boolean): { w: number; h: number } {
  const s = vector ? MAP_BG.width / width : Math.min(1, MAP_BG.width / width);
  return { w: Math.round(width * s), h: Math.round(height * s) };
}

/** The calls a Save makes: drop the image, upload the new one, then set the strength (null = unchanged). */
export interface MapBgPlan {
  remove: boolean;
  upload: boolean;
  strength: number | null;
}

/**
 * `draft`: null when the dialog has no image, `{ isNew }` for the saved image or a newly picked one.
 * An upload keeps the saved strength (25 for a first image), so the strength follows it only when it differs.
 * Null when nothing changed.
 */
export function mapBgPlan(saved: MapBackground | undefined, draft: { isNew: boolean } | null, strength: number): MapBgPlan | null {
  const current = saved ? strengthOf(saved.strength) : null;
  if (!draft) return saved ? { remove: true, upload: false, strength: null } : null;
  if (draft.isNew) return { remove: false, upload: true, strength: strength !== (current ?? MAP_BG.strength) ? strength : null };
  return strength !== current ? { remove: false, upload: false, strength } : null;
}

export const mapBgToast = (before: MapBackground | undefined, after: MapBackground | undefined) =>
  after ? (before ? "Đã cập nhật ảnh nền bản đồ" : "Đã thêm ảnh nền bản đồ") : "Đã gỡ ảnh nền bản đồ";

/* ── Logo (preview `features/settings.js` `logoHtml`): WorkspaceSettings.branding.logo, shown by WorkspaceMark ── */

/** What UploadWorkspaceLogo accepts: PNG, JPEG or WebP up to 1 MB (SVG is refused: it can carry script). */
export const LOGO = { types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 1024 * 1024 } as const;

/** Why a picked file can't be the logo, in the preview's words; null when it can. */
export function logoFileError(file: { type: string; size: number }): string | null {
  if (!(LOGO.types as readonly string[]).includes(file.type)) return "Hãy dùng ảnh PNG, JPEG hoặc WebP.";
  if (file.size > LOGO.maxBytes) return "Logo phải có dung lượng tối đa 1 MB. Hãy chọn ảnh nhỏ hơn.";
  return null;
}

export const logoToast = (before: boolean, after: boolean) => (after ? (before ? "Đã cập nhật logo" : "Đã thêm logo") : "Đã xóa logo");

/* ── Who can join (preview `joinHtml`) and leaving (preview `canLeave`) ── */

export type Visibility = NonNullable<Schema<"Workspace">["visibility"]>;

/** The join link of a public workspace: its own page `/w/{code}`. */
export const joinLink = (origin: string, code: string) => `${origin}/w/${code}`;

/** Collection names listed in the Make public confirm: all of them up to six, else none (the count says it). */
export const MAX_LISTED_COLLECTIONS = 6;

/**
 * Can the caller leave this workspace by themselves? Any member, except the last active workspace admin.
 * `activeAdmins` is the number of active workspace admins, read only for an admin (`undefined` while unknown).
 * Null means unknown: the account menu hides Leave until it knows.
 */
export function canLeaveWorkspace(roles: readonly string[] | undefined, activeAdmins: number | undefined): boolean | null {
  if (!roles) return null;
  if (!roles.includes("roles/workspaceAdmin")) return true;
  return activeAdmins === undefined ? null : activeAdmins > 1;
}
