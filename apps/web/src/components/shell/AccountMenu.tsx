"use client";

import { Dropdown, Header, Label, Separator } from "@heroui/react";
import { ChevronsUpDown, CircleHelp, Command, Globe, LogOut, Moon, Route, Settings, Sun } from "lucide-react";
import { useRouter } from "next/navigation";

import { toast } from "@/components/ui/Toast";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { LANGUAGES, languageName, useLanguage } from "@/lib/i18n";
import type { ShellMode } from "@/lib/navigation";
import { useSession } from "@/lib/session";
import { MODE_LABEL, themeLabel } from "@/lib/theme";
import { useOptionalWorkspace } from "@/lib/workspace";
import { signOut, useRoleDisplayName } from "@/modules/auth/api";

import { changeLanguage } from "./language";
import { openAppearance, openPreferences, openShortcuts, startTour } from "./overlays";
import { useAppearance } from "./useAppearance";


/** The signed-in person's role line: workspace role, or platform role in the console. */
export function useRoleLine(mode: ShellMode): string {
  const session = useSession();
  const ctx = useOptionalWorkspace();
  const role = useRoleDisplayName(ctx?.id, ctx?.member.roles);
  if (mode === "platform" || !ctx) return session?.user.platformRole === "ADMIN" ? "Platform admin" : "Platform operator";
  return role;
}

/** Sidebar footer: account and preferences (preview `MENUS.me`). */
export function AccountMenu({ mode }: { mode: ShellMode }) {
  const router = useRouter();
  const session = useSession();
  const appearance = useAppearance();
  const [language] = useLanguage();
  const role = useRoleLine(mode);
  const name = session?.user.displayName || session?.user.email || "";
  const platform = mode === "platform";

  const onSignOut = () => {
    void signOut().then(() => {
      router.replace("/signin");
      toast("Signed out", { tone: "accent" });
    });
  };

  const coarse = typeof window !== "undefined" && window.matchMedia("(hover: none), (pointer: coarse)").matches;
  const help = [!coarse && "shortcuts", !platform && "tour"].filter(Boolean);
  const ModeIcon = appearance.dark ? Moon : Sun;

  // Who you are (opens Preferences), the two personal settings with their current value, Help, Sign out — seven rows at
  // most, so Sign out is always visible. Mode and theme live in the Appearance drawer; the console in the workspace switcher.
  return (
    <Dropdown>
      <Dropdown.Trigger className="user-button" aria-label="Account and preferences">
        <UserAvatar name={name} />
        <span className="grow stack user-button__text">
          <span className="user-button__name truncate" translate="no">
            {name}
          </span>
          <span className="user-button__meta truncate">{role}</span>
        </span>
        <ChevronsUpDown className="i i-sm" aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" offset={4}>
        <Dropdown.Menu aria-label="Account">
          <Dropdown.Section>
            <Dropdown.Item id="me" textValue={name} onAction={() => openPreferences()}>
              <UserAvatar name={name} size="lg" />
              <span className="stack grow" style={{ minWidth: 0 }}>
                <span className="medium truncate" translate="no">
                  {name}
                </span>
                <span className="t-xs muted truncate" translate="no">
                  {session?.user.email}
                </span>
              </span>
              <Settings className="i menu-item__trail" aria-hidden />
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Dropdown.Item id="appearance" textValue="Appearance" onAction={openAppearance}>
              <ModeIcon className="i" aria-hidden />
              <Label className="grow">Appearance</Label>
              <span className="menu-item__meta">
                {MODE_LABEL[appearance.mode]} · {themeLabel(appearance.look)}
              </span>
            </Dropdown.Item>
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item id="language" textValue="Language">
                <Globe className="i" aria-hidden />
                <Label className="grow">Language</Label>
                <span className="menu-item__meta" translate="no">
                  {languageName(language)}
                </span>
              </Dropdown.Item>
              <Dropdown.Popover>
                <Dropdown.Menu aria-label="Language">
                  <Dropdown.Section selectionMode="single" selectedKeys={[language]}>
                    <Header>Language</Header>
                    {LANGUAGES.map((l) => (
                      <Dropdown.Item key={l.code} id={l.code} textValue={l.native} onAction={() => changeLanguage(l.code)}>
                        <Label className="grow" translate="no">
                          {l.native}
                        </Label>
                        {l.native !== l.english && (
                          <span className="menu-item__meta" translate="no">
                            {l.english}
                          </span>
                        )}
                        <Dropdown.ItemIndicator />
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Section>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.SubmenuTrigger>
            {help.length ? (
              <Dropdown.SubmenuTrigger>
                <Dropdown.Item id="help" textValue="Help">
                  <CircleHelp className="i" aria-hidden />
                  <Label className="grow">Help</Label>
                </Dropdown.Item>
                <Dropdown.Popover>
                  <Dropdown.Menu aria-label="Help">
                    <Dropdown.Section>
                      <Header>Help</Header>
                      {!coarse ? (
                        <Dropdown.Item id="shortcuts" textValue="Keyboard shortcuts" onAction={openShortcuts}>
                          <Command className="i" aria-hidden />
                          <Label>Keyboard shortcuts</Label>
                        </Dropdown.Item>
                      ) : null}
                      {!platform ? (
                        <Dropdown.Item id="tour" textValue="Product tour" onAction={startTour}>
                          <Route className="i" aria-hidden />
                          <Label>Product tour</Label>
                        </Dropdown.Item>
                      ) : null}
                    </Dropdown.Section>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.SubmenuTrigger>
            ) : null}
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Dropdown.Item id="signout" textValue="Sign out" onAction={onSignOut}>
              <LogOut className="i" aria-hidden />
              <Label>Sign out</Label>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
