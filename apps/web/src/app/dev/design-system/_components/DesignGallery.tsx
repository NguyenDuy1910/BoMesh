"use client";

import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { ToastProvider } from "@/components/ui/Toast";
import { useAccountPreferences } from "@/lib/hooks/useAccountPreferences";

import { ButtonsSection, InputsSection, SelectionSection } from "./ControlSections";
import { EvidenceSection, IdentitySection } from "./EvidenceSection";
import { FeedbackSection, StatesSection } from "./FeedbackSections";
import { ColorSection, ScaleSection, TypographySection } from "./FoundationSections";
import { useRootAppearance } from "./kit";
import { NavigationSection, TableSection } from "./ListSections";
import { OverlaysSection } from "./OverlaySections";
import { StatusSection } from "./StatusSection";
import { ThemeBar, ThemesSection } from "./ThemeControls";

/**
 * Every primitive in every state, on the real tokens (prototype `P.design`
 * plus the Round 2 Themes section). It renders outside the product shell, on
 * its own canvas and sheet, so the background options show as they would.
 */
export function DesignGallery() {
  return (
    <ToastProvider>
      <div className="min-h-dvh p-2 [background:var(--canvas-background)]">
        <main
          className="min-h-[calc(100dvh-16px)] rounded-(--radius-sheet) bg-surface-base text-text-primary shadow-(--shadow-sheet)"
          id="main-content"
        >
          <ThemeBar />
          <div className="mx-auto w-full max-w-[1120px] px-9 pb-16 pt-7 max-[860px]:px-4">
            <PageHeader
              actions={<ThemeToggle />}
              crumbs={[{ label: "BoMesh", href: "/" }]}
              sub="Tokens and components used by every screen. Development builds only."
              title="Design system"
            />
            <ThemesSection />
            <ColorSection />
            <TypographySection />
            <ScaleSection />
            <ButtonsSection />
            <InputsSection />
            <SelectionSection />
            <StatusSection />
            <NavigationSection />
            <TableSection />
            <OverlaysSection />
            <FeedbackSection />
            <StatesSection />
            <EvidenceSection />
            <IdentitySection />
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}

/** The prototype's header action: flip between light and dark. */
function ThemeToggle() {
  const { updatePreferences } = useAccountPreferences();
  const dark = useRootAppearance().startsWith("dark");
  return (
    <Button
      icon={dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      onClick={() => updatePreferences({ theme: dark ? "light" : "dark" })}
      variant="secondary"
    >
      {dark ? "Light theme" : "Dark theme"}
    </Button>
  );
}
