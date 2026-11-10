// Records the camera frame by frame while a scripted run plays, and reports how smoothly it moved.
//   node tools/trace.mjs <name> "<query string>" '<steps json>' [--size WxH] [--shots t0,t1,...]
// Steps: [{ "t": ms, "down": ["KeyW"], "up": ["KeyW"], "look": [dxPixels, dyPixels], "js": "expression run in the page" }, ..., { "t": ms }]
// The last step's `t` ends the run. Writes tools/out/<name>.csv and prints the worst frame-to-frame steps.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const name = args[0] || 'trace';
const query = args[1] || 'auto=1';
const steps = JSON.parse(args[2] || '[{"t":0,"down":["KeyW"]},{"t":4000}]');
const opt = (flag, d) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : d;
};
const [w, h] = opt('--size', '960x540').split('x').map(Number);
const shots = opt('--shots', '').split(',').filter(Boolean).map(Number);
const outDir = path.resolve(import.meta.dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', `--window-size=${w},${h}`],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await page.goto(`${process.env.OCULARIUM_URL ?? 'http://127.0.0.1:5199'}/?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 90000 });
const bootError = await page.evaluate(() => window.__error || null);
if (bootError) {
  console.log('BOOT ERROR: ' + bootError);
  await browser.close();
  process.exit(1);
}
// Let shaders compile and the first slow frames pass before anything is measured.
await page.waitForTimeout(Number(opt('--wait', 3500)));

await page.evaluate((steps) => {
  const g = window.__game;
  const rows = (window.__trace = []);
  const e = { x: 0, y: 0, z: 0 };
  const start = performance.now();
  let next = 0;
  const end = steps[steps.length - 1].t;
  window.__traceDone = false;
  const tick = () => {
    const t = performance.now() - start;
    while (next < steps.length && steps[next].t <= t) {
      const s = steps[next++];
      if (s.down || s.up || s.look) g.input.inject({ keysDown: s.down, keysUp: s.up, look: s.look });
      if (s.js) (0, eval)(s.js);
    }
    const p = g.player, c = g.camera;
    // Camera orientation as yaw, pitch, roll.
    const q = c.quaternion;
    const sinp = 2 * (q.w * q.x - q.y * q.z);
    e.x = Math.asin(Math.max(-1, Math.min(1, sinp)));
    e.y = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
    e.z = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.x * q.x + q.z * q.z));
    rows.push([t, c.position.x, c.position.y, c.position.z, e.x, e.y, e.z, p.position.y, p.grounded ? 1 : 0, p.speed, g.body?.figure.sink ?? 0, p.stamina, p.exertion, p.health ?? 0]);
    if (t < end) requestAnimationFrame(tick);
    else window.__traceDone = true;
  };
  requestAnimationFrame(tick);
}, steps);

const began = Date.now();
for (const at of shots) {
  await page.waitForTimeout(Math.max(0, at - (Date.now() - began)));
  await page.screenshot({ path: path.join(outDir, `${name}_${at}.png`) });
}
await page.waitForFunction(() => window.__traceDone, null, { timeout: steps[steps.length - 1].t + 60000 });
const rows = await page.evaluate(() => window.__trace);
const extra = opt('--eval', null);
if (extra) console.log('eval:', JSON.stringify(await page.evaluate(extra)));
await browser.close();

fs.writeFileSync(path.join(outDir, `${name}.csv`), 't,x,y,z,pitch,yaw,roll,feetY,grounded,speed,sink,stamina,exertion,health\n' + rows.map((r) => r.map((v) => +v.toFixed(5)).join(',')).join('\n'));

// The camera sits on a body moving over ground. What is left once the ground's own rise and fall is
// taken out is what the wearer adds; it should be small and it should never step.
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const stat = { frames: rows.length, flips: 0 };
const series = { eyeY: [], rel: [], pitch: [], yaw: [], roll: [], feet: [] };
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  const dt = Math.max(1e-3, (b[0] - a[0]) / 1000);
  series.eyeY.push((b[2] - a[2]) / dt);
  series.rel.push((b[2] - b[7] - (a[2] - a[7])) / dt);
  series.feet.push((b[7] - a[7]) / dt);
  series.pitch.push(wrap(b[4] - a[4]) / dt);
  series.yaw.push(wrap(b[5] - a[5]) / dt);
  series.roll.push(wrap(b[6] - a[6]) / dt);
  if (a[8] !== b[8]) stat.flips++;
}
const describe = (v) => {
  // Rate of change, and how hard that rate itself changes from one frame to the next (the jolt).
  let peak = 0, jolt = 0, at = 0, sum = 0;
  for (let i = 0; i < v.length; i++) {
    peak = Math.max(peak, Math.abs(v[i]));
    if (i > 0) {
      const j = Math.abs(v[i] - v[i - 1]);
      sum += j * j;
      if (j > jolt) (jolt = j), (at = i);
    }
  }
  return { peak: +peak.toFixed(3), jolt: +jolt.toFixed(3), joltRms: +Math.sqrt(sum / Math.max(1, v.length - 1)).toFixed(4), atMs: Math.round(rows[at + 1]?.[0] ?? 0) };
};
const last = rows[rows.length - 1];
console.log(
  JSON.stringify(
    {
      ...stat,
      eyeY: describe(series.eyeY),
      eyeAboveFeet: describe(series.rel),
      feetY: describe(series.feet),
      pitch: describe(series.pitch),
      yaw: describe(series.yaw),
      roll: describe(series.roll),
      end: { x: +last[1].toFixed(2), y: +last[2].toFixed(2), z: +last[3].toFixed(2), speed: +last[9].toFixed(2), stamina: +last[11].toFixed(2), exertion: +last[12].toFixed(2), health: +last[13].toFixed(0) },
    },
    null,
    0,
  ),
);
if (errors.length) console.log('console:\n  ' + [...new Set(errors)].slice(0, 12).join('\n  '));
