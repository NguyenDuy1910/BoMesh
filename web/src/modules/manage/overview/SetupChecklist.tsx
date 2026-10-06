"use client";

import { Check } from "lucide-react";

import { ButtonLink } from "@/components/ui/Button";
import { ui } from "@/components/ui/design-system";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { Progress } from "@/components/ui/Progress";
import { cn } from "@/lib/cn";

export interface SetupStep {
  id: string;
  title: string;
  description: string;
  done: boolean;
  /** Where the step is done; null when the caller cannot do it themselves. */
  action: { label: string; href: string } | null;
  /** Where a finished step's result is seen. */
  view?: string;
  /** Shown when the step's state comes from a pending API. */
  preview?: boolean;
}

/**
 * A new workspace's first steps, each ticked from real state. The first open
 * step the caller can do carries the page's primary button.
 */
export function SetupChecklist({
  workspaceName,
  steps,
  primary,
}: {
  workspaceName: string;
  steps: readonly SetupStep[];
  /** False when another part of the page already holds the primary button. */
  primary: boolean;
}) {
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done && step.action);

  return (
    <section aria-labelledby="overview-setup" className={cn(ui.card, "mx-auto mt-1 mb-7 max-w-[640px] overflow-hidden")}>
      <div className="px-5 py-4.5">
        <h2 className={ui.sectionTitle} id="overview-setup">Set up {workspaceName}</h2>
        <div className="mt-2.5 flex items-center gap-3">
          <Progress className="flex-1" label={`Setup of ${workspaceName}`} value={(done / steps.length) * 100} />
          <span className="whitespace-nowrap text-meta tabular-nums text-text-tertiary">
            {done} of {steps.length} done
          </span>
        </div>
      </div>
      <ol>
        {steps.map((step) => (
          <li className="flex items-center gap-3.5 border-t border-border-subtle px-5 py-3.5" key={step.id}>
            <span
              aria-hidden="true"
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full border-[1.5px]",
                step.done ? "border-status-success bg-status-success text-text-inverse" : "border-border-strong",
              )}
            >
              {step.done && <Check className="size-3.5" strokeWidth={3} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("flex items-center gap-2 text-body font-medium", step.done ? "text-text-secondary" : "text-text-primary")}>
                {step.title}
                {step.done && <span className="sr-only"> (done)</span>}
                {step.preview && <PreviewTag />}
              </p>
              <p className="text-meta text-text-tertiary">{step.description}</p>
            </div>
            {step.done
              ? step.view && <ButtonLink href={step.view} size="sm" variant="ghost">View</ButtonLink>
              : step.action && (
                <ButtonLink href={step.action.href} size="sm" variant={primary && step === next ? "primary" : "secondary"}>
                  {step.action.label}
                </ButtonLink>
              )}
          </li>
        ))}
      </ol>
    </section>
  );
}
