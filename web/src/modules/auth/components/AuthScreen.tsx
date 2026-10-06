import { BookOpen, FileText, GitBranch, Link2, Lock, ShieldCheck, Sparkles, Users } from "lucide-react";

import { ProductMark } from "@/components/ui/ProductMark";
import { appBrand } from "@/lib/brand";
import { cn } from "@/lib/cn";

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
      className="auth-mesh relative hidden flex-col justify-between overflow-hidden p-12 text-(--auth-art-text) [background:var(--auth-art-background)] min-[1100px]:flex"
    >
      <BrandLine className="auth-mesh__brand" />
      <div className="auth-mesh__body">
        <p className="auth-mesh__eyebrow">One trusted knowledge layer</p>
        <p className="auth-mesh__title">
          Your company’s knowledge, <em>alive and connected.</em>
        </p>
        <p className="auth-mesh__subtitle">
          {appBrand.productName} links every approved source into a living knowledge mesh—so every answer arrives with
          context, lineage, and evidence.
        </p>

        <figure
          aria-label="Product, customer, security, and engineering knowledge connected into one grounded answer"
          className="auth-mesh__stage"
          role="img"
        >
          <svg aria-hidden="true" className="auth-mesh__links" preserveAspectRatio="none" viewBox="0 0 540 300">
            <defs>
              <linearGradient id="auth-mesh-line" x1="0" x2="1" y1="0" y2="1">
                <stop stopColor="var(--auth-mesh-violet)" />
                <stop offset=".52" stopColor="var(--auth-mesh-blue)" />
                <stop offset="1" stopColor="var(--auth-mesh-cyan)" />
              </linearGradient>
            </defs>
            <path className="auth-mesh__link auth-mesh__link--bright" d="M98 70 C180 62 188 128 270 156" />
            <path className="auth-mesh__link" d="M444 64 C356 70 350 119 270 156" />
            <path className="auth-mesh__link" d="M104 238 C174 224 196 186 270 156" />
            <path className="auth-mesh__link auth-mesh__link--bright" d="M438 232 C358 222 344 180 270 156" />
            <path className="auth-mesh__link" d="M98 70 C188 8 352 8 444 64" />
            <path className="auth-mesh__link" d="M104 238 C206 286 342 280 438 232" />
            <circle className="auth-mesh__link-dot" cx="168" cy="87" r="2.4" />
            <circle className="auth-mesh__link-dot" cx="370" cy="88" r="2.4" />
            <circle className="auth-mesh__link-dot" cx="365" cy="209" r="2.4" />
          </svg>

          <div className="auth-mesh__node auth-mesh__node--product">
            <FileText aria-hidden="true" />
            <span>
              <b>Product knowledge</b>
              <small>Roadmaps &amp; specifications</small>
            </span>
          </div>
          <div className="auth-mesh__node auth-mesh__node--customer">
            <Users aria-hidden="true" />
            <span>
              <b>Customer context</b>
              <small>Research &amp; insights</small>
            </span>
          </div>
          <div className="auth-mesh__node auth-mesh__node--security">
            <ShieldCheck aria-hidden="true" />
            <span>
              <b>Security policies</b>
              <small>Controls &amp; guidance</small>
            </span>
          </div>
          <div className="auth-mesh__node auth-mesh__node--engineering">
            <BookOpen aria-hidden="true" />
            <span>
              <b>Engineering memory</b>
              <small>Decisions &amp; runbooks</small>
            </span>
          </div>

          <div className="auth-mesh__core">
            <span className="auth-mesh__core-icon">
              <Sparkles aria-hidden="true" />
            </span>
            <b>Grounded answer</b>
            <span>Connected across trusted sources</span>
            <span className="auth-mesh__core-proof">
              <Link2 aria-hidden="true" />
              Evidence attached
            </span>
          </div>
        </figure>

        <p className="auth-mesh__permission">
          <ShieldCheck aria-hidden="true" />
          <span>
            <b>Permission-aware by design.</b> People only discover knowledge they can access.
          </span>
        </p>
      </div>
      <div className="auth-mesh__footer">
        <span>
          <Lock aria-hidden="true" />
          Private to your workspace
        </span>
        <span>
          <GitBranch aria-hidden="true" />
          Every answer stays traceable
        </span>
      </div>
    </aside>
  );
}
