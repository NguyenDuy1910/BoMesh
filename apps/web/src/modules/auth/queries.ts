"use client";

import { useCallback, useRef, useState } from "react";

import { getAuthSession } from "@/lib/auth/session";
import { ApiError } from "@/lib/api/request";
import { switchWorkspace as requestWorkspaceSwitch } from "@/modules/auth/api";

/**
 * Switch exactly one workspace at a time and retain a recoverable error beside
 * the control that initiated the change.
 */
export function useWorkspaceSwitch() {
  const requestInFlight = useRef(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    const current = getAuthSession();
    if (!current) {
      setError("Your session has expired. Please sign in again.");
      return false;
    }
    if (workspaceId === current.active_workspace_id) return true;
    if (requestInFlight.current) return false;

    requestInFlight.current = true;
    setSwitchingId(workspaceId);
    setError(null);
    try {
      await requestWorkspaceSwitch(workspaceId);
      return true;
    } catch (cause) {
      // The API's detail names internal ids; say what happened instead.
      setError(
        cause instanceof ApiError && cause.status === 403
          ? "You’re no longer a member of that workspace. Ask its admin to add you again."
          : cause instanceof ApiError && cause.status === 401
            ? "Your session has expired. Please sign in again."
            : cause instanceof ApiError && cause.status === undefined
              ? cause.message
              : "The workspace couldn’t be opened. Try again in a moment.",
      );
      return false;
    } finally {
      requestInFlight.current = false;
      setSwitchingId(null);
    }
  }, []);

  return { error, switchingId, switchWorkspace };
}
