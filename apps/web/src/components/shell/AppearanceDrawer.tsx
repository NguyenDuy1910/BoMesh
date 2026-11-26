"use client";

import { Button, Chip, ColorSwatchPicker, Drawer, Label, Slider, type Color } from "@heroui/react";
import clsx from "clsx";
import { Check, Monitor, Moon, Palette, RefreshCw, Settings, Sun } from "lucide-react";
import { type CSSProperties } from "react";

import { Disclosure } from "@/components/ui/Disclosure";
import { Segmented } from "@/components/ui/Segmented";
import { toast } from "@/components/ui/Toast";
import {
  ACCENTS,
  accentHex,
  accentOf,
  BASES,
  DEFAULT_LOOK,
  FONTS,
  fontById,
  getAppearance,
  previewHue,
  RADII,
  resetLook,
  setAppearance,
  setLook,
  setMode,
  setThemePreset,
  THEMES,
  themeById,
  themeLabel,
  themePreview,
  type NamedTheme,
  type ThemeMode,
} from "@/lib/theme";

import { closeOverlay, useShellOverlays } from "./overlays";
import { useAppearance } from "./useAppearance";

const CUSTOM = "custom";

/** Mini preview of a named theme, drawn from its own colours. The default theme is featured as the recommendation. */
function ThemeCard({ theme, on, dark, featured = false }: { theme: NamedTheme; on: boolean; dark: boolean; featured?: boolean }) {
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
    <button
      type="button"
      className={clsx("theme-card", featured && "theme-card--featured")}
      aria-pressed={on}
      aria-label={`Giao diện ${theme.label}`}
      onClick={() => setThemePreset(theme.id)}
    >
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
      {featured ? (
        <span className="theme-card__meta">
          <span className="row gap-8">
            <span className="theme-card__name">{theme.label}</span>
            <Chip size="sm" color="accent" variant="soft">
              Đề xuất
            </Chip>
          </span>
          <span className="theme-card__note theme-card__note--wrap">{theme.pitch ?? theme.note}</span>
        </span>
      ) : (
        <span className="theme-card__meta">
          <span className="theme-card__name">{theme.label}</span>
          <span className="theme-card__note">{theme.note}</span>
        </span>
      )}
      {on && (
        <span className="theme-card__check">
          <Check className="i" aria-hidden />
        </span>
      )}
    </button>
  );
}

/** Mode; the default theme featured, the others behind “More themes”; accent, tint, radius and font behind “Customize”. A
 * disclosure starts open when what it holds is in use (preview `controls()`). */
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
  const featured = themeById(DEFAULT_LOOK.theme);
  const others = THEMES.filter((t) => t.id !== DEFAULT_LOOK.theme);
  const current = others.find((t) => t.id === look.theme);
  const isCustom = look.theme === CUSTOM;

  return (
    <div className="stack gap-20 appearance">
      <div className="field">
        <span className="label">Chế độ</span>
        <Segmented<ThemeMode>
          full
          label="Chế độ"
          value={mode}
          onChange={setMode}
          options={[
            { value: "light", label: "Sáng", icon: Sun },
            { value: "dark", label: "Tối", icon: Moon },
            { value: "system", label: "Theo hệ thống", icon: Monitor },
          ]}
        />
      </div>
      <div className="field">
        <span className="label">Chủ đề giao diện</span>
        <div className="stack gap-8">
          {featured ? <ThemeCard theme={featured} on={look.theme === featured.id} dark={dark} featured /> : null}
          <Disclosure icon={Palette} title="Chủ đề khác" summary={current ? current.label : `${others.length} chủ đề`} defaultOpen={Boolean(current)}>
            <div className="theme-gallery">
              {others.map((t) => (
                <ThemeCard key={t.id} theme={t} on={look.theme === t.id} dark={dark} />
              ))}
            </div>
          </Disclosure>
        </div>
      </div>
      <Disclosure
        icon={Settings}
        title="Tùy chỉnh"
        summary={isCustom ? "Tùy chỉnh" : `${accentOf(look).label} · ${RADII.find((r) => r.id === look.radius)?.label ?? ""} · ${fontById(look.font).label}`}
        defaultOpen={isCustom}
      >
        <div className="stack gap-20">
          <div className="field">
            <span className="label">Màu nhấn</span>
            {/* Swatch ids are their colours, which follow the mode and hue; React Aria can't change an item's id, so remount. */}
            <ColorSwatchPicker
              key={[...swatches.map((s) => s.hex), customHex].join()}
              aria-label="Màu nhấn"
              value={custom ? customHex : (swatches.find((s) => s.id === look.accent)?.hex ?? swatches[0].hex)}
              onChange={onAccent}
            >
              {swatches.map((s) => (
                <ColorSwatchPicker.Item key={s.id} color={s.hex} aria-label={s.label}>
                  <ColorSwatchPicker.Swatch colorName={s.label} />
                  <ColorSwatchPicker.Indicator />
                </ColorSwatchPicker.Item>
              ))}
              <ColorSwatchPicker.Item color={customHex} aria-label="Sắc độ tùy chỉnh">
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
                  <Label className="t-xs muted grow">Sắc độ</Label>
                  <Slider.Output className="mono t-xs muted">{({ state }) => `${Math.round(state.values[0])}°`}</Slider.Output>
                </div>
                <Slider.Track className="hue-track">
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
            )}
            <div className="description">Nút, liên kết, vùng chọn, viền tiêu điểm và đánh dấu.</div>
          </div>
          <div className="field">
            <span className="label">Sắc nền</span>
            <Segmented
              full
              label="Sắc nền"
              value={look.base}
              onChange={(base) => setLook({ base })}
              options={BASES.map((b) => ({ value: b.id, label: b.label }))}
            />
            <div className="description">Mức màu nhấn phủ lên nền, thẻ, đường viền và văn bản.</div>
          </div>
          <div className="field">
            <span className="label">Bo góc</span>
            <Segmented
              full
              label="Bo góc"
              value={look.radius}
              onChange={(radius) => setLook({ radius })}
              options={RADII.map((r) => ({ value: r.id, label: r.id === "xl" ? "XL" : r.label }))}
            />
          </div>
          <div className="field">
            <span className="label">Phông chữ</span>
            <div className="font-options" role="group" aria-label="Phông chữ">
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
        </div>
      </Disclosure>
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
  const { look } = useAppearance();
  const isDefaultLook = (["theme", "accent", "base", "radius", "font"] as const).every((k) => look[k] === DEFAULT_LOOK[k]);

  const reset = () => {
    const before = getAppearance();
    resetLook();
    toast(`Đã đặt lại giao diện về ${themeLabel(DEFAULT_LOOK)}`, { undo: () => setAppearance(before) });
  };

  return (
    <Drawer.Backdrop variant="transparent" isOpen={isOpen} onOpenChange={(o) => !o && closeOverlay()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Đóng" />
          <Drawer.Header>
            <Drawer.Heading>Giao diện</Drawer.Heading>
            <p className="drawer__description">Thay đổi toàn bộ ứng dụng ngay lập tức. Được lưu cho bạn trên thiết bị này.</p>
          </Drawer.Header>
          <Drawer.Body>{isOpen && <Controls />}</Drawer.Body>
          <Drawer.Footer>
            <div className="drawer__footer-start row gap-8">
              {isDefaultLook ? null : (
                <Button variant="ghost" onPress={reset}>
                  <RefreshCw className="i" aria-hidden />
                  {`Đặt lại về ${themeLabel(DEFAULT_LOOK)}`}
                </Button>
              )}
            </div>
            <Button slot="close" variant="primary">
              Xong
            </Button>
          </Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
