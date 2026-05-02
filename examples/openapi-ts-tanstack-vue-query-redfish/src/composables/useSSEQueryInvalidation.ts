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
  isHeartbeatEvent,
  isQueryUnder,
  isQueryUrlExactly,
  isResourceLifecycleEvent,
  parentPath,
  resolveCaptureGroups,
  type SseInvalidationRule,
  stripActionsSuffix,
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
          applySseEventInvalidation(queryClient, event, rules);
        }
      }

      lastProcessed = events[0] ?? null;
    },
    { immediate: true },
  );
}

/**
 * Pure event-handling step exported for unit testing. Production
 * callers should use the `useSSEQueryInvalidation` composable above
 * which mounts the watcher and supplies the live store cursor.
 */
export function applySseEventInvalidation(
  queryClient: QueryClient,
  event: EventRecord,
  rules: readonly SseInvalidationRule[],
): void {
  // `HeartbeatEvent.*` is a connection-health ping (and the registry
  // the SSE composable uses to "prime" bmcweb's stream) — it never
  // represents a resource change, so do not invalidate anything.
  if (isHeartbeatEvent(event)) return;

  // Coarsest signal — buffer overflow trumps everything else.
  if (isBufferExceededEvent(event)) {
    void queryClient.invalidateQueries();
    return;
  }

  // Subtree invalidation rooted at the resource the event identifies.
  //
  // We normalise `/Actions/<X>` off the origin first so an action
  // endpoint maps to the resource the action runs on (`Chassis.Reset`
  // on `/redfish/v1/Chassis/X/Actions/Chassis.Reset` ⇒ `Chassis/X`).
  // The predicate `isQueryUnder(origin)` then matches the resource
  // itself plus any cached sub-resource queries (e.g. `Chassis/X/Bios`
  // when `Chassis/X` is the origin) — but it deliberately does NOT
  // walk *upwards* to ancestors. A `ResourceChanged` on a leaf does
  // not require its parent collections (or the ServiceRoot!) to
  // refetch — the BMC is responsible for emitting separate events
  // for any ancestor whose state actually depends on the leaf.
  const rawOrigin = extractOriginOfCondition(event);
  const origin = rawOrigin ? stripActionsSuffix(rawOrigin) : null;

  if (origin) {
    void queryClient.invalidateQueries({
      predicate: (query) => isQueryUnder(query.queryKey, origin),
    });

    // `ResourceCreated` / `ResourceRemoved` change collection
    // membership — refresh the parent collection so list views
    // surface the add/remove.
    if (isResourceLifecycleEvent(event)) {
      const parent = parentPath(origin);
      if (parent) {
        void queryClient.invalidateQueries({
          predicate: (query) => isQueryUrlExactly(query.queryKey, parent),
        });
      }
    }
  }

  // Static rule registry — fires for events whose `OriginOfCondition`
  // does not (or cannot) lead the cache to the affected resources by
  // subtree alone (e.g. `Chassis.Reset`'s effect on the matching
  // System resource in a parallel tree). A rule matches when *all* of
  // its declared matchers (`messageIdPattern` / `messagePattern` /
  // `originPattern` / `resourceTypes`) match; a rule with no matchers
  // at all is ignored as a safety net.
  //
  // Rule `invalidate` URLs may reference capture groups from the
  // matching `originPattern` via `{1}`, `{2}`, … placeholders so the
  // rule can target a specific instance rather than an entire
  // collection prefix.
  const messageId = event.MessageId ?? '';
  const message = typeof event.Message === 'string' ? event.Message : '';
  const resourceType = typeof event.ResourceType === 'string' ? event.ResourceType : null;
  const originForRules = rawOrigin ?? '';

  for (const rule of rules) {
    if (!rule.messageIdPattern && !rule.messagePattern && !rule.originPattern) continue;
    if (rule.messageIdPattern && !rule.messageIdPattern.test(messageId)) continue;
    if (rule.messagePattern && !rule.messagePattern.test(message)) continue;

    let originMatch: RegExpMatchArray | null = null;
    if (rule.originPattern) {
      originMatch = rule.originPattern.exec(originForRules);
      if (!originMatch) continue;
    }

    if (
      rule.resourceTypes &&
      (resourceType === null || !rule.resourceTypes.includes(resourceType))
    ) {
      continue;
    }
    for (const urlPrefix of rule.invalidate) {
      const resolved = resolveCaptureGroups(urlPrefix, originMatch);
      if (!resolved) continue; // unsubstituted `{N}` → drop, do not over-match.
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryUnder(query.queryKey, resolved),
      });
    }
  }
}
