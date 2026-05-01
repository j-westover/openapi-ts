/**
 * SSE → Vue Query cache invalidation engine.
 *
 * Mount this composable once near the top of the component tree
 * (typically `App.vue`). It watches the bounded SSE event log in the
 * SSE Pinia store and translates each event into one or more
 * `queryClient.invalidateQueries(...)` calls so Vue Query data stays
 * coherent with the BMC without polling.
 *
 * The contract this implements is documented at
 * `docs/designs/vue-query-sse-cache-invalidation.md` (relative to this
 * example's project root).
 */

import type { QueryClient } from '@tanstack/vue-query';
import { useQueryClient } from '@tanstack/vue-query';
import { watch } from 'vue';

import type { EventRecord } from '@/composables/parseSSEEvent';
import {
  DEFAULT_INVALIDATION_RULES,
  extractOriginOfCondition,
  isBufferExceededEvent,
  isQueryAncestorOf,
  isQueryUnder,
  isQueryUrlExactly,
  isResourceLifecycleEvent,
  parentPath,
  type SseInvalidationRule,
} from '@/composables/sseInvalidationRules';
import { useSSEStore } from '@/stores/sse';

export interface UseSSEQueryInvalidationOptions {
  /**
   * Additional rules appended to the defaults. Use this for
   * vendor-specific events that are not covered by the DMTF-spec
   * registries.
   */
  rules?: readonly SseInvalidationRule[];
}

export function useSSEQueryInvalidation(options: UseSSEQueryInvalidationOptions = {}): void {
  const sseStore = useSSEStore();
  const queryClient = useQueryClient();
  const rules = [...DEFAULT_INVALIDATION_RULES, ...(options.rules ?? [])];

  // Track the most-recently-processed event by reference identity so
  // we never invalidate the same event twice. The store's bounded
  // window is also our protection against runaway memory; if we lose
  // track of the cursor (i.e. it has been evicted) we treat that as a
  // buffer overflow and invalidate everything as a safety net.
  let lastProcessed: EventRecord | null = null;

  watch(
    () => sseStore.events,
    (events) => {
      if (!events.length) {
        lastProcessed = null;
        return;
      }

      // Walk the array (newest-first per the store contract) until we
      // hit the cursor, accumulating events oldest-first for replay.
      const fresh: EventRecord[] = [];
      let cursorWasFound = lastProcessed === null;
      for (const event of events) {
        if (event === lastProcessed) {
          cursorWasFound = true;
          break;
        }
        fresh.unshift(event);
      }

      if (!cursorWasFound) {
        // The cursor scrolled out of the bounded window — we missed
        // events. Conservatively flush the whole cache.
        void queryClient.invalidateQueries();
      } else {
        for (const event of fresh) {
          handleEvent(queryClient, event, rules);
        }
      }

      lastProcessed = events[0] ?? null;
    },
    { immediate: true },
  );
}

function handleEvent(
  queryClient: QueryClient,
  event: EventRecord,
  rules: readonly SseInvalidationRule[],
): void {
  // Coarsest signal — buffer overflow trumps everything else.
  if (isBufferExceededEvent(event)) {
    void queryClient.invalidateQueries();
    return;
  }

  // Fine-grained match against the URL embedded in every cached query
  // key by `@hey-api/openapi-ts`'s `@tanstack/vue-query` plugin.
  const origin = extractOriginOfCondition(event);
  if (origin) {
    void queryClient.invalidateQueries({
      predicate: (query) => isQueryAncestorOf(query.queryKey, origin),
    });

    if (isResourceLifecycleEvent(event)) {
      const parent = parentPath(origin);
      if (parent) {
        void queryClient.invalidateQueries({
          predicate: (query) => isQueryUrlExactly(query.queryKey, parent),
        });
      }
    }
  }

  // Static rule registry — for events without an OriginOfCondition or
  // whose origin URI does not map to a UI resource.
  const messageId = event.MessageId ?? '';
  const resourceType = typeof event.ResourceType === 'string' ? event.ResourceType : null;

  for (const rule of rules) {
    if (!rule.messageIdPattern.test(messageId)) continue;
    if (
      rule.resourceTypes &&
      (resourceType === null || !rule.resourceTypes.includes(resourceType))
    ) {
      continue;
    }
    for (const urlPrefix of rule.invalidate) {
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryUnder(query.queryKey, urlPrefix),
      });
    }
  }
}
