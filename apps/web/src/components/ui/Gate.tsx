"use client";

import type { ReactNode } from "react";
import { ErrorState } from "./ErrorState";
import { SkeletonRows } from "./SkeletonRows";

/** The part of a react-query result `Gate` reads (any `useQuery`/`useInfiniteQuery` result fits). */
export interface GateQuery<T> {
  data?: T;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

export interface GateProps<T> {
  /** A react-query result. */
  query: GateQuery<T>;
  /** Loading placeholder (default `<SkeletonRows/>`). */
  skeleton?: ReactNode;
  /** Whether the loaded data is empty; a predicate receives the data. */
  isEmpty?: boolean | ((data: T) => boolean);
  /** Rendered when `isEmpty` holds (an `EmptyState` or `NoMatches`). */
  empty?: ReactNode;
  /** Overrides the default `ErrorState` (receives the error and a retry). */
  error?: (error: unknown, retry: () => unknown) => ReactNode;
  /** Loaded content; a function receives the data. */
  children: ReactNode | ((data: T) => ReactNode);
}

/**
 * Loading / error / empty wrapper for a data region (preview `gate()`).
 * Data already on screen stays visible during background refetch failures.
 */
export function Gate<T>({ query, skeleton, isEmpty, empty, error, children }: GateProps<T>) {
  const { data } = query;
  if (data === undefined) {
    if (query.isError) return <>{error ? error(query.error, query.refetch) : <ErrorState error={query.error} onRetry={query.refetch} />}</>;
    if (query.isPending) return <>{skeleton ?? <SkeletonRows />}</>;
  }
  const loaded = data as T;
  const emptyNow = typeof isEmpty === "function" ? isEmpty(loaded) : isEmpty;
  if (emptyNow && empty !== undefined) return <>{empty}</>;
  return <>{typeof children === "function" ? children(loaded) : children}</>;
}
