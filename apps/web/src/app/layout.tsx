import type { Metadata, Viewport } from "next";

import { appearanceBootScript } from "@/lib/theme";

import { fontVariables } from "./fonts";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "BoMesh", template: "%s · BoMesh" },
  description: "BoMesh — không gian làm việc AI hiểu ngữ cảnh cho tri thức của tổ chức bạn.",
  applicationName: "BoMesh",
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/** The interface is Vietnamese only for now: the server renders Vietnamese, nothing translates the page afterwards. */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The boot script sets data-theme and the theme variables before hydration.
    <html lang="vi" data-theme="light" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: appearanceBootScript() }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
