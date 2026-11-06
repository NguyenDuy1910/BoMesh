"use client";

import { ClipboardList, MessageCircle } from "lucide-react";

import { ItemIcon, ListItem } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useMember } from "@/modules/knowledge/queries";

import { isOpen, isQuestion, relIn, requestTitle, type Request } from "../model";
import { useRequestType, useSpaceMap } from "../queries";
import { RequestStatusChip } from "./RequestStatus";

/**
 * One request as a list row (preview `X.requestItem`) for My requests, Home and Spaces.
 * Resolves its type, space and requester names from cached queries.
 */
export function RequestRow({ request }: { request: Request }) {
  const { member } = useWorkspace();
  const mine = request.requester === member.name;
  const type = useRequestType(request.requestType).data;
  const space = useSpaceMap().get(request.space ?? "");
  const requester = useMember(mine ? undefined : request.requester).data;
  const needs = mine && request.state === "NEEDS_INFO";
  const description = [
    !mine && (requester?.displayName || "Someone"),
    isQuestion(request) ? `Question · ${space?.displayName ?? ""}` : space?.displayName,
    `Updated ${relIn(request.updateTime ?? request.createTime)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ListItem
      className="rq-item"
      lead={<ItemIcon icon={isQuestion(request) ? MessageCircle : ClipboardList} tone={needs ? "warning" : isOpen(request) ? "accent" : undefined} />}
      title={requestTitle(request, type)}
      contentTitle={isQuestion(request) || !!request.title}
      description={description}
      actions={<RequestStatusChip request={request} mine={mine} space={space} />}
      href={`/requests/${resourceId(request.name)}`}
      unread={needs}
    />
  );
}
