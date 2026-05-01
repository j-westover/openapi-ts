/**
 * Locate the active "managed system" the way the downstream
 * `webui-vue` does: the first member of `/redfish/v1/Systems`. The
 * resolved member resource is the source of truth for `PowerState`,
 * `Status` (HealthRollup + per-component health), `AssetTag`, `Model`,
 * `SerialNumber`, and the `ComputerSystem.Reset` action.
 *
 * Callers only need the derived refs — the underlying queries are
 * surfaced as `systemsQuery` / `systemQuery` for diagnostics and
 * manual refetching.
 */

import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed } from 'vue';

import { getSystemByIdOptions, getSystemsOptions } from '@/client/@tanstack/vue-query.gen';
import type { ComputerSystem } from '@/client/types.gen';

const SYSTEMS_BASE = '/redfish/v1/Systems/';

function memberIdFromOdataId(odataId: string | undefined): string | null {
  if (!odataId) return null;
  if (!odataId.startsWith(SYSTEMS_BASE)) return null;
  return odataId.slice(SYSTEMS_BASE.length).replace(/\/+$/, '') || null;
}

export function useManagedSystem() {
  const queryClient = useQueryClient();

  const systemsQuery = useQuery(getSystemsOptions());

  // The DMTF spec returns `Members` as `Array<OdataV4IdRef>`; the first
  // entry is the active system on virtually every BMC.
  const computerSystemId = computed<string | null>(() => {
    const first = systemsQuery.data.value?.Members?.[0];
    return memberIdFromOdataId(first?.['@odata.id']);
  });

  const systemQuery = useQuery(
    computed(() => ({
      ...getSystemByIdOptions({
        path: { ComputerSystemId: computerSystemId.value ?? '' },
      }),
      enabled: Boolean(computerSystemId.value),
    })),
  );

  const managedSystem = computed<ComputerSystem | undefined>(() => systemQuery.data.value);

  // The DMTF spec types `PowerState`, `Status.Health`, `Status.HealthRollup`,
  // and `Status.State` as `<EnumType> | unknown` so vendors can extend the
  // taxonomy. Coerce to `string | null` here so consumers don't have to
  // re-narrow at every render site.
  const stringOrNull = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;

  const powerState = computed(() => stringOrNull(managedSystem.value?.PowerState));
  const status = computed(() => managedSystem.value?.Status);
  const healthRollup = computed(() => stringOrNull(status.value?.HealthRollup));
  const health = computed(() => stringOrNull(status.value?.Health));
  const systemState = computed(() => stringOrNull(status.value?.State));
  const assetTag = computed(() => managedSystem.value?.AssetTag ?? null);
  const model = computed(() => managedSystem.value?.Model ?? null);
  const serialNumber = computed(() => managedSystem.value?.SerialNumber ?? null);

  /**
   * Force-refresh the System resource. Useful right after a power
   * action where the cache needs to catch up with the BMC's new state.
   */
  function refetchManagedSystem(): void {
    void systemsQuery.refetch();
    void systemQuery.refetch();
  }

  /**
   * Best-effort refetch of every cached query. Used by the AppHeader's
   * top-level "Refresh" button.
   */
  function refetchAll(): void {
    void queryClient.invalidateQueries();
  }

  return {
    assetTag,
    computerSystemId,
    health,
    healthRollup,
    managedSystem,
    model,
    powerState,
    refetchAll,
    refetchManagedSystem,
    serialNumber,
    status,
    systemQuery,
    systemState,
    systemsQuery,
  };
}
