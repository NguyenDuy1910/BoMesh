import { Be_Vietnam_Pro, Google_Sans_Flex, IBM_Plex_Sans, Inter, Manrope } from "next/font/google";

/**
 * The appearance fonts (`FONTS` in lib/theme.ts), served from this app. Each one is a CSS variable on <html>
 * that the font stacks name, so its files download only once a stack uses it. The default (Be Vietnam Pro) is
 * preloaded: a reload paints in it at once instead of swapping fonts after hydration. next/font needs every option
 * written as a literal.
 */
const vietnam = Be_Vietnam_Pro({ subsets: ["latin", "vietnamese"], weight: ["400", "500", "600", "700"], variable: "--font-vietnam", display: "swap" });
const google = Google_Sans_Flex({ subsets: ["latin", "vietnamese"], axes: ["opsz"], variable: "--font-google", display: "swap", preload: false });
const inter = Inter({ subsets: ["latin", "vietnamese"], variable: "--font-inter", display: "swap", preload: false });
const plex = IBM_Plex_Sans({ subsets: ["latin", "vietnamese"], variable: "--font-plex", display: "swap", preload: false });
const manrope = Manrope({ subsets: ["latin", "vietnamese"], variable: "--font-manrope", display: "swap", preload: false });

export const fontVariables = [vietnam, google, inter, plex, manrope].map((font) => font.variable).join(" ");
