/**
 * What a role lets someone do, in the words of the person setting it up.
 *
 * The API speaks permission codes (`collection.update`); people choose
 * abilities ("Add and edit documents"). This module is the one place that
 * maps one onto the other, groups the abilities by area, and knows which
 * ability only makes sense together with another. Codes never reach the
 * screen; a code the catalogue does not know yet falls back to the
 * server's own description under "Other".
 */

export interface Capability {
  code: string;
  /** Checkbox label: what the person can do. */
  label: string;
  /** Lower-case phrase for one-line role summaries. */
  short: string;
  /** One sentence on what it means in practice. */
  hint: string;
  /** Abilities this one is useless without; ticking it ticks them too. */
  requires?: readonly string[];
}

export interface CapabilityArea {
  id: string;
  title: string;
  /** Shown under the area title when the area needs context. */
  note?: string;
  capabilities: readonly Capability[];
}

export const CAPABILITY_AREAS: readonly CapabilityArea[] = [
  {
    id: "knowledge",
    title: "Knowledge",
    note: "Applies to every collection in the workspace. To give access to one collection only, share that collection instead.",
    capabilities: [
      {
        code: "knowledge.read",
        label: "Ask questions and search",
        short: "search knowledge",
        hint: "Use chat and search over the collections they can open.",
      },
      {
        code: "collection.read",
        label: "Open every collection",
        short: "open every collection",
        hint: "See all collections, not only the ones shared with them.",
        requires: ["knowledge.read"],
      },
      {
        code: "collection.update",
        label: "Add and edit documents",
        short: "edit documents",
        hint: "Upload, change and remove documents in any collection.",
        requires: ["collection.read"],
      },
      {
        code: "knowledge.manage",
        label: "Create collections",
        short: "create collections",
        hint: "Create new collections and organize the workspace's knowledge.",
        requires: ["collection.read"],
      },
      {
        code: "collection.share",
        label: "Share collections",
        short: "share collections",
        hint: "Decide who else can open or edit a collection.",
        requires: ["collection.read"],
      },
      {
        code: "collection.delete",
        label: "Delete collections",
        short: "delete collections",
        hint: "Remove whole collections and everything in them.",
        requires: ["collection.read"],
      },
    ],
  },
  {
    id: "ingestion",
    title: "Ingestion",
    capabilities: [
      {
        code: "ingestion.run",
        label: "Process documents",
        short: "process documents",
        hint: "Start processing so documents become searchable, in any collection they can open.",
        requires: ["collection.read"],
      },
      {
        code: "ingestion.read",
        label: "See all processing runs",
        short: "see all runs",
        hint: "Follow every run in the workspace, not only the ones they started.",
      },
      {
        code: "ingestion.manage",
        label: "Stop any processing run",
        short: "stop runs",
        hint: "Cancel runs started by anyone.",
        requires: ["ingestion.read"],
      },
      {
        code: "source.manage",
        label: "Connect data sources",
        short: "connect data sources",
        hint: "Connect Google Drive, Confluence and other sources, sync them and set their schedules.",
      },
    ],
  },
  {
    id: "people",
    title: "People and access",
    capabilities: [
      {
        code: "user.manage",
        label: "Manage members",
        short: "manage members",
        hint: "Add people to the workspace, change their role or suspend them.",
      },
      {
        code: "group.manage",
        label: "Manage groups",
        short: "manage groups",
        hint: "Create groups and choose who is in them.",
      },
      {
        code: "role.manage",
        label: "Manage roles",
        short: "manage roles",
        hint: "Create roles like this one and change what they allow.",
      },
      {
        code: "access.manage",
        label: "Approve access requests",
        short: "approve access requests",
        hint: "Answer people who ask to open or edit a collection.",
      },
    ],
  },
  {
    id: "workspace",
    title: "Workspace",
    capabilities: [
      {
        code: "tenant.read",
        label: "See the workspace overview",
        short: "see the overview",
        hint: "Open the workspace dashboard and its numbers.",
      },
      {
        code: "tenant.manage",
        label: "Change workspace settings",
        short: "change settings",
        hint: "Rename the workspace and set up its assistant.",
        requires: ["tenant.read"],
      },
      {
        code: "audit.read",
        label: "See the activity log",
        short: "see the activity log",
        hint: "Review who changed what in this workspace.",
      },
    ],
  },
];

const ALL_CAPABILITIES = CAPABILITY_AREAS.flatMap((area) => area.capabilities);
const BY_CODE: Record<string, Capability> = Object.fromEntries(
  ALL_CAPABILITIES.map((capability) => [capability.code, capability]),
);

/** The abilities someone needs to run the whole workspace. */
const FULL_CONTROL = ["user.manage", "role.manage", "tenant.manage"];

/** One line on what a role allows, read from its permissions rather than its name. */
export function describeAccess(codes: readonly string[]): string {
  const held = new Set(codes);
  if (FULL_CONTROL.every((code) => held.has(code))) return "Full control of this workspace";
  const phrases = ALL_CAPABILITIES
    .filter((capability) => held.has(capability.code))
    .map((capability) => capability.short);
  if (!phrases.length) return "No abilities yet";
  const shown = phrases.slice(0, 3);
  const rest = phrases.length - shown.length;
  const list = rest > 0
    ? `${shown.join(", ")} and ${rest} more`
    : shown.length > 1
      ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
      : shown[0];
  return `Can ${list}`;
}

/**
 * Tick or untick one ability. Ticking also ticks what it requires; unticking
 * also unticks whatever required it, so a role is never half-useful.
 */
export function toggleAbility(selected: readonly string[], code: string, on: boolean): string[] {
  const next = new Set(selected);
  if (on) {
    const pending = [code];
    while (pending.length) {
      const current = pending.pop() as string;
      if (next.has(current) && current !== code) continue;
      next.add(current);
      pending.push(...(BY_CODE[current]?.requires ?? []));
    }
  } else {
    const pending = [code];
    while (pending.length) {
      const current = pending.pop() as string;
      next.delete(current);
      for (const capability of ALL_CAPABILITIES) {
        if (next.has(capability.code) && capability.requires?.includes(current)) pending.push(capability.code);
      }
    }
  }
  return [...next];
}

/** An area as it should appear for these codes: known abilities first, then any the catalogue lacks. */
export function areasFor(
  codes: readonly string[],
  describe: (code: string) => string | undefined,
): { area: CapabilityArea; capabilities: Capability[] }[] {
  const wanted = new Set(codes);
  const areas = CAPABILITY_AREAS.map((area) => ({
    area,
    capabilities: area.capabilities.filter((capability) => wanted.has(capability.code)),
  }));
  const unknown = codes.filter((code) => !(code in BY_CODE)).map((code) => ({
    code,
    label: describe(code) ?? "Additional ability",
    short: (describe(code) ?? "additional ability").toLowerCase(),
    hint: "",
  }));
  if (unknown.length) {
    areas.push({ area: { id: "other", title: "Other", capabilities: unknown }, capabilities: unknown });
  }
  return areas.filter((entry) => entry.capabilities.length);
}
