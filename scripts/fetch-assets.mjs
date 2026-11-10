// Downloads the raw Poly Haven assets listed in manifest.mjs into RAW_DIR.
// Idempotent: files already present with the expected size are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { RAW_DIR, textures, models, hdris } from './manifest.mjs';

const UA = { 'User-Agent': 'Ocularium-dev/0.1 (asset fetch)' };
const API = 'https://api.polyhaven.com';

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
  }
  throw new Error('failed: ' + url);
}

async function download(url, dest, size) {
  if (fs.existsSync(dest) && (!size || fs.statSync(dest).size === size)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error('http ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dest + '.part', buf);
      fs.renameSync(dest + '.part', dest);
      return true;
    } catch (e) {
      if (attempt === 3) throw new Error(`download failed ${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
    }
  }
}

async function pool(items, n, fn) {
  let i = 0;
  const out = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const pick = (entry, res, exts) => {
  if (!entry) return null;
  const r = entry[res] || entry['2k'] || entry['1k'];
  if (!r) return null;
  for (const e of exts) if (r[e]) return { ...r[e], ext: e };
  return null;
};

const report = { textures: {}, models: {}, hdris: {}, missing: [] };
let bytes = 0;

async function fetchTexture([id, cfg]) {
  const files = await getJson(`${API}/files/${id}`);
  if (!files) return report.missing.push('texture ' + id);
  const want = {
    diff: pick(files.Diffuse || files.diffuse, cfg.res, ['jpg', 'png']),
    nor: pick(files.nor_gl, cfg.res, ['jpg', 'png']),
    arm: pick(files.arm, cfg.res, ['jpg', 'png']),
  };
  if (cfg.disp) want.disp = pick(files.Displacement, cfg.res, ['png', 'jpg']);
  const got = {};
  for (const [k, f] of Object.entries(want)) {
    if (!f) continue;
    const dest = path.join(RAW_DIR, 'textures', id, `${k}.${f.ext}`);
    await download(f.url, dest, f.size);
    bytes += f.size;
    got[k] = path.basename(dest);
  }
  if (!got.diff || !got.nor) report.missing.push(`texture ${id} maps: ${Object.keys(got)}`);
  report.textures[id] = got;
}

async function fetchModel([id, cfg]) {
  const files = await getJson(`${API}/files/${id}`);
  const g = files && files.gltf && (files.gltf[cfg.res] || files.gltf['1k']);
  if (!g || !g.gltf) return report.missing.push('model ' + id);
  const dir = path.join(RAW_DIR, 'models', id);
  const main = g.gltf;
  await download(main.url, path.join(dir, `${id}.gltf`), main.size);
  bytes += main.size;
  for (const [rel, f] of Object.entries(main.include || {})) {
    await download(f.url, path.join(dir, rel), f.size);
    bytes += f.size;
  }
  report.models[id] = Object.keys(main.include || {}).length + 1;
}

async function fetchHdri([id, cfg]) {
  const files = await getJson(`${API}/files/${id}`);
  const f = pick(files && files.hdri, cfg.res, ['hdr']);
  if (!f) return report.missing.push('hdri ' + id);
  await download(f.url, path.join(RAW_DIR, 'hdris', `${id}.hdr`), f.size);
  bytes += f.size;
  report.hdris[id] = f.size;
}

// Credits come straight from the API so the in-game credits file stays accurate.
async function fetchCredits() {
  const ids = [...Object.keys(textures), ...Object.keys(models), ...Object.keys(hdris)];
  const infos = await pool(ids, 6, async (id) => {
    const info = await getJson(`${API}/info/${id}`);
    return { id, name: info?.name ?? id, authors: Object.keys(info?.authors ?? {}) };
  });
  fs.writeFileSync(path.join(RAW_DIR, 'credits.json'), JSON.stringify(infos, null, 1));
}

fs.mkdirSync(RAW_DIR, { recursive: true });
await pool(Object.entries(textures), 5, fetchTexture);
await pool(Object.entries(models), 4, fetchModel);
await pool(Object.entries(hdris), 2, fetchHdri);
await fetchCredits();

console.log(`textures: ${Object.keys(report.textures).length}  models: ${Object.keys(report.models).length}  hdris: ${Object.keys(report.hdris).length}`);
console.log(`total source size: ${(bytes / 1048576).toFixed(0)} MB in ${RAW_DIR}`);
if (report.missing.length) console.log('MISSING:\n  ' + report.missing.join('\n  '));
