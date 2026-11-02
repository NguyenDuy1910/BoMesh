import { Lock } from "lucide-react";

import { Page } from "@/components/shell/Page";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * What a caller sees on an address they may not open (prototype `noAccess()`).
 * It never says which permission is missing — the sidebar already shows
 * everything this person can use.
 */
export function NoAccess() {
  return (
    <Page>
      <EmptyState
        action={(
          <>
            <ButtonLink href="/knowledge" variant="primary">Go to Knowledge</ButtonLink>
            <ButtonLink href="/chat">New chat</ButtonLink>
          </>
        )}
        description="Ask a workspace admin if you need it. Everything you can use is in the sidebar."
        icon={<Lock aria-hidden="true" />}
        title="You don’t have access to this page"
      />
    </Page>
  );
}
