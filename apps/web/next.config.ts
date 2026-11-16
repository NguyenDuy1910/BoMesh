import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

const repositoryRoot = path.resolve(__dirname, "../..");
loadEnvConfig(repositoryRoot, process.env.NODE_ENV !== "production", undefined, true);
const nextConfig: NextConfig = {
  // The web app is run from `apps/web/`, while local configuration lives at
  // the repository root. Explicitly define public values so production builds
  // inline the same values that `next dev` receives from `@next/env`.
  env: {
    NEXT_PUBLIC_BOMESH_API_URL: process.env.NEXT_PUBLIC_BOMESH_API_URL ?? "",
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
    NEXT_PUBLIC_BOMESH_DEV_ADAPTERS: process.env.NEXT_PUBLIC_BOMESH_DEV_ADAPTERS ?? "",
  },
  devIndicators: false,
  reactCompiler: false,
  turbopack: {
    // Keep module resolution at the app that owns Next.js dependencies.
    root: __dirname,
  },
  // Addresses retired by the current IA (preview router aliases): old bookmarks and links land on their new home.
  // Next passes the request's query through, with the destination's own keys taking precedence.
  async redirects() {
    const libraryTab = (value: string, destination: string) => ({
      source: "/knowledge/library",
      has: [{ type: "query" as const, key: "tab", value }],
      destination,
      permanent: true,
    });
    return [
      { source: "/inbox", destination: "/home", permanent: true },
      { source: "/chats", destination: "/chat", permanent: true },
      { source: "/bases", destination: "/studio?tab=collections", permanent: true },
      { source: "/bases/:id", destination: "/studio/collections/:id", permanent: true },
      { source: "/documents", destination: "/studio?tab=documents", permanent: true },
      // Knowledge health's old tabs (?tab=details|duplicates) land on Documents → Quality (`studioAddress`).
      { source: "/knowledge-health", destination: "/studio", permanent: true },
      { source: "/sources", destination: "/studio?tab=sources", permanent: true },
      { source: "/connections", destination: "/studio?tab=sources&view=accounts", permanent: true },
      { source: "/knowledge/collections/:id", destination: "/knowledge/lists/:id", permanent: true },
      { source: "/knowledge/browse", destination: "/knowledge", permanent: true },
      libraryTab("contributions", "/contributions"),
      libraryTab("recent", "/recent"),
      libraryTab("collections", "/knowledge/library?tab=lists"),
      { source: "/access", destination: "/people", permanent: true },
      { source: "/p/models", destination: "/p/health", permanent: true },
    ];
  },
};

export default nextConfig;
