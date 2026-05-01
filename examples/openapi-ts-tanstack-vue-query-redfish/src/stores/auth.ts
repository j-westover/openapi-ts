/**
 * Auth store for the Redfish SessionService session token.
 *
 * The token is mirrored into `sessionStorage` so a page reload does not log
 * the user out. There is intentionally no cookie: the token is forwarded as
 * the `X-Auth-Token` header on every request (set by the axios request
 * interceptor in `client-setup.ts`) and the `onRequest` hook in `useSSE`
 * forwards it onto the SSE stream as well.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

const STORAGE_KEY_TOKEN = 'redfish_auth_token';
const STORAGE_KEY_SESSION = 'redfish_session_uri';

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(sessionStorage.getItem(STORAGE_KEY_TOKEN));
  const sessionUri = ref<string | null>(sessionStorage.getItem(STORAGE_KEY_SESSION));

  const isAuthenticated = computed(() => Boolean(token.value));

  function setSession(authToken: string, uri: string): void {
    token.value = authToken;
    sessionUri.value = uri;
    sessionStorage.setItem(STORAGE_KEY_TOKEN, authToken);
    sessionStorage.setItem(STORAGE_KEY_SESSION, uri);
  }

  function clearSession(): void {
    token.value = null;
    sessionUri.value = null;
    sessionStorage.removeItem(STORAGE_KEY_TOKEN);
    sessionStorage.removeItem(STORAGE_KEY_SESSION);
  }

  return {
    clearSession,
    isAuthenticated,
    sessionUri,
    setSession,
    token,
  };
});
