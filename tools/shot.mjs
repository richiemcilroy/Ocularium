// Loads the game in Chrome via Playwright, waits for it to be ready, and saves screenshots.
//   node tools/shot.mjs <name> "<query string>" [--wait ms] [--eval "js"] [--perf] [--size WxH] [--uncapped]
// Screenshots go to tools/out/<name>.png. Prints frame statistics and any console errors.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const name = args[0] || 'shot';
const query = args[1] || '';
const opt = (flag, d) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : d;
};
const has = (flag) => args.includes(flag);
const wait = Number(opt('--wait', 2500));
const [w, h] = opt('--size', '1920x1080').split('x').map(Number);
const outDir = path.resolve(import.meta.dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const launchArgs = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', `--window-size=${w},${h}`];
if (has('--uncapped')) launchArgs.push('--disable-frame-rate-limit', '--disable-gpu-vsync');

const browser = await chromium.launch({ channel: 'chrome', headless: !has('--headed'), args: launchArgs });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

const url = `${process.env.OCULARIUM_URL ?? "http://127.0.0.1:5199"}/?${query}`;
await page.goto(url, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 90000 });
} catch {
  errors.push('timeout waiting for ready');
}
const bootError = await page.evaluate(() => window.__error || null);
if (bootError) errors.push('BOOT ERROR: ' + bootError);

await page.waitForTimeout(wait);
const js = opt('--eval', null);
if (js) {
  const r = await page.evaluate(js);
  if (r !== undefined) console.log('eval:', JSON.stringify(r));
  await page.waitForTimeout(Number(opt('--settle', 600)));
}
if (has('--perf')) {
  await page.evaluate(() => window.__game?.stats?.reset?.());
  await page.waitForTimeout(Number(opt('--perf-ms', 4000)));
}
const stats = await page.evaluate(() => window.__stats || null);
await page.screenshot({ path: path.join(outDir, `${name}.png`) });
console.log('stats:', JSON.stringify(stats));
const unique = [...new Set(errors)];
if (unique.length) console.log('console:\n  ' + unique.slice(0, 25).join('\n  '));
await browser.close();
