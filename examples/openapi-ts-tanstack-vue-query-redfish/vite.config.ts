import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import type { ProxyOptions, UserConfig } from 'vite';
import vueDevTools from 'vite-plugin-vue-devtools';

import { mockRedfishPlugin } from './mock-redfish';

/**
 * If `VITE_BMC_URL` is set, requests to `/redfish` are proxied to the BMC
 * (with HSTS / content-encoding tweaks for SSE compatibility). Otherwise we
 * use the in-process mock plugin so the example boots out of the box.
 */
const bmcTarget = process.env.VITE_BMC_URL;

const config: UserConfig = {
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
          // Standard JSON traffic.
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

          // SSE: keep the connection open, disable buffering / encoding.
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

export default config;
