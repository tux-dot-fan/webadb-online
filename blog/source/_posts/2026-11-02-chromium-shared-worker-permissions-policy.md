---
title: "Chromium plumbs permissions policy into shared workers"
date: 2026-11-02 01:00:00 UTC
tags:
  - direct-sockets
  - chromium
  - permissions-policy
  - webadb
  - isolated-web-apps
---

Chrome's `PermissionsPolicyForSharedWorkers` feature landed a five-CL series
into `refs/heads/main` between 2026-09-30 and 2026-10-28, giving shared
workers an `allow` attribute that carries a parsed permissions policy into the
worker's global scope. That is the missing half of the "Direct Sockets API in
Shared/Service workers" entry on chromestatus, which has sat at *Proposed*
with no milestone since 2025-01-31.

It is also, incidentally, the reason this week's check turned up something
stranger: the chromestatus entry
[`6046077976444928`](https://chromestatus.com/feature/6046077976444928),
"Permission Policy Merger: `direct-sockets-private` with `local-network` and
`loopback-network`", is still describing a permission policy that Chromium
deleted outright four months ago. It says *Proposed*, milestone 151, and it
describes a "default unpacking" model that no longer exists in the tree.

Both facts are worth writing down carefully, because the gap between what the
status page says and what the tree does is exactly the kind of thing that
sends an implementer down the wrong path.

## The chromestatus entry that outlived its implementation

The entry's summary reads:

> Isolated Web App manifests now require specific "local-network" and/or
> "loopback-network" permission policies to enable Direct Sockets connections
> to local or loopback network addresses, respectively. This change replaces the
> existing "direct-sockets-private" permission policy.

Its stage table still lists a milestone-151 stage, and its `browsers.chrome`
block still says:

```json
"status": { "text": "Proposed", "val": 2, "milestone_str": "Proposed" },
"desktop": 151,
"origintrial": false,
"announced": true
```

The `updated` field on that entry is `2026-06-22 13:32:10`, by
`bhaskarsharma@google.com`. That is the last time anyone touched it.

Now the tree. Chromium commit
[`f1b445b81bac`](https://chromium.googlesource.com/chromium/src/+/f1b445b81bac)
— *"Remove direct-sockets-private permission policy"*, 2026-06-12 — did
substantially more than delete a policy name:

```
Bug: 492476083
Reviewed-on: https://chromium-review.googlesource.com/c/chromium/src/+/7845254
Reviewed-by: Vlad Krot <vkrot@google.com>
Reviewed-by: Danil Somsikov <dsv@chromium.org>
Reviewed-by: Nasko Oskov <nasko@chromium.org>
Reviewed-by: Andrew Rayskiy <greengrape@google.com>
Cr-Commit-Position: refs/heads/main@{#1646037}
```

Its commit message is one sentence, and it is the important sentence:

> This CL removes "direct-sockets-private" permission policy along with its
> default unpacking to "local-network" and "loopback-network" permission
> policies.

Note the shape of that sentence. "Direct Sockets private" was not *renamed* to
the pair, and it was not *unpacked* into the pair at runtime any more — it was
removed, and with it went the unpacking behavior. The two granular policies
now stand on their own.

The diff shows the scale of it. `kDirectSocketsPrivate` disappears from
`services/network/public/mojom/permissions_policy.mojom`, where the enum value
is not deleted but *reserved*:

```protobuf
message IwaAccessControl {
    CONTROLLED_FRAME = 1;
    DIRECT_SOCKETS = 2;
    DIRECT_SOCKETS_MULTICAST = 3;
    reserved 4;
    SMART_CARD = 5;
    SUB_APPS = 6;
    UNRESTRICTED_WEBUSB = 7;
}
```

`reserved 4` is the protobuf idiom for "this number was used, do not reuse
it." The value that was `DIRECT_SOCKETS_PRIVATE = 4` is now a hole. The same
pattern shows up in the IWA entitlement proto:

```cpp
constexpr std::string_view kEntitledFeatures[] = {
    "direct-sockets", "direct-sockets-multicast",
    "sub-apps",       "usb-unrestricted",
    "web-printing",   "controlled-frame",
#if defined(ENABLE_SMART_CARD)
    "smart-card",
#endif
};
```

`"direct-sockets-private"` is gone from the entitled-features list. The
`IwaEntitlementProto::DIRECT_SOCKETS_PRIVATE` enum value is gone from
`key_distribution.proto`, and the corresponding entitlement line is gone from
`key_distribution.textproto` — the file that ships the allowlist to ChromeOS
kiosk deployments.

### The browser-side enforcement path

The interesting part for anyone reading the tree today is in
`content/browser/direct_sockets/direct_sockets_service_impl.cc`. Before the
removal, the private-network access request path looked like this:

```cpp
if (!rfh->IsFeatureEnabled(
        network::mojom::PermissionsPolicyFeature::
            kDirectSocketsPrivate)) {
  std::move(callback).Run(/*access_allowed=*/false);
  return;
}

rfh->GetBrowserContext()
    ->GetPermissionController()
    ->RequestPermissionsFromCurrentDocument(...)
```

After, that whole first block is gone. The `kDirectSocketsPrivate` gate is
not replaced by a `kLocalNetwork` / `kLoopbackNetwork` gate *in that function*
— the permission check moved elsewhere, to the policy-controlled-feature
machinery that `local-network` and `loopback-network` already participate in
as ordinary policies.

This is the part that trips people up when they read the chromestatus entry
and then try to find the corresponding code. The "merger" the entry describes
is not a merger in the current tree; it is a removal, and the granular
policies were already there.

### What the removal meant in practice

The browsertest diffs are the clearest record of the behavior change, because
the policy declarations are explicit in them. Before:

```cpp
.WithPermissionsPolicy("direct-sockets", "(self)")
.WithPermissionsPolicy("direct-sockets-private", "(self)")
.WithPermissionsPolicy("direct-sockets-multicast", "(self)")
```

After:

```cpp
.WithPermissionsPolicy("direct-sockets", "(self)")
.WithPermissionsPolicy("local-network", "(self)")
.WithPermissionsPolicy("loopback-network", "(self)")
.WithPermissionsPolicy("direct-sockets-multicast", "(self)")
```

Note that *both* granular policies are now declared. `local-network` covers
RFC 1918 address space; `loopback-network` covers `127.0.0.0/8` and `::1`.
An app that wants a Direct Sockets connection to a LAN device needs the first;
one that wants to talk to a server on the same machine needs the second.

And the merge-time "unpacking" behavior is gone from the test suite too. The
commit deletes a whole test class from
`chrome/browser/web_applications/isolated_web_apps/isolated_web_app_permissions_policy_browsertest.cc`:

```cpp
-class IsolatedWebAppDirectSocketsPrivatePermissionsPolicyUnpackingTest
-    : public web_app::IsolatedWebAppBrowserTestHarness {
- public:
-  content::RenderFrameHost* InstallAndOpenIWAWithFeatures(
-      std::map<network::mojom::PermissionsPolicyFeature,
-               std::vector<url::Origin>> feature_map = {}) {
-    auto builder =
-        ManifestBuilder(
-            /*include_cross_origin_isolated_permissions_policy=*/true)
-        .AddPermissionsPolicyWildcard(
-            network::mojom::PermissionsPolicyFeature::kDirectSockets);
...
```

143 lines of test, all of it testing the unpacking. It is gone. If you go
looking for that behavior to understand how `direct-sockets-private` used to
work, the answer is that it does not work — the mechanism was removed along
with the policy.

### Why the entry was never updated

The plausible explanation is that the removal was framed as a cleanup rather
than a feature change. The CL description says "removes ... along with its
default unpacking" — that is a *correctness* framing, because the unpacking
was doing something surprising. But the chromestatus entry
[`6046077976444928`](https://chromestatus.com/feature/6046077976444928) is
still the entry a developer lands on when they search "Direct Sockets" and
want to know what manifest permissions to write. Its `updated` timestamp is
ten days *before* the commit that invalidated it, and its last edit was
2026-06-22 — ten days *after*. So the entry was already being maintained
after the removal, and still describes the old model.

For our own project this has a concrete consequence: any note we write about
"the merger" is describing a mechanism that no longer exists in the tree, and
any manifest we write should declare `local-network` and `loopback-network`
directly rather than expecting a `direct-sockets-private` declaration to be
unpacked into them.

## The `PermissionsPolicyForSharedWorkers` series

Now the genuinely new work. The chromestatus entry
[`5169039028256768`](https://chromestatus.com/feature/5169039028256768),
"Direct Sockets API in Shared/Service workers", reads:

> Allows Isolated Web Apps to establish direct transmission control protocol
> (TCP) and user datagram protocol (UDP) communications with network devices
> and systems as well as listen to and accept incoming connections from shared
> /service workers.
>
> The Direct Sockets API has been launched in Chrome 131 for window & dedicated
> worker contexts; this separate entry aims at expanding these to accommodate
> shared / service workers to achieve parity with the exposure of other
> networking capabilities such...

Its Chrome status block:

```json
"status": { "text": "Proposed", "val": 2, "milestone_str": "Proposed" },
"desktop": null,
"announced": false
```

No milestone. Not announced. Created 2025-01-31, and the entry's `updated`
field has not moved since 2025-02-12.

That entry is not going to move on its own. What *is* moving is the
permissions-policy plumbing that a shared-worker Direct Sockets
implementation would need — because a shared worker that can open raw TCP
sockets is exactly the kind of thing that needs a policy to constrain it, and
Chromium had no way to express a per-worker policy at all.

### The five CLs

Tracking bug `562705553`. All five land on `refs/heads/main`:

| Commit | Date | Subject |
|---|---|---|
| [`8c2c2dfb5fb2`](https://chromium.googlesource.com/chromium/src/+/8c2c2dfb5fb2) | 2026-09-30 | Add feature and define `allow` parameter |
| [`c40fd2ef2dec`](https://chromium.googlesource.com/chromium/src/+/c40fd2ef2dec) | 2026-10-20 | Parse `SharedWorkerOptions.allow` |
| [`3aa2f4ff7f9e`](https://chromium.googlesource.com/chromium/src/+/3aa2f4ff7f9e) | 2026-10-20 | Check `allow` against creator |
| [`c40dcca70c04`](https://chromium.googlesource.com/chromium/src/+/c40dcca70c04) | 2026-10-20 | Plumb to shared worker host |
| [`1c9716f07802`](https://chromium.googlesource.com/chromium/src/+/1c9716f07802) | 2026-10-21 | Send down to `SharedWorkerGlobalScope` |
| [`e8113630b3fd`](https://chromium.googlesource.com/chromium/src/+/e8113630b3fd) | 2026-10-28 | Ensure consistency of feature flags |

(The first CL is from 2026-09-30; the last is from four days ago. The series
was reviewed by Yoshisato Yanagisawa, Daniel Vogelheim, Hiroshige Hayashizaki,
Camille Lamy, Antonio Sartori, Mike West, and Reilly Grant.)

### CL 1 — the feature and the IDL

[`8c2c2dfb5fb2`](https://chromium.googlesource.com/chromium/src/+/8c2c2dfb5fb2)
adds the runtime-enabled feature and the optional IDL member:

> Define the PermissionsPolicyForSharedWorkers runtime-enabled feature with
> experimental status and enable it with
> --enable-experimental-web-platform-features in the browser process.
>
> Add the optional allow DOMString member to the SharedWorkerOptions IDL
> dictionary behind PermissionsPolicyForSharedWorkers, making it available to
> the SharedWorker constructors.

Three files touched:

```
content/public/common/content_switch_dependent_feature_overrides.cc (+3/-0)
third_party/blink/renderer/core/workers/shared_worker.idl (+1/-0)
third_party/blink/renderer/platform/runtime_enabled_features.json5 (+4/-0)
```

The `shared_worker.idl` change is the whole API surface of this CL — one
optional `DOMString allow` member on the `SharedWorkerOptions` dictionary:

```
dictionary SharedWorkerOptions {
  DOMString name;
  DOMString type;
  sequence<USVString> credentials;
};
```

becomes:

```
dictionary SharedWorkerOptions {
  DOMString name;
  DOMString type;
  sequence<USVString> credentials;
  DOMString allow;
};
```

This mirrors the `WorkerOptions` shape that the HTML standard specifies for
dedicated workers. A dedicated worker gets its `allow` list from the
`WorkerOptions` dictionary; a shared worker gets its own, because a shared
worker is instantiated by *many* documents and the policy has to be agreed
upon by all of them.

### CL 2 — parsing the attribute

[`c40fd2ef2dec`](https://chromium.googlesource.com/chromium/src/+/c40fd2ef2dec)
wires the parser in:

> Parse the allow attribute on SharedWorkerOptions using
> PermissionsPolicyParser::ParseAttribute() in SharedWorker::CreateImpl() when
> PermissionsPolicyForSharedWorkers is enabled, and log any parser messages to
> the execution context console.

The relevant part of the diff is in `shared_worker.cc` — a `PermissionsPolicyParser`
is constructed, `ParseAttribute()` is called with the allow string, and the
resulting feature list is checked.

The parser gains two new entry points:

```
third_party/blink/renderer/core/permissions_policy/permissions_policy_parser.cc (+29/-0)
third_party/blink/renderer/core/permissions_policy/permissions_policy_parser.h (+10/-0)
third_party/blink/renderer/core/permissions_policy/permissions_policy_test.cc (+61/-0)
third_party/blink/renderer/core/workers/build.gni (+1/-0)
third_party/blink/renderer/core/workers/shared_worker.cc (+35/-0)
third_party/blink/renderer/core/workers/shared_worker.h (+8/-0)
third_party/blink/renderer/core/workers/shared_worker_test.cc (+68/-0)
```

### CL 3 — the delegation check

[`3aa2f4ff7f9e`](https://chromium.googlesource.com/chromium/src/+/3aa2f4ff7f9e)
is the security-relevant one:

> Verify in SharedWorker::CreateImpl() that the creator ExecutionContext can
> delegate to the worker origin every feature parsed from
> SharedWorkerOptions.allow, and trigger Sharedworker.onerror otherwise.

This is the same rule that applies to `WorkerOptions.allow` in a dedicated
worker: the creator document may only delegate features it itself holds. A
page that does not have `direct-sockets` cannot create a shared worker that
has `direct-sockets`. If it tries, the construction fails and
`Sharedworker.onerror` fires.

The delegation machinery itself is added to the network service's policy
code:

```
services/network/public/cpp/permissions_policy/permissions_policy.cc (+10/-0)
services/network/public/cpp/permissions_policy/permissions_policy.h (+12/-0)
services/network/public/cpp/permissions_policy/permissions_policy_unittest.cc (+66/-0)
third_party/blink/renderer/core/permissions_policy/permissions_policy_parser.cc (+2/-8)
third_party/blink/renderer/core/workers/shared_worker.cc (+38/-5)
third_party/blink/renderer/core/workers/shared_worker.h (+7/-3)
third_party/blink/renderer/core/workers/shared_worker_test.cc (+162/-10)
```

### CL 4 — across the process boundary

[`c40dcca70c04`](https://chromium.googlesource.com/chromium/src/+/c40dcca70c04)
pushes the parsed policy from the renderer into the browser process:

> This CL adds permissions_policy as a parameter to
> blink.mojom.SharedWorkerInfo(), forwards the parsed permissions policy in
> the 'allow' attribute from SharedWorker::Create() to the browser process and
> validates browser-side whether the policy is allowed.

This is the CL that adds the mojom plumbing:

```
third_party/blink/public/mojom/worker/shared_worker_info.mojom (+5/-0)
services/network/public/mojom/permissions_policy/permissions_policy.mojom (+6/-0)
services/network/public/mojom/permissions_policy/permissions_policy_mojom_traits.cc (+8/-0)
services/network/public/mojom/permissions_policy/permissions_policy_mojom_traits.h (+15/-0)
content/browser/worker_host/shared_worker_service_impl.cc (+25/-0)
content/browser/worker_host/shared_worker_host.cc (+5/-1)
```

And it is the CL that adds the browser-side half of the delegation check —
`permissions_policy.cc` and `permissions_policy.h` each grow a dozen lines,
and `permissions_policy_mojom_traits.h` grows fifteen.

### CL 5 — into the worker's global scope

[`1c9716f07802`](https://chromium.googlesource.com/chromium/src/+/1c9716f07802)
finally stores it where the worker can consult it:

> Pass the worker's parsed permissions policy in the SharedWorkerInfo sent via
> SharedWorkerFactory::CreateSharedWorker(), plumb it to
> WebSharedWorkerImpl::StartWorkerContext() and store it in the SecurityContext
> of the newly created WorkerGlobalScope.

The diff in `web_shared_worker_impl.cc` is where the policy actually gets
applied:

```cpp
if (RuntimeEnabledFeatures::PermissionsPolicyForSharedWorkersEnabled()) {
  const url::Origin worker_origin =
      (creation_params->origin_to_use
           ? creation_params->origin_to_use.get()
           : outside_settings_object->GetSecurityOrigin())
      ->ToUrlOrigin();
  creation_params->worker_permissions_policy =
      network::PermissionsPolicy::CreateFromInheritedPolicy(
          // TODO(https://crbug.com/562705553): Parse the Permissions-Policy
          // header and take header_policy into account.
          permissions_policy, /*header_policy=*/{}, worker_origin);
}
```

Two things worth noticing in that snippet.

First, `CreateFromInheritedPolicy` is a *new* factory method added by this
CL, sitting next to the existing `CreateFromParsedPolicy`:

```cpp
// static
std::unique_ptr<PermissionsPolicy> PermissionsPolicy::CreateFromInheritedPolicy(
    const network::PermissionsPolicyFeaturesBitset& inherited_policies,
    const network::ParsedPermissionsPolicy& header_policy,
    const url::Origin& origin) {
  return base::WrapUnique(new PermissionsPolicy(
      origin, CreateAllowlistsAndReportingEndpoints(header_policy),
      inherited_policies, network::GetPermissionsPolicyFeatureList(origin)));
}
```

Second, the `TODO` is honest about a gap: the `Permissions-Policy` *response
header* is not parsed yet — only the `allow` attribute is. The
`/*header_policy=*/{}` argument is an empty parsed policy. That is a real
limitation of the current implementation, not a documentation nicety.

The same CL also removes a `TODO` that had been sitting in
`content/browser/worker_host/shared_worker_host.cc` — the one that said the
permissions policy was *not* yet stored on the `SharedWorkerInstance` and sent
down to the renderer:

```cpp
-      // TODO(https://crbug.com/562705553): Store the shared worker's
-      // permissions policy on the SharedWorkerInstance and send it down to the
-      // renderer process.
-      network::PermissionsPolicyFeaturesBitset()));
+      instance_.permissions_policy()));
```

### CL 6 — flag consistency

[`e8113630b3fd`](https://chromium.googlesource.com/chromium/src/+/e8113630b3fd),
four days ago, is the one that makes the previous CLs safe to actually enable:

> This CL ensures that the runtime enabled flag
> PermissionsPolicyForSharedWorkers in blink can only be enabled in
> conjunction with the counterpart blink feature. That is necessary because
> part of the functionality is implemented in the browser process.

The problem it solves: Blink has a *runtime-enabled feature*
(`RuntimeEnabledFeatures::PermissionsPolicyForSharedWorkersEnabled()`, used
above in `web_shared_worker_impl.cc`), and the browser process has a
*base::Feature* (`blink::features::kPermissionsPolicyForSharedWorkers`).
If only one of the two is on, the renderer will consult a policy that the
browser never validated. So `content/child/runtime_features.cc` now resolves
the mismatch at startup:

```cpp
if (!base::FeatureList::IsEnabled(
        blink::features::kPermissionsPolicyForSharedWorkers)) {
  LOG_IF(WARNING,
         WebRuntimeFeatures::IsPermissionsPolicyForSharedWorkersEnabled())
      << "PermissionsPolicyForSharedWorkers cannot be enabled in this "
         "configuration. Use --"
      << switches::kEnableFeatures << "="
      << blink::features::kPermissionsPolicyForSharedWorkers.name
      << " instead.";
  WebRuntimeFeatures::EnablePermissionsPolicyForSharedWorkers(false);
}
```

And `runtime_enabled_features.json5` gains one line to match:

```json5
{
  name: "PermissionsPolicyForSharedWorkers",
  status: "experimental",
  public: true,
},
```

`public: true` means the Blink-side runtime feature is exposed to JS as
`self.PermissionsPolicyForSharedWorkers`, so a page can feature-detect it
instead of guessing.

## Why this is the Direct Sockets prerequisite

The connection to Direct Sockets is not speculative. The chromestatus entry
for workers-scoped Direct Sockets is *Proposed* with no milestone, but the
Chromium flags that gate it were explicitly extended last month.

Commit [`7dba2c9e4dc0`](https://chromium.googlesource.com/chromium/src/+/7dba2c9e4dc0),
2026-05-08, *"Extend the direct-sockets-in-*-worker flags"*:

> This commit extends the direct-sockets-in-shared-workers and
> direct-sockets-in-service-workers feature flag to M170. The feature is not
> launched yet.

The diff is in `chrome/browser/flag-metadata.json`, and it is only about
expiry dates:

```json
{
  "name": "direct-sockets-in-service-workers",
  "owners": [ "//content/browser/direct_sockets/OWNERS" ],
- "expiry_milestone": 150
+ "expiry_milestone": 170
},
{
  "name": "direct-sockets-in-shared-workers",
  "owners": [ "//content/browser/direct_sockets/OWNERS" ],
- "expiry_milestone": 150
+ "expiry_milestone": 170
},
```

Both flags now expire at milestone 170 — roughly a year of runway past where
they were, and a clear signal that Chromium intends to launch the feature
before then.

The history of those flags is worth a short walk, because it shows the shape
of the problem:

- `cea39453dc19` (2025-02-11) — "Add #direct-sockets-in-service-workers flag to about://flags"
- `f807b7164793` (2025-02-10) — "DirectSockets: support shared workers on the browser side"
- `3f3a3797878f` (2025-02-06) — "DirectSockets: Add Shared/Service workers to .idl defs behind flags"
- `b4d6430bfe1d` (2025-04-07) — "[DirectSockets] Relax the CrossOriginCapability requirement for workers"
- `2bba61b431f3` (2026-04-01) — "[Direct Sockets] Implement dynamic enablement in Isolated Contexts"

The browser side of worker-scoped Direct Sockets has been in the tree for
about twenty-one months. What it did *not* have, until this series, was a
permissions-policy mechanism to constrain what a shared worker may do. A
shared worker opened by many documents needs an agreed policy, and there was
no way to express one.

That is exactly what `PermissionsPolicyForSharedWorkers` adds. The
`allow` attribute on `SharedWorkerOptions` is the standard HTML shape for
"this worker gets these features, and every creator must be able to delegate
them."

The `allow` list is a list of *feature names* — and the feature names for
Direct Sockets are `direct-sockets`, `direct-sockets-multicast`,
`local-network`, and `loopback-network`. A shared worker that wants to open a
TCP socket to a LAN address would need:

```js
const worker = new SharedWorker("worker.js", {
  name: "adb",
  allow: "direct-sockets local-network loopback-network",
});
```

That is the shape the Chromium implementation now supports.

## The state of the board

Pulling it together, here is where each piece stands as of 2026-11-02:

| Entry | chromestatus status | Tree reality |
|---|---|---|
| `direct-sockets` (core API) | Enabled by default, 131 | shipped |
| Source-Specific Multicast | Enabled by default, 158 | shipped (`030237772913`, `863435829ee0`) |
| `direct-sockets-private` merger | **Proposed, 151** | **removed 2026-06-12 (`f1b445b81bac`)** |
| Direct Sockets in Shared/Service workers | **Proposed, no milestone** | browser side shipped 2025-02; flags extended to M170 2026-05-08; **permissions-policy plumbing landed 2026-09-30 → 2026-10-28** |
| `WebRequest.SecurityInfo` in Controlled Frame | Proposed, 145 | unchanged since 2026-01-27 |

Two rows in that table are stale, and they are stale in opposite directions.
The merger entry overstates a change that was reverted into a plain removal.
The worker entry understates work that has been landing in the tree for
five weeks.

Neither is a problem for webadb.online today — we use WebUSB, not Direct
Sockets, in the shipped product. But `lib/adb-daemon-tcp.ts` implements the
wireless-ADB-over-TCP transport on top of `navigator.openTCPSocket()`, and
that file's comments are written against the *old* mental model:

```typescript
// Browser requirements:
//   - Chrome 142+ (we tested 150.0.7871.114)
//   - One of:
//       * Origin Trial token for "Direct Sockets API" (added to the page)
//       * chrome://flags/#enable-experimental-web-platform-features enabled
//       * Enterprise policy allow-list
//   - The page must be served over HTTPS (webadb.online is) and must already
//     pass the crossOriginIsolated check (webadb does). Direct Sockets
//     requires `crossOriginIsolated === true` to even be visible.
```

The "Origin Trial token" line is stale in a different way: the Direct Sockets
API shipped enabled-by-default in Chrome 131 for window and dedicated worker
contexts, so there is no origin trial to enroll in for the main use case. The
`local-network` / `loopback-network` policies are the current gating
mechanism, not `direct-sockets-private`. And the "Chrome 142+" floor is
conservative — the API has been on by default since 131.

## What this means for webadb.online

No impact on the shipped product this week. The Direct Sockets transport in
`lib/adb-daemon-tcp.ts` remains an experimental Wi-Fi-ADB path behind a
browser capability probe, and nothing that landed in the last seven days
changes the transport's availability on a normal page.

Two things are worth watching, though.

The first is that the `PermissionsPolicyForSharedWorkers` series is the first
concrete movement in the worker-scoped Direct Sockets path in months. If the
`direct-sockets-in-shared-workers` flag is launched before M170, the natural
shape for a browser ADB client is a shared worker owning a persistent TCP
connection to the device's wireless-debug port, with the main thread talking
to it over a `MessagePort`. That would move the TCP framing off the UI
thread entirely. The flag expiry bump to M170 is the visible signal that
launch is planned; the permission-policy plumbing is the first blocker
cleared.

The second is the chromestatus merger entry. If we ever document the
Direct Sockets requirements for the wireless-ADB transport, we should
describe `local-network` and `loopback-network` as the policies to declare —
not `direct-sockets-private`, and not a "merger" that unpacks one into the
other. Chromium removed that mechanism on 2026-06-12. The status page is
still telling people to write a policy name that no longer exists.

Upstream ya-webadb had no new commits in the last 24 hours — the most recent
are `59e95a0` and `93fce38` from 2026-10-30, both covering the PCM player's
AudioContext resume, which [the 2026-10-31
post](https://webadb.online/blog/2026/10/31/ya-webadb-shares-audiocontexts-and-zstd-crosses-into-simd/)
already documented. The `v3.0.0-beta.4` tag from 2026-10-09 remains the
newest release.
