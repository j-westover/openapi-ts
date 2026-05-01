import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import vueDevTools from 'vite-plugin-vue-devtools';

import { mockRedfishPlugin } from './mock-redfish';

/**
 * If `VITE_BMC_URL` is set, requests to `/redfish` are proxied to the BMC
 * (with HSTS / content-encoding tweaks for SSE compatibility). Otherwise
 * we use the in-process mock plugin so the example boots out of the box.
 *
 * `loadEnv` reads from `.env`, `.env.local`, `.env.[mode]`, and
 * `.env.[mode].local` so the BMC URL can come from a gitignored
 * `.env.development.local` instead of a shell variable.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const bmcTarget = env.VITE_BMC_URL || process.env.VITE_BMC_URL;

  return {
    build: {
      sourcemap: true,
      target: 'esnext',
    },
    esbuild: {
      target: 'esnext',
    },
    optimizeDeps: {
      esbuildOptions: {
        target: 'esnext',
      },
    },
    plugins: [vue(), vueJsx(), vueDevTools(), bmcTarget ? null : mockRedfishPlugin()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: bmcTarget
      ? {
          proxy: {
            
            
            
            
            
            
            
            // Standard JSON traffic for everything else under
// `/redfish/...`.
'/redfish': {
              changeOrigin: true,
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq) => {
                  proxyReq.setHeader('Accept', 'application/json');
                });
                proxy.on('proxyRes', (proxyRes) => {
                  delete proxyRes.headers['strict-transport-security'];
                  delete proxyRes.headers['content-encoding'];
                });
              },
              secure: false,
              target: bmcTarget,
            } satisfies ProxyOptions,

            
            
            // SSE: keep the connection open, disable buffering /
// encoding, leave the browser's `Accept: text/event-stream`
// header alone (bmcweb routes on it and 404s otherwise).
//
// Declared *before* the `/redfish` rule so vite's proxy
// matcher cannot accidentally route SSE through the JSON
// rule and clobber `Accept` to `application/json`.
'/redfish/v1/EventService/SSE': {
              changeOrigin: true,
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq) => {
                  proxyReq.removeHeader('accept-encoding');
                });
                proxy.on('proxyRes', (proxyRes, _req, res) => {
                  delete proxyRes.headers['strict-transport-security'];
                  delete proxyRes.headers['content-encoding'];
                  proxyRes.headers['x-accel-buffering'] = 'no';
                  proxyRes.headers['cache-control'] = 'no-cache';
                  res.socket?.setTimeout(0);
                });
                proxy.on('error', (err) => {
                  console.error('[vite] SSE proxy error:', err.message);
                });
              },
              proxyTimeout: 0,
              secure: false,
              target: bmcTarget,
              timeout: 0,
            } satisfies ProxyOptions,
          },
        }
      : undefined,
  };
});
