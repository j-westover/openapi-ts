# OpenAPI integration for `webui-vue`

Author: Jason Westover (Discord: jasonwestover)

Other contributors: None

Created: May 1, 2026

## Problem Description

`webui-vue` (the Vue 3 + Vite reference UI for OpenBMC) currently talks to
the BMC by hand-rolling [Axios] calls and locally-typed shapes against the
[Redfish] REST API. There is no source-of-truth contract between the
front-end and the BMC: every new endpoint becomes a new ad-hoc fetch helper
and a hand-maintained TypeScript shape, response/error handling is
inconsistent across stores, and Redfish schema drift (a vendor adds a field,
DMTF deprecates one) can only be caught at runtime in the browser. The
DMTF, however, ships a complete, machine-readable OpenAPI document for
Redfish, so this is exactly the kind of contract that codegen exists to
solve. This design proposes adopting [`@hey-api/openapi-ts`][hey-api] with
its [`@hey-api/client-axios`][hey-api-axios] runtime plug-in to generate a
typed Redfish SDK from that spec, **layered on top of the existing Axios
instance** that `webui-vue` already configures, and surfaced through
[TanStack Vue Query]. The generated client is added alongside today's
hand-rolled calls in the first PR; individual stores/views migrate over
in independent follow-ups.

The explicit non-goals — and equivalently, the things this proposal
preserves — are:

- **Keep Axios as the HTTP transport.** `webui-vue` relies on Axios for
  several behaviours that the browser `fetch` API does not provide
  natively: response-header access for `ETag`/`If-Match` request
  serialisation, request/response interceptors for the
  `X-Auth-Token` / 401-redirect flow, configurable
  `transformRequest`/`transformResponse` hooks, automatic JSON parsing,
  upload/download progress events, and request cancellation via
  `CancelToken`. Choosing `@hey-api/client-axios` (rather than
  `@hey-api/client-fetch`, `client-ofetch`, `client-ky`, etc.) means
  every generated SDK call routes through the _same_ `AxiosInstance` the
  existing code uses, so existing interceptors, ETag conditionals,
  proxies, and timeouts all keep applying without change.
- **Keep Pinia and Vue Query as the state/cache layers.** No store
  rewrites; the new SDK exposes Vue Query option helpers that drop into
  existing `useQuery`/`useMutation` call sites.
- **No user-visible behaviour change** in the first PR.

This design covers the codegen and wiring of the typed SDK. The
companion runtime design — how SSE events from
`/redfish/v1/EventService/SSE` are mapped to Vue Query cache
invalidations so the cache stays correct without polling — is in
[`vue-query-sse-cache-invalidation.md`][sse-cache] and depends only on
the query-key shape that this design's `@tanstack/vue-query` plugin
emits. The two designs are intended to land together but are scoped as
independent reviews.

## Background and References

- **OpenBMC `webui-vue`** — the Vue 3 + Vite reference UI for OpenBMC, used
  to manage Redfish-conformant systems through the BMC's HTTP API.
  <https://github.com/openbmc/webui-vue>
- **DMTF Redfish OpenAPI** — DMTF publishes a complete, versioned OpenAPI
  3.x document describing the Redfish surface area, mirrored under
  <https://github.com/DMTF/Redfish-Publications> at
  `openapi/openapi.yaml`.
- **`@hey-api/openapi-ts`** — production-ready OpenAPI → TypeScript codegen
  with a plug-in architecture that emits an SDK, a runtime client, schemas,
  and adapters for [TanStack Query] (React, Vue, Svelte, Angular), Pinia
  Colada, ofetch, ky, fetch, and Axios. <https://heyapi.dev/>
- **TanStack Vue Query** — the data-fetching/caching primitive already in
  use elsewhere in the Vue ecosystem and a natural fit for Redfish
  collections (`Systems`, `Chassis`, `Managers`, …) and for SSE streams via
  `client.sse.get(...)`. <https://tanstack.com/query/latest>
- **Reference implementation** — the
  `examples/openapi-ts-tanstack-vue-query-redfish/` directory of the
  `@hey-api/openapi-ts` repository contains a working end-to-end example
  that targets a DMTF Redfish BMC, demonstrates session-based auth, the
  `EventService` SSE stream over fetch (for header-based `X-Auth-Token`
  forwarding), the `parser.filters.operations.include` mechanism for
  trimming the generated surface, and a Vite middleware mock for local
  development without a BMC. This design proposes folding the same shape
  into `webui-vue`.
- **Prior art in `webui-vue` itself** — Gerrit change
  [openbmc/webui-vue 86518][gerrit-orval] ("Redfish API generation +
  Vue Query") prototyped this same idea with `orval` as the codegen
  tool. It built and verified `+1` on Jenkins, but stood up roughly
  1000 LOC of custom build-pipeline code (schema preprocessing, model
  post-processing, dist generation, a pre-commit hook, a Vite alias)
  to work around Redfish-specific rough edges in Orval. This design
  treats that change as the empirical baseline for the comparison in
  _Alternatives Considered (c)_ below.
- **Companion runtime design** —
  [`vue-query-sse-cache-invalidation.md`][sse-cache] specifies how the
  query-key shape this design produces is consumed by an SSE-driven
  invalidation engine, so that cached data refreshes automatically
  when the BMC publishes an event. That design is the runtime pillar
  of the same feature; this one is the codegen pillar.
- **Glossary**
  - **SDK**: the per-operation TypeScript functions and Vue Query helpers
    emitted by `openapi-ts` (`getServiceRoot`, `getSystemsOptions`, …).
  - **Scoped client**: the trimmed subset of the SDK that is committed to
    git, governed by `parser.filters.operations.include`.
  - **Full client**: the entire DMTF surface area; useful for
    IDE/agent type discovery, never committed.

## Requirements

The constraints come both from the mechanics of `webui-vue` and from
OpenBMC's release/CI conventions.

**Users.** Three kinds of contributors are affected: (a) BMC firmware
developers who consume the UI to validate Redfish behaviour; (b) UI
developers who add features that call new Redfish endpoints; (c)
distribution maintainers who ship `webui-vue` as part of a BMC firmware
image and run a release build that must be reproducible offline.

**Compatibility.** The first integration PR must be a strict superset of
today's behaviour: every existing route, store, and component continues to
work unchanged, every existing fetch helper continues to be used. Only
_new_ code may use the generated SDK. Migration of existing fetches is
handled in subsequent PRs and is not blocked on this design merging.

**Build hygiene.** OpenBMC firmware builds rely on `npm install` +
`npm run build` running deterministically through a corporate proxy with
no further outbound network access during the build itself. The codegen
step (which has to fetch or read the Redfish OpenAPI document) must
therefore be **separable from `npm run build`**: it produces files that
are committed to the repository, and the release build only consumes
those committed files.

**Tree-shaking and bundle size.** The full DMTF Redfish spec is large
(thousands of versioned schemas, hundreds of paths). A naïve generation
emits ~9 MB of TypeScript and slows `vue-tsc` to multi-minute runs. The
committed subset must be small enough that typecheck stays in the
single-digit-second range and the production bundle stays close to its
current size. The reference example demonstrates a 100× reduction in
typecheck time and a tree-shaken SDK chunk under 5 kB minified.

**Auth, sessions, ETag, and SSE.** Redfish uses session tokens delivered
as `X-Auth-Token` headers (per
[DMTF DSP0266](https://www.dmtf.org/dsp/DSP0266) §13). Several Redfish
mutating operations also require optimistic-concurrency control via
`If-Match: <ETag>`; `webui-vue` reads the response `ETag` header on a
prior `GET` and replays it on the subsequent `PATCH`/`PUT`/`DELETE`. The
generated `@hey-api/client-axios` runtime delegates every request to the
host application's `AxiosInstance`, so the existing request and response
interceptors that implement `X-Auth-Token` injection, ETag capture, and
401-redirect logic continue to apply unchanged for every generated SDK
call.

Server-Sent Events are the one place where the generated client uses
`fetch` instead of Axios — `client.sse.get(...)` consumes a
`ReadableStream` so that `X-Auth-Token` can be set as a header on the
`EventService/SSE` stream, sidestepping the `EventSource`-cookie
workaround the current `webui-vue` uses. This is a non-goal for the
first PR but informs the architecture choice.

**OpenBMC contribution flow.** Changes are reviewed via Gerrit, not pull
request, and the maintainers expect commits split along clean boundaries:
introduction of tooling, introduction of generated artefacts, then
per-feature migrations. This proposal is sized to fit that flow.

## Proposed Design

The integration is a two-layer addition that sits _next to_ the existing
data layer, never on top of it. The first PR delivers the tooling and the
committed scoped artefacts but wires nothing up; subsequent PRs migrate
specific features.

### HTTP transport: `@hey-api/client-axios`

Of the seven runtime client plug-ins `openapi-ts` ships
(`@hey-api/client-axios`, `-fetch`, `-ofetch`, `-ky`, `-next`, `-nuxt`,
`-angular`), this design selects **`@hey-api/client-axios`**. The
generated runtime exposes its `AxiosInstance` as `client.instance` and
routes every SDK call through it, which means `webui-vue` continues to
get all of the Axios features it currently depends on:

- `request`/`response` **interceptors** — for `X-Auth-Token`
  injection, 401 → `/login` redirection, and the `ETag` capture used by
  optimistic-concurrency `PATCH`/`PUT`/`DELETE` flows.
- **Full response object** — `ETag`, `Location`, and other response
  headers are first-class on the returned `AxiosResponse`, not buried
  behind a separate `headers.get()` call as on `fetch`.
- `transformRequest` / `transformResponse` hooks — used by `webui-vue`
  for legacy boolean coercion and for un-quoted ETag header
  normalisation.
- **Cancellation** via `AbortController` _and_ `CancelToken` — the
  latter is what existing `webui-vue` route guards use to cancel
  in-flight requests on navigation.
- **Upload/download progress** — needed for the firmware-update view.
- **Per-baseURL `AxiosInstance`s** — `webui-vue` routes some traffic
  through the BMC and some through a local mock; both can be supplied
  by passing distinct `client` instances to the generated SDK calls.

Concretely, PR-1 wires the existing `AxiosInstance` into the generated
client at app boot:

```ts
// src/main.ts (sketch)
import { client } from '@/client/client.gen';
import { existingAxios } from '@/api/axios'; // already exists in webui-vue

client.setConfig({ axios: existingAxios });
```

After this single line, every call to a generated SDK function
(`getSystems`, `patchSystemById`, …) goes through the same Axios
instance — same interceptors, same baseURL, same `withCredentials`,
same ETag capture — as the hand-rolled calls do today.

### Layer 1 — codegen tooling (PR-1, behavioural no-op)

Add the following to `webui-vue`:

```
.
├── openapi-ts.config.ts          # generation config + operation filter
├── scripts/
│   └── redfish-spec-patch.ts     # spec preprocessing helpers
├── specs/
│   └── redfish.yaml              # vendored DMTF spec (offline)
└── src/
    ├── client/                   # COMMITTED scoped SDK (small)
    └── client.full/              # GITIGNORED full SDK (dev only)
```

`openapi-ts.config.ts` is a single file that:

1. Reads the spec from `./specs/redfish.yaml` (vendored) by default, with
   `REDFISH_OPENAPI_URL` as an override hook.
2. Selects between _full_ and _scoped_ mode via `REDFISH_SCOPE`:
   - `REDFISH_SCOPE=full` (or unset) writes the entire SDK to
     `src/client.full/` (gitignored). This is for local dev and for
     coding-agent type discovery.
   - `REDFISH_SCOPE=scoped` writes only the operations listed in
     `SCOPED_OPERATIONS` (a top-level constant in the config) to
     `src/client/`. This is what gets committed and shipped.
3. Patches a few well-known Redfish quirks at parse time: collapses
   `Foo_v1_2_3_Foo` schema names, fills dangling `$ref` stubs, injects
   `$expand` / `$select` / `$filter` / `$top` / `$skip` query parameters
   on every Redfish `GET`, un-marks `UserName`/`Password`/`Token` on the
   `Session` schema as `readOnly` so the generated `SessionWritable`
   actually contains the login fields, and synthesises Orval-style
   `operationId`s for paths that don't declare one.
4. Emits four files (`client.gen.ts`, `sdk.gen.ts`, `types.gen.ts`,
   `@tanstack/vue-query.gen.ts`) plus the static `client/` and `core/`
   subdirectories. The `index.ts` re-export barrel and the
   `@hey-api/schemas` runtime registry are _not_ generated — they would
   each add several MB and the SDK already exports specific paths.

`package.json` adds two scripts:

```jsonc
"openapi-ts": "openapi-ts",                              // → src/client.full/
"openapi-ts:scoped": "REDFISH_SCOPE=scoped openapi-ts", // → src/client/
```

`npm run build` is **not changed** and continues to be a pure
typecheck-plus-bundle step against the committed `src/client/`. There is
no codegen on the build path. The PR sequence is structured so the merge
of PR-1 changes the build-time behaviour by 0 ms.

### Layer 2 — opt-in usage (PR-N, one feature at a time)

Generated artefacts are imported through the `@/client/` alias the same
way the example uses them. A typical migration of a hand-rolled call
looks like:

```vue
<script setup lang="ts">
// Before:
//   const { data } = await axios.get('/redfish/v1/Systems');
//   systems.value = data?.Members ?? [];

// After:
import { useQuery } from '@tanstack/vue-query';
import { getSystemsOptions } from '@/client/@tanstack/vue-query.gen';

const systems = useQuery(getSystemsOptions());
</script>
```

For mutations, error tracking, request cancellation, optimistic updates,
and retries, the existing patterns from `webui-vue` (Pinia stores, BVToast
notifications) layer over Vue Query without modification.

The `@hey-api/openapi-ts` `@tanstack/vue-query` plugin emits query keys
that carry the request URL inside `query.queryKey[0]`. That property is
the contract between this codegen and the SSE-driven cache invalidation
engine described in [`vue-query-sse-cache-invalidation.md`][sse-cache]:
the engine reads the URL out of every cached query, resolves any
templated path parameters, and prefix-matches against an SSE event's
`OriginOfCondition` URI. No customisation of the generated keys is
required; PR-1 just exposes them via the standard `*Options()` helpers.

The `EventService/SSE` stream is the one place where the typed SDK
provides material new behaviour: the generated `client.sse.get(...)` uses
`fetch` + `ReadableStream`, which lets us pass `X-Auth-Token` as a header
directly instead of relying on cookies. This removes the long-standing
"only-cookies-on-EventSource" workaround that `webui-vue` and its
maintainers have repeatedly worked around.

### Architecture diagram

```
        +-------------------------+      +--------------------------+
        |  DMTF Redfish OpenAPI   |      |  Vendor Redfish overlay  |
        |  (specs/redfish.yaml)   |      |  (optional, future PR)   |
        +-----------+-------------+      +-------------+------------+
                    |                                  |
                    +----------------+ +---------------+
                                     | |
                                     v v
                       +-----------------------------+
                       |  @hey-api/openapi-ts        |  only run by
                       |  + openapi-ts.config.ts     |  `openapi-ts:scoped`
                       |  + redfish-spec-patch.ts    |
                       +--------------+--------------+
                                      |
                                      v
                +----------------------+----------------------+
                |   src/client/  (committed, scoped, ~120kB)  |
                |   - client.gen.ts (singleton)               |
                |   - sdk.gen.ts (typed operations)           |
                |   - types.gen.ts                            |
                |   - @tanstack/vue-query.gen.ts              |
                +----------------------+----------------------+
                                      |
                                      v consumed by
                       +-----------------------------+
                       |  Vue components + Pinia     |
                       |  stores via                 |
                       |    useQuery / useMutation   |
                       +-----------------------------+
                                      |
                                      v
                          npm run build  (no network)
```

## Alternatives Considered

**(a) Hand-rolled types only, no codegen.** This is the status quo. It
keeps the dependency surface minimal (no `openapi-ts`) but it leaves the
contract problem unsolved: Redfish has thousands of types, vendors extend
it, and the version drift across BMC implementations is material.
Rejected because the maintenance cost grows linearly with surface area
covered.

**(a′) `@hey-api/openapi-ts` with `@hey-api/client-fetch` (or
`-ofetch` / `-ky`) instead of `-axios`.** The fetch-family runtimes are
smaller and have no Axios runtime dependency. They were rejected because
`webui-vue` materially depends on Axios behaviours that the
fetch-family clients either lack or implement differently:

- **ETag round-tripping for optimistic concurrency.** `webui-vue`
  captures the `ETag` response header in a global response interceptor
  and replays it as `If-Match` on the matching mutation. Axios exposes
  response headers as a normal object on the `AxiosResponse`;
  `client-fetch` would force every interceptor and store to switch to
  the `Headers` API, which is a cross-cutting refactor.
- **`CancelToken`-based request cancellation** used by existing
  `webui-vue` route guards. `AbortController` is a separate API and
  `webui-vue`'s helpers are not yet migrated to it.
- **`transformRequest` / `transformResponse` hooks** used today for
  legacy quirks (un-quoted ETag normalisation, boolean coercion on
  certain BMC responses).
- **Upload progress events** for the firmware-update flow.

Choosing `@hey-api/client-axios` keeps every one of those mechanisms
working as-is for both old hand-rolled calls _and_ new generated calls,
because both go through the same `AxiosInstance`. A future PR could
revisit fetch-based transport once those behaviours are migrated; this
proposal does not block it.

**(b) `openapi-typescript` (drosse­l/openapi-typescript) only.** This
emits a single `paths` interface that you index into per request. It's
zero-runtime and tiny, but it also produces no SDK functions, no Vue
Query helpers, and no SSE client — every call site is still hand-rolled
and only the response shapes are typed. Rejected because it solves only a
fraction of the problem.

**(c) `orval` — attempted first; see Gerrit change
[openbmc/webui-vue 86518][gerrit-orval].** Orval emits an Axios SDK
and Vue/React/Svelte Query helpers, and a working 12-patchset
integration was prototyped against this exact spec, verified by Jenkins
(`Verified +1`), and posted for review. Standing that prototype up
revealed enough Redfish-specific rough edges that this proposal moves
to `@hey-api/openapi-ts` instead. Concretely, the Orval prototype had to
add, _in addition_ to the Orval CLI itself:

- a `@redocly/cli` dependency and a `schema:bundle` script to resolve
  external `$ref`s into a single document — `openapi-ts` does this
  in-process via the bundled `@hey-api/json-schema-ref-parser`;
- a hand-written `scripts/api/preprocess-schema.ts` to massage the
  spec for Orval v7 (`oneOf`/`anyOf`-null → `nullable: true`, enum
  descriptions reshaped from object to array form) — `openapi-ts`
  exposes the same hook as a typed `parser.patch.input` callback;
- a hand-written `pascal-case-models.ts` post-processor with
  case-collision detection to clean the versioned
  `Foo_v1_2_3_Foo` schema names — `openapi-ts` provides
  `parser.transforms.schemaName`;
- a hand-written `operation-name/` post-processor for paths that
  declare no `operationId` (the majority on Redfish) —
  `openapi-ts` provides `parser.patch.operations`;
- a custom `scripts/pre-commit-api.js` hook plus a Vite alias plus a
  `check-api` guard script to swap a ~24 MB `redfish.gen.ts` (full,
  gitignored) for a ~20 kB `redfish.dist.ts` (committed) and to
  rewrite `.gitignore` on the fly with the set of model files the
  app actually imports — `openapi-ts` covers the same workflow with
  one declarative `parser.filters.operations.include` and two
  separate output paths, no aliasing, no `.gitignore` rewriting,
  no usage-analysis pass;
- a patched `src/api/mutator/axios-instance.ts` to stop the
  generated mutator from throwing `ReferenceError: localStorage is
not defined` in Node/SSR contexts — `@hey-api/client-axios` takes
  the host application's existing `AxiosInstance` via
  `client.setConfig({ axios })` and never owns storage itself, so
  whatever rules `webui-vue` already has around storage continue to
  apply unchanged;
- generation that takes **~3 minutes** end-to-end against the DMTF
  spec (the wrapper script in the Orval prototype prints progress
  indicators specifically because of this) — the equivalent
  `openapi-ts:scoped` run in the Redfish reference example completes
  in **~16 seconds**;
- no native typed SSE client — Orval does not generate one. The
  fetch + `ReadableStream` SSE client used by this proposal is built
  into `@hey-api/openapi-ts` as `client.sse.get(...)` with
  `Last-Event-ID` resumption, jittered exponential backoff, and
  `AbortSignal` cancellation already wired up. Hand-rolling that for
  Orval is doable but is another ~250 LOC of code to own.

In aggregate, the Orval prototype contributed roughly 1000 LOC of
custom build-pipeline code (`scripts/api/`, `scripts/pre-commit-api.js`,
`src/api/mutator/`, `src/api/operation-name/`,
`pascal-case-models.ts`, the dist-generation pipeline, the Vite alias,
the `.gitignore` rewriter, the `check-api` guard) on top of the Orval
CLI to work around gaps that are specific to Redfish's shape and size.
Most of that custom code matches one-for-one with a built-in feature
of `@hey-api/openapi-ts`. Moving to `@hey-api/openapi-ts` collapses the
new surface area down to a single `openapi-ts.config.ts` plus a small
`redfish-spec-patch.ts` helpers file — the exact shape used by the
existing Redfish reference example in the `@hey-api/openapi-ts`
monorepo.

**(d) Generate at build time, not commit-time.** Run `openapi-ts` as a
`prebuild` step so generated files are never committed. Rejected because
it would require network access during release builds and would
materially slow `npm run build`. Committing the scoped artefacts and
running codegen only when the operation list changes is strictly cheaper
on every dimension that matters (CI time, reproducibility, diff
reviewability).

**(e) Generate the entire DMTF surface and tree-shake at the bundler.**
Vite already tree-shakes the SDK chunk to a few kB, but `vue-tsc` still
walks the entire 9 MB of generated `.gen.ts` files and turns the
typecheck step into a 5+ minute wait. Rejected because the developer
experience cost is too high. Committing a scoped subset (with the full
spec available locally on disk for discovery) gives both fast typechecks
_and_ full IDE visibility.

## Impacts

**API impact.** None on the existing public surface in PR-1. Subsequent
per-feature PRs will replace internal call sites with typed equivalents
but will not change props, events, route names, store shapes, or HTTP
behaviour observable from the BMC's point of view.

**Security impact.** Slightly positive on net. The generated client makes
auth handling consistent (single `client.instance.interceptors.request`
location for `X-Auth-Token`; single 401-handler for forced logout). The
fetch-based SSE client (used for the `EventService/SSE` stream) removes
the need to mirror the session token into a cookie purely so the dev
proxy can re-inject it onto `EventSource` requests. New attack surface
introduced by `@hey-api/openapi-ts` is _codegen-time only_: the package
runs as a devDependency, never executes in the browser, and the runtime
deps it pulls in are limited to `axios` (already used) plus a small SSE
parser (~200 LOC, vendored into `src/client/core/`).

**Documentation impact.** Adds a `docs/openapi-integration.md` page
covering: the `full` vs `scoped` workflow, how to add a new endpoint to
the scoped surface, how to vendor a fresh spec, and how to write a new
view that uses the generated Vue Query helpers. Updates `CONTRIBUTING.md`
with a single-paragraph pointer at the new doc.

**Performance impact.** Net positive. Bundle size stays flat because vite
already tree-shakes; runtime is identical (Axios / fetch). The committed
SDK is ~120 kB on disk, which is negligible against the rest of the repo.
Typecheck and build wall-clock numbers are listed in the reference
example's build-timing report and are well within OpenBMC's existing
budget.

**Developer impact.** The biggest operational change. Developers gain
end-to-end types for every request and response, automatic Vue Query
helpers, and an editable list (`SCOPED_OPERATIONS`) that documents
exactly which Redfish endpoints `webui-vue` calls. The cost is one new
script in their workflow (`npm run openapi-ts:scoped`) when adding a new
endpoint. The full SDK at `src/client.full/` is gitignored, so cloning
the repo and running `npm install && npm run build` works without ever
running codegen.

**Upgradability impact.** The DMTF Redfish spec versions independently of
`webui-vue`. Refreshing the spec is now a deterministic three-line
operation (`curl` to `specs/redfish.yaml`, `npm run openapi-ts:scoped`,
review the diff). Vendor extensions can be added later by overlaying a
patch on top of the DMTF spec inside `parser.patch.input` — the same
mechanism the reference example uses for `unlockSessionLoginFields`.

### Organizational

- **Does this proposal require a new repository?** No.
- **Initial maintainer(s)?** The current `webui-vue` maintainer set, with
  the proposing author co-listed for the first one or two release cycles
  to handle codegen-related issues.
- **Repositories expected to be modified?**
  - `openbmc/webui-vue` — primary
  - `openbmc/docs` — to add this design and a brief pointer page
  - No firmware repositories are affected; the change is browser-only.

## Testing

**Unit.** The pure helpers added in `scripts/redfish-spec-patch.ts`
(`buildOperationName`, `cleanSchemaName`, `unlockSessionLoginFields`,
`patchDanglingSchemaRefs`, `stampVersionedSchemaDescriptions`) are
covered by Vitest unit tests in `tests/unit/redfish-spec-patch.test.ts`.
None of them touch the network or the file system, so they run in <100
ms and gate every PR. The `parseSSEEventData` helper from the reference
example is also unit-tested with table-driven inputs (single record,
record array, `EventBufferExceeded`, malformed JSON).

**Generated-artefact drift.** A CI step runs
`REDFISH_OPENAPI_URL=./specs/redfish.yaml npm run openapi-ts:scoped`
and then `git diff --exit-code src/client/`. A PR that changes
`SCOPED_OPERATIONS` without committing the regenerated client fails
this check; a PR that updates `specs/redfish.yaml` without
re-running codegen also fails. Both cases produce an actionable error.

**Integration.** Existing `webui-vue` Cypress / Vitest integration tests
continue to run unmodified (PR-1 changes no behaviour). Per-feature
migration PRs are individually testable: each one swaps a single store
or view, and Cypress runs against the existing mock harness that
`webui-vue` already maintains.

**Build reproducibility.** A separate CI step runs the OpenBMC release
script flow (`rm -rf node_modules && npm install && npm run build`) in
network-isolated mode (no DNS for outbound traffic) and asserts that the
build succeeds and produces a stable hash. This proves the `npm run build`
step is genuinely network-free, which is the primary contract of this
design.

**CI impact.** The above adds three jobs to the matrix: unit tests
(~5 s), drift check (~20 s including spec parse), and isolated build
(~30 s). All three run in parallel and add no critical-path time to the
existing pipeline.

[Axios]: https://axios-http.com/
[Redfish]: https://www.dmtf.org/standards/redfish
[hey-api]: https://heyapi.dev/
[hey-api-axios]: https://heyapi.dev/openapi-ts/clients/axios
[gerrit-orval]: https://gerrit.openbmc.org/c/openbmc/webui-vue/+/86518
[sse-cache]: ./vue-query-sse-cache-invalidation.md
[TanStack Query]: https://tanstack.com/query/latest
[TanStack Vue Query]: https://tanstack.com/query/latest/docs/vue/overview
