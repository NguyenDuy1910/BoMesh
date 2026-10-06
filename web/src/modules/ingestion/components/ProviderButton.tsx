"use client";

import { Button } from "@/components/ui/Button";
import type { ConnectorEntry } from "@/modules/ingestion/queries";

import { AppIcon } from "./AppIcon";

/** Who a connector's accounts sign in with, when the registry does not say. */
const KNOWN_PROVIDERS: Record<string, { key: string; name: string }> = {
  google_drive: { key: "google", name: "Google" },
  confluence: { key: "atlassian", name: "Atlassian" },
};

/** The identity provider behind a connector: "Google" for Drive, "Atlassian" for Confluence. */
export function providerOf(connectorKey: string, entry?: ConnectorEntry): { key: string; name: string } {
  const capability = entry?.capability;
  if (capability?.provider_key && capability.provider_display_name) {
    return { key: capability.provider_key, name: capability.provider_display_name };
  }
  return KNOWN_PROVIDERS[connectorKey] ?? { key: connectorKey, name: entry?.connector.name ?? connectorKey };
}

/** "Continue with Google": the button that opens a provider's sign-in window. */
export function ProviderButton({
  connectorKey,
  provider,
  label,
  onClick,
  loading,
}: {
  connectorKey: string;
  provider: { key: string; name: string };
  label?: string;
  onClick: () => void;
  loading?: boolean;
}) {
  return (
    <Button
      icon={
        <AppIcon
          className="size-5 rounded-full"
          connector={provider.key === "google" ? "google" : connectorKey}
          size="xs"
        />
      }
      loading={loading}
      onClick={onClick}
    >
      {label ?? `Continue with ${provider.name}`}
    </Button>
  );
}
