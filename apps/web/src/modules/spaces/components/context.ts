import type { SpacePermission } from "../api";
import type { Space, SpaceTypeDef } from "../types";

/** What a space tab knows about the space and the caller (preview `ctx`). */
export interface SpaceView {
  space: Space;
  /** Bare space ID. */
  sid: string;
  type: SpaceTypeDef;
  /** The caller's space role, or null. */
  role: string | null;
  /** Lead or staff: answer questions, publish work, handle requests. */
  staff: boolean;
  /** May change the space (lead or workspace admin): Settings, people, roles. */
  manage: boolean;
  /** Not a member and not a manager (open spaces only reach the page). */
  visitor: boolean;
  can: (permission: SpacePermission) => boolean;
}
