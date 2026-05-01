/**
 * Configures the generated `@hey-api/client-axios` client used by the SDK,
 * and wires up auth interceptors that:
 *
 *  - inject the Redfish session token (`X-Auth-Token`) on every request, and
 *  - force a logout (clear session + bounce to /login) on 401/403 responses.
 *
 * The generated SDK uses this single shared client by default, so importing
 * any function from `./client` is enough to make authenticated calls — no
 * need to pass a `client` to every method.
 */

import type { Router } from 'vue-router';

import { client } from './client/client.gen';
import { useAuthStore } from './stores/auth';

export function configureRedfishClient(router: Router): void {
  client.setConfig({
    baseURL: import.meta.env.VITE_BMC_URL || '',
  });

  client.instance.interceptors.request.use((config) => {
    const token = useAuthStore().token;
    if (token) config.headers.set('X-Auth-Token', token);
    return config;
  });

  client.instance.interceptors.response.use(
    (response) => response,
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
