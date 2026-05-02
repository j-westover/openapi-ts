/**
 * Configures the generated `@hey-api/client-axios` client used by the
 * SDK, and wires up the request/response pipeline that:
 *
 *   - injects the Redfish session token (`X-Auth-Token`) on every
 *     request,
 *   - replays response `ETag`s as `If-None-Match` so the BMC can
 *     short-circuit unchanged GETs with `304 Not Modified` instead
 *     of re-sending the full payload (via
 *     [`axios-cache-interceptor`](https://axios-cache-interceptor.js.org/)),
 *   - forces a logout (clear session + bounce to /login) on 401
 *     responses, and
 *   - keeps the Vue Query cache warm by mirroring every successful
 *     `GET /redfish/*` response into the cache.
 *
 * The mirror interceptor is the "dual cache population" half of the
 * SSE → Vue Query cache invalidation contract documented in
 * `../docs/designs/vue-query-sse-cache-invalidation.md` (relative to
 * this example's project root). It is a no-op unless a Vue Query hook
 * is already mounted for the same URL, so it is safe to install
 * unconditionally.
 */

import type { QueryClient } from '@tanstack/vue-query';
import type { AxiosResponse } from 'axios';
import { buildMemoryStorage, buildWebStorage, setupCache } from 'axios-cache-interceptor';
import type { Router } from 'vue-router';

import { client } from './client/client.gen';
import { isQueryUrlExactly } from './composables/sseInvalidationRules';
import { useAuthStore } from './stores/auth';

export interface ConfigureRedfishClientOptions {
  queryClient: QueryClient;
  router: Router;
}

// `localStorage` lets the cache survive a page reload — re-opening
// the dashboard after F5 sends `If-None-Match` immediately, so the
// initial waterfall comes back as 304s if nothing changed in the
// meantime. Falls back to in-memory storage for SSR / Node test
// contexts where `localStorage` is not defined.
const isBrowser = typeof window !== 'undefined' && typeof localStorage !== 'undefined';
const cacheStorage = isBrowser
  ? buildWebStorage(localStorage, 'redfish-axios-cache:')
  : buildMemoryStorage();

export function configureRedfishClient({
  queryClient,
  router,
}: ConfigureRedfishClientOptions): void {
  client.setConfig({
    // In dev, baseURL stays empty so requests are relative to the
    // current origin and Vite's proxy (configured from `VITE_BMC_URL`
    // in `.env.development.local` or the shell) routes them to the
    // BMC. In production builds there is no proxy, so we read
    // `VITE_BMC_URL` directly — assuming the BMC permits CORS or the
    // example is served from the BMC's own origin.
    baseURL: import.meta.env.DEV ? '' : import.meta.env.VITE_BMC_URL || '',
  });

  // Wrap the SDK's axios instance with cache + ETag support. This
  // stores every successful GET response keyed by URL and replays
  // the response's `ETag` as `If-None-Match` on the next request to
  // the same URL. Combined with Vue Query invalidation, the cost of
  // a "the data probably did not actually change" refetch (e.g. a
  // `Chassis.Reset` invalidating the Chassis collection while its
  // membership stays put) drops to a single 304 round-trip.
  //
  // `ttl: 0` keeps every entry stale-by-default — the cache never
  // serves a stored body without first asking the BMC. We rely on
  // ETags exclusively; `interpretHeader: false` and
  // `modifiedSince: false` disable the time-based fallbacks that
  // would otherwise kick in. `staleIfError: false` keeps an
  // unreachable BMC from silently serving stale data.
  setupCache(client.instance, {
    etag: true,
    interpretHeader: false,
    methods: ['get'],
    modifiedSince: false,
    staleIfError: false,
    storage: cacheStorage,
    ttl: 0,
  });

  client.instance.interceptors.request.use((config) => {
    const token = useAuthStore().token;
    if (token) config.headers.set('X-Auth-Token', token);
    return config;
  });

  client.instance.interceptors.response.use(
    (response) => {
      mirrorIntoQueryCache(queryClient, response);
      return response;
    },
    (error: { response?: { status?: number } }) => {
      const auth = useAuthStore();
      if (error.response?.status === 401 && auth.isAuthenticated) {
        auth.clearSession();
        void router.push('/login');
      }
      return Promise.reject(error);
    },
  );
}

/**
 * Mirror every successful Redfish GET into any Vue Query entry whose
 * resolved URL matches. When no matching query exists this is a no-op,
 * which is exactly the right behaviour: this hook exists to keep the
 * cache up to date for queries that are *already* mounted, so that an
 * SSE-triggered refetch (or a parallel hook in another view) never
 * sees stale data.
 */
function mirrorIntoQueryCache(queryClient: QueryClient, response: AxiosResponse): void {
  const config = response.config;
  const method = config.method?.toLowerCase() ?? 'get';
  if (method !== 'get') return;

  const url = config.url;
  if (!url || !url.startsWith('/redfish/')) return;

  queryClient.setQueriesData(
    {
      predicate: (query) => isQueryUrlExactly(query.queryKey, url),
    },
    response.data,
  );
}
