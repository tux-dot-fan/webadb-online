---
title: Hello, webadb
date: 2026-08-07 09:35:28
tags:
  - meta
  - announcement
---

This is the first post on the new webadb.online blog — release notes,
deep dives, and field reports from running [webadb.online](https://webadb.online)
in production.

## What's here

- **Release notes** when we ship a meaningful change to the
  desktop-style UI, the WebUSB session layer, or the device bridge.
- **Deep dives** into the trickier parts of the stack — `unzip -p`
  on the device, the [ya-webadb](https://github.com/yume-chan/ya-webadb)
  shell protocol, how we get `crossOriginIsolated === true` over
  Cloudflare Pages, etc.
- **Field reports** from real-device testing (currently a Xiaomi 13
  on HyperOS, plus whatever loaner lands on the desk).

## How it's built

The site itself is a Next.js static export served by Cloudflare Pages,
and the blog is a plain [Hexo](https://hexo.io/) instance living in
`blog/` whose output (`hexo generate → public/blog/`) gets folded into
the Next.js export on the next `npm run build`. One repo, one
project, two static-site generators.

The blog ships inside `webadb.online/blog/`, so the COOP/COEP headers
that gate `SharedArrayBuffer` on the main app don't leak into the
blog's HTML (we override them in `public/_headers`).

More soon.
