import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Script from "next/script";
import { AuthGate } from "@/components/auth/AuthGate";
import { appearanceBootScript } from "@/lib/appearance";
import { appBrand } from "@/lib/brand";
import "./globals.css";

// Bound to --font-plex-sans / --font-plex-mono on <html>; tokens.css builds
// --font-sans / --font-mono on them.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin", "latin-ext", "vietnamese"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext", "vietnamese"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: appBrand.productName,
  description: "Enterprise knowledge and BI assistant.",
  applicationName: appBrand.productName,
  manifest: "/site.webmanifest",
  openGraph: {
    title: appBrand.productName,
    description: "Enterprise knowledge and BI assistant.",
    siteName: appBrand.productName,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // A <meta> tag cannot read CSS variables: these mirror --surface-canvas in
  // tokens.css (light and dark).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f2f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d10" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      className={`${plexSans.variable} ${plexMono.variable}`}
      data-accent="indigo"
      data-bg="plain"
      data-density="comfortable"
      lang="en"
      suppressHydrationWarning
    >
      <body>
        <Script id="bomesh-appearance" strategy="beforeInteractive">
          {appearanceBootScript}
        </Script>
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
