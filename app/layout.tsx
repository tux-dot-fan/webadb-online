import type { Metadata, Viewport } from "next";
import "./globals.css";

const SITE_URL = "https://webadb.online";
const OG_IMAGE = `${SITE_URL}/og-image.png`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "WebADB — Run ADB fully in your browser",
    template: "%s · WebADB",
  },
  description:
    "Connect your Android device over USB and run ADB commands — shell, install APKs, transfer files, take screenshots, stream logcat — entirely from your browser. No install, no drivers.",
  applicationName: "WebADB",
  keywords: [
    "ADB",
    "Android",
    "Android Debug Bridge",
    "WebUSB",
    "browser ADB",
    "APK install",
    "scrcpy alternative",
    "logcat",
    "shell",
    "WebADB",
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
    apple: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: "WebADB — Run ADB fully in your browser",
    description:
      "Connect your Android device over USB and run ADB commands entirely from your browser. No install, no drivers.",
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
      "Connect your Android device over USB and run ADB commands entirely from your browser.",
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
  themeColor: "#0b0f17",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "WebADB",
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Android Debug Bridge Client",
  operatingSystem: "Chrome OS, Windows, macOS, Linux",
  description:
    "Run ADB commands on your Android device from any modern Chromium-based browser over WebUSB. No install, no drivers.",
  url: SITE_URL,
  image: OG_IMAGE,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  featureList: [
    "Shell command execution",
    "APK installation",
    "File transfer (upload & download)",
    "Screenshot capture",
    "Logcat streaming with ANSI colors",
    "Installed app management (list, launch, uninstall)",
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
        <link rel="canonical" href={SITE_URL} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}