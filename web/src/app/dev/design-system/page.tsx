import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { DesignGallery } from "./_components/DesignGallery";

export const metadata: Metadata = {
  title: "Design system",
  robots: { index: false, follow: false },
};

/** The component gallery. Development builds only: production answers 404. */
export default function DesignSystemPage() {
  if (process.env.NODE_ENV === "production") notFound();
  // The tabs specimen reads `?tab=` through useSearchParams.
  return (
    <Suspense fallback={null}>
      <DesignGallery />
    </Suspense>
  );
}
