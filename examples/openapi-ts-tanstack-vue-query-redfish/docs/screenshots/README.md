# Screenshots

Captured against an NVIDIA HGX BMC running real OpenBMC bmcweb at the
time of capture (the example boots equally well against the in-process
mock — see the project README's _Getting started_ section).

| File                 | What it shows                                                                     |
| -------------------- | --------------------------------------------------------------------------------- |
| `login.png`          | The unauthenticated login screen.                                                 |
| `dashboard.png`      | The main dashboard at rest — header, Service Root, Systems, Chassis, Live Events. |
| `health-tooltip.png` | Per-component health grid (`TelemetryService/MetricReports` fallback).            |
| `power-dropdown.png` | Power menu with `ActionInfo`-gated `AllowableValues`.                             |
| `power-cycle.gif`    | Animated `On → PoweringOff → Off → PoweringOn → On` (captured against the mock).  |

## Regenerating

The capture script is not committed — it has heavyweight one-time
dependencies (Playwright + Chromium) that do not belong in the
example's `package.json`. To refresh these screenshots:

```bash
# 1. Start the example's dev server (mock mode is fine, no real BMC
#    is required for the four read-only shots above).
cd examples/openapi-ts-tanstack-vue-query-redfish
pnpm dev

# 2. From a scratch directory, install Playwright once.
mkdir /tmp/redfish-capture && cd /tmp/redfish-capture
npm init -y >/dev/null
npm install --no-save playwright
npx playwright install chromium

# 3. Run the capture (mock-mode credentials are anything; pass real
#    creds via `REDFISH_USER` / `REDFISH_PASS` if pointed at a BMC).
cat > capture.mjs <<'EOF'
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const USERNAME = process.env.REDFISH_USER ?? 'admin';
const PASSWORD = process.env.REDFISH_PASS ?? 'demo';
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { height: 760, width: 1280 },
});
const page = await context.newPage();
await page.goto(BASE);

await page.waitForSelector('#username');
await page.screenshot({ path: join(OUT, 'login.png') });
await page.fill('#username', USERNAME);
await page.fill('#password', PASSWORD);
await page.click('button[type=submit]');

await page.waitForSelector('header', { timeout: 60_000 });
await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, 'dashboard.png') });

await page.locator('button[aria-label="System health"]').hover();
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'health-tooltip.png') });

await page.locator('main').hover({ position: { x: 100, y: 200 } });
await page.waitForTimeout(200);
await page.locator('button[title^="Power:"]').click();
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, 'power-dropdown.png') });

await browser.close();
EOF
node capture.mjs

# 4. Copy the artifacts back over the committed copies.
cp out/*.png \
  $OLDPWD/examples/openapi-ts-tanstack-vue-query-redfish/docs/screenshots/
```

The script is intentionally read-only: it logs in, hovers over the
Health badge, and opens (but does not click into) the Power dropdown.
No action button is ever invoked, so it is safe to point at production
hardware.

## Power-cycle demo (mock-mode only)

`power-cycle.gif` is captured against the in-process mock — the
script clicks `Graceful Shutdown` and `Power On` in sequence, which
is **destructive on real hardware**. To regenerate:

1. Disable `VITE_BMC_URL` in `.env.development.local` (or unset it)
   so the mock plugin takes over.
2. Restart the dev server (`pnpm dev:fresh`).
3. Run a capture script in the same scratch directory as the
   read-only one above. The reference implementation walks the
   header strip through five visible states (`On`, `PoweringOff`
   pulse, `Off`, `PoweringOn` blink, back to `On`), captures
   ~16 frames at 600–700 ms intervals, and assembles them into a
   GIF via `gif-encoder-2` — no `ffmpeg` required:

```bash
# In the same /tmp/redfish-capture working dir as above:
npm install --no-save gif-encoder-2 pngjs
node capture-demo.mjs   # drives Graceful Shutdown + Power On
cp out/demo.gif $OLDPWD/.../docs/screenshots/power-cycle.gif
```

The full `capture-demo.mjs` is intentionally kept out of the example's
`package.json` (heavyweight Playwright + pure-JS GIF encoder
dependencies that are never needed at runtime). Everything it does
exercises the same mock surface the unit tests cover.
