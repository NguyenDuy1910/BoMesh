import { Suspense } from "react";

import { BasePage } from "@/modules/knowledge/bases/components/BasePage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <BasePage id={decodeURIComponent(id)} />
    </Suspense>
  );
}
