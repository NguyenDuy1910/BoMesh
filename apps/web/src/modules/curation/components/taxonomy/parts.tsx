"use client";

import { Button, ColorSwatchPicker, Pressable, Tooltip } from "@heroui/react";
import { Undo2 } from "lucide-react";
import { useCallback, type CSSProperties, type ReactNode } from "react";

import { PopoverSheet, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { DOMAIN_COLORS } from "@/lib/tones";
import { useWorkspace } from "@/lib/workspace";
import { CONCEPT_ICONS, conceptIcon } from "@/modules/home/domainIcon";
import { useSources } from "@/modules/ingestion/queries";
import type { Concept } from "@/modules/knowledge/api";
import { useItemsByName } from "@/modules/knowledge/queries";
import { conceptLabel, resourceKey, type Taxonomy } from "@/modules/knowledge/taxonomy";

import { useInvalidateTaxonomy, useRememberConcept } from "../../queries";
import { updateConcept, type ConceptFields, type ConceptRule } from "../../taxonomyApi";

/** What the caller may do in Classification (preview `canManageTaxonomy`, split by the API's permissions). */
export interface TaxonomyAccess {
  /** New concepts (drafts, imports, accepted proposals). */
  create: boolean;
  /** Edit concepts: labels, definition, relations, mappings, look; merge, split, retire. */
  update: boolean;
  /** Delete never-published drafts. */
  remove: boolean;
  /** Scheme settings, the classification prompt and its test box. */
  scheme: boolean;
  publish: boolean;
  /** Proposals and labels awaiting review. */
  decide: boolean;
}

export function useTaxonomyAccess(): TaxonomyAccess {
  const { can } = useWorkspace();
  return {
    create: can("concepts.create"),
    update: can("concepts.update"),
    remove: can("concepts.delete"),
    scheme: can("conceptSchemes.update"),
    publish: can("conceptSchemes.publish"),
    decide: can("conceptProposals.decide"),
  };
}

/** “ · ” between meta parts. */
export const DOT = (
  <span className="muted" aria-hidden="true">
    {" · "}
  </span>
);

/** A detail section (preview `sec`): title, an aside, a muted description, the body. */
export function Sec({ title, desc, aside, children }: { title: string; desc?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="tx-sec">
      <div className="tx-sec__head">
        <h3 className="tx-sec__title">{title}</h3>
        {aside}
      </div>
      {desc ? <p className="tx-sec__desc">{desc}</p> : null}
      {children}
    </section>
  );
}

/** A rule's condition in words (preview `ruleText`): “Tài liệu trong “Kho…””, “Tài liệu từ “Nguồn…””, “Tài liệu có “Khái niệm””;
 *  collections and sources are named by one batch read each. */
export function useRuleWhen(t: Taxonomy, rules: readonly ConceptRule[]): (rule: ConceptRule) => string {
  const collections = useItemsByName(
    rules.map((r) => r.when?.collection),
    { view: "BASIC" },
  ).items;
  const sources = useSources().data ?? [];
  return (r) => {
    const w = r.when ?? {};
    if (w.collection) return `Tài liệu trong “${[...collections.values()].find((x) => x.name === w.collection)?.displayName ?? resourceKey(w.collection)}”`;
    if (w.source) return `Tài liệu từ “${sources.find((s) => s.name === w.source)?.displayName ?? resourceKey(w.source)}”`;
    return `Tài liệu có “${conceptLabel(t, w.concept)}”`;
  };
}

/** Up to three document titles, then “+n nữa” (preview `sample`). */
export function Sample({ titles, n = titles.length }: { titles: readonly string[]; n?: number }) {
  return (
    <span className="tx-sug__sample">
      {titles.slice(0, 3).map((t, i) => (
        <span key={`${t}-${i}`}>
          {i ? <span aria-hidden="true">, </span> : null}
          <span translate="no">{t}</span>
        </span>
      ))}
      {n > 3 ? <span>{` +${n - 3} nữa`}</span> : null}
    </span>
  );
}

/** The value a field had, for Undo (an absent list is empty, an absent text blank). */
function before(c: Concept, patch: Partial<ConceptFields>): Partial<ConceptFields> {
  return Object.fromEntries(Object.keys(patch).map((k) => [k, c[k as keyof ConceptFields] ?? (Array.isArray(patch[k as keyof ConceptFields]) ? [] : "")]));
}

/**
 * Applies an edit to a concept at once (preview `apply`): the working copy changes, people see it everywhere, the scheme
 * lists it until Publish; the toast offers Undo. Resolves to the saved concept, or null when it failed (said in a toast).
 */
export function useEditConcept() {
  const remember = useRememberConcept();
  const refresh = useInvalidateTaxonomy();
  return useCallback(
    async (c: Concept, patch: Partial<ConceptFields>, message: string): Promise<Concept | null> => {
      const fail = (error: unknown) => {
        refresh();
        toast(errorMessage(error), { tone: "danger" });
      };
      const revert = before(c, patch);
      try {
        const saved = await updateConcept(c, patch);
        remember(saved);
        refresh();
        toast(message, {
          undo: () =>
            void updateConcept(saved, revert).then((x) => {
              remember(x);
              refresh();
            }, fail),
        });
        return saved;
      } catch (error) {
        fail(error);
        return null;
      }
    },
    [remember, refresh],
  );
}

/**
 * A concept's icon on its color tile, opening the shared icon grid (preview `iconButton()` + `PO['tx-icon']`). Picking
 * closes it; a narrower concept with its own icon can go back to its broader concept's.
 */
export function IconPicker({ shown, color, value, onPick, onReset }: { shown?: string; color: string; value: string; onPick: (icon: string) => void; onReset?: () => void }) {
  const Icon = conceptIcon(shown);
  return (
    <PopoverSheet
      title="Biểu tượng"
      className="tx-icons-pop"
      footer={
        onReset ? (
          <Button slot="close" variant="ghost" size="sm" onPress={onReset}>
            <Undo2 className="i" aria-hidden />
            Dùng biểu tượng của khái niệm cha
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
        {CONCEPT_ICONS.map(({ name, label, icon: Item }) => (
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

/** A top concept's color: swatches of the shared palette (preview `swatchPicker` over `DOMAIN_COLORS`). */
export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const picked = DOMAIN_COLORS.find((c) => c.hex === value.toLowerCase())?.hex ?? NONE;
  return (
    <ColorSwatchPicker aria-label="Màu khái niệm" value={picked} onChange={(c) => onChange(c.toString("hex").toLowerCase())}>
      {DOMAIN_COLORS.map((c) => (
        <ColorSwatchPicker.Item key={c.hex} color={c.hex} aria-label={c.label}>
          {/* The palette's own name ("Cam"), not React Aria's generated English one. */}
          <ColorSwatchPicker.Swatch colorName={c.label} />
          <ColorSwatchPicker.Indicator />
        </ColorSwatchPicker.Item>
      ))}
    </ColorSwatchPicker>
  );
}

/** Downloads text as a file in the browser. */
export function saveText(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
