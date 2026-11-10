// tools/netsize.mjs : loads the game once and reports what the browser had to download to start it.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
const sizes = new Map();
page.on('response', async (r) => {
  try {
    const len = Number(r.headers()['content-length']) || (await r.body()).length;
    sizes.set(new URL(r.url()).pathname, len);
  } catch {}
});
const t0 = Date.now();
await page.goto('http://127.0.0.1:5199/?auto=1');
await page.waitForFunction('window.__ready || window.__error', null, { timeout: 120000 });
const ready = Date.now() - t0;
await page.waitForTimeout(6000);
const groups = {};
let total = 0;
for (const [path, n] of sizes) {
  total += n;
  const g = path.startsWith('/assets/') ? path.split('/').slice(0, 3).join('/') : path.startsWith('/node_modules') ? 'code: libraries' : 'code: game';
  groups[g] = (groups[g] ?? 0) + n;
}
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
console.log(`ready after ${ready} ms locally; ${sizes.size} requests, ${mb(total)}`);
for (const [g, n] of Object.entries(groups).sort((a, b) => b[1] - a[1])) console.log(mb(n).padStart(9), g);
console.log('largest:');
for (const [p, n] of [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(mb(n).padStart(9), p);
await browser.close();
