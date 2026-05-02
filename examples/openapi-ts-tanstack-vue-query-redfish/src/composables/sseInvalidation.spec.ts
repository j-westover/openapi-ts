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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EventRecord } from '@/composables/parseSSEEvent';
import {
  DEFAULT_INVALIDATION_RULES,
  REDFISH_OPERATION_URLS,
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

// Mutable view onto the URL registry so individual tests can inject
// synthetic operation ids (e.g. `getChassisById`) without registering
// them globally for the whole suite. Always pair a `REGISTRY[op]=...`
// write with a `delete REGISTRY[op]` in a `try/finally`.
const REGISTRY = REDFISH_OPERATION_URLS as Record<string, string>;

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
      'targets the matching System-by-id when ResetType=%s',
      (resetType) => {
        const { client, invalidatedUrls } = buildFakeClient();
        applySseEventInvalidation(client, chassisResetEvent(resetType), RULES);
        // The capture-group rule resolves `{1}` to `System_0` from
        // the action's `/Chassis/<ID>/Actions/Chassis.Reset` segment.
        expect(invalidatedUrls()).toContain('/redfish/v1/Systems/System_0');
      },
    );

    it('refreshes the Systems and Chassis collections (membership shifts on power events)', () => {
      // Real BMCs report different chassis enumeration during power
      // transitions (boards / modules / GPUs become visible or
      // non-visible as physical power propagates). The collection
      // queries are exact-URL invalidations — only the collection
      // itself refetches; cached member-by-id queries do not get
      // swept along. ServiceRoot stays cached either way.
      const { client, invalidatedUrls } = buildFakeClient();
      applySseEventInvalidation(client, chassisResetEvent('On'), RULES);
      const matched = invalidatedUrls();
      expect(matched).toContain('/redfish/v1/Systems');
      expect(matched).toContain('/redfish/v1/Chassis');
      expect(matched).not.toContain('/redfish/v1');
    });

    it('does not invalidate unrelated subtrees (sessions, telemetry, account)', () => {
      const { client, invalidatedUrls } = buildFakeClient();
      applySseEventInvalidation(client, chassisResetEvent('On'), RULES);
      const matched = invalidatedUrls();
      expect(matched).not.toContain('/redfish/v1/SessionService/Sessions');
      expect(matched).not.toContain('/redfish/v1/TelemetryService/MetricReports');
    });

    it('targets the affected Chassis-by-id and refreshes the collection without sweeping siblings', () => {
      // With `getChassisById` registered, the rule resolves the
      // subtree-match `/redfish/v1/Chassis/{1}` → `/redfish/v1/Chassis/System_0`
      // (matches the affected member by-id) AND the exact-match
      // `/redfish/v1/Chassis` (matches only the collection itself).
      // Sibling Chassis-by-id queries (`Other`) are deliberately NOT
      // matched by either predicate.
      REGISTRY['getChassisById'] = '/redfish/v1/Chassis/{ChassisId}';
      try {
        const queries: ReadonlyArray<FakeCachedQuery> = [
          cached('getChassis', '/redfish/v1/Chassis'),
          cached('getChassisById', '/redfish/v1/Chassis/System_0', { ChassisId: 'System_0' }),
          cached('getChassisById', '/redfish/v1/Chassis/Other', { ChassisId: 'Other' }),
        ];
        const { client, invalidatedUrls } = buildFakeClient(queries);
        applySseEventInvalidation(client, chassisResetEvent('On'), RULES);
        const matched = invalidatedUrls();
        expect(matched).toContain('/redfish/v1/Chassis/System_0');
        expect(matched).toContain('/redfish/v1/Chassis');
        expect(matched).not.toContain('/redfish/v1/Chassis/Other');
      } finally {
        delete REGISTRY['getChassisById'];
      }
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
      // These messages do not carry an `OriginOfCondition` and the
      // rule has no origin-pattern capture group to substitute, so it
      // falls back to the broadest-safe scope (the whole Systems and
      // Chassis subtrees). `isQueryUnder('/redfish/v1/Systems')`
      // matches the collection AND any Systems-by-id query in cache.
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

    it('does not invalidate ServiceRoot (no origin → no subtree walk)', () => {
      const { client, invalidatedUrls } = buildFakeClient();
      applySseEventInvalidation(
        client,
        openbmcStateEvent('xyz.openbmc_project.State.Info.ChassisPowerOnStarted'),
        RULES,
      );
      // ServiceRoot is `/redfish/v1` — neither inside the Systems
      // nor Chassis subtree the rule targets.
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

// ---------------------------------------------------------------------------
// Design-doc matrix (vue-query-sse-cache-invalidation.md §Testing)
// ---------------------------------------------------------------------------
//
// These exercises register synthetic operation ids in
// `REDFISH_OPERATION_URLS` so the test cache can include resources
// (sensors, sub-collections) the example app does not currently scope.
// The registry is restored after the suite finishes.

const SYNTHETIC_OPS: ReadonlyArray<readonly [string, string]> = [
  ['getChassisById', '/redfish/v1/Chassis/{ChassisId}'],
  ['getChassisSensors', '/redfish/v1/Chassis/{ChassisId}/Sensors'],
  ['getChassisSensorById', '/redfish/v1/Chassis/{ChassisId}/Sensors/{SensorId}'],
  ['getTaskService', '/redfish/v1/TaskService'],
  ['getTaskServiceTasks', '/redfish/v1/TaskService/Tasks'],
];

describe('design-doc matrix', () => {
  beforeAll(() => {
    for (const [opId, url] of SYNTHETIC_OPS) {
      REGISTRY[opId] = url;
    }
  });
  afterAll(() => {
    for (const [opId] of SYNTHETIC_OPS) {
      delete REGISTRY[opId];
    }
  });

  describe('per-instance targeting (BMC_0 vs BMC_1 isolation)', () => {
    it('targets only the leaf and leaves siblings + ancestors untouched', () => {
      const queries: ReadonlyArray<FakeCachedQuery> = [
        cached('getChassis', '/redfish/v1/Chassis'),
        cached('getChassisById', '/redfish/v1/Chassis/BMC_0', { ChassisId: 'BMC_0' }),
        cached('getChassisById', '/redfish/v1/Chassis/BMC_1', { ChassisId: 'BMC_1' }),
        cached('getChassisSensors', '/redfish/v1/Chassis/BMC_0/Sensors', { ChassisId: 'BMC_0' }),
        cached('getChassisSensorById', '/redfish/v1/Chassis/BMC_0/Sensors/temp1', {
          ChassisId: 'BMC_0',
          SensorId: 'temp1',
        }),
      ];
      const { client, invalidatedUrls } = buildFakeClient(queries);
      applySseEventInvalidation(
        client,
        {
          MessageId: 'ResourceEvent.1.0.ResourceChanged',
          OriginOfCondition: { '@odata.id': '/redfish/v1/Chassis/BMC_0/Sensors/temp1' },
        },
        RULES,
      );
      const matched = invalidatedUrls();
      // Subtree-from-origin: only the exact resource at origin (no
      // descendants cached). Ancestors are NOT invalidated — the BMC
      // is responsible for emitting separate events for any ancestor
      // whose state actually depends on the leaf.
      expect(matched).toEqual(expect.arrayContaining(['/redfish/v1/Chassis/BMC_0/Sensors/temp1']));
      expect(matched).not.toContain('/redfish/v1/Chassis');
      expect(matched).not.toContain('/redfish/v1/Chassis/BMC_0');
      expect(matched).not.toContain('/redfish/v1/Chassis/BMC_0/Sensors');
      expect(matched).not.toContain('/redfish/v1/Chassis/BMC_1');
    });

    it('invalidates cached descendants of the origin', () => {
      // Origin is a parent (`/Chassis/BMC_0`). Cached descendants
      // (a sub-resource and a deep leaf) should all refetch — the
      // resource's state is being announced as changed.
      const queries: ReadonlyArray<FakeCachedQuery> = [
        cached('getChassisById', '/redfish/v1/Chassis/BMC_0', { ChassisId: 'BMC_0' }),
        cached('getChassisSensors', '/redfish/v1/Chassis/BMC_0/Sensors', { ChassisId: 'BMC_0' }),
        cached('getChassisSensorById', '/redfish/v1/Chassis/BMC_0/Sensors/temp1', {
          ChassisId: 'BMC_0',
          SensorId: 'temp1',
        }),
        cached('getChassisById', '/redfish/v1/Chassis/BMC_1', { ChassisId: 'BMC_1' }),
      ];
      const { client, invalidatedUrls } = buildFakeClient(queries);
      applySseEventInvalidation(
        client,
        {
          MessageId: 'ResourceEvent.1.0.ResourceChanged',
          OriginOfCondition: { '@odata.id': '/redfish/v1/Chassis/BMC_0' },
        },
        RULES,
      );
      const matched = invalidatedUrls();
      expect(matched).toEqual(
        expect.arrayContaining([
          '/redfish/v1/Chassis/BMC_0',
          '/redfish/v1/Chassis/BMC_0/Sensors',
          '/redfish/v1/Chassis/BMC_0/Sensors/temp1',
        ]),
      );
      expect(matched).not.toContain('/redfish/v1/Chassis/BMC_1');
    });
  });

  describe('ResourceCreated parent-collection invalidation', () => {
    function resourceCreatedEvent(originPath: string): EventRecord {
      return {
        MessageId: 'ResourceEvent.1.0.ResourceCreated',
        OriginOfCondition: { '@odata.id': originPath },
      };
    }

    it('invalidates the new resource AND the parent collection (so list views see the add)', () => {
      const queries: ReadonlyArray<FakeCachedQuery> = [
        cached('getServiceRoot', '/redfish/v1'),
        cached('getSystems', '/redfish/v1/Systems'),
        cached('getSystemById', '/redfish/v1/Systems/system0', { ComputerSystemId: 'system0' }),
        cached('getChassis', '/redfish/v1/Chassis'),
      ];
      const { client, invalidatedUrls } = buildFakeClient(queries);
      applySseEventInvalidation(client, resourceCreatedEvent('/redfish/v1/Systems/system0'), RULES);

      const matched = invalidatedUrls();
      // The new resource (subtree-from-origin) AND its parent
      // (lifecycle-event branch). ServiceRoot is NOT invalidated —
      // it is not under the origin and not the parent collection.
      expect(matched).toEqual(
        expect.arrayContaining(['/redfish/v1/Systems', '/redfish/v1/Systems/system0']),
      );
      expect(matched).not.toContain('/redfish/v1');
      expect(matched).not.toContain('/redfish/v1/Chassis');
    });

    it('treats `ResourceRemoved` the same way (parent invalidated for list refresh)', () => {
      const queries: ReadonlyArray<FakeCachedQuery> = [
        cached('getSystems', '/redfish/v1/Systems'),
        cached('getSystemById', '/redfish/v1/Systems/system0', { ComputerSystemId: 'system0' }),
      ];
      const { client, invalidatedUrls } = buildFakeClient(queries);
      applySseEventInvalidation(
        client,
        {
          MessageId: 'ResourceEvent.1.0.ResourceRemoved',
          OriginOfCondition: { '@odata.id': '/redfish/v1/Systems/system0' },
        },
        RULES,
      );
      const matched = invalidatedUrls();
      expect(matched).toEqual(
        expect.arrayContaining(['/redfish/v1/Systems', '/redfish/v1/Systems/system0']),
      );
    });
  });

  describe('TaskEvent.* registry rule', () => {
    it('invalidates the task tree for any `TaskEvent.*` MessageId, regardless of OriginOfCondition', () => {
      const queries: ReadonlyArray<FakeCachedQuery> = [
        cached('getTaskService', '/redfish/v1/TaskService'),
        cached('getTaskServiceTasks', '/redfish/v1/TaskService/Tasks'),
        cached('getChassis', '/redfish/v1/Chassis'),
      ];
      const { client, invalidatedUrls } = buildFakeClient(queries);
      applySseEventInvalidation(client, { MessageId: 'TaskEvent.1.0.TaskCompletedOK' }, RULES);
      const matched = invalidatedUrls();
      expect(matched).toEqual(
        expect.arrayContaining(['/redfish/v1/TaskService', '/redfish/v1/TaskService/Tasks']),
      );
      expect(matched).not.toContain('/redfish/v1/Chassis');
    });
  });

  describe('Update.* registry rule', () => {
    it('invalidates UpdateService URL family for any `Update.*` MessageId', () => {
      const queries: ReadonlyArray<FakeCachedQuery> = [cached('getChassis', '/redfish/v1/Chassis')];
      const { calls, client } = buildFakeClient(queries);
      applySseEventInvalidation(client, { MessageId: 'Update.1.0.UpdateInProgress' }, RULES);
      // Three predicates fire (one per `invalidate` URL) — they all
      // produce empty `matched` arrays for the fixture cache because
      // we don't register UpdateService ops, but the *attempt* is
      // observable: three non-global calls.
      const ruleAttempts = calls.filter((c) => !c.isGlobal);
      expect(ruleAttempts).toHaveLength(3);
    });
  });

  describe('flat-string OriginOfCondition (vendor variant)', () => {
    it('targets the same resource as the DMTF object shape', () => {
      const queries: ReadonlyArray<FakeCachedQuery> = [
        cached('getServiceRoot', '/redfish/v1'),
        cached('getSystems', '/redfish/v1/Systems'),
        cached('getSystemById', '/redfish/v1/Systems/system0', { ComputerSystemId: 'system0' }),
      ];
      const { client, invalidatedUrls } = buildFakeClient(queries);
      applySseEventInvalidation(
        client,
        {
          MessageId: 'ResourceEvent.1.0.ResourceChanged',
          // Flat-string variant some BMCs emit.
          OriginOfCondition: '/redfish/v1/Systems/system0',
        },
        RULES,
      );
      const matched = invalidatedUrls();
      expect(matched).toEqual(expect.arrayContaining(['/redfish/v1/Systems/system0']));
      // No ancestor walk — parent collection / ServiceRoot stay cached.
      expect(matched).not.toContain('/redfish/v1');
      expect(matched).not.toContain('/redfish/v1/Systems');
    });
  });

  describe('events with no OriginOfCondition and no matching rule', () => {
    it('produces zero invalidations (engine bails cleanly)', () => {
      const { calls, client } = buildFakeClient();
      applySseEventInvalidation(client, { MessageId: 'OEM.Vendor.1.0.UnrecognizedEvent' }, RULES);
      expect(calls).toHaveLength(0);
    });
  });
});
