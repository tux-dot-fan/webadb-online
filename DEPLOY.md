# Deploying to Cloudflare Pages

This project is a static Next.js export (`output: "export"` in `next.config.mjs`).
Cloudflare Pages is the right home for it — no server runtime, no Workers, no
edge functions. Just a CDN serving the `out/` directory.

## One-time setup (≈ 5 minutes)

1. **Open the Pages creation page**:
   https://dash.cloudflare.com/?to=/:account/pages/new/provider/github

2. **Connect GitHub** (first time only):
   - Click "Connect GitHub account"
   - Authorize Cloudflare to read `tux-dot-fan/webadb-online`
   - You can scope to this one repo — no need to grant org-wide access

3. **Select the repo**:
   - Pick `tux-dot-fan/webadb-online`
   - Click "Begin setup"

4. **Configure the project** — these are the **exact** settings:

   | Field | Value |
   |---|---|
   | Project name | `webadb-online` |
   | Production branch | `main` |
   | Framework preset | `Next.js` (auto-detected) |
   | Build command | `npm run build` (auto-filled) |
   | **Build output directory** | **`out`** ⚠️ critical — auto-fills to `.next`, **change it** |
   | Root directory | (leave empty) |
   | Environment variables | (none) |
   | Build watch paths | (default — leave alone) |

5. **Click "Save and Deploy"**.
   First build takes 1–3 minutes. Watch the build log.

6. **After success**, you'll get a `*.webadb-online.pages.dev` URL. Test it:
   - Open it in Chrome
   - Check DevTools → Network → look at any response — should have
     `Cross-Origin-Embedder-Policy: require-corp` header (proves `_headers`
     file is being applied)
   - Check Application → check `crossOriginIsolated === true` in JS console:
     ```js
     self.crossOriginIsolated  // should be true
     ```

## Attaching webadb.online

Once the first deploy succeeds:

1. Project page → **Custom domains** tab
2. Click **"Set up a custom domain"**
3. Enter `webadb.online` → Continue
4. CF will either:
   - Auto-add the DNS record (if `webadb.online`'s nameservers are already
     on Cloudflare) → wait ~90s for cert → done
   - Ask you to add a CNAME at your current registrar → follow the prompts

5. Repeat for `www.webadb.online` (or set up a redirect from `www` → apex)

## After deploy

Every push to `main` triggers a fresh build + deploy automatically. Preview
deploys are created for every other branch / PR (also automatic).

To roll back: Project → **Deployments** → click ⋯ on the previous good deploy →
"Rollback to this deploy".

## Common failure modes

| Error in build log | Fix |
|---|---|
| `Could not find ./out/index.html` | Build output directory is `.next`. Change it to `out`. |
| `SyntaxError: Unexpected token '#'` | Node version too old. Set it to `22`. |
| `wrangler.toml not found` (fatal) | (Not possible — we don't ship wrangler.toml.) |
| `Module not found: Can't resolve ...` | Missing `npm install` step. Shouldn't happen, but check "Build command" includes `npm install` (it does by default for Node projects). |

## Local equivalent

```bash
npm run build
npx wrangler pages dev ./out
```

This runs a local Pages emulator with `_headers` and `_redirects` applied —
useful for testing header changes without redeploying.