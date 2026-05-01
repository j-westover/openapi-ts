import { defineConfig } from '@hey-api/openapi-ts';

import {
  buildOperationName,
  cleanSchemaName,
  patchDanglingSchemaRefs,
  REDFISH_QUERY_PARAMETERS,
  redfishParameterName,
  stampVersionedSchemaDescriptions,
  unlockSessionLoginFields,
} from './scripts/redfish-spec-patch';

/**
 * `@hey-api/openapi-ts` configuration for a Redfish BMC client.
 *
 * The DMTF Redfish spec is huge (thousands of schemas, hundreds of paths),
 * so this config supports two outputs and the `REDFISH_SCOPE` env var picks
 * which to write:
 *
 * | Command                  | `REDFISH_SCOPE` | Output dir          | Tracked? |
 * |--------------------------|-----------------|---------------------|----------|
 * | `pnpm openapi-ts`        | (unset → full)  | `src/client.full/`  | no (ignored) |
 * | `pnpm openapi-ts:scoped` | `scoped`        | `src/client/`       | yes (committed) |
 *
 *  - `src/client.full/` is the dev playground: the entire DMTF surface, so
 *    your IDE, autocomplete, and coding agents see every endpoint and
 *    schema. Run `pnpm openapi-ts` once locally; never commit it.
 *  - `src/client/` is what the app imports (`@/client/...`) and what CI
 *    builds against. It only contains the operations listed in
 *    `SCOPED_OPERATIONS`. Run `pnpm openapi-ts:scoped` whenever you change
 *    the list, then commit.
 *
 * Because the two outputs live at different paths, regenerating one never
 * disturbs the other and CI never has to download the spec.
 */

const SCOPED_OPERATIONS = [
  'GET /redfish/v1',
  'GET /redfish/v1/Systems',
  'GET /redfish/v1/Chassis',
  'GET /redfish/v1/SessionService/Sessions',
  'POST /redfish/v1/SessionService/Sessions',
  'DELETE /redfish/v1/SessionService/Sessions/{SessionId}',
  'POST /redfish/v1/EventService/Actions/EventService.SubmitTestEvent',
  // The SSE stream at `/redfish/v1/EventService/SSE` is not declared in the
  // spec — it is consumed via `client.sse.get(...)`.
] as const;

const isScoped = process.env.REDFISH_SCOPE === 'scoped';

export default defineConfig({
  input:
    process.env.REDFISH_OPENAPI_URL ||
    'https://raw.githubusercontent.com/DMTF/Redfish-Publications/refs/heads/main/openapi/openapi.yaml',
  logs: {
    level: 'info',
  },
  output: {
    // Skip the giant top-level `index.ts` re-export barrel. The app imports
    // from specific paths (`@/client/sdk.gen`, etc.) so the barrel just
    // bloats the committed output for no benefit.
    // Note: `indexFile` is the published-API name; the workspace HEAD calls
    // this `entryFile` but they are aliases for the same option.
    indexFile: false,
    path: isScoped ? 'src/client' : 'src/client.full',
    postProcess: ['oxfmt', 'eslint'],
  },
  parser: {
    ...(isScoped && {
      filters: {
        operations: {
          include: SCOPED_OPERATIONS,
        },
      },
    }),
    patch: {
      input: (spec) => {
        const s = spec as unknown as Record<string, unknown>;
        patchDanglingSchemaRefs(s);
        stampVersionedSchemaDescriptions(s);
        unlockSessionLoginFields(s);
        injectRedfishQueryParameters(s);
        s.servers = [{ url: '' }];
      },
      operations: (method, path, operation) => {
        if (!operation.operationId) {
          operation.operationId = method + buildOperationName(path);
        }
      },
    },
    transforms: {
      schemaName: cleanSchemaName,
    },
  },
  plugins: [
    '@hey-api/client-axios',
    // `@hey-api/schemas` is intentionally omitted — it would emit a
    // `schemas.gen.ts` runtime registry (~8 MB unfiltered) and the example
    // does not use it. Add it back if you need runtime JSON Schemas.
    '@hey-api/sdk',
    {
      enums: 'javascript',
      name: '@hey-api/typescript',
    },
    '@tanstack/vue-query',
  ],
});

function injectRedfishQueryParameters(spec: Record<string, unknown>): void {
  const components = (spec.components ??= {}) as Record<string, unknown>;
  const parameters = (components.parameters ??= {}) as Record<string, unknown>;
  const paths = (spec.paths ??= {}) as Record<string, unknown>;

  for (const rp of REDFISH_QUERY_PARAMETERS) {
    parameters[redfishParameterName(rp.key)] = {
      description: rp.description,
      in: 'query',
      name: rp.key,
      required: false,
      schema: rp.schema ?? { type: 'string' },
    };
  }

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathKey.startsWith('/redfish/v1') || pathKey.includes('$metadata')) continue;
    if (!pathItem || typeof pathItem !== 'object') continue;
    const getOp = (pathItem as Record<string, unknown>).get as
      | { parameters?: Array<Record<string, unknown>> }
      | undefined;
    if (!getOp) continue;
    getOp.parameters ??= [];

    for (const rp of REDFISH_QUERY_PARAMETERS) {
      const componentName = redfishParameterName(rp.key);
      const exists = getOp.parameters.some(
        (p) =>
          (p?.in === 'query' && p?.name === rp.key) ||
          (typeof p?.$ref === 'string' && (p.$ref as string).endsWith(`/${componentName}`)),
      );
      if (!exists) {
        getOp.parameters.push({ $ref: `#/components/parameters/${componentName}` });
      }
    }
  }
}
