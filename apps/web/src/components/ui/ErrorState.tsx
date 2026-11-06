"use client";

import { Button } from "@heroui/react";
import { AlertCircle, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api/client";
import { EmptyState } from "./EmptyState";

const DEFAULT_TITLE = "This didn’t load";
const DEFAULT_DESCRIPTION = "Check your connection and try again. Nothing was lost.";

export interface ErrorStateProps {
  /** The failure; a client-side API error (4xx) shows the server's message, anything else the generic copy. */
  error?: unknown;
  /** Retry handler (e.g. react-query `refetch`); the button shows progress while a returned promise runs. */
  onRetry?: () => unknown;
  title?: ReactNode;
  description?: ReactNode;
  /** Card surface around the state (default true, as in the preview). */
  boxed?: boolean;
  compact?: boolean;
}

/** Load failure (preview `errorState()`): danger icon tile, plain copy, "Try again". */
export function ErrorState({ error, onRetry, title = DEFAULT_TITLE, description, boxed = true, compact }: ErrorStateProps) {
  const [retrying, setRetrying] = useState(false);
  const detail = description ?? (error instanceof ApiError && error.status < 500 ? error.message : DEFAULT_DESCRIPTION);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry?.();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <EmptyState
      icon={AlertCircle}
      tone="danger"
      title={title}
      description={detail}
      boxed={boxed}
      compact={compact}
      actions={
        onRetry ? (
          <Button variant="tertiary" isPending={retrying} onPress={retry}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}
