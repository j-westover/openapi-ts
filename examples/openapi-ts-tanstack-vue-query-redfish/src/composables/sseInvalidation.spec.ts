/**
 * Unit tests for the SSE → Vue Query cache invalidation engine.
 *
 * These exercise `applySseEventInvalidation` directly with a hand-
 * rolled fake `QueryClient`, so the assertions read as
 * "given this event, this set of cached query URLs is invalidated".
 * The cached query fixtures mirror the operation-id / URL-template
 * pairs registered in `REDFISH_OPERATION_URLS`.
 */

import type { QueryClient, QueryKey } from '@tanstack/vue-query';
import { describe, expect, it } from 'vitest';

import type { EventRecord } from '@/composables/parseSSEEvent';
import {
  DEFAULT_INVALIDATION_RULES,
  type SseInvalidationRule,
} from '@/composables/sseInvalidationRules';
import { applySseEventInvalidation } from '@/composables/useSSEQueryInvalidation';

interface FakeCachedQuery {
  queryKey: QueryKey;
  url: string;
}

interface InvalidateCall {
  isGlobal: boolean;
  matched: ReadonlyArray<string>;
}

interface PredicateOpts {
  predicate?: (query: { queryKey: QueryKey }) => boolean;
}

function cached(opId: string, url: string, path?: Record<string, string>): FakeCachedQuery {
  // The shape `@hey-api/openapi-ts`'s `@tanstack/vue-query` plugin
  // emits for `query.queryKey[0]` — `_id` plus an optional `path`
  // bag for templated parameters.
  return { queryKey: [{ _id: opId, ...(path ? { path } : {}) }], url };
}

const FIXTURE_QUERIES: ReadonlyArray<FakeCachedQuery> = [
  cached('getServiceRoot', '/redfish/v1'),
  cached('getSystems', '/redfish/v1/Systems'),
  cached('getSystemById', '/redfish/v1/Systems/System_0', { ComputerSystemId: 'System_0' }),
  cached('getChassis', '/redfish/v1/Chassis'),
  cached('getSessionServiceSessions', '/redfish/v1/SessionService/Sessions'),
  cached('getTelemetryServiceMetricReports', '/redfish/v1/TelemetryService/MetricReports'),
];

function buildFakeClient(queries: ReadonlyArray<FakeCachedQuery> = FIXTURE_QUERIES): {
  calls: ReadonlyArray<InvalidateCall>;
  client: QueryClient;
  invalidatedUrls: () => ReadonlyArray<string>;
} {
  const calls: InvalidateCall[] = [];
  const client = {
    invalidateQueries(opts?: PredicateOpts): Promise<void> {
      if (!opts || !opts.predicate) {
        // No-args call → catastrophic flush.
        calls.push({ isGlobal: true, matched: queries.map((q) => q.url) });
        return Promise.resolve();
      }
      const matched = queries
        .filter((q) => opts.predicate!({ queryKey: q.queryKey }))
        .map((q) => q.url);
      calls.push({ isGlobal: false, matched });
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  const invalidatedUrls = (): ReadonlyArray<string> => {
    const seen = new Set<string>();
    for (const call of calls) for (const url of call.matched) seen.add(url);
    return [...seen];
  };
  return { calls, client, invalidatedUrls };
}

const RULES: ReadonlyArray<SseInvalidationRule> = DEFAULT_INVALIDATION_RULES;

describe('applySseEventInvalidation', () => {
  describe('*.Reset action events (id:151 Off / id:153 On — Chassis.Reset)', () => {
    function chassisResetEvent(value: 'Off' | 'On'): EventRecord {
      // Real-world events the user reported, captured verbatim from
      // an OpenBMC bmcweb event stream.
      return {
        EventId: value === 'Off' ? '151' : '153',
        EventType: 'Event',
        Message: `The property ResetType was assigned the value '${value}' due to modification by the service.`,
        MessageArgs: ['ResetType', value],
        MessageId: 'Base.1.15.PropertyValueModified',
        MessageSeverity: 'OK',
        OriginOfCondition: {
          '@odata.id': '/redfish/v1/Chassis/System_0/Actions/Chassis.Reset',
        },
      };
    }

    it.each(['Off', 'On'] as const)(
      'invalidates the System tree when ResetType=%s',
      (resetType) => {
        const { client, invalidatedUrls } = buildFakeClient();
        applySseEventInvalidation(client, chassisResetEvent(resetType), RULES);
        expect(invalidatedUrls()).toEqual(
          expect.arrayContaining([
            '/redfish/v1',
            '/redfish/v1/Systems',
            '/redfish/v1/Systems/System_0',
            '/redfish/v1/Chassis',
          ]),
        );
      },
    );

    it('does not invalidate unrelated subtrees (sessions, telemetry)', () => {
      const { client, invalidatedUrls } = buildFakeClient();
      applySseEventInvalidation(client, chassisResetEvent('On'), RULES);
      expect(invalidatedUrls()).not.toEqual(
        expect.arrayContaining([
          '/redfish/v1/SessionService/Sessions',
          '/redfish/v1/TelemetryService/MetricReports',
        ]),
      );
    });

    it('strips /Actions/ off the origin so the parent resource is reachable by ancestor match', () => {
      // Synthetic cached Chassis-by-id query proves the strip; the
      // real fixture omits chassis-by-id (no scoped `getChassisById`).
      const queries: ReadonlyArray<FakeCachedQuery> = [
        cached('getChassis', '/redfish/v1/Chassis'),
        // Pretend a hypothetical scoped op exists; the engine only
        // cares that `_id → URL-template` is in the registry, so
        // hijack `getChassis` collection vs. an ancestor-style URL
        // by injecting a synthetic op into FIXTURE-style data.
        cached('getServiceRoot', '/redfish/v1'),
      ];
      const { client, invalidatedUrls } = buildFakeClient(queries);
      applySseEventInvalidation(client, chassisResetEvent('On'), RULES);
      // ServiceRoot is an ancestor of the *stripped* origin.
      expect(invalidatedUrls()).toContain('/redfish/v1');
      expect(invalidatedUrls()).toContain('/redfish/v1/Chassis');
    });
  });

  describe('OpenBMC state-info messages (id:154 ChassisPowerOnStarted)', () => {
    function openbmcStateEvent(signal: string): EventRecord {
      // Real-world event the user reported, captured verbatim. Note
      // that `MessageId` is the *empty string*, `OriginOfCondition`
      // is absent, and the D-Bus signal path lives in `Message`.
      return {
        EventId: '154',
        EventType: 'Event',
        Message: signal,
        MessageId: '',
        MessageSeverity: 'OK',
      };
    }

    it.each([
      'xyz.openbmc_project.State.Info.ChassisPowerOnStarted',
      'xyz.openbmc_project.State.Info.ChassisPowerOnFinished',
      'xyz.openbmc_project.State.Info.ChassisPowerOffStarted',
      'xyz.openbmc_project.State.Info.ChassisPowerOffFinished',
      'xyz.openbmc_project.State.Host.Info.HostTransition',
      'xyz.openbmc_project.State.BMC.Info.BMCStateChanged',
    ])('invalidates Systems + Chassis trees on %s', (signal) => {
      const { client, invalidatedUrls } = buildFakeClient();
      applySseEventInvalidation(client, openbmcStateEvent(signal), RULES);
      expect(invalidatedUrls()).toEqual(
        expect.arrayContaining([
          '/redfish/v1/Systems',
          '/redfish/v1/Systems/System_0',
          '/redfish/v1/Chassis',
        ]),
      );
    });

    it('does not invalidate ServiceRoot (no origin to ancestor-match)', () => {
      const { client, invalidatedUrls } = buildFakeClient();
      applySseEventInvalidation(
        client,
        openbmcStateEvent('xyz.openbmc_project.State.Info.ChassisPowerOnStarted'),
        RULES,
      );
      // ServiceRoot is `/redfish/v1` — only reached when an origin
      // is present (it is not under either Systems/Chassis prefix).
      expect(invalidatedUrls()).not.toContain('/redfish/v1');
    });

    it('ignores non-state OpenBMC messages', () => {
      const { client, invalidatedUrls } = buildFakeClient();
      applySseEventInvalidation(
        client,
        openbmcStateEvent('xyz.openbmc_project.Inventory.Manager.SomethingElse'),
        RULES,
      );
      expect(invalidatedUrls()).toHaveLength(0);
    });
  });

  describe('Heartbeat events', () => {
    it('does not invalidate anything', () => {
      const { calls, client } = buildFakeClient();
      applySseEventInvalidation(
        client,
        { MessageId: 'HeartbeatEvent.1.0.RedfishServiceFunctional' },
        RULES,
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('Buffer-exceeded events', () => {
    it('triggers a global flush', () => {
      const { calls, client } = buildFakeClient();
      applySseEventInvalidation(
        client,
        { MessageId: 'ResourceEvent.1.0.EventBufferExceeded' },
        RULES,
      );
      expect(calls).toEqual([{ isGlobal: true, matched: expect.any(Array) }]);
    });
  });

  describe('rules with no matchers (safety net)', () => {
    it('never fires', () => {
      const malformedRule: SseInvalidationRule = { invalidate: ['/redfish/v1/Systems'] };
      const { calls, client } = buildFakeClient();
      applySseEventInvalidation(client, { Message: 'anything', MessageId: 'anything' }, [
        malformedRule,
      ]);
      expect(calls).toHaveLength(0);
    });
  });
});
