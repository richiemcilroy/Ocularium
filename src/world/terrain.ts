import * as THREE from 'three/webgpu';
import type { SurfaceKind } from './builder';

/**
 * Shape and surfacing of the land around the castle. Everything here is a
 * pure function of position so the mesh, the physics collider, footstep
 * sounds and prop scatter all agree.
 */

/** Outer line of the curtain wall. */
export const WARD = { x: 22.23, z: 14.82, thick: 2.55 };
/** Centre of the gate passage on the south wall. */
export const GATE_X = 3.705;

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise, -1..1. */
export function noise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

export function fbm(x: number, y: number, octaves: number): number {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * f + i * 17.3, y * f - i * 9.1) * amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum;
}

/** Deterministic random stream. */
export function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The cart track leaves the gate and wanders south. */
export function roadX(z: number): number {
  return GATE_X + 3.4 * Math.sin(Math.max(0, z - 17) / 23);
}

function wild(x: number, z: number): number {
  const d = Math.hypot(x, z - 5);
  const hills = Math.pow(smooth(46, 104, d), 1.3) * (11 + 7 * noise(x * 0.013 + 3.1, z * 0.013));
  return fbm(x * 0.017, z * 0.017, 3) * 3.2 + fbm(x * 0.075 + 9, z * 0.075, 2) * 0.55 + hills;
}

/** Ground height in metres. The ward and a skirt around it are level. */
export function heightAt(x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x) - 26.5);
  const dz = Math.max(0, z > 0 ? z - 19.5 : -z - 18.5);
  const open = smooth(0, 16, Math.hypot(dx, dz));
  if (open <= 0) return 0;
  let h = wild(x, z);
  if (z > 14) {
    // The track is worn level across its width and sits a little below the verge.
    const rx = roadX(z);
    const along = wild(rx, z) - 0.12;
    h = along + (h - along) * smooth(1.6, 7, Math.abs(x - rx));
  }
  return h * open;
}

function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax, vz = bz - az;
  const t = Math.min(1, Math.max(0, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(px - ax - vx * t, pz - az - vz * t);
}

/** Paved route from the gate across the yard to the hall door. */
const PAVED: Array<[number, number]> = [
  [GATE_X, 18.5],
  [GATE_X, 9],
  [1.4, 3.6],
  [-7, 2.5],
  [-11.5, 2.5],
];

export interface Paint {
  cobble: number;
  grass: number;
  wet: number;
}

export function paintAt(x: number, z: number, out: Paint): Paint {
  let d = Infinity;
  for (let i = 0; i + 1 < PAVED.length; i++) d = Math.min(d, segmentDistance(x, z, PAVED[i][0], PAVED[i][1], PAVED[i + 1][0], PAVED[i + 1][1]));
  let cobble = 1 - smooth(1.25, 2.5, d);
  // Apron in front of the hall door, and a hard standing round the cooking fire.
  const ax = Math.max(0, -11.6 - x, x + 9.0), az = Math.max(0, 0.6 - z, z - 4.4);
  cobble = Math.max(cobble, 1 - smooth(0, 1.1, Math.hypot(ax, az)));
  cobble = Math.max(cobble, 1 - smooth(1.5, 2.5, Math.hypot(x - 1.5, z - 1)));

  const outside = Math.abs(x) > WARD.x - 0.5 || Math.abs(z) > WARD.z - 0.5;
  let grass: number;
  let wet: number;
  if (outside) {
    const track = z > WARD.z ? smooth(2.2, 5.5, Math.abs(x - roadX(z))) : 1;
    grass = track;
    wet = 1 - track * 0.8;
  } else {
    // Weeds find the foot of the walls where nobody walks.
    const wall = Math.min(WARD.x - WARD.thick - Math.abs(x), WARD.z - WARD.thick - Math.abs(z));
    grass = 0.8 * (1 - smooth(0.2, 1.7, wall)) * (1 - cobble);
    wet = 1;
  }
  out.cobble = cobble;
  out.grass = grass * (1 - cobble);
  out.wet = wet;
  return out;
}

const scratch: Paint = { cobble: 0, grass: 0, wet: 0 };

/** What is underfoot on open ground. */
export function groundSurfaceAt(x: number, z: number): SurfaceKind {
  const p = paintAt(x, z, scratch);
  if (p.cobble > 0.55) return 'stone';
  if (p.grass > 0.55) return 'grass';
  return 'dirt';
}

/** The ground mesh: positions, normals, paint colours and an (unbaked) sky attribute. */
export function buildGroundGeometry(): THREE.BufferGeometry {
  const x0 = -110, x1 = 110, z0 = -100, z1 = 120;
  const nx = x1 - x0, nz = z1 - z0;
  const positions = new Float32Array((nx + 1) * (nz + 1) * 3);
  const colors = new Float32Array((nx + 1) * (nz + 1) * 3);
  const sky = new Float32Array((nx + 1) * (nz + 1)).fill(1);
  const paint: Paint = { cobble: 0, grass: 0, wet: 0 };
  let k = 0;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++, k++) {
      const x = x0 + i, z = z0 + j;
      positions[k * 3] = x;
      positions[k * 3 + 1] = heightAt(x, z);
      positions[k * 3 + 2] = z;
      paintAt(x, z, paint);
      colors[k * 3] = paint.cobble;
      colors[k * 3 + 1] = paint.grass;
      colors[k * 3 + 2] = paint.wet;
    }
  }
  const indices = new Uint32Array(nx * nz * 6);
  let q = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      indices[q++] = a; indices[q++] = c; indices[q++] = b;
      indices[q++] = b; indices[q++] = c; indices[q++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('sky', new THREE.BufferAttribute(sky, 1));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  return g;
}
