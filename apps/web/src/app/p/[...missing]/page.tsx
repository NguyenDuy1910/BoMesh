import { NotFoundState } from "@/components/shell/NotFoundState";

/** Unknown platform-console addresses render "doesn't exist" inside the console shell. */
export default function MissingPlatformPage() {
  return <NotFoundState />;
}
