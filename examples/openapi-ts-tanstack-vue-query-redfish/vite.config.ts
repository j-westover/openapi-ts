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

  // bmcweb routes the SSE endpoint on `Accept: text/event-stream` and
  // returns `404` when it sees `application/json`. We therefore branch
  // on the request URL inside the single `/redfish` proxy: SSE keeps
  // the browser's `Accept`, everything else is forced to JSON. Doing
  // it inside one rule (rather than two ordered rules) is robust
  // against formatter passes reordering object keys.
  const SSE_PATH = '/redfish/v1/EventService/SSE';

  const redfishProxy: ProxyOptions = {
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq, req) => {
        const isSse = req.url?.startsWith(SSE_PATH) ?? false;
        if (isSse) {
          // Keep `Accept: text/event-stream` from the browser; strip
          // `accept-encoding` so bmcweb cannot return a gzipped body
          // that the SSE reader cannot decode chunk-by-chunk.
          proxyReq.removeHeader('accept-encoding');
        } else {
          proxyReq.setHeader('Accept', 'application/json');
        }
      });
      proxy.on('proxyRes', (proxyRes, req, res) => {
        delete proxyRes.headers['strict-transport-security'];
        delete proxyRes.headers['content-encoding'];
        const isSse = req.url?.startsWith(SSE_PATH) ?? false;
        if (isSse) {
          proxyRes.headers['x-accel-buffering'] = 'no';
          proxyRes.headers['cache-control'] = 'no-cache';
          res.socket?.setTimeout(0);
        }
      });
      proxy.on('error', (err, req) => {
        const isSse = req.url?.startsWith(SSE_PATH) ?? false;
        if (isSse) console.error('[vite] SSE proxy error:', err.message);
      });
    },
    proxyTimeout: 0,
    secure: false,
    target: bmcTarget,
    timeout: 0,
  };

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
    server: bmcTarget ? { proxy: { '/redfish': redfishProxy } } : undefined,
  };
});
