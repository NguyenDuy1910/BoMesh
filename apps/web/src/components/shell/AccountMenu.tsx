"use client";

import { Command, LogOut, Moon, Route, Sun, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { RailTip } from "@/components/shell/RailTip";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useAccountPreferences } from "@/lib/hooks/useAccountPreferences";
import { signOut } from "@/modules/auth/api";

/**
 * The sidebar foot (prototype `MENUS.me`): who is signed in, preferences,
 * a theme switch, keyboard shortcuts, the product tour and sign out.
 */
export function AccountMenu({
  collapsed,
  onOpenPreferences,
  onOpenShortcuts,
  onStartTour,
}: {
  collapsed: boolean;
  onOpenPreferences: () => void;
  onOpenShortcuts: () => void;
  onStartTour: () => void;
}) {
  const router = useRouter();
  const { viewer } = useCurrentWorkspace();
  const { updatePreferences } = useAccountPreferences();
  const [dark, setDark] = useState(false);
  const name = viewer?.name ?? "Signed in";
  const label = `Account: ${name}`;

  return (
    <Menu
      align="start"
      className="flex w-full"
      menuClassName="min-w-[240px]"
      onOpenChange={(open) => {
        if (open) setDark(document.documentElement.dataset.theme === "dark");
      }}
      trigger={(props) => (
        <RailTip enabled={collapsed} label={label}>
          <button {...props} aria-label={label} className="side-me">
            <Avatar name={name} size="md" />
            <span className="side-grow hide-collapsed">
              <span className="ws-name font-medium">{name}</span>
              {viewer?.email && <span className="ws-meta">{viewer.email}</span>}
            </span>
          </button>
        </RailTip>
      )}
    >
      <MenuItem onSelect={onOpenPreferences} textValue={name}>
        <span className="flex min-w-0 flex-col py-0.5">
          <span className="truncate font-semibold">{name}</span>
          {viewer?.email && <span className="truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{viewer.email}</span>}
        </span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<UserRound />} onSelect={onOpenPreferences}>Profile &amp; preferences</MenuItem>
      <MenuItem icon={dark ? <Sun /> : <Moon />} onSelect={() => updatePreferences({ theme: dark ? "light" : "dark" })}>
        {dark ? "Light theme" : "Dark theme"}
      </MenuItem>
      <MenuItem icon={<Command />} onSelect={onOpenShortcuts}>Keyboard shortcuts</MenuItem>
      <MenuItem icon={<Route />} onSelect={onStartTour}>Product tour</MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<LogOut />}
        onSelect={() => {
          void signOut().then(() => router.replace("/auth/login"));
        }}
      >
        Sign out
      </MenuItem>
    </Menu>
  );
}
