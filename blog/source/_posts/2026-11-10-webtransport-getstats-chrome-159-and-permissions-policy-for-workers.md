---
title: "Chrome 159 ships WebTransport getStats() on Android — and Chromium implements 5 of the spec's 13 fields"
date: 2026-11-10 01:00:00 UTC
tags:
  - webtransport
  - getstats
  - chrome-159
  - permissions-policy
  - webusb
---

Chrome's WebTransport connection-statistics entry was rewritten yesterday — `updated: 2026-11-09T19:33:48Z` by `vbryhider@microsoft.com` — and what it now says is that `WebTransport.getStats()` ships in Chrome 159 on desktop, Android, and WebView alike. What makes this interesting is not the milestone assignment; it is the gap between the spec's thirteen dictionary members and the five that Chromium actually implements, and the fact that Chromium's own runtime flag for the whole feature is still `experimental` while every one of its sibling WebTransport flags flipped to `stable` in the preceding three days.

The second story is quieter but closer to home. Chrome Platform Status's Permissions-Policy-for-workers entry was also touched yesterday, `updated: 2026-11-09T14:35:29Z` by `antoniosartori@chromium.org`, and the explainer behind it names WebUSB and WebHID — by URL — as the use cases it is designed to unblock.

## The milestone: stage 260, all three platforms, 159

The [WebTransport connection statistics](https://chromestatus.com/feature/5120203192139776)
entry (`5120203192139776`) carries four stages. Stage 220 is the intent-to-ship
placeholder; stage 230 carries the historical `desktop_first=124,
android_first=124` — the release where `getStats()` first appeared; stage 250
is the origin-trial slot, and it is empty (`ot_action_requested: false`,
`origin_trial_id: null`, no trial feedback URL). Stage 260 is the one that
matters:

```
stage_type: 260
desktop_first: 159
android_first: 159
webview_first: 159
intent_thread_url: https://groups.google.com/a/chromium.org/d/msgid/blink-dev/6aecbed8.dafb4d6f.4865.0071.GAE%40google.com
```

`159` is the milestone this blog has been tracking since the Chrome 158
cycle — the same number that carried
[WebTransport Datagram writable streams and prioritization](https://chromestatus.com/feature/5183354944225280)
and [WebTransport Datagram readable stream type](https://chromestatus.com/feature/5148774971342848)
yesterday. But those two were about *sending* datagrams. This one is about
*observing* the connection, and the distinction matters for a completely
practical reason: `getStats()` is the API you call when you want to know
*why* your datagrams are not arriving.

The feature is classified `feature_type: "Chromium catches up"`, which is
the chromestatus taxonomy for "the spec has this, Firefox and Safari have
this, Chromium does not". The entry's own interoperability note is
unusually candid about the state of the art:

> Firefox and Safari expose getStats(), but implementation maturity and
> returned fields vary between all browsers.

> The WebTransport specification currently defines connection byte/packet
> counters (bytesSent, bytesSentOverhead, bytesAcknowledged, packetsSent,
> bytesLost, packetsLost, bytesReceived, packetsReceived) and
> atSendCapacity; Chromium does not expose these members. Applications
> should check for optional members rather than assume that every browser
> returns the same subset.

That last sentence is the one to internalise. `getStats()` is a
feature-detect-and-branch API, not a uniform one.

## The spec defines thirteen fields; Chromium implements five

The W3C WebTransport Editor's Draft, §6.13, defines the connection-stats
dictionary in full:

```webidl
dictionary WebTransportConnectionStats {
  unsigned long long bytesSent;
  unsigned long long bytesSentOverhead;
  unsigned long long bytesAcknowledged;
  unsigned long long packetsSent;
  unsigned long long bytesLost;
  unsigned long long packetsLost;
  unsigned long long bytesReceived;
  unsigned long long packetsReceived;
  DOMHighResTimeStamp smoothedRtt;
  DOMHighResTimeStamp rttVariation;
  DOMHighResTimeStamp minRtt;
  required WebTransportDatagramStats datagrams;
  unsigned long long? estimatedSendRate = null;
  boolean atSendCapacity = false;
};
```

Chromium's own IDL,
`third_party/blink/renderer/modules/webtransport/web_transport_connection_stats.idl`,
is a strict subset:

```webidl
dictionary WebTransportConnectionStats {
  DOMHighResTimeStamp smoothedRtt;
  DOMHighResTimeStamp rttVariation;
  DOMHighResTimeStamp minRtt;
  required WebTransportDatagramStats datagrams;
  unsigned long long? estimatedSendRate = null;
};
```

Five members against the spec's thirteen. Every byte and packet counter is
absent, and so is `atSendCapacity`. What survives is the latency trio, the
nested datagram stats, and the send-rate estimate. The datagram dictionary
itself is implemented completely —
`web_transport_datagram_stats.idl` has all four members
(`expiredOutgoing`, `droppedIncoming`, `expiredIncoming`, `lostOutgoing`) —
which lines up with the chromestatus summary's promise of "counts of
expired, lost, and dropped datagrams".

The omission is deliberate, not an oversight, and the reason is visible in
the renderer source. `WebTransport::ConvertStatsFromMojom()` in
`web_transport.cc` copies the network-service mojom struct field by field:

```cpp
WebTransportConnectionStats* WebTransport::ConvertStatsFromMojom(
    network::mojom::blink::WebTransportStatsPtr in) {
  auto* out = MakeGarbageCollected<WebTransportConnectionStats>();
  // QUIC initializes min_rtt to zero until it has a valid RTT sample.
  if (in->min_rtt.is_positive()) {
    out->setMinRtt(in->min_rtt.InMillisecondsF());
    out->setSmoothedRtt(in->smoothed_rtt.InMillisecondsF());
    out->setRttVariation(in->rtt_variation.InMillisecondsF());
  }
  if (in->estimated_send_rate_bps > 0) {
    out->setEstimatedSendRate(in->estimated_send_rate_bps);
  } else {
    out->setEstimatedSendRate(std::nullopt);
  }
  auto* datagram_stats = MakeGarbageCollected<WebTransportDatagramStats>();
  datagram_stats->setExpiredOutgoing(in->datagrams_expired_outgoing);
  datagram_stats->setLostOutgoing(in->datagrams_lost_outgoing);
  UpdateIncomingDatagramStats(datagram_stats);
  out->setDatagrams(datagram_stats);
  return out;
}
```

There is no branch for `bytes_sent`, no branch for `packets_lost`, no branch
for `at_send_capacity`. The mojom struct simply does not carry them.
Chromium's network service exposes a QUIC-level stats subset and Blink maps
it one-to-one.

Two details in that function are worth pausing on, because both are places
where the observable behaviour differs from the naive reading of the spec.

**The RTT triple is all-or-nothing.** The `if (in->min_rtt.is_positive())`
guard means that if QUIC has not yet collected a valid RTT sample, *all
three* RTT members stay absent — `smoothedRtt`, `rttVariation` and `minRtt`
are missing together, even though `smoothedRtt` and `rttVariation` might
have had values. The spec's note on the dictionary says only "Any
unavailable stats will be absent from the WebTransportConnectionStats
dictionary", which does not warn you that they arrive as a correlated
group. Code that does `stats.smoothedRtt ?? 0` will silently report a
zero RTT for a freshly-opened connection rather than an absence.

**`estimatedSendRate` is a nullable that can go backwards.** The spec is
explicit: "If the user agent does not currently have an estimate, the member
MUST be the null value. The member can be null even if it was not null in
previous results." Chromium's mapping honours this — `estimated_send_rate_bps
> 0` produces a number, anything else produces `std::nullopt`. But note
the unit: the mojom field is named `_bps` and the spec's field is
`unsigned long long?`, described as "the estimated rate at which queued
data will be sent by the user agent, in bits per second". The spec
dictionary's declared type (`unsigned long long`) does not match its own
prose unit (bits per second), which is a spec wart worth noting if you
ever try to compare the value against a byte counter.

## `atSendCapacity` is the field everyone will want, and it is the one Chromium does not have

`atSendCapacity` is the boolean that tells you whether the send-rate
estimate is meaningful. From the spec:

> A value of false indicates the estimatedSendRate might be application
> limited, meaning the application is sending significantly less data than
> the congestion controller allows. A congestion controller might produce a
> poor estimate of the available network capacity while it is application
> limited.
>
> A value of true indicates the application is sending data at network
> capacity, and the estimatedSendRate reflects the network capacity
> available to the application.
>
> When atSendCapacity is true, the estimatedSendRate reflects a ceiling.

This is the difference between "the network is slow" and "you are not
sending enough to saturate it" — the single most common misdiagnosis in
any adaptive-rate video or audio pipeline. Chromium does not expose it.
The renderer never sets it, and the IDL does not declare it, so
`stats.atSendCapacity` is `undefined` in Chrome 159 no matter what the
network is doing.

The chromium-status entry's `interop_compat_risks` field names this
exactly, listing `atSendCapacity` alongside the eight byte and packet
counters as members Chromium does not expose. The spec's own text explains
why it might be hard to implement: the estimate has to distinguish an
application-limited sender from a network-limited one, and the spec
acknowledges the "pooled connection" complication — when a session rides an
existing connection, only members marked as *pooled connection stats* are
revealed, and `atSendCapacity`, `smoothedRtt`, `rttVariation`, `minRtt`
and `estimatedSendRate` are the five that carry that marker.

## The flag that is still experimental

Here is the detail that makes this more than a routine milestone story.
`getStats()` is not a plain method in Chromium — it is gated:

```idl
[CallWith=ScriptState, RuntimeEnabled=WebTransportStats]
Promise<WebTransportConnectionStats> getStats();
```

And in
`third_party/blink/renderer/platform/runtime_enabled_features.json5`,
the flag's entry is not stable. It is the only one in the whole WebTransport
block that is not:

```json5
{
  // Note: enabling this without setting WebTransportCongestionControl to
  // either BBRv1 or BBRv2 will produce poor bandwidth estimates.
  name: "WebTransportStats",
  status: "experimental",
  base_feature: "none",
},
```

Compare that to its immediate neighbours in the same file as of the
current `refs/heads/main`:

| Flag | Status | Flip commit | Date |
|---|---|---|---|
| `WebTransportReceiveStream` | `stable` | `74ac1565e4e4` | 2026-11-04 |
| `WebTransportSendGroup` | `stable` | `e74069210529` | 2026-11-04 |
| `WebTransportCongestionControl` | `stable` | `665a26498b6a` | 2026-11-02 |
| `WebTransportExportKeyingMaterial` | `stable` | `c8d2a52b660d` | 2026-10-29 |
| `WebTransportDatagramsWritable` | `stable` | `c389dc69815b` | 2026-11-05 |
| `WebTransportDatagramsReadableType` | `stable` | `2f09e1584e25` | 2026-11-06 |
| `WebTransportStats` | **`experimental`** | — | — |

Six WebTransport flags flipped `experimental → stable` in the eight days
between October 29 and November 6. `WebTransportStats` did not go with them,
and the comment in the file explains the dependency: the send-rate estimate
comes from the congestion controller, so the flag's usefulness is
conditional on `WebTransportCongestionControl` being set to BBRv1 or BBRv2
rather than left at the default.

That is a coherent engineering decision — shipping a bandwidth estimate
derived from a cubic congestion controller is how you get a number that
looks authoritative and is wrong. But it does mean that "Chrome 159 ships
`getStats()`" and "`getStats()` is available to you in Chrome 159" are
different claims. The first is what chromestatus now says; the second
depends on a runtime flag that is off by default and has no `base_feature`
to enable it through a command-line switch on stable builds. On stable
Chrome, `transport.getStats` may well be `undefined`. On Chrome for Testing
or a `--enable-features=WebTransportStats` build, it is there, and the
`estimatedSendRate` it returns is the BBR-derived number the flag comment
warns about.

## The send-group statistics that arrived in October

There is a second, older piece of this surface that landed before the
milestone announcement: send-stream and send-group statistics.
Chromium commit `4cc5073b6b2a` — "WebTransport: implement GetStats for
SendGroup" — landed on `2026-10-23T00:21:34Z`, reviewed by Nidhi Jaju and
Matthew Denton, and commit-queued by Viktoriya Bryhider (the same
`vbryhider@microsoft.com` who owns the chromestatus entry). It is a large
change: fifteen files, +665/−138, with `web_transport_send_group.cc` alone
gaining 129 lines and `web_transport_test.cc` gaining 344.

The commit message describes the mechanics:

> Replace zeroed send group statistics with aggregated bytes written, sent,
> and acknowledged for the group's members. Snapshot membership when
> getStats() is called so later reassignment does not change which streams
> contribute to the pending result.
>
> Track membership changes and fold finalized stream counters into group
> totals, preserving statistics without retaining completed streams.
>
> Request statistics for all active members in a single network-service
> IPC. Share pending requests between stream and group queries, and keep
> requests pending when statistics are temporarily unavailable until a
> terminal notification or connection cleanup completes them.

That last clause is the interesting one — it is a pending-request state
machine shared between stream-level and group-level queries, and it has to
survive a member disappearing mid-flight. The "snapshot membership when
getStats() is called" rule is the spec-consistent behaviour: the answer
reflects the group as it was when you asked.

The spec's per-stream dictionaries are correspondingly small:

```webidl
dictionary WebTransportSendStreamStats {
  unsigned long long bytesWritten;
  unsigned long long bytesSent;
  unsigned long long bytesAcknowledged;
};

dictionary WebTransportReceiveStreamStats {
  unsigned long long bytesReceived;
  unsigned long long bytesRead;
};
```

`bytesWritten` versus `bytesSent` versus `bytesAcknowledged` is the trio
that matters most for a sender: bytes written is what the application
handed to the stream, bytes sent is what left the machine, bytes
acknowledged is what the peer confirmed. The gap between written and
acknowledged is your in-flight-and-lost window. Chromium does not expose
the same trio at the *connection* level — it is available only per stream
and per send group.

## Permissions Policy for workers: the WebUSB angle

The second entry touched yesterday is
[Permissions Policy for workers](https://chromestatus.com/feature/5073502741856256)
(`5073502741856256`), updated `2026-11-09T14:35:29Z` by
`antoniosartori@chromium.org`. Unlike the WebTransport entry, this one is
not close to shipping: its stages run 110 through 160 (intent to prototype
through intent to ship) and all six are bare — no milestones, no origin
trial, no rollout platform. The chromestatus `chrome.status` field reads
`Proposed`.

What is notable is the explainer. The
[workers-permissions-policy](https://github.com/explainers-by-googlers/workers-permissions-policy)
README lists its example use cases, and the first one is "Connected devices
APIs" — with a list of APIs that are "normally only exposed to documents":

- [Gamepad API](https://github.com/w3c/gamepad/issues/37)
- [WebUSB](https://github.com/WICG/webusb/issues/73)
- [WebHID](https://github.com/WICG/webhid/issues/120)
- [Web MIDI](https://github.com/WICG/web-midi-api/issues/99)
- [Web Serial](https://github.com/WICG/serial/issues/116)

> As those APIs are normally gated behind Permissions Policy, extending
> Permissions Policy to workers seems a prerequisite for shipping those APIs
> to workers in a consistent way.

WebUSB is second on that list. That is not a coincidence for this project,
and it explains why the Chromestatus entry is worth watching even at the
"Proposed" stage: WebUSB is currently a document-context-only API, and
`navigator.usb.requestDevice()` cannot be called from a worker. A worker
cannot open a USB device, which means an ADB client implemented on top of
WebUSB cannot currently be moved off the main thread — the WebUSB session
handling, the ADB daemon WebUSB transport, and the sync protocol all have to
run where `navigator.usb` exists.

This is the continuation of a thread this blog started on November 2, when
Chromium's `PermissionsPolicyForSharedWorkers` landed across six CLs. The
flag's current state in
`runtime_enabled_features.json5` is unchanged since then:

```json5
{
  name: "PermissionsPolicyForSharedWorkers",
  status: "experimental",
  public: true,
},
```

The October work is still visible in the tree. Two commits from
`2026-10-20T15:42:05Z` and `2026-10-20T15:42:21Z` — `c40fd2ef2dec` and
`3aa2f4ff7f9e`, both queued by Antonio Sartori — implement the shared-worker
half of the model:

```
c40fd2ef2dec  [PermissionsPolicyForWorkers] Parse SharedWorkerOptions.allow
   Parse the allow attribute on SharedWorkerOptions using
   PermissionsPolicyParser::ParseAttribute() in SharedWorker::CreateImpl()
   when PermissionsPolicyForSharedWorkers is enabled, and log any parser
   messages to the execution context console.

3aa2f4ff7f9e  [PermissionsPolicyForWorkers] Check 'allow' against creator
   Verify in SharedWorker::CreateImpl() that the creator ExecutionContext
   can delegate to the worker origin every feature parsed from
   SharedWorkerOptions.allow, and trigger Sharedworker.onerror otherwise.
```

Both are part of tracking bug `562705553`. The shared-worker model the
explainer proposes is the strict one: capabilities are delegated *at
creation* via an `allow` option, and a subsequent context connecting to the
same shared worker must pass a compatible `allow` or the connection fails —
the same shape as cross-origin iframes, and deliberately *not* the same
shape as dedicated workers, which inherit their creator's policy wholesale.

For webadb, the dedicated-worker case is the interesting one, and it is
already effectively working: "for same-origin workers this would currently
basically result in inheriting the parent's Permissions Policy, a behavior
which is already implemented by some vendors and is also covered by WPTs".
The explainer notes the HTML standard "manually checks the creator's
Permissions Policy for dedicated workers, but not for shared workers,
because of the multiple inheritance issue that this proposal aims to solve".

The other two use cases are less speculative. SharedArrayBuffer and
cross-origin isolation are already the foundation of webadb's deployment —
`public/_headers` sets COOP/COEP/CORP so ya-webadb can use
`SharedArrayBuffer` — and the explainer's point is that the
`cross-origin-isolated` policy-controlled feature is currently checked by
hand in the HTML standard for dedicated workers but not for shared workers.
And Local Network Access, which gates local network requests behind
Permissions Policy, "currently forbids local network access from workers"
for exactly the same reason.

## What shipped in webadb itself

One code change landed in this repository in the last 24 hours, and it is
about the flakiest part of the ADB-in-browser story: installing an APK.
Commit `f0720bf` — "fix(apk): add -d -g --user 0 to pm install, retry
minimally, verbose diagnostics" — changed
`components/ApkInstallPanel.tsx`.

The installer previously ran `pm install -r -t <path>` and, on failure,
reported "pm install returned exit 1" plus whatever was on stdout. The new
flag set is:

```
pm install -r -t -d -g --user 0 /data/local/tmp/<name>.apk
```

with `-d` allowing a version downgrade, `-g` granting runtime permissions
at install time so the app is not dead-on-arrival with an empty permission
set, and `--user 0` targeting the primary user explicitly. Notably absent
is `-s`: that flag means "install on shared storage", which Android 11+
rejects for third-party APKs with
`INSTALL_FAILED_INVALID_INSTALL_LOCATION`, and which places the app
somewhere the launcher does not index.

The more interesting part is the retry. If the extended flag set fails, the
installer automatically retries with a bare `pm install -r <path>` — the
exact command that works from a terminal. The reasoning is that some OEM
skins (HyperOS in particular) reject *combinations* of individually-valid
flags, which means no amount of flag-reading on the host side will save
you; you have to try the minimal form.

And when both fail, the panel now attaches real diagnostics: the full
command line that ran, the combined stdout and stderr (`pm install` reports
failures on stdout, not stderr, which is why the original message was so
empty), an `ls -lZ` of the staged file so a truncated or permission-broken
upload is distinguishable from a bad APK, and the device's own
`pm install --help` output so the user can see exactly which flags their
Android build accepts. Two specific tokens get a plain-English hint:
`INSTALL_PARSE_FAILED_NO_COLLECTED_CERTIFICATES` (the staged file may be
truncated or unreadable) and `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (the
signing key differs from the installed app — uninstall it first).

There is one more small change worth naming: the staged filename is forced
to end in `.apk`. Files named without the extension are rejected outright
by some devices, and a browser file picker makes it easy to pick up a file
called `app-release-final` that is actually an APK.

## What this means for webadb.online

Two of these three stories are upstream primitives, and neither is
actionable this week — but one of them changes what we can *plan* for.

`WebTransport.getStats()` gives us a way to tell "the network is slow"
apart from "the application is not sending enough", and it gives us
per-datagram expired/lost/dropped counters that a QUIC-based ADB transport
could surface as a connection-quality readout. The caveat is precise:
Chromium exposes five of the spec's thirteen members and, more
importantly, the whole method sits behind a runtime flag that is still
`experimental` — so on stable Chrome 159 you should feature-detect
`typeof transport.getStats === "function"` and expect
`stats.atSendCapacity` to be `undefined` even when the call succeeds.

The Permissions Policy for workers story is the closer one, because its
first listed use case is WebUSB. The day Permissions Policy works in
workers, `navigator.usb` can be exposed to a dedicated worker, and the
WebUSB session handling in ya-webadb — which today has to run on the
main thread because that is the only place `navigator.usb` exists — could
move off it. That is not a small refactor for us, but it is the kind of
constraint removal that is worth noticing six months before it lands.

No impact on webadb's runtime behaviour this week, beyond the APK
installer fix: ya-webadb's `origin/main` head is still `d22e9dc` ("chore:
release v3.0.0-beta.5"), there are no new commits, no new pull requests,
and no new releases since the beta.5 announcement this blog covered on
November 7. The last activity in the upstream repository remains
[PR #879](https://github.com/yume-chan/ya-webadb/pull/879), closed on
`2026-11-04T17:25:21Z`. Direct Sockets was not re-checked — that is a
Monday ritual, and it will be due tomorrow.
