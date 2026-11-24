"use client";

import { Button, ColorSwatchPicker, Pressable, Tooltip } from "@heroui/react";
import { Undo2 } from "lucide-react";
import type { CSSProperties } from "react";

import { PopoverSheet } from "@/components/ui";
import { DOMAIN_COLORS } from "@/lib/tones";
import { DOMAIN_ICON, TOPIC_ICONS, topicIcon } from "@/modules/home/domainIcon";

export interface IconPickerProps {
  /** The icon drawn on the tile (a topic without its own shows its domain's). */
  shown?: string;
  /** The tile's color (`--tone`): the domain's. */
  color: string;
  /** The stored icon, checked in the grid ("" = none of its own). */
  value: string;
  onPick: (icon: string) => void;
  /** A topic with its own icon: *Use domain icon* clears it. */
  onReset?: () => void;
}

/**
 * The node's icon on its color tile, opening a compact grid of the shared icon set (preview `iconButton()` +
 * `PO['tx-icon']`). Picking closes it.
 */
export function IconPicker({ shown, color, value, onPick, onReset }: IconPickerProps) {
  const Icon = topicIcon(shown || DOMAIN_ICON);
  return (
    <PopoverSheet
      title="Biểu tượng"
      className="tx-icons-pop"
      footer={
        onReset ? (
          <Button slot="close" variant="ghost" size="sm" onPress={onReset}>
            <Undo2 className="i" aria-hidden />
            Dùng biểu tượng của lĩnh vực
          </Button>
        ) : undefined
      }
      trigger={
        <Pressable>
          <button type="button" className="tx-icon-btn item-icon item-icon--tone" style={{ "--tone": color } as CSSProperties} aria-label="Đổi biểu tượng" title="Đổi biểu tượng">
            <Icon className="i" aria-hidden />
          </button>
        </Pressable>
      }
    >
      <div className="tx-icons" role="group" aria-label="Biểu tượng">
        {TOPIC_ICONS.map(({ name, label, icon: Item }) => (
          <Tooltip key={name}>
            <Button slot="close" isIconOnly variant="ghost" aria-label={label} aria-pressed={name === value} className="tx-icons__item" onPress={() => onPick(name)}>
              <Item aria-hidden />
            </Button>
            <Tooltip.Content>{label}</Tooltip.Content>
          </Tooltip>
        ))}
      </div>
    </PopoverSheet>
  );
}

/** React Aria's "nothing picked" (its default color): black, which no palette swatch is. */
const NONE = "#000000";

/**
 * A domain's color: swatches of the shared palette (HeroUI ColorSwatchPicker; preview `swatchPicker` over
 * `DOMAIN_COLORS`). `value` is the stored color; one outside the palette (or none) checks no swatch.
 */
export function DomainColorPicker({ value, onChange, size, label = "Màu lĩnh vực" }: { value: string; onChange: (hex: string) => void; size?: "sm"; label?: string }) {
  const picked = DOMAIN_COLORS.find((c) => c.hex === value.toLowerCase())?.hex ?? NONE;
  return (
    <ColorSwatchPicker aria-label={label} size={size} value={picked} onChange={(c) => onChange(c.toString("hex").toLowerCase())}>
      {DOMAIN_COLORS.map((c) => (
        <ColorSwatchPicker.Item key={c.hex} color={c.hex} aria-label={c.label}>
          {/* The palette's own name ("Orange"), not React Aria's generated English one ("dark vibrant purple"). */}
          <ColorSwatchPicker.Swatch colorName={c.label} />
          <ColorSwatchPicker.Indicator />
        </ColorSwatchPicker.Item>
      ))}
    </ColorSwatchPicker>
  );
}
