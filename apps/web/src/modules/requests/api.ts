import { api, call, listAll, requestId, resourceId } from "@/lib/api/client";

import type { Request, RequestMessage, RequestType } from "./model";

/**
 * Requests API (`/api/v1/workspaces/{w}/requests…`, api_design.md §8). Every
 * function takes the bare workspace ID first; `request` accepts a bare ID or a name.
 * Spaces, space members and request-type lists come from `@/modules/spaces/api`.
 */

const rq = (workspace: string, request: string) => ({ workspace, request: resourceId(request) });

/** SERVICE and QUESTION requests the caller filed or may decide, most recently updated first. */
export function listRequests(workspace: string): Promise<Request[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/requests", {
          params: { path: { workspace }, query: { pageSize: 200, pageToken, filter: 'kind = "SERVICE" OR kind = "QUESTION"', orderBy: "updateTime desc" } },
        }),
      ),
    (page) => page.requests,
    2000,
  );
}

export function getRequest(workspace: string, request: string): Promise<Request> {
  return call(api.GET("/api/v1/workspaces/{workspace}/requests/{request}", { params: { path: rq(workspace, request) } }));
}

/** CreateRequest; `validateOnly` returns the request with `eligibility` without filing it. */
export function createRequest(workspace: string, body: Request, { validateOnly = false }: { validateOnly?: boolean } = {}): Promise<Request> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests", {
      params: { path: { workspace }, query: validateOnly ? { validateOnly: true } : { requestId: requestId() } },
      body,
    }),
  );
}

/** UpdateRequest — deciders set `assignee` (`""` unassigns). */
export function setAssignee(workspace: string, request: string, assignee: string | null): Promise<Request> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/requests/{request}", {
      params: { path: rq(workspace, request), query: { updateMask: "assignee" } },
      body: { kind: "SERVICE", assignee: assignee ?? "" },
    }),
  );
}

export function listRequestMessages(workspace: string, request: string): Promise<RequestMessage[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/requests/{request}/messages", {
          params: { path: rq(workspace, request), query: { pageSize: 200, pageToken, orderBy: "createTime" } },
        }),
      ),
    (page) => page.messages,
    5000,
  );
}

/** A requester message on a NEEDS_INFO request returns it to OPEN. */
export function createRequestMessage(workspace: string, request: string, text: string): Promise<RequestMessage> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests/{request}/messages", {
      params: { path: rq(workspace, request), query: { requestId: requestId() } },
      body: { text },
    }),
  );
}

export function approveRequest(workspace: string, request: string, message?: string): Promise<Request> {
  return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:approve", { params: { path: rq(workspace, request) }, body: { message: message || undefined } }));
}

export function denyRequest(workspace: string, request: string, message: string): Promise<Request> {
  return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:deny", { params: { path: rq(workspace, request) }, body: { message } }));
}

/** Ask for information: OPEN → NEEDS_INFO. */
export function sendBackRequest(workspace: string, request: string, message: string): Promise<Request> {
  return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:sendBack", { params: { path: rq(workspace, request) }, body: { message } }));
}

/** → ANSWERED; `publishToCollection` adds the answer to that collection as a document (`faqItem`). */
export function answerRequest(workspace: string, request: string, answer: string, publishToCollection?: string): Promise<Request> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests/{request}:answer", {
      params: { path: rq(workspace, request) },
      body: { answer, publishToCollection: publishToCollection || undefined },
    }),
  );
}

/** Mark completed: OPEN, NEEDS_INFO, APPROVED or ANSWERED → CLOSED. */
export function closeRequest(workspace: string, request: string): Promise<Request> {
  return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:close", { params: { path: rq(workspace, request) }, body: {} }));
}

export function withdrawRequest(workspace: string, request: string): Promise<Request> {
  return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:withdraw", { params: { path: rq(workspace, request) }, body: {} }));
}

/** One request type by name (soft-deleted ones included, so old requests keep their labels). */
export function getRequestType(name: string): Promise<RequestType> {
  const parts = name.split("/");
  return call(
    api.GET("/api/v1/workspaces/{workspace}/spaces/{space}/requestTypes/{requestType}", {
      params: { path: { workspace: parts[1], space: parts[3], requestType: parts[5] } },
    }),
  );
}
