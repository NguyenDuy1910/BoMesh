import { NotFoundState } from "@/components/shell/NotFoundState";

/** Unknown addresses outside the app shell (e.g. a page calling `notFound()` before the shell loads). */
export default function NotFound() {
  return (
    <div className="main__scroll" style={{ height: "100%" }}>
      <NotFoundState />
    </div>
  );
}
