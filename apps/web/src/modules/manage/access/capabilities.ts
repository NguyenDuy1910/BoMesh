/**
 * What a role lets someone do, in the words of the person setting it up.
 *
 * The API speaks permission codes (`collection.update`); people read
 * sentences ("Add and edit documents in any knowledge base"). This module is
 * the one place that maps one onto the other, groups the abilities by area,
 * and knows which ability only makes sense together with another. Codes never
 * reach the screen; a code the catalogue does not know yet falls back to the
 * server's own description under "Other".
 */

export interface Capability {
  code: string;
  /** The sentence shown beside its switch: what the person can do. */
  label: string;
  /** Lower-case phrase for one-line role summaries. */
  short: string;
  /** Abilities this one is useless without; turning it on turns them on too. */
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
    id: "workspace",
    title: "Workspace",
    capabilities: [
      { code: "tenant.read", label: "View the workspace overview", short: "see the overview" },
      {
        code: "tenant.manage",
        label: "Change workspace settings and assistant setup",
        short: "change settings",
        requires: ["tenant.read"],
      },
    ],
  },
  {
    id: "people",
    title: "People & access",
    capabilities: [
      { code: "user.manage", label: "Add and suspend members and change their role", short: "manage members" },
      { code: "group.manage", label: "Create and manage groups", short: "manage groups" },
      { code: "role.manage", label: "Create and edit roles", short: "edit roles" },
      { code: "access.manage", label: "Approve or deny access requests", short: "approve access requests" },
    ],
  },
  {
    id: "knowledge",
    title: "Knowledge",
    note: "Applies to every knowledge base. To give access to one knowledge base only, share it from that knowledge base instead.",
    capabilities: [
      { code: "knowledge.read", label: "Ask questions and browse knowledge", short: "ask questions" },
      {
        code: "collection.read",
        label: "Open every knowledge base, not only the ones shared with them",
        short: "open every knowledge base",
        requires: ["knowledge.read"],
      },
      {
        code: "collection.update",
        label: "Add and edit documents in any knowledge base",
        short: "edit documents",
        requires: ["collection.read"],
      },
      {
        code: "knowledge.manage",
        label: "Create and organize knowledge bases",
        short: "create knowledge bases",
        requires: ["collection.read"],
      },
      {
        code: "collection.share",
        label: "Share knowledge bases with people and groups",
        short: "share knowledge bases",
        requires: ["collection.read"],
      },
      {
        code: "collection.delete",
        label: "Delete knowledge bases",
        short: "delete knowledge bases",
        requires: ["collection.read"],
      },
    ],
  },
  {
    id: "sources",
    title: "Sources",
    capabilities: [
      { code: "source.manage", label: "Connect and manage sources and schedules", short: "manage sources" },
      { code: "ingestion.read", label: "View sync history", short: "see sync history" },
      {
        code: "ingestion.run",
        label: "Start syncs and reprocess documents",
        short: "start syncs",
        requires: ["collection.read"],
      },
      {
        code: "ingestion.manage",
        label: "Cancel any running sync",
        short: "cancel syncs",
        requires: ["ingestion.read"],
      },
    ],
  },
  {
    id: "activity",
    title: "Activity",
    capabilities: [{ code: "audit.read", label: "View the activity log and sign-ins", short: "see activity" }],
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
 * Every ability these codes grant, as the sentences people read, in catalogue
 * order. A code the catalogue lacks reads as the server's description.
 */
export function abilitySentences(codes: readonly string[], describe: (code: string) => string | undefined = () => undefined): string[] {
  const held = new Set(codes);
  const known = ALL_CAPABILITIES.filter((capability) => held.has(capability.code)).map((capability) => capability.label);
  const unknown = codes.filter((code) => !(code in BY_CODE)).map((code) => describe(code) ?? "An additional ability");
  return [...known, ...unknown];
}

/**
 * Turn one ability on or off. Turning on also turns on what it requires;
 * turning off also turns off whatever required it, so a role is never half-useful.
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

/** The areas to show for these codes: known abilities in catalogue order, then any the catalogue lacks under "Other". */
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
    label: describe(code) ?? "An additional ability",
    short: (describe(code) ?? "an additional ability").toLowerCase(),
  }));
  if (unknown.length) {
    areas.push({ area: { id: "other", title: "Other", capabilities: unknown }, capabilities: unknown });
  }
  return areas.filter((entry) => entry.capabilities.length);
}
