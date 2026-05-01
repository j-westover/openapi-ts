# Typecheck performance

The committed scoped Redfish SDK at `src/client/` is small (~1.4 MB across
~100 `.gen.ts` files), but the DMTF schema's deeply-nested unions /
intersections / `as const` enums are expensive for TypeScript to analyse.
A cold `pnpm typecheck` (or `pnpm build`) currently takes about
**5 minutes** on a quiet macOS arm64 host. This document explains why,
what was investigated for a faster alternative, and what to watch for
upstream so we can flip the switch when the time is right.

## Why it is slow

`pnpm typecheck` runs `vue-tsc --build --force`. `vue-tsc` is the
[Vue Tooling](https://github.com/vuejs/language-tools) wrapper around
TypeScript's `tsc` that adds Vue SFC support, and it inherits `tsc`'s
single-threaded check loop. The dominant cost is walking
`src/client/**/*.gen.ts` end-to-end (the entire scoped Redfish SDK plus
its TanStack Vue Query helpers) on every cold run.

The `--force` flag intentionally invalidates the incremental cache
(`node_modules/.tmp/*.tsbuildinfo`), which is what produces the cold
timing. With a warm cache, the same `vue-tsc --build` (no `--force`)
runs in **~0.28 s** because every project reference reports "up to
date" and exits early.

| Mode                        | Time   |
| --------------------------- | ------ |
| `vue-tsc --build --force`   | ~5 min |
| `vue-tsc --build` (warm)    | ~0.3 s |
| `vite build` (no typecheck) | ~3 s   |

So the cold cost is real but only paid in CI / clean-checkout. Day-to-day
local development hits the warm path.

## Why not switch to `tsgo` today

The hey-api workspace has already adopted [TypeScript Native Preview
(`tsgo`)](https://github.com/microsoft/typescript-go) for its non-Vue
packages — every `packages/*` directory's `typecheck` script reads
`tsgo --noEmit`, and the Axios example uses
`tsgo --noEmit && vite build`. tsgo is a Go-based reimplementation of
TypeScript with internal parallelism; in our measurements, it can
type-check the example's `.ts`-only portion in ~5–6 s (a ~50× speedup
over `tsc`'s ~5 min).

The blocker for _this_ example is **`.vue` SFC support**, which tsgo
does not yet have. The Vue Tooling team's tracking issue is
[`vuejs/language-tools#5381`][issue-5381] (open, last updated
2026-04-29). Per maintainer comments there:

- Tsgo does not yet expose a stable plugin API, so Volar — the language
  server that powers vue-tsc — cannot host its SFC type-checking inside
  tsgo.
- The official path is **TypeScript 7.1's plugin API**, which is being
  designed in [`microsoft/typescript-go#2824`][ts-go-2824] but has no
  release timeline.
- A targeted PR ([`vuejs/language-tools#5860`][lang-pr-5860]) shipped in
  December 2025, but it only adopted tsgo for the language-tools repo's
  own internal development — it did not surface user-facing tsgo support
  for Vue projects. `vue-tsc` 3.2.x has no `--use-tsgo` flag.

[issue-5381]: https://github.com/vuejs/language-tools/issues/5381
[ts-go-2824]: https://github.com/microsoft/typescript-go/issues/2824
[lang-pr-5860]: https://github.com/vuejs/language-tools/pull/5860

## Community workarounds — measured

Two community drop-in replacements were recommended in the
language-tools issue thread by the maintainers themselves. Both were
benchmarked against this example end-to-end on 2026-05-01.

| Tool                                     | Cold timing | Warm timing  | Exit | Notes                                           |
| ---------------------------------------- | ----------- | ------------ | ---- | ----------------------------------------------- |
| `vue-tsc --build --force`                | **~289 s**  | **0.28 s**   | 0    | Baseline. Authoritative.                        |
| [`golar`][golar] `typecheck`             | **~79 s**   | ~5.4 s       | 0    | **3.7× faster cold.** Multi-core (user > real). |
| [`vue-tsgo`][vue-tsgo] `--build --force` | **~139 s**  | not measured | 1    | 2.1× faster cold. Single-threaded wrapper.      |

[golar]: https://github.com/auvred/golar
[vue-tsgo]: https://github.com/KazariEX/vue-tsgo

Both tools were installed in a scratch directory (`/tmp/redfish-tsgo-bench/`)
without modifying the example's `package.json`. Reproducing the
measurement is a five-minute exercise — see
[Reproducing the benchmark](#reproducing-the-benchmark) below.

### Findings

- **`golar` is the clear cold-run winner.** Faithful checks
  (verified by injecting a deliberate rename and confirming both `.vue`
  consumers were flagged in 5.4 s warm), genuine multi-core utilisation
  on cold, drop-in for `vue-tsc --noEmit` per the author. It uses
  `@vue/language-core` internally for SFC handling.
- **`vue-tsgo` is honest but not parallel.** The wall-clock improvement
  comes from tsgo's faster single-thread, not concurrency.
- **`vue-tsgo` flags 2 × TS2883** "inferred type cannot be named
  without a reference to `AxiosError`" warnings on
  `useManagedSystem` that neither `vue-tsc` nor `golar` surface. Those
  are real TS 7 stricter-declaration-portability checks (not bugs in
  our code) and would need explicit return-type annotations on
  `useManagedSystem` to silence. `golar` apparently relaxes them to
  keep behavioural parity with `vue-tsc`.
- **Warm-cache picture flips the conclusion for everyday work.**
  `vue-tsc`'s incremental mode lands at 0.28 s; `golar` has no
  incremental support today and runs ~5 s warm. So local development
  loop: `vue-tsc` still wins. CI / clean checkout: `golar` wins
  decisively.

## Decision

For this branch we are staying on **`vue-tsc --build --force`** until
either:

- `vue-tsc` itself adds a stable `--use-tsgo` flag, or
- `golar` ships incremental-rebuild support and reaches 1.x.

Adopting an early-stage drop-in tool as a permanent `devDependency` on a
public example is more risk than the current cold cost warrants. The
warm-cache developer experience is already excellent (~0.3 s).

What we **did** change as part of this investigation:

- **`tsconfig.app.json`**: dropped the redundant `baseUrl: "."`. It was
  not doing anything useful when `paths` is also set, and tsgo-family
  tools error out on it (`error TS5102: Option 'baseUrl' has been
removed`). Removing it preserves vue-tsc behaviour exactly while
  unblocking future tsgo experiments.

## Reproducing the benchmark

```bash
# 1. Drop the BMC URL so the dev server uses the in-process mock (or
#    leave it set — the typecheck does not touch the network).
cd examples/openapi-ts-tanstack-vue-query-redfish

# 2. Set up a scratch dir for the tsgo-family tools.
mkdir /tmp/redfish-tsgo-bench && cd /tmp/redfish-tsgo-bench
npm init -y >/dev/null
npm install --no-save golar @golar/vue vue-tsgo

# 3. Pin a golar config that points at the example's source tree.
cat > golar.config.ts <<'EOF'
import { defineConfig } from 'golar/unstable';
import '@golar/vue';

const EXAMPLE = '<absolute path to examples/openapi-ts-tanstack-vue-query-redfish>';

export default defineConfig({
  typecheck: {
    include: [`${EXAMPLE}/src/**/*.ts`, `${EXAMPLE}/src/**/*.vue`, `${EXAMPLE}/env.d.ts`],
    exclude: [`${EXAMPLE}/src/**/__tests__/*`, `${EXAMPLE}/src/**/*.spec.ts`],
  },
});
EOF

# 4. Run each tool with /usr/bin/time -p for a wall-clock comparison.
cd <example>
rm -rf node_modules/.tmp
/usr/bin/time -p ./node_modules/.bin/vue-tsc --build --force         # baseline

cd /tmp/redfish-tsgo-bench
/usr/bin/time -p node --experimental-strip-types --no-warnings \
  ./node_modules/.bin/golar typecheck                                 # golar

cd <example>
/usr/bin/time -p /tmp/redfish-tsgo-bench/node_modules/.bin/vue-tsgo --build --force  # vue-tsgo
```

## Future-proof checklist

- Track [`vuejs/language-tools#5381`][issue-5381] for `vue-tsc --use-tsgo`
  landing.
- Track [`microsoft/typescript-go#2824`][ts-go-2824] for the TS 7.1
  plugin API needed for proper Vue support.
- Track [`auvred/golar`][golar] release pace — incremental-rebuild
  support is the missing piece that would make golar a strict win for
  daily local use.
- When any of those land, the migration is a **two-line change**: bump
  `vue-tsc` (or add `golar`/`@golar/vue` as devDeps), update the
  `typecheck` and `build` scripts in `package.json`. The
  `tsconfig.app.json` cleanup landed in this branch is the only
  prerequisite.
