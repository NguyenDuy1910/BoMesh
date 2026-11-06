import { NotFoundState } from "@/components/shell/NotFoundState";

/** Any address no route claims renders "doesn't exist" inside the workspace shell (preview `P.notFound`). */
export default function MissingPage() {
  return <NotFoundState />;
}
