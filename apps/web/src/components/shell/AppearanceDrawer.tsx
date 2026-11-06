"use client";

import { Button, ColorSwatchPicker, Drawer, Label, Slider, type Color } from "@heroui/react";
import { Check, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, type CSSProperties } from "react";

import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { toast } from "@/components/ui/Toast";
import {
  ACCENTS,
  accentHex,
  BASES,
  ensureFont,
  FONTS,
  getAppearance,
  previewHue,
  RADII,
  resetLook,
  setAppearance,
  setLook,
  setMode,
  setThemePreset,
  THEMES,
  themeLabel,
  themePreview,
  type NamedTheme,
  type ThemeMode,
} from "@/lib/theme";

import { closeOverlay, useShellOverlays } from "./overlays";
import { useAppearance } from "./useAppearance";

const CUSTOM = "custom";

/** Mini preview of a named theme, drawn from its own colours. */
function ThemeCard({ theme, on, dark }: { theme: NamedTheme; on: boolean; dark: boolean }) {
  const p = themePreview(theme, dark);
  const style = {
    "--tp-bg": p.bg,
    "--tp-surface": p.surface,
    "--tp-line": p.line,
    "--tp-text": p.text,
    "--tp-muted": p.muted,
    "--tp-accent": p.accent,
    "--tp-ink": p.ink,
    "--tp-r": `${p.radius}rem`,
    fontFamily: p.font,
  } as CSSProperties;
  return (
    <button type="button" className="theme-card" aria-pressed={on} aria-label={`${theme.label} theme`} onClick={() => setThemePreset(theme.id)}>
      <span className="theme-card__preview" style={style} aria-hidden>
        <span className="theme-card__side">
          <i />
          <i className="is-on" />
          <i />
        </span>
        <span className="theme-card__panel">
          <b>Aa</b>
          <span className="theme-card__line" />
          <span className="theme-card__line theme-card__line--short" />
          <span className="theme-card__row">
            <span className="theme-card__btn" />
            <span className="theme-card__chip" />
          </span>
        </span>
      </span>
      <span className="theme-card__meta">
        <span className="theme-card__name">{theme.label}</span>
        <span className="theme-card__note">{theme.note}</span>
      </span>
      {on && (
        <span className="theme-card__check">
          <Check className="i" aria-hidden />
        </span>
      )}
    </button>
  );
}

function Controls() {
  const { mode, look, dark } = useAppearance();
  const custom = look.accent === CUSTOM;
  const swatches = ACCENTS.map((a) => ({ id: a.id, label: a.label, hex: accentHex({ ...look, accent: a.id }, dark) }));
  const customHex = accentHex({ ...look, accent: CUSTOM }, dark);
  const onAccent = (color: Color) => {
    const hex = color.toString("hex").toUpperCase();
    const hit = swatches.find((s) => s.hex.toUpperCase() === hex);
    setLook({ accent: hit ? hit.id : CUSTOM });
  };

  return (
    <div className="stack gap-20 appearance">
      <div className="field">
        <span className="label">Mode</span>
        <Segmented<ThemeMode>
          full
          label="Mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "light", label: "Light", icon: Sun },
            { value: "dark", label: "Dark", icon: Moon },
            { value: "system", label: "System", icon: Monitor },
          ]}
        />
      </div>
      <div className="field">
        <div className="row">
          <span className="label grow">Theme</span>
          <span className="t-xs muted">{themeLabel(look)}</span>
        </div>
        <div className="theme-gallery">
          {THEMES.map((t) => (
            <ThemeCard key={t.id} theme={t} on={look.theme === t.id} dark={dark} />
          ))}
        </div>
      </div>
      <hr className="separator" />
      <h3 className="t-subheading">Customize</h3>
      <div className="field">
        <span className="label">Accent color</span>
        {/* Swatch ids are their colours, which follow the mode and hue; React Aria can't change an item's id, so remount. */}
        <ColorSwatchPicker
          key={[...swatches.map((s) => s.hex), customHex].join()}
          aria-label="Accent color"
          value={custom ? customHex : (swatches.find((s) => s.id === look.accent)?.hex ?? swatches[0].hex)}
          onChange={onAccent}
        >
          {swatches.map((s) => (
            <ColorSwatchPicker.Item key={s.id} color={s.hex} aria-label={s.label}>
              <ColorSwatchPicker.Swatch />
              <ColorSwatchPicker.Indicator />
            </ColorSwatchPicker.Item>
          ))}
          <ColorSwatchPicker.Item color={customHex} aria-label="Custom hue">
            <span className="color-swatch-picker__swatch hue-swatch" aria-hidden />
            <ColorSwatchPicker.Indicator />
          </ColorSwatchPicker.Item>
        </ColorSwatchPicker>
        {custom && (
          <Slider
            className="hue-field mt-12"
            minValue={0}
            maxValue={360}
            step={1}
            value={Math.round(look.hue)}
            onChange={(v) => previewHue(Number(v))}
            onChangeEnd={(v) => setLook({ accent: CUSTOM, hue: Number(v) })}
          >
            <div className="row">
              <Label className="t-xs muted grow">Hue</Label>
              <Slider.Output className="mono t-xs muted">{({ state }) => `${Math.round(state.values[0])}°`}</Slider.Output>
            </div>
            <Slider.Track className="hue-track">
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
        )}
        <div className="description">Buttons, links, selection, focus rings and highlights.</div>
      </div>
      <div className="field">
        <span className="label">Background tint</span>
        <Segmented
          full
          label="Background tint"
          value={look.base}
          onChange={(base) => setLook({ base })}
          options={BASES.map((b) => ({ value: b.id, label: b.label }))}
        />
        <div className="description">How much the accent colors the canvas, cards, borders and text.</div>
      </div>
      <div className="field">
        <span className="label">Corner radius</span>
        <Segmented
          full
          label="Corner radius"
          value={look.radius}
          onChange={(radius) => setLook({ radius })}
          options={RADII.map((r) => ({ value: r.id, label: r.label === "Extra large" ? "XL" : r.label }))}
        />
      </div>
      <div className="field">
        <span className="label">Font</span>
        <div className="font-options" role="group" aria-label="Font">
          {FONTS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="font-option"
              aria-pressed={look.font === f.id}
              style={{ fontFamily: f.stack }}
              onClick={() => setLook({ font: f.id })}
            >
              <span className="font-option__sample">Aa</span>
              <span className="font-option__name">{f.label}</span>
            </button>
          ))}
        </div>
      </div>
      <Callout description="Status colors (success, warning, danger) and cited-evidence highlights keep their meaning in every theme." />
    </div>
  );
}

/**
 * Appearance (preview `DR.appearance`): one personal theme for the whole
 * interface. Clear backdrop, so the app behind re-themes live.
 */
export function AppearanceDrawer() {
  const { open } = useShellOverlays();
  const isOpen = open === "appearance";

  useEffect(() => {
    if (isOpen) for (const f of FONTS) ensureFont(f.id);
  }, [isOpen]);

  const reset = () => {
    const before = getAppearance();
    resetLook();
    toast("Appearance reset to BoMesh", { undo: () => setAppearance(before) });
  };

  return (
    <Drawer.Backdrop variant="transparent" isOpen={isOpen} onOpenChange={(o) => !o && closeOverlay()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <Drawer.Heading>Appearance</Drawer.Heading>
            <p className="drawer__description">Changes the whole app right away. Saved for you on this device.</p>
          </Drawer.Header>
          <Drawer.Body>{isOpen && <Controls />}</Drawer.Body>
          <Drawer.Footer>
            <div className="drawer__footer-start row gap-8">
              <Button variant="ghost" onPress={reset}>
                <RefreshCw className="i" aria-hidden />
                Reset to BoMesh
              </Button>
            </div>
            <Button slot="close" variant="primary">
              Done
            </Button>
          </Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
