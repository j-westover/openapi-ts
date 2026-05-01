/**
 * Health rollup with a fallback chain, ported from the downstream
 * `webui-vue/src/api/composables/useHealthRollup.ts`.
 *
 * Priority:
 *   1. `System.Status.HealthRollup` (native Redfish — preferred).
 *   2. `TelemetryService/MetricReports/*HealthMetrics*` worst-case
 *      computed from per-component `HealthRollup` values
 *      (NVIDIA / HGX-style BMCs that don't ship native rollup).
 *   3. `'Unknown'` — no signal available.
 *
 * The downstream also has a third tier that aggregates unresolved
 * critical/warning entries from the EventLog. That requires a sizable
 * `useEventLog` composable (paginated, filtered, etc.) which is out
 * of scope for this reference example. Skipping it here means a BMC
 * with no native rollup *and* no `HealthMetrics` MetricReport will
 * fall through to `'Unknown'` — matching the downstream's lowest tier.
 */

import { computed, type ComputedRef } from 'vue';

import { useHealthMetrics } from '@/composables/useHealthMetrics';
import { useManagedSystem } from '@/composables/useManagedSystem';

export type HealthRollup = 'Critical' | 'OK' | 'Unknown' | 'Warning';
export type HealthRollupSource = 'MetricReports' | 'System' | 'Unknown';

export interface UseHealthRollupReturn {
  dataSource: ComputedRef<HealthRollupSource>;
  healthRollup: ComputedRef<HealthRollup>;
  isError: ComputedRef<boolean>;
  isLoading: ComputedRef<boolean>;
}

export function useHealthRollup(): UseHealthRollupReturn {
  const { healthRollup: systemRollup, systemQuery } = useManagedSystem();
  const { componentHealth, isError: metricsError, isLoading: metricsLoading } = useHealthMetrics();

  // Tier 2 input: only consult the metric report when the System
  // resource didn't ship its own rollup. The metric values are still
  // fetched (the tooltip grid uses them) — we just don't fold them
  // into the rollup if we already have a native answer.
  const metricRollupValues = computed<string[]>(() => {
    if (systemRollup.value) return [];
    return componentHealth.value
      .map((entry) => entry.healthRollup)
      .filter((value) => value && value !== '-');
  });

  const healthRollup = computed<HealthRollup>(() => {
    if (systemRollup.value && isHealth(systemRollup.value)) return systemRollup.value;
    if (metricRollupValues.value.length > 0) return worstCase(metricRollupValues.value);
    return 'Unknown';
  });

  const dataSource = computed<HealthRollupSource>(() => {
    if (systemRollup.value) return 'System';
    if (metricRollupValues.value.length > 0) return 'MetricReports';
    return 'Unknown';
  });

  const isLoading = computed(() => systemQuery.isLoading.value || metricsLoading.value);
  const isError = computed(() => metricsError.value);

  return { dataSource, healthRollup, isError, isLoading };
}

function isHealth(value: string): value is HealthRollup {
  return value === 'OK' || value === 'Warning' || value === 'Critical';
}

function worstCase(values: ReadonlyArray<string>): HealthRollup {
  if (values.includes('Critical')) return 'Critical';
  if (values.includes('Warning')) return 'Warning';
  return 'OK';
}
