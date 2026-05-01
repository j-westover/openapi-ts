<script setup lang="ts">
/**
 * Compact SSE connection-state indicator: a coloured dot + the status
 * string read from the SSE Pinia store. Mirrors the downstream
 * `<SSEStatusIndicator>` shape (icon + text, hidden text on small
 * screens) but built on Tailwind directly so we avoid the
 * `bootstrap-vue-next` dependency.
 */
import { computed } from 'vue';

import { useSSEStore } from '@/stores/sse';

const sseStore = useSSEStore();

const dotClass = computed(() => {
  switch (sseStore.status) {
    case 'connected':
      return 'bg-green-400';
    case 'reconnecting':
    case 'connecting':
      return 'bg-yellow-400 animate-pulse';
    case 'error':
      return 'bg-red-400';
    case 'disconnected':
    default:
      return 'bg-gray-500';
  }
});

const labelClass = computed(() => {
  switch (sseStore.status) {
    case 'connected':
      return 'text-green-400';
    case 'reconnecting':
    case 'connecting':
      return 'text-yellow-400';
    case 'error':
      return 'text-red-400';
    case 'disconnected':
    default:
      return 'text-gray-500';
  }
});
</script>

<template>
  <div
    class="flex items-center gap-2 px-2 text-sm"
    :title="sseStore.errorMessage ?? `SSE: ${sseStore.status}`"
  >
    <span aria-hidden="true" class="inline-block size-2 rounded-full" :class="dotClass" />
    <span class="text-gray-400">SSE:</span>
    <span :class="labelClass">{{ sseStore.status }}</span>
  </div>
</template>
