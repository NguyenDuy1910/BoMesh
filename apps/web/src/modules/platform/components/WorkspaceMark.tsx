"use client";

import { Layers } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";

/** A workspace's initials on its colour: an avatar with square corners, so it never reads as a person. */
export function WorkspaceMark({ name, size = "md", className }: { name: string; size?: "xs" | "sm" | "md" | "lg" | "xl"; className?: string }) {
  return <Avatar className={cn(size === "xs" || size === "sm" ? "rounded-xs" : "rounded-md", className)} name={name} size={size} />;
}

/** Stands where a workspace would for events that belong to the platform itself. */
export function PlatformMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-grid size-5 shrink-0 place-items-center rounded-xs bg-surface-inverse text-text-inverse", className)}
    >
      <Layers className="size-3" />
    </span>
  );
}

const noSubscription = () => () => {};

/**
 * Where people reach this deployment (`app.example.com`), so a workspace's web
 * address reads `app.example.com/<code>`. Empty during the server render.
 */
export function useOriginHost(): string {
  return useSyncExternalStore(noSubscription, () => window.location.host, () => "");
}
