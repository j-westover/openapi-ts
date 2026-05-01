/**
 * Configures the generated `@hey-api/client-axios` client used by the
 * SDK, and wires up axios interceptors that:
 *
 *   - inject the Redfish session token (`X-Auth-Token`) on every
 *     request,
 *   - force a logout (clear session + bounce to /login) on 401
 *     responses, and
 *   - keep the Vue Query cache warm by mirroring every successful
 *     `GET /redfish/*` response into the cache.
 *
 * The third interceptor is the "dual cache population" half of the
 * SSE → Vue Query cache invalidation contract documented at
 * `docs/designs/vue-query-sse-cache-invalidation.md`. It is a no-op
 * unless a Vue Query hook is already mounted for the same URL, so it
 * is safe to install unconditionally.
 */

import type { QueryClient } from '@tanstack/vue-query';
import type { AxiosResponse } from 'axios';
import type { Router } from 'vue-router';

import { client } from './client/client.gen';
import { isQueryUrlExactly } from './composables/sseInvalidationRules';
import { useAuthStore } from './stores/auth';

export interface ConfigureRedfishClientOptions {
  queryClient: QueryClient;
  router: Router;
}

export function configureRedfishClient({
  queryClient,
  router,
}: ConfigureRedfishClientOptions): void {
  client.setConfig({
    baseURL: import.meta.env.VITE_BMC_URL || '',
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
