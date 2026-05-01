<script setup lang="ts">
import { VueQueryDevtools } from '@tanstack/vue-query-devtools';
import { RouterView } from 'vue-router';

import { useSSEQueryInvalidation } from '@/composables/useSSEQueryInvalidation';

// Watches the SSE event stream and invalidates Vue Query cache entries
// for affected resources. Mounted here so it is alive for the entire
// app lifetime and survives route changes. See
// docs/designs/vue-query-sse-cache-invalidation.md for the contract
// this implements.
useSSEQueryInvalidation();
</script>

<template>
  <div>
    <RouterView />
    <VueQueryDevtools />
  </div>
</template>
