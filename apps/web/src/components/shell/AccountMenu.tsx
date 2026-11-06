"use client";

import { Dropdown, Header, Label, Separator } from "@heroui/react";
import { ChevronsUpDown, Command, Globe, Layers, LogOut, Monitor, Moon, Route, Settings, Sun, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";

import { toast } from "@/components/ui/Toast";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { LANGUAGES, languageName, useLanguage } from "@/lib/i18n";
import { PLATFORM_CONSOLE, type ShellMode } from "@/lib/navigation";
import { isPlatformOperator, useSession } from "@/lib/session";
import { accentColor, setMode, themeLabel, type ThemeMode } from "@/lib/theme";
import { useOptionalWorkspace } from "@/lib/workspace";
import { signOut, useRoleDisplayName } from "@/modules/auth/api";

import { changeLanguage } from "./LanguagePicker";
import { openAppearance, openPreferences, openShortcuts } from "./overlays";
import { startTour } from "./ProductTour";
import { useAppearance } from "./useAppearance";

const MODES: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
  { mode: "system", label: "Match system", icon: Monitor },
];

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

  return (
    <Dropdown>
      <Dropdown.Trigger className="user-button" aria-label="Account and preferences">
        <UserAvatar name={name} />
        <span className="grow stack">
          <span className="user-button__name truncate" translate="no">
            {name}
          </span>
          <span className="user-button__meta truncate" translate="no">
            {session?.user.email}
          </span>
        </span>
        <ChevronsUpDown className="i i-sm muted" aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" offset={4} className="shell-menu">
        <Dropdown.Menu aria-label="Account">
          <Dropdown.Section>
            <Dropdown.Item id="me" textValue={name} onAction={openPreferences}>
              <UserAvatar name={name} size="lg" />
              <span className="stack grow" style={{ minWidth: 0 }}>
                <span className="medium truncate" translate="no">
                  {name}
                </span>
                <span className="t-xs muted truncate">{role}</span>
              </span>
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Dropdown.Item id="prefs" textValue="Preferences" onAction={openPreferences}>
              <Settings className="i" aria-hidden />
              <Label>Preferences</Label>
            </Dropdown.Item>
          </Dropdown.Section>
          <Dropdown.Section selectionMode="single" selectedKeys={[`mode:${appearance.mode}`]}>
            <Header>Appearance</Header>
            {MODES.map(({ mode: m, label, icon: Icon }) => (
              <Dropdown.Item key={m} id={`mode:${m}`} textValue={label} onAction={() => setMode(m)}>
                <Icon className="i" aria-hidden />
                <Label>{label}</Label>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
          <Dropdown.Section>
            <Dropdown.Item id="theme" textValue="Theme and colors…" onAction={openAppearance}>
              <span className="i theme-dot" style={{ background: accentColor(appearance.look, appearance.dark) }} aria-hidden />
              <Label className="grow">Theme and colors…</Label>
              <span className="menu-item__meta">{themeLabel(appearance.look)}</span>
            </Dropdown.Item>
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item id="language" textValue="Language">
                <Globe className="i" aria-hidden />
                <Label className="grow">Language</Label>
                <span className="menu-item__meta" translate="no">
                  {languageName(language)}
                </span>
              </Dropdown.Item>
              <Dropdown.Popover className="shell-menu">
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
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Dropdown.Item id="shortcuts" textValue="Keyboard shortcuts" onAction={openShortcuts}>
              <Command className="i" aria-hidden />
              <Label>Keyboard shortcuts</Label>
            </Dropdown.Item>
            {!platform ? (
              <Dropdown.Item id="tour" textValue="Product tour" onAction={startTour}>
                <Route className="i" aria-hidden />
                <Label>Product tour</Label>
              </Dropdown.Item>
            ) : null}
            {isPlatformOperator(session) && !platform ? (
              <Dropdown.Item id="platform" textValue="Platform console" onAction={() => router.push(PLATFORM_CONSOLE.href)}>
                <Layers className="i" aria-hidden />
                <Label>Platform console</Label>
              </Dropdown.Item>
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
