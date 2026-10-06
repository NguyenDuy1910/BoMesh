import { redirect } from "next/navigation";

/** Manage has no page of its own; its first section is the overview. */
export default function ManagePage() {
  redirect("/manage/overview");
}
