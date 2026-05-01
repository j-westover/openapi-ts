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

/**
 * Redfish `PowerState` values that warrant short-interval polling.
 *
 * On many BMCs (notably bmcweb) the power-on transition is not
 * announced with a settle-state SSE event — the BMC emits the
 * `Chassis.Reset` action event, leaves `PowerState` at `PoweringOn`
 * for several seconds, and then silently flips it to `On` without
 * notifying the SSE stream. We poll the System resource at 2s
 * intervals to compensate, stopping as soon as `PowerState` settles.
 *
 * `PoweringOff` is intentionally *not* polled — graceful shutdown can
 * take minutes (OS shutdown sequencing) and the BMC reliably publishes
 * the eventual `Off` transition. The UI surfaces an in-progress
 * pulse animation on the icon instead (`PowerStateIcon` →
 * `'off blink'` status).
 */
const TRANSIENT_POWER_STATES: ReadonlySet<string> = new Set(['PoweringOn']);
const POWER_STATE_POLL_MS = 2000;

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
      // Poll while the BMC reports a transient power transition so we
      // do not depend on a follow-up SSE event that some BMCs never
      // emit. Returning `false` lets TanStack Query treat polling as
      // off; returning `2000` makes it refetch every 2s. The function
      // is re-evaluated after every successful fetch, so polling
      // stops the moment `PowerState` settles to `On` / `Off`.
      //
      // Inference inside `computed(() => ({ ...spread, ... }))` loses
      // the deeply-instantiated query-key generic, so the parameter
      // is described structurally — TanStack's `Query` shape is far
      // wider, but only `state.data` matters here.
      refetchInterval: (query: { state: { data?: ComputerSystem } }) => {
        const ps = query.state.data?.PowerState;
        return typeof ps === 'string' && TRANSIENT_POWER_STATES.has(ps)
          ? POWER_STATE_POLL_MS
          : false;
      },
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
