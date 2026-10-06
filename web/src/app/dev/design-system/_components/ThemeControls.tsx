"use client";

import { CheckCircle2 } from "lucide-react";

import { CitationChip } from "@/components/patterns/CitationChip";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tooltip } from "@/components/ui/Tooltip";
import { ui } from "@/components/ui/design-system";
import { ACCENT_OPTIONS, BACKGROUND_OPTIONS, DENSITY_OPTIONS, THEME_OPTIONS } from "@/lib/appearance";
import { cn } from "@/lib/cn";
import { useAccountPreferences } from "@/lib/hooks/useAccountPreferences";

import { Grid, Section, useRootAppearance } from "./kit";

/**
 * Sticky appearance bar: the same preferences the account dialog writes, so
 * every specimen below repaints exactly as a signed-in screen would.
 */
export function ThemeBar() {
  const { preferences, updatePreferences } = useAccountPreferences();
  return (
    <div
      aria-label="Appearance"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-t-(--radius-sheet) border-b border-border-subtle bg-surface-base/95 px-9 py-2.5 backdrop-blur-sm max-[860px]:px-4"
      role="region"
    >
      <BarGroup label="Theme">
        <SegmentedControl
          ariaLabel="Theme"
          onChange={(theme) => updatePreferences({ theme })}
          options={THEME_OPTIONS}
          size="sm"
          value={preferences.theme}
        />
      </BarGroup>
      <BarGroup label="Accent">
        <div aria-label="Accent" className="flex items-center gap-1.5" role="group">
          <AccentDot
            label="Follow the workspace"
            onClick={() => updatePreferences({ accent: "workspace" })}
            pressed={preferences.accent === "workspace"}
            swatch={WORKSPACE_SWATCH}
          />
          {ACCENT_OPTIONS.map((option) => (
            <AccentDot
              key={option.value}
              label={option.label}
              onClick={() => updatePreferences({ accent: option.value })}
              pressed={preferences.accent === option.value}
              swatch={option.swatch}
            />
          ))}
        </div>
      </BarGroup>
      <BarGroup label="Background">
        <SegmentedControl
          ariaLabel="Background"
          onChange={(background) => updatePreferences({ background })}
          options={BACKGROUND_OPTIONS}
          size="sm"
          value={preferences.background}
        />
      </BarGroup>
      <BarGroup label="Density">
        <SegmentedControl
          ariaLabel="Density"
          onChange={(density) => updatePreferences({ density })}
          options={DENSITY_OPTIONS}
          size="sm"
          value={preferences.density}
        />
      </BarGroup>
    </div>
  );
}

function BarGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="text-meta text-text-tertiary">
        {label}
      </span>
      {children}
    </div>
  );
}

/** The prototype's "workspace" chip: every accent at once, since it follows the brand. */
const WORKSPACE_SWATCH = `conic-gradient(${ACCENT_OPTIONS.map((option, index) => `${option.swatch} 0 ${((index + 1) * 100) / ACCENT_OPTIONS.length}%`).join(", ")})`;

function AccentDot({
  label,
  swatch,
  pressed,
  onClick,
}: {
  label: string;
  swatch: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        aria-label={label}
        aria-pressed={pressed}
        className={cn(
          "size-5 rounded-full border border-border-default",
          ui.motion,
          ui.focus,
          "aria-pressed:shadow-[0_0_0_2px_var(--surface-base),0_0_0_4px_var(--text-primary)]",
        )}
        onClick={onClick}
        style={{ background: swatch }}
        type="button"
      />
    </Tooltip>
  );
}

/**
 * Round 2 "Themes": one card per accent. The cards paint the fixed picker
 * swatch (the accent's light primary) because the live accent tokens are
 * scoped to <html>; the Color section below shows the live values.
 */
export function ThemesSection() {
  const { preferences, updatePreferences } = useAccountPreferences();
  // With "Follow the workspace" the boot script picks the accent; <html> says which.
  const appearance = useRootAppearance();
  const effective = appearance ? document.documentElement.dataset.accent : preferences.accent;
  return (
    <Section
      description={`Accent and background are themeable. Status colors and the amber evidence highlight are fixed so meaning never changes between workspaces.${preferences.accent === "workspace" ? " The accent follows the workspace brand; pick one to override it for you." : ""}`}
      id="themes"
      title="Themes"
    >
      <Grid cols={5}>
        {ACCENT_OPTIONS.map((option) => {
          const on = effective === option.value;
          return (
            <div
              className={cn(
                "relative flex flex-col gap-2.5 rounded-lg border border-border-subtle bg-surface-base p-3.5",
                ui.motion,
                "hover:border-border-default hover:shadow-(--shadow-2) has-focus-visible:shadow-(--shadow-focus)",
                on && "border-text-primary shadow-[0_0_0_1px_var(--text-primary)] hover:border-text-primary",
              )}
              key={option.value}
            >
              {/* The button's hit area covers the card; the citation numeral sits above it. */}
              <button
                aria-pressed={on}
                className="flex items-center justify-between text-left font-semibold text-text-primary outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']"
                onClick={() => updatePreferences({ accent: option.value })}
                type="button"
              >
                {option.label}
                {on && <CheckCircle2 aria-hidden="true" className="size-4" />}
              </button>
              <span
                className="flex h-7.5 items-center rounded-[7px] px-2.5 text-meta font-medium"
                style={{ background: option.swatch, color: "var(--file-label)" }}
              >
                Primary
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="flex h-5.5 w-max items-center rounded-sm px-2 text-caption"
                  style={{
                    background: `color-mix(in srgb, ${option.swatch} 13%, transparent)`,
                    color: `color-mix(in srgb, ${option.swatch} 50%, var(--text-primary))`,
                  }}
                >
                  Selected
                </span>
                <CitationChip className="relative" n={1} title="Evidence keeps its amber in every accent" />
              </span>
            </div>
          );
        })}
      </Grid>
    </Section>
  );
}
