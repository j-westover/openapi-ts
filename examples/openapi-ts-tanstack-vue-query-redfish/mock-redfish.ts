/**
 * Vite plugin that serves a tiny in-process Redfish mock so the example
 * boots without a real BMC. Activated when `VITE_BMC_URL` is unset (the
 * default local-dev case in `vite.config.ts`).
 *
 * Implements the minimum surface the dashboard exercises:
 *
 *   - GET    /redfish/v1
 *   - GET    /redfish/v1/Systems
 *   - GET    /redfish/v1/Chassis
 *   - GET    /redfish/v1/SessionService/Sessions       (auth check)
 *   - POST   /redfish/v1/SessionService/Sessions       (login)
 *   - DELETE /redfish/v1/SessionService/Sessions/:id   (logout)
 *   - POST   /redfish/v1/EventService/Actions/EventService.SubmitTestEvent
 *   - GET    /redfish/v1/EventService/SSE              (SSE stream)
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
  Chassis: { '@odata.id': '/redfish/v1/Chassis' },
  EventService: { '@odata.id': '/redfish/v1/EventService' },
  Id: 'RootService',
  Name: 'Root Service',
  Product: 'Mock Redfish BMC',
  RedfishVersion: '1.21.0',
  SessionService: { '@odata.id': '/redfish/v1/SessionService' },
  Systems: { '@odata.id': '/redfish/v1/Systems' },
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
        if (
          method === 'POST' &&
          url === '/redfish/v1/EventService/Actions/EventService.SubmitTestEvent'
        ) {
          // Discard the body and ack so the SSE composable's "ping" succeeds.
          await parseBody(req).catch(() => undefined);
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

          const interval = setInterval(() => {
            const event = {
              '@odata.type': '#Event.v1_7_0.Event',
              Events: [
                {
                  EventType: 'StatusChange',
                  Message: `Mock status update at ${new Date().toISOString()}`,
                  MessageId: 'ResourceEvent.1.0.StatusChange',
                  OriginOfCondition: { '@odata.id': '/redfish/v1/Systems/1' },
                },
              ],
            };
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }, 15_000);

          req.on('close', () => clearInterval(interval));
          return;
        }

        // Service root
        if (method === 'GET' && (url === '/redfish/v1' || url === '/redfish/v1/')) {
          return json(res, 200, SERVICE_ROOT);
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
