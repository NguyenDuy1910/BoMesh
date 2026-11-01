"use client";

import { CitationChip } from "@/components/patterns/CitationChip";

import { Grid, Group, Section, Swatch, readToken, useRootAppearance } from "./kit";

type SwatchSpec = readonly [name: string, token: string, note?: string];

const COLOR_GROUPS: readonly { title: string; swatches: readonly SwatchSpec[] }[] = [
  {
    title: "Surfaces",
    swatches: [
      ["Canvas", "--surface-canvas", "app background"],
      ["Base", "--surface-base", "sheet, cards"],
      ["Raised", "--surface-raised", "menus, dialogs"],
      ["Subtle", "--surface-subtle", "table heads"],
      ["Inset", "--surface-inset", "wells, tracks"],
      ["Hover", "--surface-hover"],
      ["Pressed", "--surface-pressed"],
      ["Selected", "--surface-selected"],
      ["Inverse", "--surface-inverse", "toasts, bulk bar"],
      ["Scrim", "--scrim"],
    ],
  },
  {
    title: "Text",
    swatches: [
      ["Primary", "--text-primary"],
      ["Secondary", "--text-secondary"],
      ["Tertiary", "--text-tertiary"],
      ["Disabled", "--text-disabled"],
      ["Accent", "--text-accent", "links, selected"],
      ["On accent", "--text-on-accent"],
      ["Inverse", "--text-inverse"],
    ],
  },
  {
    title: "Borders",
    swatches: [
      ["Subtle", "--border-subtle", "hairlines"],
      ["Default", "--border-default", "controls"],
      ["Strong", "--border-strong"],
      ["Focus", "--border-focus"],
    ],
  },
  {
    title: "Primary · themeable",
    swatches: [
      ["Primary", "--accent-primary", "actions"],
      ["Hover", "--accent-hover"],
      ["Pressed", "--accent-pressed"],
      ["Soft", "--accent-soft", "selection"],
      ["Soft hover", "--accent-soft-hover"],
      ["Focus ring", "--focus-ring"],
    ],
  },
  {
    title: "Evidence · fixed, citations only",
    swatches: [
      ["Evidence", "--evidence-bg"],
      ["Border", "--evidence-border"],
      ["Text", "--evidence-text"],
      ["Strong", "--evidence-strong", "active citation"],
      ["Line", "--evidence-line", "passage rule"],
    ],
  },
];

const STATUS_TONES = [
  ["Success", "success"],
  ["Warning", "warning"],
  ["Danger", "danger"],
  ["Info", "info"],
  ["Neutral", "neutral"],
] as const;

export function ColorSection() {
  const appearance = useRootAppearance();
  return (
    <Section
      description="Surfaces stack canvas → base → raised. One primary for actions and selection. Amber is reserved for evidence. Values below are read live from the current theme and accent."
      id="color"
      title="Color"
    >
      {COLOR_GROUPS.map((group) => (
        <Group key={group.title} title={group.title}>
          <Grid cols={4}>
            {group.swatches.map(([name, token, note]) => (
              <Swatch appearance={appearance} key={token} name={name} note={note} token={token} />
            ))}
          </Grid>
        </Group>
      ))}
      <Group title="Status · fixed, always with a text label">
        <Grid cols={5}>
          {STATUS_TONES.map(([name, tone]) => (
            <div
              className="grid gap-1 rounded-lg border px-3 py-2.5"
              key={tone}
              style={{
                background: `var(--status-${tone}-bg)`,
                borderColor: `var(--status-${tone}-border)`,
                color: `var(--status-${tone}-text)`,
              }}
            >
              <span className="font-semibold">{name}</span>
              <span className="truncate font-[family-name:var(--font-mono)] text-[0.6875rem]">
                --status-{tone}-{"{text,bg,border}"}
              </span>
              {(["text", "bg", "border"] as const).map((part) => (
                <span className="flex justify-between gap-2 font-[family-name:var(--font-mono)] text-[0.71875rem]" key={part}>
                  <span>{part}</span>
                  <span>{appearance ? readToken(`--status-${tone}-${part}`).toLowerCase() : ""}</span>
                </span>
              ))}
            </div>
          ))}
        </Grid>
      </Group>
    </Section>
  );
}

const TYPE_SCALE = [
  {
    label: "Display · 28/600",
    token: "--text-size-display",
    className: "text-display font-semibold tracking-[-0.02em]",
    sample: "What can I help you find?",
  },
  {
    label: "Page title · 24/600",
    token: "--text-size-title",
    className: "text-title font-semibold tracking-[-0.015em]",
    sample: "HR Policies",
  },
  { label: "Section · 15/600", token: "--text-size-section", className: "text-section font-semibold", sample: "Needs attention" },
  { label: "Body · 14/400", token: "--text-size-body", className: "text-body", sample: "Connect sources and keep them in sync." },
  { label: "Meta · 12.5/400", token: "--text-size-meta", className: "text-meta text-text-tertiary", sample: "Updated 2 h ago · 18 documents" },
  { label: "Caption · 12/500", token: "--text-size-caption", className: "text-caption font-medium text-text-tertiary", sample: "Last 7 days" },
] as const;

export function TypographySection() {
  return (
    <Section
      description="IBM Plex Sans for interface and reading; IBM Plex Mono for numbers, codes and citation numerals. Nothing renders below 12px."
      id="typography"
      title="Typography"
    >
      <div>
        {TYPE_SCALE.map((row) => (
          <TypeRow key={row.label} label={row.label} token={row.token}>
            <span className={row.className}>{row.sample}</span>
          </TypeRow>
        ))}
        <TypeRow label="Reading · 15.5/1.7" token="--text-size-reading">
          <span className="text-reading">
            The meal per diem is USD 75 per day <CitationChip n={1} title="Travel & Expense Policy.pdf" />
          </span>
        </TypeRow>
        <TypeRow label="Mono · 12/500" token="--font-mono">
          <span className="font-[family-name:var(--font-mono)] text-[0.75rem] font-medium">bomesh.app/northwind · 99.98%</span>
        </TypeRow>
      </div>
    </Section>
  );
}

function TypeRow({ label, token, children }: { label: string; token: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border-subtle py-2.5 min-[861px]:flex-row min-[861px]:items-baseline min-[861px]:gap-5">
      <span className="grid w-[170px] flex-none text-meta text-text-tertiary">
        {label}
        <span className="font-[family-name:var(--font-mono)] text-[0.6875rem]">{token}</span>
      </span>
      <span className="min-w-0 text-text-primary">{children}</span>
    </div>
  );
}

const SPACING = [4, 8, 12, 16, 20, 24, 32, 40, 48] as const;

/* Written out in full so Tailwind sees every class. */
const RADII = [
  ["xs · 4", "--radius-xs", "rounded-xs"],
  ["sm · 6 chips", "--radius-sm", "rounded-sm"],
  ["md · 8 controls", "--radius-md", "rounded-md"],
  ["lg · 10 cards", "--radius-lg", "rounded-lg"],
  ["sheet · 12", "--radius-sheet", "rounded-(--radius-sheet)"],
  ["xl · 14", "--radius-xl", "rounded-xl"],
  ["2xl · 16 dialogs", "--radius-2xl", "rounded-2xl"],
  ["full", "--radius-full", "rounded-full"],
] as const;

const ELEVATION = [
  ["Card", "border · no shadow", "rounded-lg border border-border-subtle"],
  ["Raised", "--shadow-1", "rounded-lg shadow-(--shadow-1)"],
  ["Hover", "--shadow-2", "rounded-lg shadow-(--shadow-2)"],
  ["Popover", "--shadow-pop", "rounded-lg shadow-(--shadow-pop)"],
  ["Sheet", "--shadow-sheet", "rounded-(--radius-sheet) shadow-(--shadow-sheet)"],
  ["Dialog", "--shadow-modal", "rounded-2xl shadow-(--shadow-modal)"],
] as const;

const CONTROL_HEIGHTS = [
  ["Small", "--control-sm", "h-(--control-sm)"],
  ["Medium", "--control-md", "h-(--control-md)"],
  ["Large", "--control-lg", "h-(--control-lg)"],
] as const;

export function ScaleSection() {
  const appearance = useRootAppearance();
  return (
    <Section
      description="4px grid. Radius 6 chips · 8 buttons and inputs · 10 cards · 12 the page sheet · 16 dialogs. Elevation only for floating layers. Compact density shortens controls and rows; type never shrinks."
      id="scale"
      title="Spacing, radius, elevation"
    >
      <Group title="Spacing">
        <div className="flex flex-wrap items-end gap-3.5">
          {SPACING.map((size) => (
            <div className="flex flex-col items-center gap-1" key={size}>
              <div className="rounded-[3px] bg-accent-soft-hover" style={{ width: size, height: size }} />
              <span className="font-[family-name:var(--font-mono)] text-[0.6875rem] text-text-tertiary">{size}</span>
            </div>
          ))}
        </div>
      </Group>
      <Group title="Radius">
        <Grid cols={4}>
          {RADII.map(([label, token, className]) => (
            <div className="flex items-center gap-3" key={token}>
              <div className={`size-12 flex-none border-[1.5px] border-border-strong bg-surface-subtle ${className}`} />
              <span className="grid text-meta text-text-secondary">
                {label}
                <span className="font-[family-name:var(--font-mono)] text-[0.6875rem] text-text-tertiary">{token}</span>
              </span>
            </div>
          ))}
        </Grid>
      </Group>
      <Group title="Elevation">
        <Grid cols={3} className="lg:grid-cols-6">
          {ELEVATION.map(([label, token, className]) => (
            <div className={`grid h-21 place-items-center bg-surface-raised text-center text-[0.8125rem] ${className}`} key={label}>
              <span>
                {label}
                <span className="block font-[family-name:var(--font-mono)] text-[0.6875rem] text-text-tertiary">{token}</span>
              </span>
            </div>
          ))}
        </Grid>
      </Group>
      <Group title="Control heights · follow density">
        <div className="flex flex-wrap items-end gap-3">
          {CONTROL_HEIGHTS.map(([label, token, className]) => (
            <div className={`flex w-40 items-center justify-between rounded-md bg-surface-inset px-3 text-meta ${className}`} key={token}>
              <span>{label}</span>
              <span className="font-[family-name:var(--font-mono)] text-[0.6875rem] text-text-tertiary">
                {appearance ? readToken(token) : token}
              </span>
            </div>
          ))}
        </div>
      </Group>
    </Section>
  );
}
