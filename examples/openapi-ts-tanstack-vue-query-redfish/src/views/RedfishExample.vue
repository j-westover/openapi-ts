<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';

import {
  deleteSessionServiceSessionByIdMutation,
  getChassisOptions,
  getServiceRootOptions,
  getSystemsOptions,
  postEventServiceSubmitTestEventMutation,
} from '@/client/@tanstack/vue-query.gen';
import { useSSE } from '@/composables/useSSE';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const queryClient = useQueryClient();
const authStore = useAuthStore();
const { sessionUri } = storeToRefs(authStore);

// SSE → Vue Query cache invalidation is mounted globally in App.vue
// (`useSSEQueryInvalidation`); the call here only opens / displays the
// stream.
const sse = useSSE();

const serviceRoot = useQuery(getServiceRootOptions());
const systemsQuery = useQuery(getSystemsOptions());
const chassisQuery = useQuery(getChassisOptions());

const submitTestEvent = useMutation(postEventServiceSubmitTestEventMutation());

function pingSse(): void {
  // Some BMCs don't open the SSE response until the first event, so poking
  // the heartbeat registry will surface the connection more quickly.
  submitTestEvent.mutate({
    body: { MessageId: 'HeartbeatEvent.1.1.RedfishServiceFunctional' },
  });
}

const logoutMutation = useMutation({
  ...deleteSessionServiceSessionByIdMutation(),
  // Logout is best-effort: even if the DELETE fails (BMC unreachable, token
  // already expired, …) we still tear down local state and bounce to /login.
  onSettled: tearDownSession,
});

function tearDownSession(): void {
  sse.disconnect();
  authStore.clearSession();
  queryClient.clear();
  void router.push('/login');
}

function handleLogout(): void {
  // The session URI from login looks like
  // `/redfish/v1/SessionService/Sessions/<id>`.
  const sessionId = sessionUri.value?.split('/').pop();
  if (!sessionId) {
    tearDownSession();
    return;
  }
  logoutMutation.mutate({ path: { SessionId: sessionId } });
}
</script>

<template>
  <div class="min-h-screen bg-gray-900 text-white">
    <header
      class="flex items-center justify-between border-b border-gray-700 bg-gray-800 px-6 py-3"
    >
      <h1 class="text-lg font-semibold">Redfish Dashboard</h1>
      <div class="flex items-center gap-4">
        <span class="text-sm text-gray-400">
          SSE:
          <span
            :class="{
              'text-gray-500': sse.status.value === 'disconnected',
              'text-green-400': sse.isConnected.value,
              'text-red-400': sse.status.value === 'error',
              'text-yellow-400': sse.status.value === 'reconnecting',
            }"
          >
            {{ sse.status.value }}
          </span>
        </span>
        <button
          class="rounded bg-red-600 px-3 py-1 text-sm font-medium transition hover:bg-red-700 disabled:opacity-50"
          :disabled="logoutMutation.isPending.value"
          type="button"
          @click="handleLogout"
        >
          Logout
        </button>
      </div>
    </header>

    <main class="mx-auto max-w-7xl p-6">
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section class="rounded-lg bg-gray-800 p-5">
          <h2 class="mb-3 text-lg font-semibold">Service Root</h2>
          <div v-if="serviceRoot.isPending.value" class="text-gray-400">Loading…</div>
          <div v-else-if="serviceRoot.error.value" class="text-red-400">
            {{ serviceRoot.error.value.message }}
          </div>
          <div v-else class="space-y-1 text-sm">
            <p>
              <span class="text-gray-400">Product:</span>
              {{ serviceRoot.data.value?.Product || 'N/A' }}
            </p>
            <p>
              <span class="text-gray-400">Redfish Version:</span>
              {{ serviceRoot.data.value?.RedfishVersion || 'N/A' }}
            </p>
            <p>
              <span class="text-gray-400">UUID:</span>
              {{ serviceRoot.data.value?.UUID || 'N/A' }}
            </p>
            <p>
              <span class="text-gray-400">Vendor:</span>
              {{ serviceRoot.data.value?.Vendor || 'N/A' }}
            </p>
          </div>
        </section>

        <section class="rounded-lg bg-gray-800 p-5">
          <h2 class="mb-3 text-lg font-semibold">
            Systems
            <span class="text-sm font-normal text-gray-400">
              ({{ systemsQuery.data.value?.Members?.length ?? 0 }})
            </span>
          </h2>
          <div v-if="systemsQuery.isPending.value" class="text-gray-400">Loading…</div>
          <ul v-else class="space-y-2">
            <li
              v-for="(system, i) in systemsQuery.data.value?.Members ?? []"
              :key="system['@odata.id'] ?? i"
              class="rounded border border-gray-700 px-3 py-2 text-sm"
            >
              {{ system['@odata.id'] || JSON.stringify(system) }}
            </li>
            <li v-if="!systemsQuery.data.value?.Members?.length" class="text-gray-500">
              No systems found
            </li>
          </ul>
        </section>

        <section class="rounded-lg bg-gray-800 p-5">
          <h2 class="mb-3 text-lg font-semibold">
            Chassis
            <span class="text-sm font-normal text-gray-400">
              ({{ chassisQuery.data.value?.Members?.length ?? 0 }})
            </span>
          </h2>
          <div v-if="chassisQuery.isPending.value" class="text-gray-400">Loading…</div>
          <ul v-else class="space-y-2">
            <li
              v-for="(item, i) in chassisQuery.data.value?.Members ?? []"
              :key="item['@odata.id'] ?? i"
              class="rounded border border-gray-700 px-3 py-2 text-sm"
            >
              {{ item['@odata.id'] || JSON.stringify(item) }}
            </li>
            <li v-if="!chassisQuery.data.value?.Members?.length" class="text-gray-500">
              No chassis found
            </li>
          </ul>
        </section>

        <section class="rounded-lg bg-gray-800 p-5">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-semibold">
              Live Events
              <span class="text-sm font-normal text-gray-400">
                ({{ sse.events.value.length }})
              </span>
            </h2>
            <div class="flex gap-2">
              <button
                v-if="!sse.isConnected.value"
                class="rounded bg-green-700 px-2 py-1 text-xs transition hover:bg-green-600"
                type="button"
                @click="sse.connect"
              >
                Connect
              </button>
              <button
                v-else
                class="rounded bg-yellow-700 px-2 py-1 text-xs transition hover:bg-yellow-600"
                type="button"
                @click="sse.disconnect"
              >
                Disconnect
              </button>
              <button
                class="rounded bg-blue-700 px-2 py-1 text-xs transition hover:bg-blue-600 disabled:opacity-50"
                :disabled="submitTestEvent.isPending.value"
                type="button"
                @click="pingSse"
              >
                Ping
              </button>
            </div>
          </div>

          <div
            v-if="sse.bufferExceeded.value"
            class="mb-2 rounded bg-yellow-900/50 p-2 text-xs text-yellow-300"
            role="alert"
          >
            Event buffer exceeded — data may be stale. Queries have been refetched.
          </div>

          <div class="max-h-80 space-y-1 overflow-y-auto">
            <div
              v-for="(event, i) in sse.events.value"
              :key="event.Timestamp ?? i"
              class="rounded border border-gray-700 px-2 py-1 font-mono text-xs"
            >
              <span class="text-blue-400">{{ event.MessageId || 'event' }}</span>
              <span v-if="event.Message" class="ml-2 text-gray-300">{{ event.Message }}</span>
            </div>
            <div v-if="sse.events.value.length === 0" class="text-sm text-gray-500">
              No events received yet. Events will appear here when the BMC sends them.
            </div>
          </div>
        </section>
      </div>

      <div class="mt-6 rounded-lg border border-gray-700 bg-gray-800/50 p-4 text-sm text-gray-400">
        <p class="mb-1 font-medium text-gray-300">About this example</p>
        <p>
          Built with
          <code class="text-blue-400">@hey-api/client-axios</code> +
          <code class="text-blue-400">@tanstack/vue-query</code>. Every call above goes through the
          generated SDK; SSE events stream via the generated
          <code class="text-blue-400">client.sse.get()</code>, which uses
          <code class="text-blue-400">fetch</code>+
          <code class="text-blue-400">ReadableStream</code> so we can attach the Redfish
          <code class="text-blue-400">X-Auth-Token</code> header.
        </p>
      </div>
    </main>
  </div>
</template>
