import { Zap } from "lucide-react";

import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";
import { auditActorName, type AuditActor } from "@/modules/manage/activity/audit-actions";

const SYSTEM_SIZE = { xs: "size-5", sm: "size-6", md: "size-7", lg: "size-9" } as const;

/** The person's avatar, or BoMesh's mark for events BoMesh did itself. */
export function ActorAvatar({ actor, size = "sm" }: { actor: AuditActor; size?: keyof typeof SYSTEM_SIZE }) {
  if (actor.id || actor.email) return <Avatar name={auditActorName(actor)} size={size} />;
  return (
    <span
      aria-hidden="true"
      className={cn("grid shrink-0 place-items-center rounded-full bg-accent-soft text-text-accent [&_svg]:size-3", SYSTEM_SIZE[size])}
    >
      <Zap />
    </span>
  );
}
