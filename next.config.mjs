/** @type {import('next').NextConfig} */
const nextConfig = {
  // ya-webadb is ESM-only and uses Web Streams APIs. Static export so we
  // can deploy to Cloudflare Pages (or any static host) — no Node server.
  // COOP/COEP/CORP headers are applied via `public/_headers` at deploy time
  // because `headers()` doesn't fire when `output: "export"` is set.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // `headers()` IS applied in `next dev` and `next start`, even with
  // output: "export". So we set them here for local development —
  // production gets them from public/_headers instead.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;