import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://webadb.online"),
  title: "WebADB — Run ADB fully in your browser",
  description:
    "Connect your Android device over USB and run ADB commands — shell, install APKs, transfer files, take screenshots — entirely from your browser. No install, no drivers.",
  applicationName: "WebADB",
  keywords: [
    "ADB",
    "Android",
    "WebUSB",
    "browser ADB",
    "APK install",
    "scrcpy",
    "WebADB",
  ],
  authors: [{ name: "webadb.online" }],
  openGraph: {
    type: "website",
    url: "https://webadb.online",
    title: "WebADB — Run ADB fully in your browser",
    description:
      "Connect your Android device over USB and run ADB commands entirely from your browser. No install, no drivers.",
    siteName: "WebADB",
  },
  twitter: {
    card: "summary_large_image",
    title: "WebADB — Run ADB fully in your browser",
    description:
      "Connect your Android device over USB and run ADB commands entirely from your browser.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0f17",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}