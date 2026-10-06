import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

import { LEGACY_REDIRECTS } from "./src/lib/legacy-redirects";

const repositoryRoot = path.resolve(__dirname, "..");
loadEnvConfig(repositoryRoot, process.env.NODE_ENV !== "production", undefined, true);
const nextConfig: NextConfig = {
  // The web app is run from `web/`, while local configuration lives at the
  // repository root. Explicitly define public values so production builds
  // inline the same values that `next dev` receives from `@next/env`.
  env: {
    NEXT_PUBLIC_BOMESH_API_URL: process.env.NEXT_PUBLIC_BOMESH_API_URL ?? "",
    NEXT_PUBLIC_BOMESH_TENANT_ID: process.env.NEXT_PUBLIC_BOMESH_TENANT_ID ?? "",
    NEXT_PUBLIC_BOMESH_USER_ID: process.env.NEXT_PUBLIC_BOMESH_USER_ID ?? "",
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
    NEXT_PUBLIC_BOMESH_PENDING_FEATURES: process.env.NEXT_PUBLIC_BOMESH_PENDING_FEATURES ?? "",
    NEXT_PUBLIC_BOMESH_PENDING_MARKER: process.env.NEXT_PUBLIC_BOMESH_PENDING_MARKER ?? "",
  },
  devIndicators: false,
  // Addresses from before the one-shell navigation (src/lib/legacy-redirects.ts).
  async redirects() {
    return [...LEGACY_REDIRECTS];
  },
  reactCompiler: false,
  turbopack: {},
  webpack: (config) => {
    config.watchOptions = {
      ...config.watchOptions,
      poll: false,
    };
    return config;
  },
};

export default nextConfig;
