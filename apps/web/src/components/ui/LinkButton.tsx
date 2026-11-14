"use client";

import { Button } from "@heroui/react";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export interface LinkButtonProps {
  /** Navigates (a real link). Omit and pass `onPress` for an in-page action. */
  href?: string;
  onPress?: () => void;
  /** Trailing icon (after the label), e.g. ArrowRight or ExternalLink. */
  icon?: LucideIcon;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}

/** Quiet text action (preview `linkBtn()`, HeroUI Link button): accent text, its icon after the label. */
export function LinkButton({ href, onPress, icon: Icon, size, className, children }: LinkButtonProps) {
  const cls = clsx("button button--link", size === "sm" && "button--sm", className);
  const inner = (
    <>
      <span>{children}</span>
      {Icon ? <Icon className="i" aria-hidden /> : null}
    </>
  );
  if (href)
    return (
      <Link href={href} className={cls} onClick={onPress}>
        {inner}
      </Link>
    );
  return (
    <Button variant="ghost" size={size} className={cls} onPress={onPress}>
      {inner}
    </Button>
  );
}
