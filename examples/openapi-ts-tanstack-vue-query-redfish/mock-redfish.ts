/**
 * Vite plugin that serves a tiny in-process Redfish mock so the example
 * boots without a real BMC. Activated when `VITE_BMC_URL` is unset (the
 * default local-dev case in `vite.config.ts`).
 *
 * Implements the minimum surface the dashboard exercises:
 *
 *   - GET    /redfish/v1
 *   - GET    /redfish/v1/Systems
 *   - GET    /redfish/v1/Systems/1
 *   - GET    /redfish/v1/Systems/1/ResetActionInfo
 *   - POST   /redfish/v1/Systems/1/Actions/ComputerSystem.Reset
 *   - GET    /redfish/v1/Chassis
 *   - GET    /redfish/v1/AccountService/Accounts/:user
 *   - GET    /redfish/v1/TelemetryService/MetricReports
 *   - GET    /redfish/v1/SessionService/Sessions       (auth check)
 *   - POST   /redfish/v1/SessionService/Sessions       (login)
 *   - DELETE /redfish/v1/SessionService/Sessions/:id   (logout)
 *   - POST   /redfish/v1/EventService/Actions/EventService.SubmitTestEvent
 *   - GET    /redfish/v1/EventService/SSE              (SSE stream)
 *
 * The reset action mutates an in-memory `PowerState` and pushes a
 * `Base.*.PropertyValueModified` SSE event mirroring what real OpenBMC
 * bmcweb publishes — including the deliberately-omitted settle event
 * for `PoweringOn`, so the example's polling fallback in
 * `useManagedSystem` can be exercised against the mock.
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Plugin } from 'vite';

interface Session {
  id: string;
  userName: string;
}

const sessions = new Map<string, Session>();

const SERVICE_ROOT = {
  '@odata.id': '/redfish/v1',
  '@odata.type': '#ServiceRoot.v1_16_0.ServiceRoot',
  AccountService: { '@odata.id': '/redfish/v1/AccountService' },
  Chassis: { '@odata.id': '/redfish/v1/Chassis' },
  EventService: { '@odata.id': '/redfish/v1/EventService' },
  Id: 'RootService',
  Name: 'Root Service',
  Product: 'Mock Redfish BMC',
  RedfishVersion: '1.21.0',
  SessionService: { '@odata.id': '/redfish/v1/SessionService' },
  Systems: { '@odata.id': '/redfish/v1/Systems' },
  TelemetryService: { '@odata.id': '/redfish/v1/TelemetryService' },
  UUID: '00000000-0000-0000-0000-000000000000',
  Vendor: 'Hey API Example',
};

const SYSTEMS_COLLECTION = {
  '@odata.id': '/redfish/v1/Systems',
  '@odata.type': '#ComputerSystemCollection.ComputerSystemCollection',
  Members: [{ '@odata.id': '/redfish/v1/Systems/1' }],
  'Members@odata.count': 1,
  Name: 'Computer System Collection',
};

const CHASSIS_COLLECTION = {
  '@odata.id': '/redfish/v1/Chassis',
  '@odata.type': '#ChassisCollection.ChassisCollection',
  Members: [{ '@odata.id': '/redfish/v1/Chassis/1' }],
  'Members@odata.count': 1,
  Name: 'Chassis Collection',
};

// Mutable in-memory state the reset action edits. A real BMC drives
// the same fields off hardware sensors and D-Bus signals; for the
// mock we keep them in module scope so transitions persist across
// requests and the SSE pusher can see the latest values.
type MockPowerState = 'On' | 'Off' | 'PoweringOn' | 'PoweringOff' | 'Paused';

const mockSystem: { health: string; healthRollup: string; powerState: MockPowerState } = {
  health: 'OK',
  healthRollup: 'OK',
  powerState: 'On',
};

function buildSystem(): Record<string, unknown> {
  return {
    '@odata.id': '/redfish/v1/Systems/1',
    '@odata.type': '#ComputerSystem.v1_22_0.ComputerSystem',
    Actions: {
      '#ComputerSystem.Reset': {
        '@Redfish.ActionInfo': '/redfish/v1/Systems/1/ResetActionInfo',
        target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset',
      },
    },
    AssetTag: 'MOCK-001',
    BiosVersion: '0.0.1-mock',
    Id: '1',
    Manufacturer: 'Hey API Example',
    Model: 'Mock-1',
    Name: 'Mock System',
    PowerState: mockSystem.powerState,
    SerialNumber: 'SN-MOCK-1',
    Status: {
      Health: mockSystem.health,
      HealthRollup: mockSystem.healthRollup,
      State: 'Enabled',
    },
  };
}

const RESET_ACTION_INFO = {
  '@odata.id': '/redfish/v1/Systems/1/ResetActionInfo',
  '@odata.type': '#ActionInfo.v1_3_0.ActionInfo',
  Id: 'ResetActionInfo',
  Name: 'Reset Action Info',
  Parameters: [
    {
      AllowableValues: [
        'On',
        'Off',
        'GracefulShutdown',
        'GracefulRestart',
        'ForceRestart',
        'ForceOff',
        'PowerCycle',
        'Nmi',
        'PushPowerButton',
        'Pause',
      ],
      DataType: 'String',
      Name: 'ResetType',
      Required: true,
    },
  ],
};

function buildAccount(userName: string): Record<string, unknown> {
  return {
    '@odata.id': `/redfish/v1/AccountService/Accounts/${userName}`,
    '@odata.type': '#ManagerAccount.v1_12_0.ManagerAccount',
    Description: `Mock account for ${userName}`,
    Enabled: true,
    Id: userName,
    Locked: false,
    Name: 'User Account',
    RoleId: userName === 'admin' ? 'Administrator' : 'ReadOnly',
    UserName: userName,
  };
}

const TELEMETRY_METRIC_REPORTS_COLLECTION = {
  '@odata.id': '/redfish/v1/TelemetryService/MetricReports',
  '@odata.type': '#MetricReportCollection.MetricReportCollection',
  // Empty by design — `useHealthRollup` falls back to
  // `System.Status.HealthRollup` when no `*HealthMetrics*` report is
  // present, which is what we want for the mock.
  Members: [] as ReadonlyArray<{ '@odata.id': string }>,
  'Members@odata.count': 0,
  Name: 'Metric Report Collection',
};

function json(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(body));
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => {
      data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authHeader(req: IncomingMessage): string | undefined {
  const value = req.headers['x-auth-token'];
  return Array.isArray(value) ? value[0] : value;
}

// Live SSE responses. The reset action handler pushes events to all
// connected clients so the example's invalidation engine can be
// exercised end-to-end against the mock.
const sseClients = new Set<ServerResponse>();

function pushSseEvent(event: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach((res) => res.write(payload));
}

let nextEventId = 1;
function pushPropertyValueModified(value: string): void {
  const id = String(nextEventId++);
  pushSseEvent({
    '@odata.type': '#Event.v1_9_0.Event',
    Events: [
      {
        EventId: id,
        EventTimestamp: new Date().toISOString(),
        EventType: 'Event',
        Message: `The property ResetType was assigned the value '${value}' due to modification by the service.`,
        MessageArgs: ['ResetType', value],
        MessageId: 'Base.1.15.PropertyValueModified',
        MessageSeverity: 'OK',
        OriginOfCondition: {
          '@odata.id': '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset',
        },
      },
    ],
    Id: id,
    Name: 'Event Log',
  });
}

function pushOpenBmcStateInfo(signal: string): void {
  const id = String(nextEventId++);
  pushSseEvent({
    '@odata.type': '#Event.v1_9_0.Event',
    Events: [
      {
        EventId: id,
        EventTimestamp: new Date().toISOString(),
        EventType: 'Event',
        Message: signal,
        MessageId: '',
        MessageSeverity: 'OK',
      },
    ],
    Id: id,
    Name: 'Event Log',
  });
}

/**
 * Apply a reset action to the in-memory state and emit the SSE
 * events a real OpenBMC bmcweb would publish, with one deliberate
 * omission: the `On`-side settle event is *not* published, so the
 * example's `useManagedSystem` polling fallback is what actually
 * drives the icon back to "On" — exactly the bug the polling hack
 * was written to compensate for. The `Off`-side settle event *is*
 * published (real BMCs do this for graceful shutdown completion).
 */
function applyResetAction(resetType: string): void {
  pushPropertyValueModified(resetType);

  switch (resetType) {
    case 'On':
    case 'PushPowerButton':
      mockSystem.powerState = 'PoweringOn';
      // Settle to On after ~3s — but do NOT publish a settle event.
      // Polling in `useManagedSystem` is the only way the icon flips
      // back to On in this scenario. (Mirrors the real BMC quirk.)
      setTimeout(() => {
        if (mockSystem.powerState === 'PoweringOn') mockSystem.powerState = 'On';
      }, 3000);
      break;

    case 'Off':
    case 'GracefulShutdown':
      mockSystem.powerState = 'PoweringOff';
      // Graceful shutdown can take minutes on a real BMC; 6s for the
      // demo. Settle event IS published — exercises the
      // `messagePattern` rule and stops the green pulse animation.
      setTimeout(() => {
        if (mockSystem.powerState === 'PoweringOff') {
          mockSystem.powerState = 'Off';
          pushOpenBmcStateInfo('xyz.openbmc_project.State.Info.ChassisPowerOffFinished');
        }
      }, 6000);
      break;

    case 'ForceOff':
      mockSystem.powerState = 'Off';
      break;

    case 'GracefulRestart':
    case 'ForceRestart':
    case 'PowerCycle':
      mockSystem.powerState = 'PoweringOff';
      setTimeout(() => {
        mockSystem.powerState = 'PoweringOn';
        pushPropertyValueModified('On');
        setTimeout(() => {
          if (mockSystem.powerState === 'PoweringOn') mockSystem.powerState = 'On';
        }, 3000);
      }, 2000);
      break;

    case 'Pause':
      mockSystem.powerState = 'Paused';
      break;

    case 'Nmi':
      // Non-maskable interrupt: state stays whatever it was.
      break;
  }
}

export function mockRedfishPlugin(): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        const method = req.method ?? 'GET';

        if (!url.startsWith('/redfish')) return next();

        // POST /redfish/v1/SessionService/Sessions — login
        if (method === 'POST' && url === '/redfish/v1/SessionService/Sessions') {
          try {
            const body = await parseBody(req);
            const userName = (body.UserName as string) || 'admin';
            const id = crypto.randomBytes(5).toString('hex');
            const token = crypto.randomBytes(16).toString('hex');
            sessions.set(token, { id, userName });
            const location = `/redfish/v1/SessionService/Sessions/${id}`;
            return json(
              res,
              201,
              { '@odata.id': location, Id: id, UserName: userName },
              { Location: location, 'X-Auth-Token': token },
            );
          } catch {
            return json(res, 400, { error: { message: 'Bad request' } });
          }
        }

        // DELETE /redfish/v1/SessionService/Sessions/:id — logout
        if (method === 'DELETE' && url.startsWith('/redfish/v1/SessionService/Sessions/')) {
          const token = authHeader(req);
          if (token) sessions.delete(token);
          res.statusCode = 204;
          return res.end();
        }

        // GET /redfish/v1/SessionService/Sessions — list (auth check)
        if (method === 'GET' && url === '/redfish/v1/SessionService/Sessions') {
          const token = authHeader(req);
          if (!token || !sessions.has(token)) {
            return json(res, 401, { error: { message: 'Unauthorized' } });
          }
          const members = [...sessions.values()].map((s) => ({
            '@odata.id': `/redfish/v1/SessionService/Sessions/${s.id}`,
          }));
          return json(res, 200, {
            '@odata.id': '/redfish/v1/SessionService/Sessions',
            Members: members,
            'Members@odata.count': members.length,
          });
        }

        // POST /redfish/v1/EventService/Actions/EventService.SubmitTestEvent
        //
        // A real Redfish service's `SubmitTestEvent` action republishes
        // the supplied event payload to every connected SSE subscriber
        // — that is the entire point of the action (it lets a client
        // verify the round-trip without waiting for a real hardware
        // condition). The mock does the same so the Live Events panel
        // visibly registers a new entry every time the user clicks
        // "Ping". Defaults keep an empty body shape working too.
        if (
          method === 'POST' &&
          url === '/redfish/v1/EventService/Actions/EventService.SubmitTestEvent'
        ) {
          const body = await parseBody(req).catch(() => ({}));
          const id = String(nextEventId++);
          const eventRecord: Record<string, unknown> = {
            EventId: (body.EventId as string | undefined) ?? id,
            EventTimestamp: (body.EventTimestamp as string | undefined) ?? new Date().toISOString(),
            EventType: (body.EventType as string | undefined) ?? 'Event',
            Message: (body.Message as string | undefined) ?? 'Mock SSE heartbeat',
            MessageArgs: (body.MessageArgs as unknown[] | undefined) ?? [],
            MessageId:
              (body.MessageId as string | undefined) ??
              'HeartbeatEvent.1.1.RedfishServiceFunctional',
            MessageSeverity: (body.Severity as string | undefined) ?? 'OK',
          };
          if (body.OriginOfCondition) {
            eventRecord.OriginOfCondition = body.OriginOfCondition;
          }
          pushSseEvent({
            '@odata.type': '#Event.v1_9_0.Event',
            Events: [eventRecord],
            Id: id,
            Name: 'Event Log',
          });
          res.statusCode = 204;
          return res.end();
        }

        // GET /redfish/v1/EventService/SSE — SSE stream
        if (method === 'GET' && url.startsWith('/redfish/v1/EventService/SSE')) {
          res.writeHead(200, {
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Content-Type': 'text/event-stream',
            'X-Accel-Buffering': 'no',
          });
          res.write(': mock SSE stream connected\n\n');

          sseClients.add(res);

          // Heartbeat keeps the stream warm without invalidating any
          // cache (the engine ignores `HeartbeatEvent.*`). Real BMCs
          // do something similar; the value here is purely "the
          // network panel shows the stream is alive".
          const heartbeat = setInterval(() => {
            const id = String(nextEventId++);
            res.write(
              `data: ${JSON.stringify({
                '@odata.type': '#Event.v1_9_0.Event',
                Events: [
                  {
                    EventId: id,
                    EventTimestamp: new Date().toISOString(),
                    EventType: 'Event',
                    Message: 'Mock SSE heartbeat',
                    MessageId: 'HeartbeatEvent.1.0.RedfishServiceFunctional',
                    MessageSeverity: 'OK',
                  },
                ],
                Id: id,
                Name: 'Event Log',
              })}\n\n`,
            );
          }, 30_000);

          req.on('close', () => {
            clearInterval(heartbeat);
            sseClients.delete(res);
          });
          return;
        }

        // POST /redfish/v1/Systems/1/Actions/ComputerSystem.Reset
        if (method === 'POST' && url === '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset') {
          try {
            const body = await parseBody(req);
            const resetType = (body.ResetType as string) || 'On';
            applyResetAction(resetType);
            res.statusCode = 204;
            return res.end();
          } catch {
            return json(res, 400, { error: { message: 'Bad request' } });
          }
        }

        // Service root
        if (method === 'GET' && (url === '/redfish/v1' || url === '/redfish/v1/')) {
          return json(res, 200, SERVICE_ROOT);
        }

        // System resource + ActionInfo
        if (method === 'GET' && url === '/redfish/v1/Systems/1') {
          return json(res, 200, buildSystem());
        }
        if (method === 'GET' && url === '/redfish/v1/Systems/1/ResetActionInfo') {
          return json(res, 200, RESET_ACTION_INFO);
        }

        // Account by id (UserMenu.RoleId fetch). Treat the path
        // segment as the username; return Administrator for `admin`.
        const accountMatch = url.match(/^\/redfish\/v1\/AccountService\/Accounts\/([^/?]+)$/);
        if (method === 'GET' && accountMatch) {
          return json(res, 200, buildAccount(decodeURIComponent(accountMatch[1])));
        }

        // Telemetry — empty collection so `useHealthRollup` falls
        // through to the System.Status.HealthRollup path.
        if (method === 'GET' && url === '/redfish/v1/TelemetryService/MetricReports') {
          return json(res, 200, TELEMETRY_METRIC_REPORTS_COLLECTION);
        }

        // Collections
        if (method === 'GET' && url === '/redfish/v1/Systems') {
          return json(res, 200, SYSTEMS_COLLECTION);
        }
        if (method === 'GET' && url === '/redfish/v1/Chassis') {
          return json(res, 200, CHASSIS_COLLECTION);
        }

        // Anything else
        return json(res, 404, {
          error: { code: 'Base.1.0.GeneralError', message: `Mock: ${url} not implemented` },
        });
      });
    },
    name: 'mock-redfish',
  };
}
