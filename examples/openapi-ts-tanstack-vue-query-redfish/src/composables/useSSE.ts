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
import { computed, type Ref, watch } from 'vue';

import { client } from '@/client/client.gen';
import { postEventServiceSubmitTestEvent } from '@/client/sdk.gen';
import type { EventRecord } from '@/composables/parseSSEEvent';
import { parseSSEEventData } from '@/composables/parseSSEEvent';
import { useAuthStore } from '@/stores/auth';
import { useSSEStore } from '@/stores/sse';

const DEFAULT_ENDPOINT = '/redfish/v1/EventService/SSE';
const MAX_RECONNECT_ATTEMPTS = 5;
const SSE_RETRY_DEFAULT_MS = 1000;
const SSE_RETRY_MAX_MS = 30_000;

// OpenBMC's bmcweb leaves the SSE response in PENDING state until the
// first event is written to the stream — `await fetch(...)` blocks
// indefinitely against an idle BMC. POSTing a HeartbeatEvent registry
// message to `EventService.SubmitTestEvent` shakes that loose by
// pushing a synthetic event through the same channel. We fire it 200 ms
// after going into 'connecting' (so the stream request is in flight)
// and again at 5 s as a backup in case the first probe didn't land.
const SSE_PRIMING_DELAY_MS = 200;
const SSE_PRIMING_RETRY_MS = 5000;
const SSE_PRIMING_MESSAGE_ID = 'HeartbeatEvent.1.1.RedfishServiceFunctional';

async function sendPrimingTestEvent(): Promise<void> {
  console.log('[SSE] sending priming test event');
  try {
    const result = await postEventServiceSubmitTestEvent({
      body: { MessageId: SSE_PRIMING_MESSAGE_ID },
      throwOnError: true,
    });
    console.log('[SSE] priming test event accepted, status=', result.status);
  } catch (error) {
    // BMC may not implement SubmitTestEvent or the HeartbeatEvent
    // registry — non-fatal, this is purely a "wake the stream up"
    // optimisation. Real events will eventually do the same job.
    console.warn('[SSE] priming test event failed (non-fatal):', error);
  }
}

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
    if (!authStore.isAuthenticated) {
      console.log('[SSE] consume() bail: not authenticated');
      return;
    }

    controller = new AbortController();
    sseStore.setStatus('connecting');
    console.log('[SSE] consume() begin, status=connecting');

    // Fire the priming probes on parallel timers. They run independently
    // of `await client.sse.get(...)` (which can block indefinitely
    // against bmcweb until an event arrives). Both are aborted as soon
    // as the stream is established, the connection is torn down, or
    // the request fails.
    const signal = controller.signal;
    const primingTimers: ReturnType<typeof setTimeout>[] = [];
    const schedulePrime = (delay: number) => {
      const timer = setTimeout(() => {
        console.log(
          `[SSE] priming timer fired (delay=${delay}ms) status=${sseStore.status} aborted=${signal.aborted}`,
        );
        if (signal.aborted) return;
        if (sseStore.status === 'connected') return;
        void sendPrimingTestEvent();
      }, delay);
      primingTimers.push(timer);
    };
    schedulePrime(SSE_PRIMING_DELAY_MS);
    schedulePrime(SSE_PRIMING_RETRY_MS);
    console.log('[SSE] priming timers armed (200ms + 5000ms)');
    const clearPrimingTimers = () => primingTimers.forEach(clearTimeout);

    try {
      const { stream } = await client.sse.get({
        // The SSE client uses `fetch` (not axios), so axios interceptors
        // do not apply. The `onRequest` hook is where we attach the
        // four things bmcweb needs to actually serve the SSE handler:
        //
        //   - `Accept: text/event-stream` — `serverSentEvents.gen.ts`
        //     does not set this for us (browser-native `EventSource`
        //     does, but our fetch-based path doesn't). Without it
        //     bmcweb routes elsewhere and returns `404`.
        //   - `Cache-Control: no-cache` — defensive against any
        //     intermediate cache between the browser and the BMC.
        //   - `X-Auth-Token` header — for non-bmcweb BMCs that
        //     authenticate via the header rather than the cookie.
        //   - `credentials: 'include'` — so the `X-Auth-Token`
        //     cookie set in `auth.ts` rides along; bmcweb gates the
        //     SSE endpoint on that cookie. (`credentials` is set here
        //     rather than at the typed entry because
        //     `client.sse.get`'s public signature does not expose it
        //     — the underlying `Request` does.)
        //
        // Re-reading the token in the hook means retries always see
        // the current value.
        onRequest: async (url, init) => {
          const headers = new Headers(init.headers);
          headers.set('Accept', 'text/event-stream');
          headers.set('Cache-Control', 'no-cache');
          if (authStore.token) headers.set('X-Auth-Token', authStore.token);
          return new Request(url, { ...init, credentials: 'include', headers });
        },
        signal: controller.signal,
        sseDefaultRetryDelay: SSE_RETRY_DEFAULT_MS,
        sseMaxRetryAttempts: MAX_RECONNECT_ATTEMPTS,
        sseMaxRetryDelay: SSE_RETRY_MAX_MS,
        url: buildUrl(),
      });

      // IMPORTANT: `client.sse.get(...)` returns the stream object
      // synchronously after `beforeRequest` resolves — the actual
      // `fetch(...)` happens lazily inside the async generator on
      // first iteration. We therefore stay in `'connecting'` (and
      // keep the priming timers armed) until the *first event*
      // actually arrives. bmcweb only flushes response headers when
      // an event is queued, so "first event arrived" is the only
      // honest signal that the stream is up.
      console.log('[SSE] client.sse.get returned, awaiting first chunk');
      let firstEventSeen = false;
      for await (const data of stream) {
        if (!firstEventSeen) {
          firstEventSeen = true;
          console.log('[SSE] first chunk received, status=connected');
          sseStore.setStatus('connected');
          sseStore.resetReconnectAttempts();
          clearPrimingTimers();
        }

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

      console.log('[SSE] for-await exited cleanly, status=disconnected');
      sseStore.setStatus('disconnected');
    } catch (error) {
      if (controller?.signal.aborted) {
        console.log('[SSE] consume() aborted (controller signal)');
        sseStore.setStatus('disconnected');
        return;
      }
      sseStore.incrementReconnectAttempts();
      const message = error instanceof Error ? error.message : 'SSE connection failed';
      console.warn('[SSE] consume() error:', message, error);
      sseStore.setStatus('error', message);
    } finally {
      clearPrimingTimers();
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
