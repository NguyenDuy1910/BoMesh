import { Suspense } from "react";

import { ReaderPage } from "@/modules/knowledge/reader/components/ReaderPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ReaderPage itemId={decodeURIComponent(id)} />
    </Suspense>
  );
}
