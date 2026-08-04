# WebADB Online

Run ADB fully in your browser. Connect your Android device over USB and run
shell commands, install APKs, browse files, take screenshots — no install,
no drivers, no extension.

**Live at**: https://webadb.online

## How it works

```
Browser  ──WebUSB──▶  Android device
   │
   └──ya-webadb (Apache 2.0) implements the ADB protocol in TypeScript
      and runs entirely in the browser. The page is cross-origin
      isolated (COOP/COEP) so SharedArrayBuffer is available.
```

Everything happens client-side. The site is a static export — there is no
server, no API, no telemetry. Files you pick with the file picker never leave
your browser.

## Features

- **Shell** — run any command via the `none` protocol
- **APK install** — pick an APK, streams over USB to `/data/local/tmp`, then
  `pm install -r -t` runs on the device
- **Files** — browse and download any file on the device
- **Screenshot** — `screencap -p` piped to a `<img>` tag

## Stack

- Next.js 15.5 (App Router, `output: "export"`)
- React 19
- TypeScript strict mode (0 errors)
- `@yume-chan/adb` 2.6 + `@yume-chan/adb-daemon-webusb` 2.3
- Cloudflare Pages (static)

## Local development

```bash
npm install
npm run dev          # http://localhost:3000
```

Headers (`Cross-Origin-Embedder-Policy: require-corp`, etc.) are set in
`next.config.mjs` for dev, and via `public/_headers` for production deploys.

## Build

```bash
npm run build        # produces ./out (static)
```

## Deploy to Cloudflare Pages

### Option A: Connect to GitHub (recommended)

1. Push this repo to GitHub (already done: https://github.com/tux-dot-fan/webadb-online)
2. Open https://dash.cloudflare.com/ → **Workers & Pages** → Create application → **Pages** → **Connect to Git**
3. Select `tux-dot-fan/webadb-online`
4. Use these **exact** build settings (these are NOT the Cloudflare auto-detected defaults — `Build output directory` MUST be `out`, not `.next`):

   | Setting | Value |
   |---|---|
   | Production branch | `main` |
   | Framework preset | `Next.js` |
   | Build command | `npm run build` |
   | **Build output directory** | **`out`** ⚠️ critical |
   | Root directory | (leave empty) |
   | Node version | `22` |

5. Click **Save and Deploy**. First build takes ~2 minutes.
6. After the first deploy, attach `webadb.online` and `www.webadb.online` as
   custom domains in the dashboard. The DNS zone must already be on
   Cloudflare for the certificate to issue.

Every push to `main` rebuilds and deploys automatically.

### Option B: Direct upload via Wrangler

```bash
npm run build
npx wrangler login
npx wrangler pages deploy ./out --project-name webadb-online
```

You'll need a Cloudflare API token with Pages edit permission.

## Architecture

```
app/
  layout.tsx          Root metadata + viewport
  page.tsx            Single page that mounts <Workspace />
  globals.css         Dark theme + workspace layout

lib/
  adb-client.ts       Singleton AdbClient. Manages WebUSB request, ADB
                      handshake, transport lifecycle, connection state.
  use-adb.ts          React hooks over AdbClient (useSyncExternalStore).

components/
  Workspace.tsx       Layout shell + tab router
  DevicePanel.tsx     Sidebar: connection status, connect/disconnect button
  ShellPanel.tsx      Command input + scrolling output
  ApkInstallPanel.tsx File picker → sync.write → pm install
  FileManagerPanel.tsx readdir + read for download
  ScreenshotPanel.tsx screencap -p piped to <img>

public/
  _headers            Cloudflare Pages headers (COOP/COEP/CORP, caching,
                      security). Copied to out/ at build time.

wrangler.toml         Wrangler CLI config
next.config.mjs       output: "export", dev-only headers()
```

## Browser support

WebUSB requires Chromium-based browsers on desktop:
- Chrome / Edge / Opera / Brave ✓
- Firefox, Safari ✗

Mobile browsers do not expose WebUSB.

## Limitations

- The site has no backend, so it can't store ADB credentials persistently.
  RSA authentication happens once: tap "Always allow from this computer" on
  the device dialog and the device remembers the key for future sessions.
- File manager is read-only (browse + download). Add upload by feeding a
  `<input type="file">` into `sync.write()`.
- Screenshot uses `screencap` (PNG bytes) rather than the raw framebuffer
  protocol — works on every Android version without per-device color-space
  handling.

## License

MIT. Built on top of [`ya-webadb`](https://github.com/yume-chan/ya-webadb)
(Apache 2.0).