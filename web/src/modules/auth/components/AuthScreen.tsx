import { MessageSquare } from "lucide-react";

import { ProductMark } from "@/components/ui/ProductMark";
import { appBrand } from "@/lib/brand";
import { cn } from "@/lib/cn";

/** Text on the always-dark art panel, as a share of `--auth-art-text`. */
const artMuted = "text-[color-mix(in_srgb,var(--auth-art-text)_64%,transparent)]";
const artFaint = "text-[color-mix(in_srgb,var(--auth-art-text)_52%,transparent)]";

/**
 * The signed-out frame: the product's promise on a dark panel beside the form
 * (wide screens), the form alone below 1100px. `art={false}` is the bare
 * centred card the workspace picker uses.
 */
export function AuthScreen({ children, art = true }: { children: React.ReactNode; art?: boolean }) {
  return (
    <div
      className={cn(
        "grid min-h-dvh grid-cols-1",
        art ? "bg-surface-base min-[1100px]:grid-cols-2" : "bg-surface-canvas",
      )}
    >
      {art && <AuthArt />}
      <main className="flex items-center justify-center px-6 py-12" id="main-content">
        <div className={cn("w-full", art ? "max-w-[380px]" : "max-w-[460px]")}>{children}</div>
      </main>
    </div>
  );
}

/** Title block shared by every auth card. */
export function AuthHeading({ title, sub, aside }: { title: string; sub?: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        <h1 className="text-title font-semibold tracking-[-0.02em] text-text-primary">{title}</h1>
        {aside}
      </div>
      {sub && <p className="mt-1.5 text-body text-text-secondary">{sub}</p>}
    </div>
  );
}

export function BrandLine({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5 text-base font-semibold tracking-[-0.01em]", className)}>
      <ProductMark decorative size="sm" />
      {appBrand.productName}
    </div>
  );
}

function AuthArt() {
  return (
    <aside
      aria-label={`About ${appBrand.productName}`}
      className="relative hidden flex-col justify-between overflow-hidden p-12 text-(--auth-art-text) [background:var(--auth-art-background)] min-[1100px]:flex"
    >
      <BrandLine />
      <div>
        <p className="max-w-[460px] text-[1.875rem] font-semibold leading-[1.15] tracking-[-0.025em]">
          Answers your company can stand behind.
        </p>
        <p className={cn("mt-3 max-w-[420px] text-[0.9375rem] leading-relaxed", artMuted)}>
          Every answer cites the documents it came from — and only the ones you’re allowed to see.
        </p>
        {/* An illustration of a cited answer, not an interactive citation. */}
        <figure
          aria-hidden="true"
          className="mt-8 max-w-[440px] rounded-2xl border border-[color-mix(in_srgb,var(--auth-art-text)_8%,transparent)] bg-[color-mix(in_srgb,var(--auth-art-text)_4%,transparent)] p-5 text-[0.90625rem] leading-[1.65] text-[color-mix(in_srgb,var(--auth-art-text)_86%,transparent)]"
        >
          <div className={cn("mb-2.5 flex items-center gap-2 text-[0.8125rem]", artMuted)}>
            <MessageSquare className="size-4" />
            What’s the per diem for international travel?
          </div>
          The meal per diem is <b className="font-semibold text-(--auth-art-text)">USD 75 per day</b> and replaces
          itemized meal receipts{" "}
          <span className="inline-flex h-[18px] min-w-[19px] items-center justify-center rounded-[5px] bg-[color-mix(in_srgb,var(--evidence-line)_20%,transparent)] px-[5px] align-[2px] font-mono text-[11px] font-semibold leading-none text-[var(--evidence-line)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--evidence-line)_50%,transparent)]">
            1
          </span>
          <div className="mt-3.5 rounded-r-lg border-l-[3px] border-[var(--evidence-line)] bg-[color-mix(in_srgb,var(--evidence-line)_10%,transparent)] px-3 py-2.5 text-meta text-[color-mix(in_srgb,var(--auth-art-text)_88%,transparent)]">
            <small className={cn("mb-1 block text-caption", artMuted)}>Travel &amp; Expense Policy · page 4</small>
            Employees traveling internationally receive a meal per diem of USD 75 per calendar day.
          </div>
        </figure>
      </div>
      <p className={cn("text-meta", artFaint)}>Permissions follow your sources. Nothing leaves your workspace.</p>
    </aside>
  );
}
