/**
 * SSE composable for the Redfish EventService.
 *
 * Powered by the generated `@hey-api/client-axios` SSE client (which uses
 * `fetch` + ReadableStream under the hood, so we can set custom auth
 * headers — unlike browser-native `EventSource`).
 *
 * The connection is held in module scope so all callers share the same
 * stream. Components just read reactive state from the SSE Pinia store.
 *
 * Lifecycle:
 *   - On `connect()`, an AbortController is created and the SSE stream is
 *     consumed in the background. State is mirrored into the store.
 *   - On `disconnect()`, the controller is aborted. The store is reset.
 *   - The composable installs a single watcher on the auth store so that
 *     logging out automatically tears down the stream.
 */

import { defineStore } from 'pinia';
import { computed, type Ref,watch } from 'vue';

import { client } from '@/client/client.gen';
import type { EventRecord } from '@/composables/parseSSEEvent';
import { parseSSEEventData } from '@/composables/parseSSEEvent';
import { useAuthStore } from '@/stores/auth';
import { useSSEStore } from '@/stores/sse';

const DEFAULT_ENDPOINT = '/redfish/v1/EventService/SSE';
const MAX_RECONNECT_ATTEMPTS = 5;
const SSE_RETRY_DEFAULT_MS = 1000;
const SSE_RETRY_MAX_MS = 30_000;

export interface UseSSEOptions {
  /** Auto-connect when authenticated. @default true */
  autoConnect?: boolean;
  /** Redfish SSE endpoint. @default `/redfish/v1/EventService/SSE` */
  endpoint?: string;
  /** Optional Redfish `$filter` expression. */
  filter?: string;
  /** Called whenever an `EventBufferExceeded` event is observed. */
  onBufferExceeded?: () => void;
}

export interface UseSSEReturn {
  bufferExceeded: Ref<boolean>;
  connect: () => void;
  disconnect: () => void;
  errorMessage: Ref<string | null>;
  events: Ref<readonly EventRecord[]>;
  isConnected: Ref<boolean>;
  status: Ref<string>;
}

const useSSEController = defineStore('sse-controller', () => {
  let controller: AbortController | null = null;
  let watchersInstalled = false;
  let onBufferExceeded: (() => void) | undefined;
  let endpoint = DEFAULT_ENDPOINT;
  let filter: string | undefined;

  const sseStore = useSSEStore();
  const authStore = useAuthStore();

  function buildUrl(): string {
    if (!filter) return endpoint;
    const params = new URLSearchParams({ $filter: filter });
    return `${endpoint}?${params.toString()}`;
  }

  function isActive(): boolean {
    return controller !== null && !controller.signal.aborted;
  }

  async function consume(): Promise<void> {
    if (isActive()) return;
    if (!authStore.isAuthenticated) return;

    controller = new AbortController();
    sseStore.setStatus('connecting');

    try {
      const { stream } = await client.sse.get({
        // The SSE client uses `fetch` (not axios), so axios interceptors do
        // not apply. We re-read the token in `onRequest` so retries always
        // see the current value.
        onRequest: async (url, init) => {
          const headers = new Headers(init.headers);
          if (authStore.token) headers.set('X-Auth-Token', authStore.token);
          return new Request(url, { ...init, headers });
        },
        signal: controller.signal,
        sseDefaultRetryDelay: SSE_RETRY_DEFAULT_MS,
        sseMaxRetryAttempts: MAX_RECONNECT_ATTEMPTS,
        sseMaxRetryDelay: SSE_RETRY_MAX_MS,
        url: buildUrl(),
      });

      sseStore.setStatus('connected');
      sseStore.resetReconnectAttempts();

      for await (const data of stream) {
        const parsed = parseSSEEventData(data);
        if (parsed.error) {
          console.warn(parsed.error);
          continue;
        }
        for (const event of parsed.events) sseStore.addEvent(event);
        if (parsed.hasBufferExceeded) {
          sseStore.markBufferExceeded();
          onBufferExceeded?.();
        }
      }

      sseStore.setStatus('disconnected');
    } catch (error) {
      if (controller?.signal.aborted) {
        sseStore.setStatus('disconnected');
        return;
      }
      sseStore.incrementReconnectAttempts();
      const message = error instanceof Error ? error.message : 'SSE connection failed';
      sseStore.setStatus('error', message);
    } finally {
      controller = null;
    }
  }

  function start(): void {
    void consume();
  }

  function stop(): void {
    if (controller) controller.abort();
    controller = null;
    sseStore.setStatus('disconnected');
  }

  function configure(options: UseSSEOptions): void {
    if (options.endpoint) endpoint = options.endpoint;
    if (options.filter !== undefined) filter = options.filter;
    if (options.onBufferExceeded) onBufferExceeded = options.onBufferExceeded;

    if (watchersInstalled) return;
    watchersInstalled = true;

    watch(
      () => authStore.isAuthenticated,
      (authed) => {
        if (authed && sseStore.enabled) start();
        else stop();
      },
    );

    watch(
      () => sseStore.enabled,
      (enabled) => {
        if (enabled && authStore.isAuthenticated) start();
        else stop();
      },
    );
  }

  return { configure, start, stop };
});

export function useSSE(options: UseSSEOptions = {}): UseSSEReturn {
  const sseStore = useSSEStore();
  const authStore = useAuthStore();
  const controller = useSSEController();

  controller.configure(options);

  if ((options.autoConnect ?? true) && authStore.isAuthenticated && sseStore.enabled) {
    controller.start();
  }

  return {
    bufferExceeded: computed(() => sseStore.bufferExceeded),
    connect: () => controller.start(),
    disconnect: () => controller.stop(),
    errorMessage: computed(() => sseStore.errorMessage),
    events: computed(() => sseStore.events),
    isConnected: computed(() => sseStore.isConnected),
    status: computed(() => sseStore.status),
  };
}

/**
 * Build a Redfish `$filter` query string.
 *
 * @example
 * buildSSEFilter({
 *   EventType: ['Alert', 'ResourceAdded'],
 *   RegistryPrefix: ['ResourceEvent'],
 * })
 * // → "(EventType eq 'Alert' or EventType eq 'ResourceAdded') and RegistryPrefix eq 'ResourceEvent'"
 */
export function buildSSEFilter(filters: Record<string, readonly string[]>): string {
  const conditions: string[] = [];

  for (const [property, values] of Object.entries(filters)) {
    if (values.length === 0) continue;
    const exprs = values.map((value) => `${property} eq '${value}'`);
    conditions.push(exprs.length === 1 ? exprs[0]! : `(${exprs.join(' or ')})`);
  }

  return conditions.join(' and ');
}
