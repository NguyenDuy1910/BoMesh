"use client";

import { buttonVariants, Card } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

/** Card with a header (preview `card(body, { title, desc, icon, cls })`). */
export function RqCard({ title, description, icon, className, children }: { title?: ReactNode; description?: ReactNode; icon?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Card className={className}>
      {title ? (
        <Card.Header>
          {icon}
          <div className="grow">
            <Card.Title>{title}</Card.Title>
            {description ? <Card.Description>{description}</Card.Description> : null}
          </div>
        </Card.Header>
      ) : null}
      {children}
    </Card>
  );
}

/** A link styled as a button (navigation, not an action). */
export function LinkButton({
  href,
  children,
  icon: Icon,
  variant = "secondary",
  size,
}: {
  href: string;
  children: ReactNode;
  icon?: LucideIcon;
  variant?: "primary" | "secondary" | "tertiary" | "ghost" | "outline";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <NextLink href={href} className={buttonVariants({ variant, size })}>
      {Icon ? <Icon className="i" aria-hidden /> : null}
      {children}
    </NextLink>
  );
}
