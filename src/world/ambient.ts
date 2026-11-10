import * as THREE from 'three/webgpu';
import type { Physics } from '../physics/physics';
import { skyVolume } from '../render/materials';

/**
 * Sky-light bake. Overcast daylight comes from the whole sky, so how bright a
 * surface is depends almost entirely on how much sky it can see. We measure
 * that with rays against the collision world:
 *   - a coarse volume (upward hemisphere) for moving things and for bounce light
 *   - per vertex (hemisphere about the surface normal, plus one bounce) for the
 *     static level, stored in a `sky` vertex attribute.
 */

const FAR = 70;
/** Share of the light arriving at a surface that it scatters back into the room. */
const BOUNCE = 0.38;

/** Cosine-weighted unit hemisphere directions about +Y. */
function hemisphere(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    const phi = i * 2.399963229728653; // golden angle
    const r = Math.sqrt(u);
    out[i * 3] = r * Math.cos(phi);
    out[i * 3 + 1] = Math.sqrt(1 - u);
    out[i * 3 + 2] = r * Math.sin(phi);
  }
  return out;
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

export async function bakeSkyVolume(physics: Physics, rays = 16, onProgress?: (f: number) => void): Promise<void> {
  const v = skyVolume;
  const { x: nx, y: ny, z: nz } = v.dims;
  const cell = new THREE.Vector3(v.size.x / nx, v.size.y / ny, v.size.z / nz);
  const dirs = hemisphere(rays);
  const direct = new Float32Array(nx * ny * nz);
  // A few hit points per voxel, to gather one bounce afterwards.
  const KEEP = 4;
  const hits = new Float32Array(nx * ny * nz * KEEP * 3);
  const hitCount = new Uint8Array(nx * ny * nz);
  const hitTotal = new Uint8Array(nx * ny * nz);
  let last = performance.now();

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = (z * ny + y) * nx + x;
        const ox = v.min.x + (x + 0.5) * cell.x;
        const oy = v.min.y + (y + 0.5) * cell.y;
        const oz = v.min.z + (z + 0.5) * cell.z;
        let open = 0;
        let kept = 0;
        let blocked = 0;
        // Rotate the ray set per voxel so banding does not line up.
        const a = (x * 0.754877 + z * 0.569840 + y * 0.31) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let k = 0; k < rays; k++) {
          const dx = dirs[k * 3] * ca - dirs[k * 3 + 2] * sa;
          const dy = dirs[k * 3 + 1];
          const dz = dirs[k * 3] * sa + dirs[k * 3 + 2] * ca;
          const t = physics.occlusion(ox, oy, oz, dx, dy, dz, FAR);
          if (t < 0) open++;
          else {
            blocked++;
            if (kept < KEEP && k % Math.max(1, Math.floor(rays / KEEP)) === 0) {
              const h = (i * KEEP + kept) * 3;
              hits[h] = ox + dx * (t - 0.3);
              hits[h + 1] = oy + dy * (t - 0.3);
              hits[h + 2] = oz + dz * (t - 0.3);
              kept++;
            }
          }
        }
        direct[i] = open / rays;
        hitCount[i] = kept;
        hitTotal[i] = Math.round((blocked / rays) * 255);
      }
    }
    if (performance.now() - last > 60) {
      onProgress?.((z / nz) * 0.8);
      await yieldToBrowser();
      last = performance.now();
    }
  }

  for (let i = 0; i < direct.length; i++) v.data[i] = Math.round(Math.min(1, direct[i]) * 255);
  // One bounce: light the blocked directions with what their hit points receive from the sky.
  const p = new THREE.Vector3();
  const out = new Uint8Array(direct.length);
  for (let i = 0; i < direct.length; i++) {
    let bounce = 0;
    for (let k = 0; k < hitCount[i]; k++) {
      const h = (i * KEEP + k) * 3;
      bounce += v.sample(p.set(hits[h], hits[h + 1], hits[h + 2]));
    }
    if (hitCount[i] > 0) bounce = (bounce / hitCount[i]) * (hitTotal[i] / 255) * BOUNCE;
    out[i] = Math.round(Math.min(1, direct[i] + bounce) * 255);
  }
  v.data.set(out);
  v.commit();
  onProgress?.(1);
}

/**
 * Bakes the `sky` attribute of a static mesh. If the geometry has a
 * `bakeOrigin` attribute (positions nudged off creases) it is used and removed.
 */
export async function bakeVertexSky(physics: Physics, mesh: THREE.Mesh, rays = 16, only?: THREE.Box3): Promise<void> {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const origin = g.getAttribute('bakeOrigin') ?? null;
  const out = new Float32Array(pos.count);
  const dirs = hemisphere(rays);
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(m);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  const b = new THREE.Vector3();
  const h = new THREE.Vector3();
  let last = performance.now();

  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
    if (origin) p.fromBufferAttribute(origin, i).applyMatrix4(m);
    else p.fromBufferAttribute(pos, i).applyMatrix4(m).addScaledVector(n, 0.08);
    if (only && !only.containsPoint(p)) {
      out[i] = 1;
      continue;
    }
    // Tangent frame about the normal, spun by a per-vertex angle.
    if (Math.abs(n.y) < 0.9) t.set(0, 1, 0).cross(n).normalize();
    else t.set(1, 0, 0).cross(n).normalize();
    b.crossVectors(n, t);
    const a = (i * 0.61803398875) % 1 * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    let light = 0;
    // What the same surface would receive standing in the open; the result is relative to that,
    // because the environment lighting already accounts for which way the surface faces.
    let open = 0;
    for (let k = 0; k < rays; k++) {
      const lx = dirs[k * 3] * ca - dirs[k * 3 + 2] * sa;
      const lz = dirs[k * 3] * sa + dirs[k * 3 + 2] * ca;
      const ly = dirs[k * 3 + 1];
      const dx = t.x * lx + n.x * ly + b.x * lz;
      const dy = t.y * lx + n.y * ly + b.y * lz;
      const dz = t.z * lx + n.z * ly + b.z * lz;
      open += dy > 0 ? 1 : 0.25;
      const d = physics.occlusion(p.x, p.y, p.z, dx, dy, dz, FAR);
      if (d < 0) {
        // Rays below the horizon that escape see the distant ground, not sky.
        light += dy > 0 ? 1 : 0.25;
      } else {
        h.set(p.x + dx * (d - 0.25), p.y + dy * (d - 0.25), p.z + dz * (d - 0.25));
        light += skyVolume.sample(h) * BOUNCE;
      }
    }
    out[i] = Math.min(1, light / open);
    if ((i & 1023) === 0 && performance.now() - last > 60) {
      await yieldToBrowser();
      last = performance.now();
    }
  }
  g.setAttribute('sky', new THREE.BufferAttribute(out, 1));
  if (origin) g.deleteAttribute('bakeOrigin');
}
