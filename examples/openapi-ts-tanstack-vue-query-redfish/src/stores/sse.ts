/**
 * Pinia store holding SSE connection state and the most-recent event window.
 *
 * The composable in `src/composables/useSSE.ts` drives this store; views
 * read from it for display.
 */

import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';

import type { EventRecord } from '@/composables/parseSSEEvent';

export type SSEStatus = 'connected' | 'connecting' | 'disconnected' | 'error' | 'reconnecting';

const MAX_EVENT_HISTORY = 200;

export const useSSEStore = defineStore('sse', () => {
  const status = ref<SSEStatus>('disconnected');
  const errorMessage = ref<string | null>(null);
  const reconnectAttempts = ref(0);
  const bufferExceeded = ref(false);
  const enabled = ref(true);
  const events = shallowRef<readonly EventRecord[]>([]);

  const isConnected = computed(() => status.value === 'connected');

  function setStatus(newStatus: SSEStatus, error?: string): void {
    status.value = newStatus;
    errorMessage.value = error ?? null;
  }

  function addEvent(event: EventRecord): void {
    const next = [event, ...events.value];
    events.value = next.length > MAX_EVENT_HISTORY ? next.slice(0, MAX_EVENT_HISTORY) : next;
  }

  function incrementReconnectAttempts(): void {
    reconnectAttempts.value++;
  }

  function resetReconnectAttempts(): void {
    reconnectAttempts.value = 0;
  }

  function markBufferExceeded(): void {
    bufferExceeded.value = true;
  }

  function reset(): void {
    status.value = 'disconnected';
    errorMessage.value = null;
    reconnectAttempts.value = 0;
    bufferExceeded.value = false;
    events.value = [];
  }

  return {
    addEvent,
    bufferExceeded,
    enabled,
    errorMessage,
    events,
    incrementReconnectAttempts,
    isConnected,
    markBufferExceeded,
    reconnectAttempts,
    reset,
    resetReconnectAttempts,
    setStatus,
    status,
  };
});
