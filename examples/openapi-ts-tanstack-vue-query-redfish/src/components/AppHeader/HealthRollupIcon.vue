<script setup lang="ts">
/**
 * Aggregate health status — mirrors the downstream
 * `webui-vue/src/components/AppHeader/HealthRollupIcon.vue`.
 *
 * The badge dot is driven by `useHealthRollup` (System → MetricReports
 * → Unknown). The tooltip grid below it always shows whichever
 * per-component rows `useHealthMetrics` could parse out of
 * `TelemetryService/MetricReports/*HealthMetrics*`, even when the
 * native `System.Status.HealthRollup` is the source for the dot.
 */
import { computed } from 'vue';

import { useHealthMetrics } from '@/composables/useHealthMetrics';
import { useHealthRollup } from '@/composables/useHealthRollup';

const { dataSource, healthRollup } = useHealthRollup();
const { componentHealth, hasMetrics } = useHealthMetrics();

const dotClass = computed(() => {
  switch (healthRollup.value) {
    case 'OK':
      return 'bg-green-400';
    case 'Warning':
      return 'bg-yellow-400';
    case 'Critical':
      return 'bg-red-400';
    default:
      return 'bg-gray-500';
  }
});

function rowColorClass(value: string | null | undefined): string {
  switch (value) {
    case 'OK':
      return 'text-green-400';
    case 'Warning':
      return 'text-yellow-400';
    case 'Critical':
      return 'text-red-400';
    default:
      return 'text-gray-400';
  }
}

const dataSourceLabel = computed(() => {
  switch (dataSource.value) {
    case 'System':
      return 'Source: Status.HealthRollup';
    case 'MetricReports':
      return 'Source: TelemetryService/MetricReports';
    default:
      return 'No health source available';
  }
});
</script>

<template>
  <div class="group relative">
    <button
      aria-label="System health"
      class="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      type="button"
    >
      <span aria-hidden="true" class="inline-block size-3 rounded-full" :class="dotClass" />
      <span class="hidden sm:inline">Health</span>
    </button>

    <!-- Hover-driven popover — `group-hover` keeps it CSS-only. -->
    <div
      class="invisible absolute right-0 z-20 mt-1 min-w-[18rem] rounded border border-gray-700 bg-gray-800 p-3 text-xs text-gray-200 opacity-0 shadow-lg transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      role="tooltip"
    >
      <div class="mb-1 font-medium">
        Health: <span :class="rowColorClass(healthRollup)">{{ healthRollup }}</span>
      </div>
      <div class="mb-2 text-[0.65rem] uppercase tracking-wide text-gray-500">
        {{ dataSourceLabel }}
      </div>

      <div v-if="hasMetrics" class="grid grid-cols-3 gap-x-4 gap-y-1">
        <div class="font-semibold text-gray-400">Component</div>
        <div class="font-semibold text-gray-400">Health</div>
        <div class="font-semibold text-gray-400">Rollup</div>
        <template v-for="row in componentHealth" :key="row.componentKey">
          <div>{{ row.name }}</div>
          <div :class="rowColorClass(row.health)">{{ row.health }}</div>
          <div :class="rowColorClass(row.healthRollup)">{{ row.healthRollup }}</div>
        </template>
      </div>
      <div v-else class="text-gray-500">No per-component health metrics available.</div>
    </div>
  </div>
</template>
