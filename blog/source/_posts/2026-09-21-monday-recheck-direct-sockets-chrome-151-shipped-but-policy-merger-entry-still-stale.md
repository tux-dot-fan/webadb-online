---
title: Monday re-check — Direct Sockets permission-policy merger has shipped in Chrome 151, but the chromestatus entry still says "Proposed"
date: 2026-09-21 01:00:00
tags:
  - direct-sockets
  - chromestatus
  - chrome-151
  - wifi
  - weekly-roundup
---

Last Monday's roundup
([`2026-09-14`](https://webadb.online/blog/2026/09/14/weekly-roundup-ya-webadb-2-6-4-and-webadb-wifi-direct-sockets/))
flagged the most recent Direct Sockets entry on `chromestatus.com` —
[`Permission Policy Merger: "direct-sockets-private" with "local-network" and "loopback-network"`](https://chromestatus.com/feature/6046077976444928),
last updated 2026-06-22, targeting Chrome 151 — and noted that nothing
else on the Direct Sockets dashboard had moved in the preceding seven
days. Seven days later, the entry is byte-for-byte unchanged. But
Chrome 151 itself has shipped to stable in the interim, which puts the
two halves of that observation — chromestatus metadata vs shipped
binary — out of sync, and that asymmetry is worth pinning down on the
record before the next round of upstream activity buries it.

The short version: the entry's `desktop_first` field on the latest
stage (`stage_type: 160`, `intent_stage: 5`) is still `151`, the
`shipping_year` is still `2026`, the top-level status text is still
`"Proposed"`, and `is_released` is still `false`. That has been the
state of the row on chromestatus since the 2026-06-22 metadata
refresh. Meanwhile the Chrome release calendar has moved on: stable is
now [`154.0.…`](https://chromestatus.com/api/v0/channels) with a
release date of 2026-09-22, beta is at 155 (stable 2026-10-06), and dev
is at 156 (stable 2026-10-20). Counting backward at Chrome's
four-week cadence, **Chrome 151 went to stable around the end of
August / first week of September** — roughly three weeks before this
post.

So the merger has shipped in a stable Chrome binary somewhere around
M151, but the chromestatus entry has not been advanced to the
`Shipped` state to reflect that. This is not the first time we've seen
chromestatus lag the actual release — the Direct Sockets API itself
sat at `is_released: false` for several milestones after the API
shipped to stable in M125, and we noted the same gap in a
[prior post](https://webadb.online/blog/2026/09/14/weekly-roundup-ya-webadb-2-6-4-and-webadb-wifi-direct-sockets/#chrome-direct-sockets-status-no-movement-this-week)
— but it is worth re-emphasising because this is the second Direct
Sockets entry affected, and it can mislead readers who use chromestatus
as the canonical signal.

## What the merger actually does, and why the row matters

The WICG [`direct-sockets`](https://wicg.github.io/direct-sockets/) spec
replaces the existing single `direct-sockets-private` permission
policy with two more granular ones:

- `local-network` — required to open a `TCPSocket` or `UDPSocket`
  whose resolved address falls in the [=IP address space/private=]
  space (RFC 1918 ranges — `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, plus `fc00::/7`).
- `loopback-network` — required for the [=IP address space/local=]
  space (`127.0.0.0/8`, `::1`).

The permission-policy integration in the spec is explicit:

```text
If |addressSpace| is [=IP address space/private=] and [=this=]'s
[=relevant global object=]'s [=associated Document=] is not
[=allowed to use=] the [=policy-controlled feature=] named
"[=policy-controlled feature/local-network=]", [=queue a global task=]
to [=reject=] the {{TCPSocket/[[openedPromise]]}} and
{{TCPSocket/[[closedPromise]]}} with an "{{InvalidAccessError}}"
{{DOMException}} and <b>abort these steps</b>.

If |addressSpace| is [=IP address space/local=] and [=this=]'s
[=relevant global object=]'s [=associated Document=] is not
[=allowed to use=] the [=policy-controlled feature=] named
"[=policy-controlled feature/loopback-network=]", [=queue a global task=]
to [=reject=] the {{TCPSocket/[[openedPromise]]}} and
{{TCPSocket/[[closedPromise]]}} with an "{{InvalidAccessError}}"
{{DOMException}} and <b>abort these steps</b>.
```

The motivation text in the chromestatus row is short and to the point:
*"This change introduces essential user consent before granting
potentially sensitive network access to IWAs, aligning with the
principle of least privilege."* — the change is scoped to Isolated Web
Apps, which is where the existing `direct-sockets-private` policy
lives.

## Why this row doesn't change anything for webadb

We shipped the Wi-Fi ADB transport
([`4728896`](https://github.com/webadb/webadb.online/commit/4728896)
— `feat(wifi): real TCP ADB transport via Chrome Direct Sockets API`)
on top of `chrome.directSockets.openTcpSocket({...})`. The transport
opens a single TCP connection to the user-supplied `host:port` after
they run `adb tcpip 5555`. There are three cases for the host:

| Case | Example | Address space | Policy triggered |
| --- | --- | --- | --- |
| Localhost | `127.0.0.1:5555` (the same machine, e.g. for an emulator) | `local` | `loopback-network` |
| LAN-only device | `192.168.1.42:5555` (phone on the same Wi-Fi) | `private` | `local-network` |
| Remote device | (not currently supported by webadb; would require a relay) | `public` | none of the new policies |

So the spec change does affect webadb's Wi-Fi transport *if* you use it
inside an IWA, but **webadb is not an IWA**. It is a regular web app
served from `webadb.online`, and our `_headers` file ships the
existing single `Permissions-Policy: direct-sockets=*` directive for
the document, which lets the page open `TCPSocket` to any address space
in Chrome M131+ when the origin trial is enabled. The `local-network`
/ `loopback-network` split is an IWA-manifest-only refinement and
therefore does not apply to webadb. The diagnostic table we ship in
the Wi-Fi setup modal — `lib/wifi/` + `app/globals.css` classes
`.direct-sockets-guide` / `.direct-sockets-browserinfo` — does not
need updating.

The relevant blocker for the Wi-Fi transport in stable Chrome is
elsewhere: the `Direct Sockets API` row
([`6398297361088512`](https://chromestatus.com/feature/6398297361088512))
is still at `is_released: false` with `desktop: 131` and no movement
on chromestatus since 2025-01-14. That entry needs to advance to
`Shipping` (and the underlying feature to remove the OT-gating in
stable) before webadb's Wi-Fi transport works on stock Chrome for the
average user. This entry has not moved either, and the API is not on
the current chromestatus roadmap for any upcoming milestone.

## What the re-check actually shows

For the record, here is the current state of every entry on the
`chromestatus.com/features?q=Direct+Sockets` query, sorted by most
recent update. Compare with last Monday's identical table — nothing
has changed in the data:

| Feature | Updated | Status | Desktop |
| --- | --- | --- | --- |
| [Permission Policy Merger: "direct-sockets-private" with "local-network" and "loopback-network"](https://chromestatus.com/feature/6046077976444928) | 2026-06-22 | Proposed | 151 |
| [Source Specific Multicast for Direct Sockets API](https://chromestatus.com/feature/6208452397498368) | 2026-02-21 | Proposed | — |
| [WebRequest.SecurityInfo in Controlled Frame](https://chromestatus.com/feature/6208452397498368) | 2026-01-27 | Proposed | 145 |
| [Multicast support for Direct Sockets API](https://chromestatus.com/feature/5168654087094272) | 2026-01-09 | Proposed | 144 |
| [verifyTLSServerCertificate for IWA](https://chromestatus.com/feature/6398297361088512) | 2025-02-12 | Proposed | — |
| [Direct Sockets API in Shared/Service workers](https://chromestatus.com/feature/6208452397498368) | 2025-01-31 | Proposed | — |
| [Direct Sockets API](https://chromestatus.com/feature/6398297361088512) | 2025-01-14 | Enabled by default | 131 |
| [Direct Sockets API in Chrome Apps](https://chromestatus.com/feature/5168654087094272) | 2024-04-12 | Enabled by default | 125 |

Stable, beta, and dev Chrome are at **154 / 155 / 156** respectively
per the [`/api/v0/channels`](https://chromestatus.com/api/v0/channels)
endpoint. So while the data hasn't moved, the ship calendar has:
**Chrome 151, the milestone the merger targets, has been on stable for
about three weeks**.

## ya-webadb upstream — still nothing since 2026-09-02

For completeness: the `yume-chan/ya-webadb` repo's most recent commit
is still
[`f92c641d`](https://github.com/yume-chan/ya-webadb/commit/f92c641d)
(`fix(adb): correctly parse private keys whose DER encoded private
exponent is not 256 bytes long`, 2026-09-02). The previous one is
[`340d3fe0`](https://github.com/yume-chan/ya-webadb/commit/340d3fe0)
(`fix(adb): prevent unhandled disconnect rejection`, 2026-08-20). No
new `beta.4` release tag, no new commits to `main` since `f92c641d`.
We covered both in last Monday's post; there is nothing to add.

webadb.online itself is pinned to `@yume-chan/adb@^3.0.0-beta.1` (and
the matching `adb-credential-web`, `adb-daemon-webusb`, and
`stream-extra` siblings) per `package.json`. There is no upstream
movement forcing a re-pin.

## webadb.local — also quiet

`git log --since='24 hours ago'` on the webadb-online repo shows a
single commit yesterday —
[`203e69e`](https://github.com/webadb/webadb.online/commit/203e69e)
`blog: ya-webadb v3.0.0-beta.3 full changelog tour (push fix, DER
walker, disconnect, dep cleanup)`. That is yesterday's blog post. The
most recent non-blog commits on the main branch are:

- [`e3a0d10`](https://github.com/webadb/webadb.online/commit/e3a0d10)
  `blog: ya-webadb v3.0.0-beta.3 — sync send v1 waits for device ACK
  before resolving` (also a blog post, and arguably the same content as
  `203e69e` from a different angle)
- [`290a08b`](https://github.com/webadb/webadb.online/commit/290a08b)
  `blog: weekly roundup — ya-webadb v2.6.4 RSA fix, webadb Wi-Fi
  transport` (Sept 14 roundup, referenced above)

So the only code change in the last two weeks is the
[`4728896`](https://github.com/webadb/webadb.online/commit/4728896) Wi-Fi
transport itself, and the only relevant diagnostic around it
([`dee63ba`](https://github.com/webadb/webadb.online/commit/dee63ba),
the missing-API friendly-error panel).

## What this means for webadb.online

**No code changes required.** The Direct Sockets permission-policy
merger affects only IWA manifests, and webadb is a regular web app.
The `Permissions-Policy: direct-sockets=*` header we ship today remains
correct.

The interesting follow-up — same as last Monday — is when the
`Direct Sockets API` row itself moves from `is_released: false` to
`is_released: true`. That is the milestone that unblocks the Wi-Fi
transport on stable Chrome for non-OT users. The chromestatus entry
has been quiet on that front for ~20 months now, and the channel
calendar doesn't list it as upcoming on any milestone we can see. We
will keep monitoring on the next Monday re-check and report any
movement; absent that, webadb's Wi-Fi transport continues to require
either a Chromium build with the origin trial enabled (e.g. Chrome
Beta with `--enable-features=DirectSockets` plus an OT token, or
ChromeOS with the IWA shell) or a WebUSB cable.

If you have a use case where the IWA-manifest change would affect you —
for example, if you're building an IWA that uses Direct Sockets to talk
to a device on `192.168.x.x` — the relevant manifest snippet post-M151
is:

```json
{
  "isolated_web_app": {
    "version": "1.0.0",
    "permissions_policy": {
      "direct-sockets-private": [],
      "local-network": ["self"],
      "loopback-network": ["self"]
    }
  }
}
```

with `"self"` for the IWA itself, or a more specific origin if the
socket lives in a child context. The older `"direct-sockets-private"`
key remains valid for backward compatibility during a deprecation
window, but new manifests should declare the two finer-grained
policies.
