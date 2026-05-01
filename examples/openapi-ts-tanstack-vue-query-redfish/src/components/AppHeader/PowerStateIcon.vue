<script setup lang="ts">
/**
 * Power-state indicator + reset-action dropdown.
 *
 * Mirrors the downstream `webui-vue/src/components/AppHeader/PowerStateIcon.vue`:
 *   - hover-tooltip showing PowerState and System State,
 *   - dropdown listing supported reset actions, gated on
 *     `ActionInfo.AllowableValues` when the action publishes one,
 *   - "Force Actions" subgroup with a warning style.
 *
 * Reset actions go through the generated `postSystemReset(...)`. The
 * `ActionInfo` query uses the typed `client.get(...)` because the
 * `@Redfish.ActionInfo` URL is per-system and not declared in the
 * spec as its own operation.
 */
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';

import { client } from '@/client/client.gen';
import { postSystemReset } from '@/client/sdk.gen';
import { ResourceResetType } from '@/client/types.gen';
import { useClickOutside } from '@/composables/useClickOutside';
import { useManagedSystem } from '@/composables/useManagedSystem';

import PowerIcon, { type PowerStatus } from './PowerIcon.vue';

const { computerSystemId, managedSystem, powerState, refetchManagedSystem, systemState } =
  useManagedSystem();

// The Reset action carries `target` (where to POST) and may also
// carry `@Redfish.ActionInfo` (a URL to fetch AllowableValues from).
// Neither is fully typed by the DMTF spec — cast to a richer shape.
interface ResetActionShape {
  '@Redfish.ActionInfo'?: string;
  target?: string;
}
const resetAction = computed<ResetActionShape | undefined>(
  () => managedSystem.value?.Actions?.['#ComputerSystem.Reset'] as ResetActionShape | undefined,
);
const actionInfoUrl = computed(() => resetAction.value?.['@Redfish.ActionInfo']);

interface ActionInfoParameter {
  AllowableValues?: ReadonlyArray<string | null>;
  Name?: string;
}
interface ActionInfo {
  Parameters?: ReadonlyArray<ActionInfoParameter>;
}

// Fetch ActionInfo (per-system, dynamic URL) only if the Reset action
// declares one. Long stale time — these rarely change.
const actionInfoQuery = useQuery({
  enabled: computed(() => Boolean(actionInfoUrl.value)),
  queryFn: async (): Promise<ActionInfo> => {
    const { data } = await client.get<ActionInfo, never, true>({
      throwOnError: true,
      url: actionInfoUrl.value!,
    });
    return data;
  },
  queryKey: computed(() => ['actionInfo', actionInfoUrl.value] as const),
  staleTime: 5 * 60 * 1000,
});

const allowableResetTypes = computed<ReadonlyArray<string>>(() => {
  const params = actionInfoQuery.data.value?.Parameters;
  if (!params) return [];
  const resetParam = params.find((p) => p.Name === 'ResetType');
  return (resetParam?.AllowableValues ?? []).filter((v): v is string => typeof v === 'string');
});

function isResetTypeSupported(resetType: string): boolean {
  // Until ActionInfo loads, optimistically allow every well-known
  // type. Once it loads, honour AllowableValues. If the BMC didn't
  // ship one (Parameters present but no `ResetType`), fall through
  // to "allow all".
  if (!actionInfoQuery.isSuccess.value) return true;
  if (allowableResetTypes.value.length === 0) return true;
  return allowableResetTypes.value.includes(resetType);
}

const powerStateIconStatus = computed<PowerStatus>(() => {
  switch (powerState.value) {
    case 'On':
    case 'PoweringOff':
      return 'on';
    case 'Off':
      return 'off';
    case 'PoweringOn':
      return 'on blink';
    case 'Paused':
      return 'on blink 1Hz';
    default:
      return 'secondary';
  }
});

// --- Reset mutation ---------------------------------------------------

const errorMessage = ref<string | null>(null);
const resetMutation = useMutation({
  mutationFn: (resetType: ResourceResetType) =>
    postSystemReset({
      body: { ResetType: resetType },
      path: { ComputerSystemId: computerSystemId.value ?? '' },
      throwOnError: true,
    }),
  onError: (error: unknown) => {
    const e = error as { message?: string; response?: { data?: { error?: { message?: string } } } };
    errorMessage.value = e.response?.data?.error?.message ?? e.message ?? 'Power action failed';
    setTimeout(() => {
      errorMessage.value = null;
    }, 5000);
  },
  onSuccess: () => {
    // Give the BMC a moment to flip its state, then refresh.
    setTimeout(refetchManagedSystem, 2000);
  },
});

const isExecuting = computed(() => resetMutation.isPending.value);

function executePowerAction(resetType: ResourceResetType): void {
  if (!computerSystemId.value) return;
  errorMessage.value = null;
  resetMutation.mutate(resetType);
  open.value = false;
}

// --- Dropdown open/close ---------------------------------------------

const open = ref(false);
const wrapperRef = ref<HTMLElement | null>(null);
useClickOutside(wrapperRef, () => {
  open.value = false;
});

function toggle(): void {
  if (isExecuting.value) return;
  open.value = !open.value;
}

const hasForceAction = computed(
  () =>
    isResetTypeSupported(ResourceResetType.FORCE_ON) ||
    isResetTypeSupported(ResourceResetType.FORCE_OFF) ||
    isResetTypeSupported(ResourceResetType.FORCE_RESTART) ||
    isResetTypeSupported(ResourceResetType.POWER_CYCLE),
);
</script>

<template>
  <div ref="wrapperRef" class="relative">
    <button
      aria-haspopup="menu"
      :aria-expanded="open"
      class="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="isExecuting"
      :title="`Power: ${powerState ?? 'Unknown'}${systemState ? ` — ${systemState}` : ''}`"
      type="button"
      @click="toggle"
    >
      <PowerIcon :aria-hidden="true" :status="powerStateIconStatus" />
      <span class="hidden sm:inline">Power</span>
      <span
        v-if="isExecuting"
        aria-hidden="true"
        class="ml-1 inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
      />
    </button>

    <div
      v-if="open"
      class="absolute right-0 z-30 mt-1 w-56 rounded border border-gray-700 bg-gray-800 py-1 text-sm shadow-lg"
      role="menu"
    >
      <div class="px-3 py-1 font-semibold text-gray-200">Power: {{ powerState ?? 'Unknown' }}</div>
      <div v-if="systemState" class="px-3 pb-1 text-xs text-gray-400">
        System State: {{ systemState }}
      </div>
      <div class="my-1 border-t border-gray-700" />

      <button
        v-if="isResetTypeSupported(ResourceResetType.ON)"
        class="block w-full px-3 py-1.5 text-left hover:bg-gray-700 disabled:opacity-50"
        :disabled="isExecuting"
        role="menuitem"
        type="button"
        @click="executePowerAction(ResourceResetType.ON)"
      >
        Power On
      </button>
      <button
        v-if="isResetTypeSupported(ResourceResetType.GRACEFUL_SHUTDOWN)"
        class="block w-full px-3 py-1.5 text-left hover:bg-gray-700 disabled:opacity-50"
        :disabled="isExecuting"
        role="menuitem"
        type="button"
        @click="executePowerAction(ResourceResetType.GRACEFUL_SHUTDOWN)"
      >
        Graceful Shutdown
      </button>
      <button
        v-if="isResetTypeSupported(ResourceResetType.GRACEFUL_RESTART)"
        class="block w-full px-3 py-1.5 text-left hover:bg-gray-700 disabled:opacity-50"
        :disabled="isExecuting"
        role="menuitem"
        type="button"
        @click="executePowerAction(ResourceResetType.GRACEFUL_RESTART)"
      >
        Graceful Restart
      </button>

      <template v-if="hasForceAction">
        <div class="my-1 border-t border-gray-700" />
        <div class="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-yellow-400">
          Force Actions
        </div>
        <button
          v-if="isResetTypeSupported(ResourceResetType.FORCE_ON)"
          class="block w-full px-3 py-1.5 text-left text-yellow-300 hover:bg-gray-700 disabled:opacity-50"
          :disabled="isExecuting"
          role="menuitem"
          type="button"
          @click="executePowerAction(ResourceResetType.FORCE_ON)"
        >
          Force On
        </button>
        <button
          v-if="isResetTypeSupported(ResourceResetType.FORCE_OFF)"
          class="block w-full px-3 py-1.5 text-left text-yellow-300 hover:bg-gray-700 disabled:opacity-50"
          :disabled="isExecuting"
          role="menuitem"
          type="button"
          @click="executePowerAction(ResourceResetType.FORCE_OFF)"
        >
          Force Off
        </button>
        <button
          v-if="isResetTypeSupported(ResourceResetType.FORCE_RESTART)"
          class="block w-full px-3 py-1.5 text-left text-yellow-300 hover:bg-gray-700 disabled:opacity-50"
          :disabled="isExecuting"
          role="menuitem"
          type="button"
          @click="executePowerAction(ResourceResetType.FORCE_RESTART)"
        >
          Force Restart
        </button>
        <button
          v-if="isResetTypeSupported(ResourceResetType.POWER_CYCLE)"
          class="block w-full px-3 py-1.5 text-left text-yellow-300 hover:bg-gray-700 disabled:opacity-50"
          :disabled="isExecuting"
          role="menuitem"
          type="button"
          @click="executePowerAction(ResourceResetType.POWER_CYCLE)"
        >
          Power Cycle
        </button>
      </template>
    </div>

    <div
      v-if="errorMessage"
      class="fixed right-4 top-16 z-50 max-w-sm rounded border border-red-800 bg-red-950/90 p-3 text-sm text-red-200 shadow-lg"
      role="alert"
    >
      <div class="mb-1 flex items-start justify-between gap-3 font-semibold">
        Power Action Error
        <button
          class="text-red-300 hover:text-red-100"
          aria-label="Dismiss"
          type="button"
          @click="errorMessage = null"
        >
          ×
        </button>
      </div>
      <div>{{ errorMessage }}</div>
    </div>
  </div>
</template>
