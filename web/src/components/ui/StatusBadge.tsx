import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";

interface StatusPresentation {
  label: string;
  tone: StatusTone;
  /** True while the backend is still working on this record. */
  moving?: boolean;
}

/**
 * The single place a backend status string becomes something an administrator
 * reads. Adding a status to the backend without adding it here shows the raw
 * value in title case rather than inventing a colour for it.
 */
const statuses: Record<string, StatusPresentation> = {
  // Lifecycle shared by users, groups, roles, policies, connections, sources.
  active: { label: "Active", tone: "success" },
  inactive: { label: "Inactive", tone: "neutral" },
  disabled: { label: "Disabled", tone: "neutral" },
  draft: { label: "Draft", tone: "neutral" },
  paused: { label: "Paused", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
  error: { label: "Error", tone: "danger" },

  // Content processing: a pending document waits for someone to run processing.
  pending: { label: "Pending", tone: "neutral" },
  processing: { label: "Processing", tone: "info", moving: true },
  ready: { label: "Ready", tone: "success" },
  outdated: { label: "Outdated", tone: "warning" },
  unsupported: { label: "Unsupported file", tone: "warning" },

  // Runs.
  running: { label: "Running", tone: "info", moving: true },
  syncing: { label: "Syncing", tone: "info", moving: true },
  completed: { label: "Completed", tone: "success" },
  succeeded: { label: "Succeeded", tone: "success" },
  success: { label: "Success", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  failure: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  terminated: { label: "Terminated", tone: "neutral" },
  timed_out: { label: "Timed out", tone: "warning" },

  // Access requests.
  approved: { label: "Approved", tone: "success" },
  denied: { label: "Denied", tone: "danger" },

  // Connectivity.
  connected: { label: "Connected", tone: "success" },
  available: { label: "Available", tone: "neutral" },
  unknown: { label: "Unknown", tone: "neutral" },
};

/**
 * A domain's own reading of a status string.
 *
 * The dictionary above is the product-wide vocabulary, and one backend word
 * can mean different things in different places: `pending` is "Pending" for a
 * document waiting to be processed, but "Review" for a workspace waiting on an
 * administrator. A domain passes its own entries rather than forking the
 * component or inventing a second badge.
 */
export type StatusVocabulary = Record<string, StatusPresentation>;

function statusPresentation(
  status?: string | null,
  vocabulary?: StatusVocabulary,
): StatusPresentation {
  const key = String(status ?? "").toLowerCase().trim();
  return (
    vocabulary?.[key] ??
    statuses[key] ?? {
      label: key
        ? key.replaceAll(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : "Unknown",
      tone: "neutral",
    }
  );
}

/** A backend status string, rendered with the product-wide state visual. */
export function StatusBadge({
  status,
  label,
  className,
  vocabulary,
}: {
  status?: string | null;
  /** Overrides the derived label while keeping the derived colour. */
  label?: string;
  className?: string;
  /** This domain's reading of the status, checked before the shared one. */
  vocabulary?: StatusVocabulary;
}) {
  const presentation = statusPresentation(status, vocabulary);
  return (
    <StatusPill className={className} pulse={presentation.moving} tone={presentation.tone}>
      {label ?? presentation.label}
    </StatusPill>
  );
}
