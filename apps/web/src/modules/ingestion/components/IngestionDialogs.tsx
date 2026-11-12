"use client";

import { useIngestionOverlay, useIsDialogHost } from "../overlays";
import { ConnectAccountDialog, ReconnectDialog } from "./AccountDialogs";
import { ConnectWizard } from "./ConnectWizard";

/** Renders the open ingestion dialog (Add source wizard, Connect account, Reconnect); only the first mounted instance draws it. */
export function IngestionDialogs() {
  const overlay = useIngestionOverlay();
  const host = useIsDialogHost();
  if (!overlay || !host) return null;
  if (overlay.kind === "wizard") return <ConnectWizard options={overlay.options} />;
  if (overlay.kind === "connect") return <ConnectAccountDialog connector={overlay.options.connector} />;
  return <ReconnectDialog connection={overlay.connection} />;
}
