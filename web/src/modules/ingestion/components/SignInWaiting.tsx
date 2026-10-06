"use client";

import { ExternalLink, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/Button";

/**
 * What a dialog says while a provider's sign-in window is open somewhere else.
 *
 * A window that slipped behind this one looks like nothing happened, so the
 * state is named and the one action that resolves it — bring that window
 * back — is offered. Cancelling lives in the dialog footer.
 */
export function SignInWaiting({
  provider,
  description,
  onFocus,
}: {
  /** "Google", "Atlassian". */
  provider: string;
  description: string;
  onFocus: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-9 text-center" role="status">
      <LoaderCircle aria-hidden="true" className="size-6 text-accent-primary motion-safe:animate-spin" />
      <p className="text-section font-semibold text-text-primary">Finish signing in in the {provider} window</p>
      <p className="max-w-[340px] text-meta text-text-secondary">{description}</p>
      <Button className="mt-2" icon={<ExternalLink />} onClick={onFocus} size="sm" variant="secondary">
        Show that window
      </Button>
    </div>
  );
}
