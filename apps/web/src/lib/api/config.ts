const localDevelopmentApiUrl = "http://127.0.0.1:8000";

/**
 * The API origin. Local development defaults to the backend's port so the web
 * client starts without an environment file; other environments set
 * `NEXT_PUBLIC_BOMESH_API_URL`. Identity is only ever the bearer token
 * (auth_contract.md "Client session boundary").
 */
export function getApiUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_BOMESH_API_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  return process.env.NODE_ENV === "development" ? localDevelopmentApiUrl : null;
}
