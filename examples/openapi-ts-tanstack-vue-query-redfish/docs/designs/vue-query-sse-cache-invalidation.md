# SSE-driven Vue Query cache invalidation

Author: Jason Westover (Discord: jasonwestover)

Other contributors: None

Created: May 1, 2026

## Problem Description

A Redfish-driven UI built on TanStack Vue Query gets free response
caching, request deduplication, and background refetching, but with the
default settings the only signals it has for "this resource changed" are
`staleTime` plus `refetchOnWindowFocus`/`refetchOnReconnect`. That is
strictly a polling model. Redfish, however, _already_ exposes a push
channel — every Redfish service may optionally publish
`/redfish/v1/EventService/SSE`, and every event could optionally carry
a `OriginOfCondition` URI that names the resource that changed. This
design pins down how to bridge those two: a deterministic mapping from
an SSE event's `OriginOfCondition` (and its `MessageId`) to one or more
Vue Query cache entries, so that the cache stays correct without any
polling and without any per-feature plumbing in components. The pattern
is implemented end-to-end in the
`examples/openapi-ts-tanstack-vue-query-redfish/` reference app and is
the runtime complement to the codegen-side design in
[`openapi-integration-webui-vue.md`][openapi-integration]. The non-goals
are: replacing TanStack Vue Query, replacing Pinia for client-only
state, and dictating the BMC's choice of polling vs. push for resources
that do not appear in `OriginOfCondition`.

## Background and References

- **TanStack Vue Query** — declarative server-state cache for Vue 3
  with hierarchical query keys. Invalidating a prefix automatically
  cascades to every key that starts with that prefix.
  <https://tanstack.com/query/latest/docs/vue/overview>
- **`@hey-api/openapi-ts` `@tanstack/vue-query` plugin** — generates
  a `*QueryKey()` and a `*Options()` helper for every typed
  operation. The query key is shaped as
  `[{ _id: <operationId>, baseURL, path?, query?, body?, headers? }]`
  — the operation id is the discriminator. Each operation's URL
  template is published in the `*Data` types (`GetChassisData['url']`
  is the literal `'/redfish/v1/Chassis'`) and is resolved to a
  concrete URL by the engine via a small `_id → url` registry plus
  `path` substitution. <https://heyapi.dev/openapi-ts/plugins/tanstack-query>
- **DMTF Redfish DSP0266 §13** — defines `EventService`,
  `EventService.SSE`, the `OriginOfCondition` field, and the
  `MessageId` registry pattern (`<RegistryPrefix>.<MajorMinor>.<MessageKey>`).
  <https://www.dmtf.org/dsp/DSP0266>
- **Reference implementation** — the rest of this project (the
  `openapi-ts-tanstack-vue-query-redfish` example, of which this
  document is part) demonstrates the SSE composable, the
  `client.sse.get(...)` fetch+`ReadableStream` consumer that allows
  custom auth headers, the Pinia store that mirrors connection state
  for the UI, and the `useSSEQueryInvalidation` engine that this
  design specifies.
- **Related design (codegen)** —
  [`openapi-integration-webui-vue.md`][openapi-integration] covers
  _what_ the typed SDK looks like, _where_ it lives, and the two-mode
  generation workflow. This document covers _how_ the cache is kept
  fresh once that SDK is wired up.
- **Pinia** — used here only for client-only state (UI prefs, derived
  computations). Server state stays in the Vue Query cache.
  <https://pinia.vuejs.org/>

## Requirements

The constraints come both from Redfish semantics and from the way
`@hey-api/openapi-ts` shapes its output.

**Deterministic query keys.** Every Redfish read that goes through the
generated SDK MUST use a query key the SSE-invalidation engine can
match against an `OriginOfCondition` URI. Concretely: each generated
`*Options()` helper produces a key shaped as
`[{ _id: '<operationId>', path?, query?, … }]`. The engine resolves
that key to a concrete URL by looking `_id` up in a per-app
`REDFISH_OPERATION_URLS` registry (one entry per scoped operation,
co-located with the engine) and substituting any `path` placeholders.
Maintaining the registry is the only piece of glue this design adds on
top of the generated output; if a future revision of the
`@tanstack/vue-query` plugin embeds the URL template in the key
directly, the registry collapses to a no-op without changing call
sites.

**No raw fetches that bypass the cache.** Any call site that fetches a
Redfish resource without a matching Vue Query hook MUST still write its
result into the cache, or the SSE engine has nothing to invalidate.
This is enforced by an axios _response_ interceptor that runs once per
GET, derives the same key shape that the generated hooks use, and
populates the cache via `queryClient.setQueryData`. The reference app
installs this interceptor in `src/client-setup.ts` alongside the
`X-Auth-Token` interceptor.

**Tolerate every BMC.** Real BMCs vary in OData `$expand`/`$select`
support, in event richness, and in whether they emit `OriginOfCondition`
at all. The invalidation engine MUST degrade gracefully: a missing
`OriginOfCondition` falls back to `MessageId`-pattern matching, an
unknown registry falls back to a no-op, and a buffer-overflow event
(`EventBufferExceeded`) falls back to a global
`invalidateQueries({})`.

**No coupling between codegen and runtime.** The query-key shape is
controlled by the `@hey-api/openapi-ts` `@tanstack/vue-query` plugin.
The SSE invalidator is a pure runtime composable. Either piece can be
upgraded independently.

**Cross-BMC reproducibility.** The mapping from `OriginOfCondition` and
`MessageId` to invalidation targets MUST be defined declaratively
(plain data, not code) so that vendor-specific events can be added by
overlaying additional rules without forking the engine.

## Proposed Design

The design has four moving parts: the **query key contract**, the
**dual cache population** path that lets non-Vue-Query callers stay in
the cache, the **SSE invalidation engine** that turns events into
`invalidateQueries` calls, and a **rule registry** for the cases where
`OriginOfCondition` alone is not enough.

### Architecture overview

```
                +------------------------------+
                |       Vue components         |
                +---------------+--------------+
                                |
                                | useQuery / useMutation
                                v
                +------------------------------+
                |  Generated SDK (openapi-ts)  |
                |  - getChassisOptions()       |
                |  - postSessionService...     |
                +---------------+--------------+
                                |
                                | client.instance (single AxiosInstance)
                                v
        +----------------------+----------------------+
        |                                             |
        |     +-----------------------------+         |
        |     |  Vue Query cache            |         |
        |     |   keyed by                  |         |
        |     |   [{ _id, url, … }]         |         |
        |     +--------------+--------------+         |
        |                    ^                        |
        |  setQueryData      |       invalidateQueries|
        |  (response         |          (predicate)   |
        |   interceptor)     |                        |
        |                    |                        |
        |     +--------------+--------------+         |
        |     |  Cache invalidator           |        |
        |     |   maps OriginOfCondition →   |        |
        |     |   query-key URL prefix       |        |
        |     +--------------+--------------+         |
        |                    ^                        |
        |                    |                        |
        |     +--------------+--------------+         |
        |     |  useSSE composable           |        |
        |     |  client.sse.get(            |        |
        |     |    EventService/SSE)         |        |
        |     +-----------------------------+         |
        +---------------------------------------------+
```

The `useSSE` composable opens (and re-opens with retry/backoff and
`Last-Event-ID` resumption) the SSE stream, parses each event with the
`parseSSEEvent` helper, and hands an `EventRecord[]` to the
invalidator. The invalidator runs the rule registry and calls
`queryClient.invalidateQueries(...)` for each match.

### Query key contract

The `@hey-api/openapi-ts` `@tanstack/vue-query` plugin emits two
helpers per typed operation. For Redfish `GET /redfish/v1/Chassis` they
look like this:

```ts
// (sketch of the generated output — see src/client/@tanstack/vue-query.gen.ts)
export const getChassisQueryKey = (opts) => createQueryKey('getChassis', opts);

export const getChassisOptions = (opts) =>
  queryOptions({
    queryFn: async ({ queryKey, signal }) => {
      const { data } = await getChassis({ ...queryKey[0], signal });
      return data;
    },
    queryKey: getChassisQueryKey(opts),
  });
```

`createQueryKey('getChassis', options)` produces a single-element key
array whose only element is an object carrying the operation id
(`_id: 'getChassis'`), the resolved `baseURL`, and any of `path`,
`query`, `body`, `headers` that the caller passed. The literal URL
template lives on the corresponding `*Data` type
(`GetChassisData['url']`) but is intentionally _not_ picked into the
query key — the plugin keeps the key narrow by treating the URL as a
property of the operation, not a property of the call.

The common query-key patterns the engine has to handle:

```ts
useQuery(getServiceRootOptions());
// → [{ _id: 'getServiceRoot', baseURL }]

useQuery(getChassisOptions());
// → [{ _id: 'getChassis', baseURL }]

useQuery(getChassisByIdOptions({ path: { ChassisId: 'BMC_0' } }));
// → [{ _id: 'getChassisById', baseURL,
//      path: { ChassisId: 'BMC_0' } }]
```

To bridge from a key like the third one to the concrete URL
`/redfish/v1/Chassis/BMC_0`, the engine consults a small per-app
registry keyed on `_id`:

```ts
export const REDFISH_OPERATION_URLS: Readonly<Record<string, string>> = {
  getChassis: '/redfish/v1/Chassis',
  getChassisById: '/redfish/v1/Chassis/{ChassisId}',
  getServiceRoot: '/redfish/v1',
  // … one row per operation in SCOPED_OPERATIONS …
};
```

For each cached query the engine: (a) reads `_id`, (b) looks it up in
the registry, (c) substitutes `path` placeholders, (d) prefix-matches
the result against the SSE event's `OriginOfCondition`. Operations
with no entry in the registry (mutations, hand-rolled hooks) are
silently skipped, which is the right default — they are not the kind
of cache the engine cares about.

The registry duplicates information that already exists in
`*Data['url']` types. A future revision of the `@tanstack/vue-query`
plugin that embeds the URL template directly in the query key would
make `REDFISH_OPERATION_URLS` unnecessary; the engine would then read
the URL straight off the key. Until that happens, the registry is the
single piece of glue that has to be kept in sync with
`SCOPED_OPERATIONS`.

### Dual cache population

Two paths populate the same Vue Query cache, both producing identical
key shapes so the invalidator does not have to special-case anything:

1. **Generated Vue Query hooks.** `useQuery(getChassisOptions())` uses
   `getChassisQueryKey()`, which is `[{ _id: 'getChassis', url:
'/redfish/v1/Chassis', … }]`. Vue Query owns the lifecycle.

2. **Axios response interceptor.** The interceptor lives in
   `src/client-setup.ts` next to the `X-Auth-Token` interceptor. For
   every successful `GET /redfish/*` it calls

   ```ts
   queryClient.setQueryData(deriveCacheKey(response.config), response.data);
   ```

   where `deriveCacheKey` reproduces the same shape the plugin emits:
   `[{ _id: opIdFromUrl(url), url, path, query }]`. Mutations are
   deliberately _not_ cached this way; they go through `useMutation`
   plus an explicit invalidation in the mutation's `onSuccess`.

The reference app does not need (2) for its current dashboard, but the
moment a view drops to a hand-rolled `client.instance.get(...)` (for
example because the SDK helper has not been added to
`SCOPED_OPERATIONS` yet), the interceptor keeps that response in the
same cache that the SSE engine already manages.

An HTTP-layer cache (`axios-cache-interceptor` with ETag support) sits
_below_ the Vue Query cache and gives the `If-Match` round-trip behaviour
that `webui-vue` already depends on. This is orthogonal to query-key
invalidation; the two caches do not see each other.

### SSE invalidation engine

The engine is a single composable, `useSSEQueryInvalidation`, that
subscribes to events from `useSSE` and calls `invalidateQueries` per
event. It is intentionally pure: same input → same `invalidateQueries`
calls.

#### Step 1 — extract the candidate URL

Every Redfish event carries either `OriginOfCondition['@odata.id']`
(preferred) or, for some BMCs, a flat `OriginOfCondition` string. The
engine normalises both to a single `originPath: string` and skips the
event if the field is absent.

```
SSE Event:
  MessageId:           ResourceEvent.1.0.ResourceChanged
  OriginOfCondition:   /redfish/v1/Chassis/BMC_0/Sensors/temp1

  → originPath = '/redfish/v1/Chassis/BMC_0/Sensors/temp1'
```

#### Step 2 — match against the Vue Query cache

The engine calls `queryClient.invalidateQueries(...)` with a `predicate`
that evaluates each cached query against `originPath`:

```ts
type KeyShape = { _id?: string; path?: Record<string, string> };

queryClient.invalidateQueries({
  predicate: (query) => {
    const key = query.queryKey[0] as KeyShape;
    const template = key?._id && REDFISH_OPERATION_URLS[key._id];
    if (!template) return false;
    const concrete = resolveUrlTemplate(template, key.path);
    return concrete === originPath || originPath.startsWith(`${concrete}/`);
  },
});
```

`resolveUrlTemplate` substitutes `{ChassisId}` with `path.ChassisId`,
yielding the same concrete URL the BMC saw. Prefix matching is
intentional: when `OriginOfCondition` points at
`/redfish/v1/Chassis/BMC_0/Sensors/temp1`, _every_ parent collection
query also gets invalidated (`/redfish/v1/Chassis`,
`/redfish/v1/Chassis/BMC_0`, `/redfish/v1/Chassis/BMC_0/Sensors`,
`/redfish/v1/Chassis/BMC_0/Sensors/temp1`). This is exactly what
TanStack Query's hierarchical-prefix invalidation gives you for free
when keys are path-shaped — we just rebuild it on top of the
URL-bearing shape that `@hey-api/openapi-ts` actually emits.

#### Step 3 — `ResourceCreated` / `ResourceRemoved` parent invalidation

For these two `MessageId` patterns, the engine _also_ invalidates the
parent collection so that a newly added or removed member surfaces in
list views immediately:

```
MessageId:           ResourceEvent.1.0.ResourceCreated
OriginOfCondition:   /redfish/v1/Systems/system0

  → invalidate originPath itself
  → also invalidate parent: '/redfish/v1/Systems'
```

#### Step 4 — static rule registry (escape hatch)

Some events do not carry an `OriginOfCondition` (or carry one that is
not the resource a UI would actually show). The engine consults a small
declarative rule table keyed on `MessageId` patterns and (optionally)
`ResourceType` values. Each rule lists query-key URL prefixes to
invalidate.

```ts
type SseInvalidationRule = {
  messageIdPattern: RegExp; // e.g. /^TaskEvent\./
  resourceTypes?: ReadonlyArray<string>;
  invalidate: ReadonlyArray<string>; // URL prefixes
};

const RULES: ReadonlyArray<SseInvalidationRule> = [
  {
    // Task lifecycle — refresh the task list and the service header.
    invalidate: ['/redfish/v1/TaskService'],
    messageIdPattern: /^TaskEvent\./,
  },
  {
    // Firmware updates — the OriginOfCondition is usually the FW
    // image; we surface the listing so progress is visible.
    invalidate: ['/redfish/v1/UpdateService'],
    messageIdPattern: /^Update\./,
  },
];
```

A real `invalidate` array can list as many URL prefixes as needed
(the shipped table also includes `/redfish/v1/TaskService/Tasks`,
`/redfish/v1/UpdateService/FirmwareInventory`, etc.). One prefix per
rule is enough to communicate the shape.

Vendor extensions land in this table without touching the engine.

#### Step 5 — the `EventBufferExceeded` fallback

The reference app already implements this: when the BMC reports it
dropped events, the engine bails out of fine-grained matching and calls
`queryClient.invalidateQueries({})`. The rest of the design only
_reduces_ the frequency with which this fallback is needed — it never
removes the need for it.

### Where the pieces live

In the reference example (and analogously in `webui-vue`):

```
src/
├── client-setup.ts                  # axios interceptors:
│                                    #  - request:  X-Auth-Token
│                                    #  - response: 401 → /login
│                                    #  - response: setQueriesData(...)
│                                    #              for any GET /redfish/*
├── composables/
│   ├── parseSSEEvent.ts             # Event envelope parser
│   ├── useSSE.ts                    # Stream consumer, retries, store mirror
│   ├── sseInvalidationRules.ts      # REDFISH_OPERATION_URLS registry,
│   │                                # default rule table, predicates
│   └── useSSEQueryInvalidation.ts   # The engine described above
└── stores/
    ├── auth.ts                      # session token (sessionStorage)
    └── sse.ts                       # connection state + bounded event log
```

`useSSEQueryInvalidation` is mounted once from `App.vue` so it is
alive for the entire app lifetime; it has no UI and exposes no state.
Per-view code never touches the engine — components only call
`useQuery(getXxxOptions())` and the cache stays current automatically.

## Alternatives Considered

**(a) Polling instead of SSE invalidation.** Set `staleTime: 0` and
`refetchInterval: <n>s` on every `useQuery`. Simple, but wastes
bandwidth on resources that almost never change (for example
`ServiceRoot`, `Chassis` membership) and lags behind for resources that
change often (sensor readings, task progress). Rejected because
Redfish already publishes the change events; polling would be paying
twice and trusting neither signal.

**(b) Operation-id-only query keys.** The `@hey-api/openapi-ts`
`@tanstack/vue-query` plugin defaults to embedding the operation id in
the key (`createQueryKey('getChassis', options)`). It is tempting to
match SSE events on operation id alone, e.g. "`ResourceChanged` →
invalidate everything keyed `getChassisById`". Rejected because it
loses _per-instance_ targeting: an event for `Chassis/BMC_0` would
also invalidate the cache for `Chassis/BMC_1`, defeating the cache.
Resolving each query's `_id` to a concrete URL via the
`REDFISH_OPERATION_URLS` registry plus `path` substitution is one
extra hash lookup per cached query; the cost is negligible and the
precision gain is large.

**(c) Rewriting query keys to plain path arrays at codegen time.**
A custom plugin (or a post-generation script) could turn
`createQueryKey('getChassis', options)` into `['Chassis']`,
`['Chassis','BMC_0']`, etc. — closer to TanStack Query's idiomatic
prefix-matching shape and matching the convention used in some Orval
prototypes (e.g. Gerrit `openbmc/webui-vue +/86518`). Rejected
_for now_ because the URL-in-key shape that `@hey-api/openapi-ts`
emits already supports the same invalidation semantics via the
`predicate`-based match and avoids the maintenance cost of owning a
custom plugin. If a future revision of the plugin offers a
`queryKeys: 'path'` knob upstream, this design accepts that as a
drop-in simplification.

**(d) Pinia for server state.** Pinia is an excellent client-state
manager but does not solve any of the problems this design targets:
no built-in deduplication, no built-in cache, no SSE integration. It
remains the right choice for client-only state (UI prefs, derived
computations) and continues to be used that way alongside Vue Query.

**(e) Re-fetching everything on every SSE event.** The simplest
imaginable engine: `useSSE` sees an event, calls
`queryClient.invalidateQueries({})`. Rejected because it defeats the
cache: every event causes every visible resource to refetch, which on
a busy system overwhelms the BMC. The fine-grained engine
_degrades_ to this only when the BMC reports `EventBufferExceeded`.

**(f) Custom event bus that bypasses Vue Query.** Components could
subscribe directly to `useSSE` events and refetch their own data.
Rejected because that ties every consumer to the SSE event shape and
duplicates the registry pattern across the app. Concentrating the
mapping in one composable keeps the component code SSE-agnostic.

## Impacts

**API impact.** None. The Redfish API is unchanged.

**Security impact.** None new beyond what the codegen design already
introduces. Auth still flows through the existing `X-Auth-Token` /
`401 → /login` interceptors. The SSE stream uses the same token via
the `onRequest` hook on `client.sse.get(...)`.

**Documentation impact.** This document is the primary reference. The
codegen-side design at
[`openapi-integration-webui-vue.md`][openapi-integration] links here
for the runtime-cache-coherence contract. The reference example's
`README.md` gains a short pointer to this doc.

**Performance impact.** Net positive. Vue Query already deduplicates
in-flight requests and caches responses; the SSE engine replaces
`refetchInterval` polling with event-driven refetch (typically <100 ms
of latency from the BMC's emit to the cache update). Bundle cost is
small — `useSSEQueryInvalidation` is well under 100 LOC plus a
declarative rule table.

**Developer impact.** Net positive on the UI side, with one new
contract for event producers.

_UI / view authors_ — strictly less work. As long as a view consumes
the generated SDK (`useQuery(getXxxOptions())`,
`useMutation(postXxxMutation())`), cache freshness, deduplication,
retries, background refetch on focus, and SSE-driven invalidation all
happen for free. There is no per-feature SSE wiring, no manual
"refetch this list on save" code, and no global event bus to
subscribe to. The only thing a view author still does is _use the
generated hook_; the engine takes care of the rest.

_BMC firmware / Redfish event producers_ — gain one client-visible
contract: `OriginOfCondition` is now a _cache invalidation key_, not
just a diagnostic field.

- Emitting an event with the correct, fully-qualified
  `OriginOfCondition` URI causes every UI watching that resource (or
  a parent collection of it) to refresh in the next event-loop tick.
  For most cases this is exactly what producers already write.
- Emitting `ResourceCreated` / `ResourceRemoved` with the URI of the
  _new or gone_ member additionally refreshes the parent collection,
  so list views surface adds/removes without a manual "refresh"
  affordance.
- Emitting an event without an `OriginOfCondition`, or with one that
  points at an internal resource the UI does not show, falls through
  to the static rule table (`TaskEvent.*`,
  `Update.*`, …). New `MessageId` registries that need similar
  treatment are added by appending one row to that table.
- Emitting `EventBufferExceeded` continues to mean "I dropped events
  on the floor"; the engine responds by flushing the entire cache.
  Event producers that have a healthy queue rarely need to send
  this. Event producers that _do_ send this should think of it as
  a coarse-but-correct fallback, not a load-shedding strategy.

In short: if your UI view uses the generated SDK, you do not have to
think about SSE at all. If your firmware emits SSE, the
`OriginOfCondition` field you were already setting now has a precise
client-side effect — and JSDoc on `useSSEQueryInvalidation` plus this
document spell that effect out for the rare case where it is not
obvious.

**Upgradability impact.** Low. If `@hey-api/openapi-ts` ships a future
option to reshape generated query keys, the engine adapts by changing
its `predicate`; no view code changes. Vendor-specific events are
absorbed by extending the rule table.

### Organizational

- **Does this proposal require a new repository?** No.
- **Initial maintainer(s)?** The proposing author plus the
  `webui-vue` core maintainers, when this lands downstream.
- **Repositories expected to be modified?**
  - `hey-api/openapi-ts` (this repo) — adds this document and a
    `useSSEQueryInvalidation` composable in the Redfish reference
    example.
  - `openbmc/webui-vue` — picks the same composable up when the
    [companion codegen design][openapi-integration] lands.

## Testing

**Unit (engine).** `useSSEQueryInvalidation` is exercised against a
hand-built `QueryClient` populated with synthetic queries whose keys
mimic the generated shape. Each test asserts which queries are
invalidated for a given `EventRecord`:

- _`ResourceChanged` on `/redfish/v1/Chassis/BMC_0/Sensors/temp1`_
  with the cache pre-loaded with `getChassis`,
  `getChassisById(BMC_0)`, `getChassisSensors(BMC_0)`,
  `getChassisSensorById(BMC_0, temp1)`, and `getChassisById(BMC_1)`
  → all four `BMC_0`-shaped queries are invalidated; the `BMC_1`
  query is untouched.
- _`ResourceCreated` on `/redfish/v1/Systems/system0`_ with
  `getSystems`, `getSystemsById(system0)`, and `getChassis` cached
  → `getSystems` (parent) and `getSystemsById(system0)` are
  invalidated; `getChassis` is untouched.
- _`TaskEvent.1.0.TaskCompletedOK`_ (no `OriginOfCondition`) with
  `getTaskService`, `getTaskServiceTasks`, and `getChassis` cached
  → first two are invalidated via the rule table; `getChassis` is
  untouched.
- _`EventBufferExceeded`_ with any cache state
  → every query is invalidated (global fallback).

**Unit (parser).** `parseSSEEventData` already has table-driven tests
in the reference example for envelope vs. flat-record shapes,
malformed JSON, and the `EventBufferExceeded` sentinel. Add cases for
the `OriginOfCondition`-string-vs-object variants that real BMCs emit.

**Integration.** A test that pipes a fake SSE stream (using a mock
`fetch` that emits `data: {...}` chunks) through `useSSE` →
`useSSEQueryInvalidation` → `QueryClient`, asserting the same matrix
above end-to-end.

**Component.** Tests verify that components using
`useQuery(getXxxOptions())` re-render with new data after the
invalidator fires for a matching `OriginOfCondition`.

**CI impact.** All of the above run under the existing Vitest config.
No new infrastructure is required.

[openapi-integration]: ./openapi-integration-webui-vue.md
