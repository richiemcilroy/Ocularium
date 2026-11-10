// Converts the raw Poly Haven downloads into runtime assets under public/assets:
//   - tiling materials  -> KTX2 (ETC1S for albedo/ARM, UASTC for normals), mipmapped
//   - models            -> GLB with KTX2 textures (KHR_texture_basisu), heavy scans simplified
//   - skies             -> copied .hdr
// Idempotent: outputs newer than their inputs are skipped. Requires `basisu` and `ffmpeg` on PATH.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { weld, simplify, dedup, prune, listTextureSlots } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { RAW_DIR, textures, models, hdris } from './manifest.mjs';

const run = promisify(execFile);
const OUT = path.resolve(import.meta.dirname, '../public/assets');
const TMP = fs.mkdtempSync(path.join(process.env.OCULARIUM_TMP || os.tmpdir(), 'oc-build-'));
const FORCE = process.argv.includes('--force');

/** Triangle budgets for scans that are far denser than a game needs. */
const TRI_BUDGET = {
  boulder_01: 12000,
  dead_tree_trunk: 20000,
  rock_moss_set_01: 20000,
  spinning_wheel_01: 20000,
  treasure_chest: 26000,
  tree_stump_01: 12000,
  wicker_basket_01: 10000,
  wooden_bowl_01: 4000,
  wooden_stool_01: 5000,
  wooden_stool_02: 5000,
  wooden_candlestick: 8000,
  shrub_01: 60000,
};

const fresh = (out, ...inputs) =>
  !FORCE && fs.existsSync(out) && inputs.every((i) => fs.statSync(out).mtimeMs >= fs.statSync(i).mtimeMs);

/** kind: 'color' (sRGB, ETC1S) | 'data' (linear, ETC1S) | 'normal' (linear, UASTC) */
async function encode(input, output, kind, { flipY = false } = {}) {
  const args = ['-ktx2', '-mipmap', '-file', input, '-output_file', output];
  if (flipY) args.push('-y_flip');
  if (kind === 'normal') args.push('-uastc', '-uastc_level', '1', '-uastc_rdo_l', '1.5', '-normal_map');
  else if (kind === 'data') args.push('-q', '220', '-linear');
  else args.push('-q', '235');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run('basisu', args, { maxBuffer: 1 << 26 });
  if (!fs.existsSync(output)) throw new Error('basisu produced no output for ' + input);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

async function buildTexture(id) {
  const src = path.join(RAW_DIR, 'textures', id);
  const dst = path.join(OUT, 'tex', id);
  const find = (k) => ['jpg', 'png'].map((e) => path.join(src, `${k}.${e}`)).find((f) => fs.existsSync(f));
  const jobs = [
    ['diff', 'color'],
    ['nor', 'normal'],
    ['arm', 'data'],
  ];
  for (const [k, kind] of jobs) {
    const input = find(k);
    if (!input) continue;
    const out = path.join(dst, `${k}.ktx2`);
    // Standalone textures are flipped so they match three's default UV convention.
    if (!fresh(out, input)) await encode(input, out, kind, { flipY: true });
  }
  const disp = find('disp');
  if (disp) {
    // Height is only used for parallax, so 1K 8-bit greyscale is plenty.
    const out = path.join(dst, 'disp.ktx2');
    if (!fresh(out, disp)) {
      const grey = path.join(TMP, `${id}_disp.png`);
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', disp, '-vf', 'scale=1024:1024:flags=area,format=gray', grey]);
      await encode(grey, out, 'data', { flipY: true });
    }
  }
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const stats = [];

async function buildModel(id) {
  const input = path.join(RAW_DIR, 'models', id, `${id}.gltf`);
  const out = path.join(OUT, 'models', `${id}.glb`);
  if (fresh(out, input)) return;
  const doc = await io.read(input);
  const root = doc.getRoot();

  const countTris = () =>
    root.listMeshes().reduce((n, m) => n + m.listPrimitives().reduce((k, p) => k + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0), 0);
  const before = countTris();
  const budget = TRI_BUDGET[id];
  if (budget && before > budget) {
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: budget / before, error: 0.01 }));
  }

  for (const tex of root.listTextures()) {
    const slots = listTextureSlots(tex);
    const kind = slots.includes('normalTexture') ? 'normal' : slots.includes('baseColorTexture') || slots.includes('emissiveTexture') ? 'color' : 'data';
    const ext = tex.getMimeType() === 'image/png' ? 'png' : 'jpg';
    const tmpIn = path.join(TMP, `${id}_${root.listTextures().indexOf(tex)}.${ext}`);
    const tmpOut = tmpIn.replace(/\.\w+$/, '.ktx2');
    fs.writeFileSync(tmpIn, tex.getImage());
    await encode(tmpIn, tmpOut, kind);
    tex.setImage(fs.readFileSync(tmpOut)).setMimeType('image/ktx2');
    fs.rmSync(tmpIn);
    fs.rmSync(tmpOut);
  }
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  await doc.transform(dedup(), prune());
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await io.write(out, doc);
  stats.push(`${id.padEnd(26)} tris ${String(Math.round(before)).padStart(7)} -> ${String(Math.round(countTris())).padStart(7)}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
}

function buildHdri(id) {
  const input = path.join(RAW_DIR, 'hdris', `${id}.hdr`);
  const out = path.join(OUT, 'sky', `${id}.hdr`);
  if (fresh(out, input)) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(input, out);
}

function writeCredits() {
  const src = path.join(RAW_DIR, 'credits.json');
  if (!fs.existsSync(src)) return;
  const list = JSON.parse(fs.readFileSync(src, 'utf8'));
  const lines = [
    '# Asset credits',
    '',
    'Environment textures, models and skies are from [Poly Haven](https://polyhaven.com), released under CC0.',
    '',
    ...list.map((a) => `- ${a.name} (\`${a.id}\`) by ${a.authors.join(', ') || 'Poly Haven'}`),
    '',
  ];
  fs.writeFileSync(path.join(OUT, 'CREDITS.md'), lines.join('\n'));
}

await MeshoptSimplifier.ready;
const t0 = Date.now();
await pool(Object.keys(textures), 4, buildTexture);
console.log(`materials done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await pool(Object.keys(models), 3, buildModel);
Object.keys(hdris).forEach(buildHdri);
writeCredits();
fs.rmSync(TMP, { recursive: true, force: true });
if (stats.length) console.log(stats.sort().join('\n'));
console.log(`all done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
