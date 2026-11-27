"use client";

import clsx from "clsx";
import { type LucideIcon } from "lucide-react";
import NextLink from "next/link";
import type { CSSProperties } from "react";

import { conceptIcon } from "@/modules/home/domainIcon";

import { conceptLabel, conceptLook, conceptPathText, type Taxonomy } from "../taxonomy";

/** The inline `--tone` and icon a concept is drawn with (its top concept's color; see `conceptLook`). */
export function conceptToneProps(taxonomy: Taxonomy, concept: string): { style: CSSProperties; Icon: LucideIcon } {
  const look = conceptLook(taxonomy, concept);
  return { style: { "--tone": look.color } as CSSProperties, Icon: conceptIcon(look.icon) };
}

/**
 * A concept tag (preview `conceptTag()`): a soft chip in its family's color with its icon, its path in the tooltip. With
 * `href` it is a link (rows, details); inside a card, whose whole surface is the control, plain text. `suggested`: the
 * classifier proposed it and nobody confirmed it yet — dashed, marked “Chờ duyệt”.
 */
export function ConceptTag({ taxonomy, concept, href, suggested = false }: { taxonomy: Taxonomy; concept: string; href?: string; suggested?: boolean }) {
  const { style, Icon } = conceptToneProps(taxonomy, concept);
  const label = conceptLabel(taxonomy, concept);
  const title = conceptPathText(taxonomy, concept);
  const className = clsx("concept-tag", suggested && "concept-tag--suggested");
  const content = (
    <>
      <Icon className="i" aria-hidden />
      <span className="concept-tag__label" translate="no">
        {label}
      </span>
      {suggested ? <span className="concept-tag__state">Chờ duyệt</span> : null}
    </>
  );
  return href ? (
    <NextLink className={className} style={style} href={href} title={title}>
      {content}
    </NextLink>
  ) : (
    <span className={className} style={style} title={title}>
      {content}
    </span>
  );
}
