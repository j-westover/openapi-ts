<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query';
import { isAxiosError } from 'axios';
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { postSessionServiceSessions } from '@/client/sdk.gen';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const username = ref('');
const password = ref('');
const errorMsg = ref('');

/**
 * `unlockSessionLoginFields` (in `scripts/redfish-spec-patch.ts`) un-marks
 * these as `readOnly` so the generated `SessionWritable` includes them, but
 * we keep this inline shape here so the example compiles even if you regen
 * without that patch enabled.
 */
interface RedfishLoginBody {
  Password: string;
  UserName: string;
}

interface RedfishLoginResponse {
  '@odata.id'?: string;
  Token?: string | null;
}

/**
 * The Redfish login response carries the session token in the
 * `X-Auth-Token` *header* (per DMTF), so we use a custom `mutationFn` to
 * surface the full axios response — the generated `Mutation()` helper
 * unwraps to `data` only and would discard the header.
 */
const login = useMutation({
  mutationFn: (body: RedfishLoginBody) =>
    postSessionServiceSessions({
      body: body as unknown as Parameters<typeof postSessionServiceSessions>[0]['body'],
      throwOnError: true,
    }),
  onError: (error) => {
    if (isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 401 || status === 403) {
        errorMsg.value = 'Invalid username or password.';
      } else if (error.code === 'ERR_NETWORK') {
        errorMsg.value = 'Cannot reach BMC. Check the proxy configuration.';
      } else {
        errorMsg.value = error.message || 'Login failed.';
      }
    } else {
      errorMsg.value = error instanceof Error ? error.message : 'Login failed.';
    }
  },
  onSuccess: ({ data, headers }) => {
    const body = data as RedfishLoginResponse | undefined;
    const headerToken = headers['x-auth-token'];
    const headerLocation = headers['location'];

    const token =
      (typeof headerToken === 'string' ? headerToken : undefined) ?? body?.Token ?? null;
    const location =
      (typeof headerLocation === 'string' ? headerLocation : undefined) ??
      body?.['@odata.id'] ??
      '';

    if (!token) {
      errorMsg.value = 'No X-Auth-Token in response. Check the BMC configuration.';
      return;
    }

    authStore.setSession(token, location, username.value);
    void router.push('/');
  },
});

function handleLogin(): void {
  errorMsg.value = '';
  login.mutate({
    Password: password.value,
    UserName: username.value,
  });
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-900">
    <div class="w-full max-w-md rounded-lg bg-gray-800 p-8 shadow-xl">
      <h1 class="mb-2 text-center text-2xl font-bold text-white">Redfish BMC Login</h1>
      <p class="mb-6 text-center text-sm text-gray-400">TanStack Vue Query + @hey-api/openapi-ts</p>

      <form class="space-y-4" @submit.prevent="handleLogin">
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-300" for="username">
            Username
          </label>
          <input
            id="username"
            v-model="username"
            autocomplete="username"
            class="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="root"
            required
            type="text"
          />
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium text-gray-300" for="password">
            Password
          </label>
          <input
            id="password"
            v-model="password"
            autocomplete="current-password"
            class="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            required
            type="password"
          />
        </div>

        <div v-if="errorMsg" class="rounded bg-red-900/50 p-3 text-sm text-red-300" role="alert">
          {{ errorMsg }}
        </div>

        <button
          :disabled="login.isPending.value || !username || !password"
          class="w-full rounded bg-blue-600 px-4 py-2 font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
        >
          {{ login.isPending.value ? 'Signing in…' : 'Sign In' }}
        </button>
      </form>
    </div>
  </div>
</template>
