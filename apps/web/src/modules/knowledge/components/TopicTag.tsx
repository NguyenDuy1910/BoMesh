"use client";

import { Layers, type LucideIcon } from "lucide-react";
import NextLink from "next/link";
import type { CSSProperties } from "react";

import { topicIcon } from "@/modules/home/domainIcon";

import type { TopicLook } from "../model";

/** The inline `--tone` and icon a topic is drawn with (its domain's color; see `TopicLook`). */
export function topicToneProps(look: TopicLook | undefined): { style?: CSSProperties; Icon: LucideIcon } {
  return { style: look ? ({ "--tone": look.color } as CSSProperties) : undefined, Icon: topicIcon(look?.icon, look?.domain ? Layers : undefined) };
}

/**
 * A topic tag (preview `topicTag()`): a soft chip in the topic's domain color with its icon. With `href` it is a
 * link (rows, details); inside a card, whose whole surface is the control, plain text.
 */
export function TopicTag({ label, look, href }: { label: string; look?: TopicLook; href?: string }) {
  const { style, Icon } = topicToneProps(look);
  const content = (
    <>
      <Icon className="i" aria-hidden />
      <span className="topic-tag__label">{label}</span>
    </>
  );
  return href ? (
    <NextLink className="topic-tag" style={style} href={href} title={label}>
      {content}
    </NextLink>
  ) : (
    <span className="topic-tag" style={style} title={label}>
      {content}
    </span>
  );
}
