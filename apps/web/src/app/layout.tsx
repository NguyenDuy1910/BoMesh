import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";

import { LanguageProvider } from "@/i18n/LanguageProvider";
import { LANGUAGE_COOKIE, languageOf } from "@/i18n/messages";
import { appearanceBootScript } from "@/lib/theme";

import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "BoMesh", template: "%s · BoMesh" },
  description: "BoMesh — context-aware AI workspace for your organization's knowledge.",
  applicationName: "BoMesh",
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The interface language from the `bomesh.lang` cookie (Vietnamese without one), so the HTML arrives in it.
  const language = languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value);
  return (
    // The boot script sets data-theme and the theme variables before hydration (and `lang` from this device's choice).
    <html lang={language} data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: appearanceBootScript() }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- the app router root layout applies to every page */}
        <link
          href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,400..700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <LanguageProvider language={language}>
          <Providers>{children}</Providers>
        </LanguageProvider>
      </body>
    </html>
  );
}
