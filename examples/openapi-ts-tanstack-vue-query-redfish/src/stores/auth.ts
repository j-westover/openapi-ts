/**
 * Auth store for the Redfish SessionService session token.
 *
 * Two storage layers are populated when a session is created:
 *
 *  1. `sessionStorage` (the canonical copy) — survives a page reload
 *     so the user is not logged out on F5, and is read back by
 *     `client-setup.ts` to set `X-Auth-Token` on every axios request.
 *
 *  2. A `SameSite=Strict` cookie named `X-Auth-Token` — required by
 *     OpenBMC's bmcweb for the SSE endpoint
 *     (`/redfish/v1/EventService/SSE`). bmcweb authenticates that
 *     specific request via the auth *cookie* rather than the header,
 *     and a missing cookie returns a misleading `404` instead of
 *     `401`. Browsers forbid JS from setting the `Cookie` header on a
 *     `fetch`, so the only way to make `client.sse.get(...)` reach a
 *     bmcweb-style BMC is to drop the token into `document.cookie`
 *     here and let the browser attach it automatically (the SSE call
 *     in `useSSE.ts` uses `credentials: 'include'`). Other Redfish
 *     servers that accept the header continue to work because we send
 *     both.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

const STORAGE_KEY_TOKEN = 'redfish_auth_token';
const STORAGE_KEY_SESSION = 'redfish_session_uri';
const STORAGE_KEY_USERNAME = 'redfish_session_username';
const COOKIE_NAME = 'X-Auth-Token';

function setTokenCookie(token: string): void {
  // `path=/` so the cookie covers `/redfish/...` as well as the
  // example's own routes; `SameSite=Strict` so it only ever rides
  // first-party requests (the dev proxy and a same-origin prod
  // deployment both qualify).
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Strict`;
}

function clearTokenCookie(): void {
  document.cookie = `${COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(sessionStorage.getItem(STORAGE_KEY_TOKEN));
  const sessionUri = ref<string | null>(sessionStorage.getItem(STORAGE_KEY_SESSION));
  const userName = ref<string | null>(sessionStorage.getItem(STORAGE_KEY_USERNAME));

  const isAuthenticated = computed(() => Boolean(token.value));

  // After a page reload, sessionStorage rehydrates `token` but the
  // cookie has to be re-written here — `document.cookie` does not
  // survive across navigations the way `sessionStorage` does for
  // tab-scoped sessions.
  if (token.value) setTokenCookie(token.value);

  function setSession(authToken: string, uri: string, name: string | null = null): void {
    token.value = authToken;
    sessionUri.value = uri;
    userName.value = name;
    sessionStorage.setItem(STORAGE_KEY_TOKEN, authToken);
    sessionStorage.setItem(STORAGE_KEY_SESSION, uri);
    if (name) sessionStorage.setItem(STORAGE_KEY_USERNAME, name);
    else sessionStorage.removeItem(STORAGE_KEY_USERNAME);
    setTokenCookie(authToken);
  }

  function clearSession(): void {
    token.value = null;
    sessionUri.value = null;
    userName.value = null;
    sessionStorage.removeItem(STORAGE_KEY_TOKEN);
    sessionStorage.removeItem(STORAGE_KEY_SESSION);
    sessionStorage.removeItem(STORAGE_KEY_USERNAME);
    clearTokenCookie();
  }

  return {
    clearSession,
    isAuthenticated,
    sessionUri,
    setSession,
    token,
    userName,
  };
});
