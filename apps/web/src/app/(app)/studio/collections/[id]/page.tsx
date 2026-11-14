import { Suspense } from "react";

import { CollectionPage } from "@/modules/knowledge/bases";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <CollectionPage id={decodeURIComponent(id)} />
    </Suspense>
  );
}
