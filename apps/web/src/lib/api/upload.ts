"use client";

import { getApiConfiguration, requestIdentityHeaders } from "@/lib/api/config";
import { ApiError } from "@/lib/api/request";
import { appBrand } from "@/lib/brand";

/**
 * Upload one local file into a collection (`POST /collections/{id}/documents`,
 * multipart). The original is stored and registered as a pending document;
 * nothing is processed until an ingestion run asks. XHR rather than `fetch`
 * so the caller can show upload progress.
 */
export function uploadCollectionFile<T>(
  collectionId: string,
  file: File,
  /** `onProgress` receives the fraction of the file sent so far (0–1). */
  options: { idempotencyKey: string; onProgress?: (fraction: number) => void },
): Promise<T> {
  const configuration = getApiConfiguration();
  if (!configuration) {
    return Promise.reject(new ApiError(
      `${appBrand.productName} is not configured. Set the API, tenant, and user environment values.`,
    ));
  }

  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file, file.name);
    request.open(
      "POST",
      `${configuration.apiUrl}/api/v1/collections/${encodeURIComponent(collectionId)}/documents`,
    );
    request.responseType = "json";
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("Idempotency-Key", options.idempotencyKey);
    for (const [name, value] of Object.entries(requestIdentityHeaders(configuration))) {
      request.setRequestHeader(name, value);
    }
    if (options.onProgress) {
      const report = options.onProgress;
      request.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) report(event.loaded / event.total);
      };
    }
    request.onerror = () => reject(new ApiError(`The upload could not reach the ${appBrand.productName} API.`));
    request.onload = () => {
      const payload = request.response as { detail?: unknown } | T | null;
      if (request.status >= 200 && request.status < 300) {
        resolve(payload as T);
        return;
      }
      const detail = payload && typeof payload === "object" && "detail" in payload && typeof payload.detail === "string"
        ? payload.detail
        : `Upload failed with status ${request.status}`;
      reject(new ApiError(detail, request.status));
    };
    request.send(form);
  });
}
