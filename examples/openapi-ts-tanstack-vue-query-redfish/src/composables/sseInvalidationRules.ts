/**
 * Helpers and the default rule table for the SSE → Vue Query cache
 * invalidation engine.
 *
 * The contract this implements is documented at
 * `docs/designs/vue-query-sse-cache-invalidation.md` (relative to this
 * example's project root).
 *
 * The engine resolves each Redfish event in two passes:
 *
 *   1. If the event carries an `OriginOfCondition` URI, every cached
 *      query whose URL is a parent of (or equal to) that URI gets
 *      invalidated. `ResourceCreated` / `ResourceRemoved` events
 *      additionally invalidate the parent collection so the new/gone
 *      member surfaces in list views.
 *   2. The static rule table below is consulted for events whose
 *      `OriginOfCondition` is missing, ambiguous, or does not point at
 *      the resource a UI cares about (typical for `TaskEvent` and
 *      `Update`-registry events).
 *
 * ## Op-id → URL bridge
 *
 * `@hey-api/openapi-ts`'s `@tanstack/vue-query` plugin emits query keys
 * shaped as `[{ _id, baseURL, path?, query?, body?, headers? }]` —
 * crucially without the request URL itself. To match an SSE event's
 * `OriginOfCondition` URI against the cache we therefore look up each
 * cached query's `_id` in a small per-app registry that maps operation
 * ids back to their URL templates. The registry only needs an entry
 * for each operation in `SCOPED_OPERATIONS` (in `openapi-ts.config.ts`)
 * — adding an operation there means adding a row here too.
 */

import type { EventRecord } from './parseSSEEvent';

export interface SseInvalidationRule {
  /**
   * URL prefixes whose cached queries should be invalidated when this
   * rule matches. Matched against each cached query's resolved URL.
   */
  invalidate: ReadonlyArray<string>;
  /**
   * Regex matched against `event.MessageId`. At least one of
   * `messageIdPattern` / `messagePattern` / `originPattern` must be set
   * or the rule never matches.
   */
  messageIdPattern?: RegExp;
  /**
   * Regex matched against `event.Message`. Lets a rule target events
   * that BMCs publish without a `MessageId` (or with an empty one) —
   * notably OpenBMC state-change signals which surface a fully-
   * qualified D-Bus signal path in `Message`
   * (`xyz.openbmc_project.State.Info.ChassisPowerOnStarted` etc.).
   */
  messagePattern?: RegExp;
  /**
   * Regex matched against the *raw* `OriginOfCondition` URI (with the
   * `/Actions/...` suffix intact). Lets a rule fire on action
   * endpoints whose state-change effect crosses resource trees — for
   * example, `Chassis.Reset` lives on the Chassis but flips the
   * System's `PowerState`.
   */
  originPattern?: RegExp;
  /**
   * Optional Redfish `ResourceType` filter. Skipped when the event
   * does not carry a string `ResourceType`.
   */
  resourceTypes?: ReadonlyArray<string>;
}

export const DEFAULT_INVALIDATION_RULES: readonly SseInvalidationRule[] = [
  // TaskEvent registry — task lifecycle events. The OriginOfCondition
  // is usually the Task itself; we additionally refresh the listing.
  {
    invalidate: ['/redfish/v1/TaskService', '/redfish/v1/TaskService/Tasks'],
    messageIdPattern: /^TaskEvent\./,
  },
  // Update registry — firmware update progress.
  {
    invalidate: [
      '/redfish/v1/UpdateService',
      '/redfish/v1/UpdateService/FirmwareInventory',
      '/redfish/v1/UpdateService/SoftwareInventory',
    ],
    messageIdPattern: /^Update\./,
  },
  // Reset actions (`Chassis.Reset`, `ComputerSystem.Reset`, vendor
  // `*.Reset` extensions). The BMC publishes these as
  // `Base.*.PropertyValueModified` events whose `OriginOfCondition`
  // is the action endpoint itself, but the actual state change
  // (`PowerState`, `Status.State`) is visible on both the parent
  // Chassis and the related System — neither of which is reachable
  // from the action URL by prefix-matching alone.
  {
    invalidate: ['/redfish/v1/Systems', '/redfish/v1/Chassis'],
    originPattern: /\/Actions\/[\w-]+\.Reset(?:\?|$)/,
  },
  // OpenBMC state-change signals. Published as Redfish events with an
  // empty `MessageId` and the full D-Bus signal path in `Message`
  // (e.g. `xyz.openbmc_project.State.Info.ChassisPowerOnStarted`,
  // `…HostTransition…`, `…BMCStateChanged`). No `OriginOfCondition`
  // is set, so prefix-matching cannot reach anything — but the
  // affected resources are always the Chassis and the System.
  {
    invalidate: ['/redfish/v1/Systems', '/redfish/v1/Chassis'],
    messagePattern: /^xyz\.openbmc_project\.State\./,
  },
];

/**
 * Operation id → URL template registry.
 *
 * Keep one entry per operation listed in `SCOPED_OPERATIONS` (in
 * `openapi-ts.config.ts`). Each value MUST match the `url` field on
 * the corresponding `*Data` type in `src/client/types.gen.ts`.
 *
 * Operations without an entry here are simply invisible to the
 * SSE-driven invalidation engine — they will not match
 * `OriginOfCondition`-based predicates (mutations like
 * `postSessionServiceSessions` typically don't need to).
 */
export const REDFISH_OPERATION_URLS: Readonly<Record<string, string>> = {
  getAccountServiceAccountById: '/redfish/v1/AccountService/Accounts/{ManagerAccountId}',
  getChassis: '/redfish/v1/Chassis',
  getServiceRoot: '/redfish/v1',
  getSessionServiceSessions: '/redfish/v1/SessionService/Sessions',
  getSystemById: '/redfish/v1/Systems/{ComputerSystemId}',
  getSystems: '/redfish/v1/Systems',
  getTelemetryServiceMetricReportById:
    '/redfish/v1/TelemetryService/MetricReports/{MetricReportId}',
  getTelemetryServiceMetricReports: '/redfish/v1/TelemetryService/MetricReports',
};

const BUFFER_EXCEEDED_MARKER = 'EventBufferExceeded';
const HEARTBEAT_REGISTRY_PREFIX = 'HeartbeatEvent.';

export function isBufferExceededEvent(event: EventRecord): boolean {
  return event.MessageId?.includes(BUFFER_EXCEEDED_MARKER) ?? false;
}

/**
 * `HeartbeatEvent.*` messages are connection-health pings (and the
 * registry the SSE composable uses to "prime" bmcweb's stream); they
 * never represent a resource change and should never trigger cache
 * invalidation.
 */
export function isHeartbeatEvent(event: EventRecord): boolean {
  return event.MessageId?.startsWith(HEARTBEAT_REGISTRY_PREFIX) ?? false;
}

export function isResourceLifecycleEvent(event: EventRecord): boolean {
  const id = event.MessageId ?? '';
  return id.includes('ResourceCreated') || id.includes('ResourceRemoved');
}

/**
 * Extract the `OriginOfCondition` URI as a plain string from either
 * the spec-shape (object with `@odata.id`) or the flat-string vendor
 * variant. Returns null when the field is absent.
 */
export function extractOriginOfCondition(event: EventRecord): string | null {
  const origin = event.OriginOfCondition;
  if (!origin) return null;
  if (typeof origin === 'string') return origin;
  return origin['@odata.id'] ?? null;
}

/**
 * Strip a trailing `/Actions/<ActionName>` segment off an
 * `OriginOfCondition` URI so prefix-matching reaches the resource that
 * owns the action rather than the action endpoint itself.
 *
 *   /redfish/v1/Chassis/System_0/Actions/Chassis.Reset
 *     → /redfish/v1/Chassis/System_0
 *
 * Leaves any other URI shape untouched.
 */
export function stripActionsSuffix(uri: string): string {
  const idx = uri.indexOf('/Actions/');
  return idx === -1 ? uri : uri.slice(0, idx);
}

/**
 * Compute the parent collection URL for an `OriginOfCondition` URI by
 * trimming the trailing path segment. Returns null for top-level URIs.
 */
export function parentPath(uri: string): string | null {
  const trimmed = uri.replace(/\/+$/, '');
  const last = trimmed.lastIndexOf('/');
  if (last <= 0) return null;
  return trimmed.slice(0, last);
}

/**
 * Resolve a templated Redfish path (`/redfish/v1/Chassis/{ChassisId}`)
 * against a `path` parameters bag, producing a concrete URL. Unfilled
 * placeholders are left as-is so an unresolved key cannot silently
 * match an SSE event.
 */
export function resolveUrlTemplate(url: string, path?: Record<string, string | number>): string {
  if (!path) return url;
  return url.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = path[key];
    return value !== undefined && value !== null ? String(value) : placeholder;
  });
}

/**
 * The shape `@hey-api/openapi-ts`'s `@tanstack/vue-query` plugin emits
 * for `query.queryKey[0]`. Other elements may exist but the engine
 * only inspects these two.
 */
export interface OptionsKeyShape {
  _id?: string;
  path?: Record<string, string | number>;
}

export function getKeyShape(queryKey: unknown): OptionsKeyShape | null {
  if (!Array.isArray(queryKey)) return null;
  const first = queryKey[0];
  if (!first || typeof first !== 'object') return null;
  return first as OptionsKeyShape;
}

/**
 * Resolve a cached query to a concrete Redfish URL by looking its
 * `_id` up in `REDFISH_OPERATION_URLS` and substituting `path`
 * parameters. Returns null for queries the registry does not know
 * about (mutation hooks, library-level keys, hand-rolled hooks).
 */
export function resolveQueryUrl(queryKey: unknown): string | null {
  const shape = getKeyShape(queryKey);
  if (!shape?._id) return null;
  const template = REDFISH_OPERATION_URLS[shape._id];
  if (!template) return null;
  return resolveUrlTemplate(template, shape.path);
}

/**
 * True when the cached query's URL is a parent of (or equal to)
 * `origin`. This is the primary `OriginOfCondition` predicate.
 */
export function isQueryAncestorOf(queryKey: unknown, origin: string): boolean {
  const concrete = resolveQueryUrl(queryKey);
  if (!concrete) return false;
  return concrete === origin || origin.startsWith(`${concrete}/`);
}

/**
 * True when the cached query's URL lives under (or equals) `prefix`.
 * Used for the static rule table.
 */
export function isQueryUnder(queryKey: unknown, prefix: string): boolean {
  const concrete = resolveQueryUrl(queryKey);
  if (!concrete) return false;
  return concrete === prefix || concrete.startsWith(`${prefix}/`);
}

/**
 * True when the cached query's URL is exactly `target`.
 */
export function isQueryUrlExactly(queryKey: unknown, target: string): boolean {
  const concrete = resolveQueryUrl(queryKey);
  return concrete === target;
}
