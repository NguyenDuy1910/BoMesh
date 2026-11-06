"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { getSession } from "@/lib/session";

/** `/`: Home when signed in, else Sign in. */
export default function IndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getSession() ? "/home" : "/signin");
  }, [router]);
  return null;
}
