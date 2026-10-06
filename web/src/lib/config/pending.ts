/**
 * Typed configuration for the "UI first, API pending" layer.
 *
 * Parsed once from public build-time variables. Next inlines `NEXT_PUBLIC_*`
 * values only when they are referenced literally, so both variables are read
 * by name here and declared in `web/next.config.ts`. No component reads
 * `process.env` for pending features; they use `lib/api/pending.ts`.
 *
 * - `NEXT_PUBLIC_BOMESH_PENDING_FEATURES`: `all` | `none` | comma list of
 *   pending feature keys. Unset or empty means `all` so development and
 *   preview builds show every pending surface; production deployments set it
 *   explicitly (usually `none`, or the keys a release has agreed to preview).
 * - `NEXT_PUBLIC_BOMESH_PENDING_MARKER`: `on` | `off` (default `on`) controls
 *   the neutral "Preview" marker on pending surfaces.
 */
export interface PendingConfig {
  features: "all" | "none" | ReadonlySet<string>;
  marker: boolean;
}

export function parsePendingFeatures(value: string | undefined): PendingConfig["features"] {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "" || normalized === "all") return "all";
  if (normalized === "none" || normalized === "off") return "none";
  const keys = normalized.split(",").map((key) => key.trim()).filter(Boolean);
  return keys.length ? new Set(keys) : "none";
}

export function parsePendingMarker(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized !== "off" && normalized !== "false" && normalized !== "0";
}

export const pendingConfig: PendingConfig = {
  features: parsePendingFeatures(process.env.NEXT_PUBLIC_BOMESH_PENDING_FEATURES),
  marker: parsePendingMarker(process.env.NEXT_PUBLIC_BOMESH_PENDING_MARKER),
};

/** Whether pending surfaces show the "Preview" marker. */
export function isPendingMarkerEnabled(): boolean {
  return pendingConfig.marker;
}
