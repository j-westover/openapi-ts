<script setup lang="ts">
/**
 * Application header — Tailwind port of
 * `webui-vue/src/components/AppHeader/AppHeader.vue`. Same layout
 * (left brand + asset/model/serial pipe-delimited row, right helper
 * menu with SSE / Health / Power / Refresh / User), responsive
 * collapse on small screens, accessible "skip to content" link.
 *
 * Differences from the downstream:
 *   - Tailwind utilities instead of `bootstrap-vue-next` + SCSS.
 *   - No `vue-i18n` (plain English strings).
 *   - No mobile-nav hamburger trigger — the example has no sidebar.
 *   - No Redfish-Logger button — vendor-specific feature.
 *   - The Refresh button calls `queryClient.invalidateQueries({})` so
 *     every cached resource refetches, matching the downstream's
 *     "refresh everything" semantics without coupling to a particular
 *     event-log composable.
 */
import { useQueryClient } from '@tanstack/vue-query';

import { useManagedSystem } from '@/composables/useManagedSystem';

import HealthRollupIcon from './HealthRollupIcon.vue';
import PowerStateIcon from './PowerStateIcon.vue';
import SSEStatusIndicator from './SSEStatusIndicator.vue';
import UserMenu from './UserMenu.vue';

const queryClient = useQueryClient();
const { assetTag, model, serialNumber } = useManagedSystem();

function refresh(): void {
  void queryClient.invalidateQueries();
}
</script>

<template>
  <header class="border-b border-gray-700 bg-gray-800 text-white">
    <a
      class="absolute left-2 -top-12 z-50 rounded bg-gray-700 px-3 py-2 text-sm transition-all focus:top-2"
      href="#main-content"
    >
      Skip to content
    </a>

    <nav
      aria-label="Application header"
      class="flex flex-wrap items-center gap-2 px-4 py-2 sm:flex-nowrap sm:px-6"
    >
      <!-- Left: brand + asset tags -->
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <RouterLink
          class="flex items-center gap-2 rounded px-2 py-1 text-base font-semibold hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          to="/"
        >
          <span aria-hidden="true" class="text-xl">⚙</span>
          Redfish Dashboard
        </RouterLink>

        <div
          v-if="assetTag || model || serialNumber"
          class="hidden min-w-0 items-center gap-3 truncate text-xs text-gray-400 sm:flex"
        >
          <span aria-hidden="true">|</span>
          <span v-if="assetTag" class="truncate">{{ assetTag }}</span>
          <span v-if="model" class="truncate">{{ model }}</span>
          <span v-if="serialNumber" class="truncate">{{ serialNumber }}</span>
        </div>
      </div>

      <!-- Right: SSE / Health / Power / Refresh / User -->
      <div class="ml-auto flex items-center gap-1">
        <SSEStatusIndicator />
        <HealthRollupIcon />
        <PowerStateIcon />

        <button
          aria-label="Refresh"
          class="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          title="Refresh all data"
          type="button"
          @click="refresh"
        >
          <!-- Carbon `renew/20` equivalent, inlined. -->
          <svg aria-hidden="true" class="size-5" fill="currentColor" viewBox="0 0 32 32">
            <path
              d="M16,4a12,12,0,0,0-9.13,4.21L4,5.45V12h6.55L8.27,9.71a10,10,0,1,1-2.13,8.78L4.13,18.94A12,12,0,1,0,16,4Z"
            />
          </svg>
          <span class="hidden sm:inline">Refresh</span>
        </button>

        <UserMenu />
      </div>
    </nav>
  </header>
</template>
