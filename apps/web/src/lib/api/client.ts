"use client";

import createClient, { type Middleware } from "openapi-fetch";

import type { components, paths } from "@/lib/api/schema";
import { getApiUrl } from "@/lib/api/config";
import { handleUnauthenticated, sessionToken } from "@/lib/session";

/**
 * The one boundary to the BoMesh API (`/api/v1`, backend/docs_design/openapi.yaml).
 *
 * `schema.d.ts` is generated from the contract (`bun run api:types`), so a call
 * to a path, parameter or field the contract does not define fails to compile.
 * Every request carries only `Authorization: Bearer …` (auth_contract.md
 * "Client session boundary"); a 401 for the current token signs the UI out.
 */
export type Schemas = components["schemas"];
export type Schema<K extends keyof Schemas> = Schemas[K];

/** google.rpc.Status as the API returns it (`{ error: Status }`). */
export class ApiError extends Error {
  readonly status: number;
  /** Canonical code name, e.g. `NOT_FOUND`, `FAILED_PRECONDITION`. */
  readonly code: string;
  /** ErrorInfo reason, e.g. `INVALID_CREDENTIALS`, when the API gave one. */
  readonly reason?: string;
  readonly metadata: Record<string, string>;
  readonly fieldViolations: { field: string; description: string }[];

  constructor(
    message: string,
    status: number,
    code: string,
    reason?: string,
    metadata: Record<string, string> = {},
    fieldViolations: { field: string; description: string }[] = [],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.metadata = metadata;
    this.fieldViolations = fieldViolations;
  }

  /** A resource the caller cannot read answers exactly like an absent one. */
  get isNotFound() {
    return this.status === 404 || this.status === 403;
  }
}

/** The network or the API address failed before any status came back. */
export class ApiUnreachableError extends Error {
  constructor() {
    super("BoMesh can't be reached right now. Check your connection and try again.");
    this.name = "ApiUnreachableError";
  }
}

interface StatusDetail {
  "@type"?: string;
  reason?: string;
  metadata?: Record<string, string>;
  fieldViolations?: { field: string; description: string }[];
}

export function toApiError(status: number, payload: unknown): ApiError {
  const body = (payload ?? {}) as { error?: { message?: string; status?: string; details?: StatusDetail[] } };
  const error = body.error ?? {};
  const details = error.details ?? [];
  const info = details.find((d) => d["@type"]?.endsWith("google.rpc.ErrorInfo"));
  const badRequest = details.find((d) => d["@type"]?.endsWith("google.rpc.BadRequest"));
  return new ApiError(
    error.message || `The request failed (${status}).`,
    status,
    error.status || "UNKNOWN",
    info?.reason,
    info?.metadata ?? {},
    badRequest?.fieldViolations ?? [],
  );
}

const auth: Middleware = {
  onRequest({ request }) {
    const token = sessionToken();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
  onResponse({ request, response }) {
    if (response.status === 401) handleUnauthenticated(request.headers.get("Authorization"));
    return response;
  },
};

function baseUrl() {
  return getApiUrl() ?? "";
}

/** Typed client: `api.GET("/api/v1/workspaces/{workspace}/items", { params: … })`. */
export const api = createClient<paths>({
  // `NEXT_PUBLIC_*` values are inlined at build time, so the origin is fixed per build.
  baseUrl: baseUrl(),
  // Pass the Request through untouched: re-wrapping it would turn the body into a stream upload.
  fetch: (request: Request) =>
    fetch(request).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new ApiUnreachableError();
    }),
  querySerializer: { array: { style: "form", explode: true } },
});
api.use(auth);

/**
 * Unwraps an openapi-fetch result: returns `data` or throws `ApiError`.
 *
 * `const workspace = await call(api.GET("/api/v1/workspaces/{workspace}", …));`
 */
export async function call<T>(
  pending: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await pending;
  if (!response.ok) throw toApiError(response.status, error);
  return data as T;
}

/**
 * Raw authorized fetch for what openapi-fetch cannot model: Server-Sent Events
 * (`:converse`), media uploads (`/upload/api/v1/…`) and `alt=media` downloads.
 * Throws `ApiError` for non-2xx responses.
 */
export async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = sessionToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, { ...init, headers, cache: "no-store" });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiUnreachableError();
  }
  if (response.status === 401) handleUnauthenticated(headers.get("Authorization"));
  if (!response.ok) {
    throw toApiError(response.status, await response.json().catch(() => null));
  }
  return response;
}

/** Absolute URL for links the browser opens itself (e.g. `?alt=media`). */
export function apiUrl(path: string): string {
  return `${baseUrl()}${path}`;
}

/** Plain-language message for any thrown value, for error states and toasts. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof ApiUnreachableError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

/**
 * Reads every page of an AIP-158 list. `fetchPage(pageToken)` returns the
 * response; `pick` selects the repeated field.
 */
export async function listAll<R extends { nextPageToken?: string }, T>(
  fetchPage: (pageToken: string | undefined) => Promise<R>,
  pick: (response: R) => T[] | undefined,
  limit = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const page = await fetchPage(token);
    out.push(...(pick(page) ?? []));
    token = page.nextPageToken || undefined;
  } while (token && out.length < limit);
  return out;
}

/** Last segment of a resource name: `workspaces/w/items/abc` → `abc`. */
export function resourceId(name: string | undefined | null): string {
  if (!name) return "";
  const i = name.lastIndexOf("/");
  return i < 0 ? name : name.slice(i + 1);
}

/** A fresh AIP-155 `requestId` for idempotent writes. */
export function requestId(): string {
  return crypto.randomUUID();
}
