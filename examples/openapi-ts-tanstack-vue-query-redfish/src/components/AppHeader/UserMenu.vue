<script setup lang="ts">
/**
 * User-avatar dropdown — mirrors the downstream
 * `webui-vue/src/components/AppHeader/UserMenu.vue`. Shows the
 * authenticated `UserName` (from `auth.ts`) and the user's `RoleId`
 * (looked up via the typed
 * `getAccountServiceAccountById({ path: { ManagerAccountId: <username> } })`).
 *
 * Logout is the same teardown the dashboard uses elsewhere: clear the
 * session, drop the Vue Query cache, route back to /login.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { storeToRefs } from 'pinia';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { deleteSessionServiceSessionByIdMutation } from '@/client/@tanstack/vue-query.gen';
import { getAccountServiceAccountByIdOptions } from '@/client/@tanstack/vue-query.gen';
import { useClickOutside } from '@/composables/useClickOutside';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
const { sessionUri, userName } = storeToRefs(authStore);
const queryClient = useQueryClient();
const router = useRouter();

// Account lookup is best-effort: not every BMC exposes a matching
// `Accounts/<UserName>`. Failures are silenced via `retry: false` and
// the menu just skips the role line.
const accountQuery = useQuery(
  computed(() => ({
    ...getAccountServiceAccountByIdOptions({
      path: { ManagerAccountId: userName.value ?? '' },
    }),
    enabled: Boolean(userName.value),
    retry: false,
  })),
);

const userRole = computed(() => accountQuery.data.value?.RoleId ?? null);

// --- Logout flow ------------------------------------------------------

function tearDownSession(): void {
  authStore.clearSession();
  queryClient.clear();
  void router.push('/login');
}

const logoutMutation = useMutation({
  ...deleteSessionServiceSessionByIdMutation(),
  onSettled: tearDownSession,
});

function onLogout(): void {
  open.value = false;
  const sessionId = sessionUri.value?.split('/').pop();
  if (!sessionId) {
    tearDownSession();
    return;
  }
  logoutMutation.mutate({ path: { SessionId: sessionId } });
}

// --- Dropdown open/close ---------------------------------------------

const open = ref(false);
const wrapperRef = ref<HTMLElement | null>(null);
useClickOutside(wrapperRef, () => {
  open.value = false;
});
</script>

<template>
  <div ref="wrapperRef" class="relative">
    <button
      aria-haspopup="menu"
      :aria-expanded="open"
      class="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      title="Account"
      type="button"
      @click="open = !open"
    >
      <!-- Carbon `user--avatar/20` equivalent, inlined to avoid a
           dependency on @carbon/icons-vue. -->
      <svg aria-hidden="true" class="size-5" fill="currentColor" viewBox="0 0 32 32">
        <path d="M16,4a5,5,0,1,1-5,5,5,5,0,0,1,5-5m0-2a7,7,0,1,0,7,7A7,7,0,0,0,16,2Z" />
        <path d="M16,18A11,11,0,0,0,5,29H7a9,9,0,0,1,18,0h2A11,11,0,0,0,16,18Z" />
      </svg>
      <span class="hidden sm:inline">{{ userName ?? 'Account' }}</span>
    </button>

    <div
      v-if="open"
      class="absolute right-0 z-30 mt-1 w-56 rounded border border-gray-700 bg-gray-800 py-1 text-sm shadow-lg"
      role="menu"
    >
      <div class="px-3 py-2">
        <div class="font-semibold text-gray-200">{{ userName ?? 'Anonymous' }}</div>
        <div v-if="userRole" class="text-xs text-gray-400">{{ userRole }}</div>
      </div>
      <div class="my-1 border-t border-gray-700" />
      <button
        class="block w-full px-3 py-1.5 text-left hover:bg-gray-700 disabled:opacity-50"
        :disabled="logoutMutation.isPending.value"
        role="menuitem"
        type="button"
        @click="onLogout"
      >
        {{ logoutMutation.isPending.value ? 'Logging out…' : 'Log out' }}
      </button>
    </div>
  </div>
</template>
