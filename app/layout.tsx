import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./xterm.css";

const SITE_URL = "https://webadb.online";
const OG_IMAGE = `${SITE_URL}/og-image.png`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "WebADB — Run ADB fully in your browser",
    template: "%s · WebADB",
  },
  description:
    "Browser-based ADB client: full file manager, one-click APK install, multi-window terminal with saved shortcuts, instant device screenshot, live logcat, system monitor, and app manager. No install, no drivers.",
  applicationName: "WebADB",
  keywords: [
    "ADB",
    "Android",
    "Android Debug Bridge",
    "WebUSB",
    "browser ADB",
    "web ADB",
    "APK install",
    "APK installer",
    "scrcpy alternative",
    "logcat",
    "shell",
    "terminal",
    "file manager",
    "screenshot",
    "system monitor",
    "WebADB",
    "no install",
    "no drivers",
    "online",
    "Chrome",
  ],
  authors: [{ name: "webadb.online" }],
  creator: "webadb.online",
  publisher: "webadb.online",
  alternates: {
    canonical: SITE_URL,
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: "WebADB — Run ADB fully in your browser",
    description:
      "Browser-based ADB client: full file manager, one-click APK install, multi-window terminal with saved shortcuts, instant device screenshot, live logcat, system monitor, and app manager. No install, no drivers.",
    siteName: "WebADB",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "WebADB — Run ADB fully in your browser",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "WebADB — Run ADB fully in your browser",
    description:
      "Browser-based ADB client: full file manager, one-click APK install, multi-window terminal with saved shortcuts, instant device screenshot, live logcat, system monitor, and app manager. No install, no drivers.",
    images: [OG_IMAGE],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  category: "Developer Tools",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Two themeColor entries (one per media query) so the browser address
  // bar / status bar matches whichever theme is active. The light variant
  // is the default; the dark variant is shown only when the user has
  // explicitly enabled the dark theme via the toolbar toggle. We don't
  // auto-honor `prefers-color-scheme: dark` because the user's previous
  // webadb.online preference is more meaningful (see ThemeToggle.tsx).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f9fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f17" },
  ],
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "WebADB",
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Android Debug Bridge Client",
  operatingSystem: "Chrome OS, Windows, macOS, Linux",
  description:
    "Browser-based ADB client: full file manager, one-click APK install, multi-window terminal with saved shortcuts, instant device screenshot, live logcat, system monitor, and app manager. No install, no drivers.",
  url: SITE_URL,
  image: OG_IMAGE,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  featureList: [
    "File manager (browse, upload, download, edit)",
    "One-click APK install",
    "Multi-window ADB terminal",
    "Saved shell shortcuts (commands, scripts, binaries)",
    "Instant device screenshot",
    "Live logcat stream with ANSI colors",
    "System monitor (CPU, memory, battery, storage)",
    "Installed app manager (list, launch, uninstall)",
    "Wi-Fi ADB enable",
    "Multi-device switching",
  ],
  browserRequirements: "Requires WebUSB support. Chromium-based browsers (Chrome, Edge, Opera) on desktop.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Resolve the user's theme synchronously, BEFORE React hydrates,
            so the page paints in the right colors on the very first frame.
            Without this the user sees a light flash for ~100 ms while the
            JS bundle loads. The logic mirrors `resolveInitial()` in
            components/ThemeToggle.tsx — keep them in sync. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var k="webadb.online:theme";var v=localStorage.getItem(k);var t=(v==="light"||v==="dark")?v:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`,
          }}
        />
        <link rel="canonical" href={SITE_URL} />
        {/* Google Analytics 4 — measurement ID is the only thing that
            changes between environments. gtag.js ships CORP cross-origin
            headers, so it works under the COEP: require-corp policy on
            the main app. The async + inline pattern matches Google's
            recommended install (kept verbatim for tooling compatibility). */}
        <script
          async
          src="https://www.googletagmanager.com/gtag/js?id=G-Z6XNXQMH3E"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-Z6XNXQMH3E');`,
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}