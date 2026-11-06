"use client";

import { useEffect } from "react";

import { closeIngestionOverlay, useIngestionOverlay } from "../overlays";
import { ConnectAccountDialog, ReconnectDialog } from "./AccountDialogs";
import { ConnectWizard } from "./ConnectWizard";

/** Renders the open ingestion dialog (wizard, Connect account, Reconnect). Mounted by /sources and /connections. */
export function IngestionDialogs() {
  const overlay = useIngestionOverlay();
  useEffect(() => closeIngestionOverlay, []);
  if (!overlay) return null;
  if (overlay.kind === "wizard") return <ConnectWizard options={overlay.options} />;
  if (overlay.kind === "connect") return <ConnectAccountDialog connector={overlay.options.connector} />;
  return <ReconnectDialog connection={overlay.connection} />;
}
