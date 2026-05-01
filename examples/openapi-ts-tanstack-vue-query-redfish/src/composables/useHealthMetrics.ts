/**
 * Per-component health metrics, ported from the downstream
 * `webui-vue/src/api/composables/useHealthMetrics.ts`.
 *
 * On BMCs that don't ship `Status.HealthRollup` on the System
 * resource, NVIDIA's stack derives health from the
 * `TelemetryService/MetricReports/*HealthMetrics*` report. This
 * composable replicates that strategy:
 *
 *   1. List `MetricReports` (collection, no `$expand`).
 *   2. Find the member whose URI contains `HealthMetrics`.
 *   3. Fetch *just* that report (avoids broken / 404-ing siblings).
 *   4. Walk its `MetricValues`, group by component, surface a
 *      sorted `ComponentHealthEntry[]` for the tooltip grid.
 *
 * Sort order, name extraction, and worst-case rollup all match the
 * downstream so the visual identity is consistent between projects.
 */

import { useQuery } from '@tanstack/vue-query';
import { computed, type ComputedRef } from 'vue';

import {
  getTelemetryServiceMetricReportByIdOptions,
  getTelemetryServiceMetricReportsOptions,
} from '@/client/@tanstack/vue-query.gen';
import type { MetricReport } from '@/client/types.gen';
import { useManagedSystem } from '@/composables/useManagedSystem';

const HEALTH_METRICS_MARKER = 'HealthMetrics';

export interface ComponentHealthEntry {
  componentKey: string;
  health: string;
  healthRollup: string;
  name: string;
  uri: string;
}

export interface UseHealthMetricsReturn {
  componentHealth: ComputedRef<ComponentHealthEntry[]>;
  hasMetrics: ComputedRef<boolean>;
  isError: ComputedRef<boolean>;
  isLoading: ComputedRef<boolean>;
}

export function useHealthMetrics(): UseHealthMetricsReturn {
  const { systemQuery } = useManagedSystem();
  const systemReady = computed(() => Boolean(systemQuery.data.value));

  // Step 1 — listing
  const listingQuery = useQuery(
    computed(() => ({
      ...getTelemetryServiceMetricReportsOptions(),
      enabled: systemReady.value,
      // Collection membership rarely changes — keep it warm.
      staleTime: 60_000,
    })),
  );

  // Step 2 — find the *HealthMetrics* member. Vendor reports keep
  // appearing under different conventions (`HGX_HealthMetrics_0`,
  // `PlatformHealthMetrics_0`, …); a substring match on
  // `HealthMetrics` covers every case observed so far.
  const healthMetricsId = computed<string | null>(() => {
    const members = listingQuery.data.value?.Members ?? [];
    for (const m of members) {
      const odataId = m['@odata.id'];
      if (typeof odataId === 'string' && odataId.includes(HEALTH_METRICS_MARKER)) {
        // /redfish/v1/TelemetryService/MetricReports/<id>  →  <id>
        const segments = odataId.split('/');
        return segments[segments.length - 1] || null;
      }
    }
    return null;
  });

  // Step 3 — fetch that one report
  const reportQuery = useQuery(
    computed(() => ({
      ...getTelemetryServiceMetricReportByIdOptions({
        path: { MetricReportId: healthMetricsId.value ?? '' },
      }),
      enabled: Boolean(healthMetricsId.value),
      // Metric values move; refresh every 30 s.
      staleTime: 30_000,
    })),
  );

  // Step 4 — parse MetricValues into per-component rows
  const componentHealth = computed<ComponentHealthEntry[]>(() => {
    const report = reportQuery.data.value as MetricReport | undefined;
    const values = report?.MetricValues;
    if (!values || values.length === 0) return [];

    const healthValues = values.filter((v) => {
      const path = v.MetricProperty ?? '';
      return (
        path.includes('/Status/Health') ||
        path.endsWith('/Health') ||
        path.endsWith('/HealthRollup')
      );
    });
    if (healthValues.length === 0) return [];

    type Bucket = { health?: string; healthRollup?: string; uri?: string };
    const buckets = new Map<string, Bucket>();

    for (const metric of healthValues) {
      const property = metric.MetricProperty ?? '';
      const componentKey = extractComponentName(property);
      const isRollup = property.endsWith('/HealthRollup');

      let bucket = buckets.get(componentKey);
      if (!bucket) {
        bucket = { uri: extractResourceURI(property) };
        buckets.set(componentKey, bucket);
      }
      const value = typeof metric.MetricValue === 'string' ? metric.MetricValue : undefined;
      if (isRollup) bucket.healthRollup = value;
      else bucket.health = value;
    }

    const rows: ComponentHealthEntry[] = [];
    for (const [key, bucket] of buckets) {
      rows.push({
        componentKey: key,
        health: bucket.health || '-',
        healthRollup: bucket.healthRollup || '-',
        name: formatComponentName(key),
        uri: bucket.uri || '',
      });
    }
    return rows.sort(sortComponents);
  });

  const isLoading = computed(() => listingQuery.isLoading.value || reportQuery.isLoading.value);
  const isError = computed(() => listingQuery.isError.value || reportQuery.isError.value);
  const hasMetrics = computed(() => componentHealth.value.length > 0);

  return { componentHealth, hasMetrics, isError, isLoading };
}

// ---------------------------------------------------------------------------
// Pure helpers (port of the downstream's name extraction / sort)
// ---------------------------------------------------------------------------

/** `/redfish/v1/Chassis/HGX_GPU_0#/Status/Health` → `/redfish/v1/Chassis/HGX_GPU_0` */
function extractResourceURI(metricProperty: string): string {
  const hash = metricProperty.indexOf('#');
  return hash === -1 ? metricProperty : metricProperty.slice(0, hash);
}

/**
 * Pull a component name out of a `MetricProperty` URL fragment. Looks
 * first for the `<segment>#…` pattern and falls back to the
 * `Chassis/...` / `Systems/...` shapes the downstream documents.
 */
function extractComponentName(metricProperty: string): string {
  const segments = metricProperty.split('/');

  for (const seg of segments) {
    if (seg.includes('#')) return seg.split('#')[0]!;
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if ((seg === 'Chassis' || seg === 'Systems') && i + 1 < segments.length) {
      const next = segments[i + 1]!;
      if (
        next.includes('GPU') ||
        next.includes('CPU') ||
        next.includes('Baseboard') ||
        next.includes('ProcessorModule')
      ) {
        return next.split('#')[0]!;
      }
    }
  }
  return 'System';
}

/** `HGX_GPU_0` → `GPU 0`, `HGX_Baseboard_0` → `Baseboard 0`. */
function formatComponentName(componentKey: string): string {
  return componentKey.replace(/^[A-Z]+_/, '').replace(/_/g, ' ') || 'System';
}

function getComponentPriority(key: string): number {
  if (key.includes('GPU')) return 0;
  if (key.includes('CPU')) return 1;
  if (key.includes('ProcessorModule') || key.includes('Module')) return 2;
  if (key.includes('Baseboard')) return 3;
  return 99;
}

function sortComponents(a: ComponentHealthEntry, b: ComponentHealthEntry): number {
  const aPri = getComponentPriority(a.componentKey);
  const bPri = getComponentPriority(b.componentKey);
  if (aPri !== bPri) return aPri - bPri;

  const aNum = Number.parseInt(/\d+$/.exec(a.componentKey)?.[0] ?? '0', 10);
  const bNum = Number.parseInt(/\d+$/.exec(b.componentKey)?.[0] ?? '0', 10);
  if (aNum !== bNum) return aNum - bNum;

  return a.componentKey.localeCompare(b.componentKey);
}
