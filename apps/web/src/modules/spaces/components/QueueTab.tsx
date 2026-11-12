"use client";

import { RequestQueue } from "@/modules/requests";

import type { SpaceView } from "./context";

/** Queue (preview `queueTab`, staff): the Requests queue, scoped to this space. */
export function QueueTab({ view }: { view: SpaceView }) {
  return <RequestQueue space={view.space.name ?? ""} />;
}
