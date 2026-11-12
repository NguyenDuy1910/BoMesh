import { Suspense } from "react";

import { ReadingListPage } from "@/modules/knowledge/library/components/ReadingListPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ReadingListPage id={id} />
    </Suspense>
  );
}
