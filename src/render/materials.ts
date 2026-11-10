import * as THREE from 'three/webgpu';
import { T, type N } from './tsl';
import type { SurfaceMaps } from '../core/assets';

const {
  abs,
  attribute,
  cameraViewMatrix,
  clamp,
  float,
  materialAO,
  max,
  mix,
  mx_noise_float,
  normalWorldGeometry,
  normalize,
  positionWorld,
  pow,
  sign,
  smoothstep,
  texture,
  texture3D,
  transformDirection,
  uniform,
  vec2,
  vec3,
  vertexColor,
} = T;

/**
 * How much of the sky each point in the level can see, stored in a coarse 3D
 * texture. Every material multiplies its ambient light by this, which is what
 * makes interiors dark and doorways glow instead of everything being lit as
 * if it stood in an open field.
 */
export class SkyVolume {
  texture: THREE.Data3DTexture;
  data: Uint8Array;
  readonly min = new THREE.Vector3();
  readonly size = new THREE.Vector3(1, 1, 1);
  readonly dims = new THREE.Vector3(1, 1, 1);
  private uMin = uniform(new THREE.Vector3());
  private uInvSize = uniform(new THREE.Vector3(1, 1, 1));
  private texNode: N;
  /** Ambient occlusion factor at the shaded point, 0..1. */
  readonly node: N;

  constructor() {
    this.data = new Uint8Array([255]);
    this.texture = this.makeTexture(1, 1, 1);
    this.texNode = texture3D(this.texture);
    // Sample a little way off the surface so walls do not read the voxel behind them.
    const p = positionWorld.add(normalWorldGeometry.mul(0.3));
    const uvw = clamp(p.sub(this.uMin).mul(this.uInvSize), 0, 1);
    this.node = this.texNode.sample(uvw).r;
  }

  private makeTexture(nx: number, ny: number, nz: number): THREE.Data3DTexture {
    const t = new THREE.Data3DTexture(this.data, nx, ny, nz);
    t.format = THREE.RedFormat;
    t.type = THREE.UnsignedByteType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  }

  /** Allocates the volume over a world-space box. Voxel centres sit at min + (i + 0.5) * cell. */
  configure(min: THREE.Vector3, max: THREE.Vector3, cell: THREE.Vector3): void {
    this.min.copy(min);
    this.size.copy(max).sub(min);
    this.dims.set(Math.ceil(this.size.x / cell.x), Math.ceil(this.size.y / cell.y), Math.ceil(this.size.z / cell.z));
    this.size.copy(this.dims).multiply(cell);
    this.data = new Uint8Array(this.dims.x * this.dims.y * this.dims.z).fill(255);
    this.texture.dispose();
    this.texture = this.makeTexture(this.dims.x, this.dims.y, this.dims.z);
    this.texNode.value = this.texture;
    this.uMin.value.copy(this.min);
    this.uInvSize.value.set(1 / this.size.x, 1 / this.size.y, 1 / this.size.z);
  }

  /** CPU lookup (trilinear) for gameplay code: exposure hints, AI visibility in the dark. */
  sample(p: THREE.Vector3): number {
    const { x: nx, y: ny, z: nz } = this.dims;
    const fx = THREE.MathUtils.clamp(((p.x - this.min.x) / this.size.x) * nx - 0.5, 0, nx - 1);
    const fy = THREE.MathUtils.clamp(((p.y - this.min.y) / this.size.y) * ny - 0.5, 0, ny - 1);
    const fz = THREE.MathUtils.clamp(((p.z - this.min.z) / this.size.z) * nz - 0.5, 0, nz - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, ny - 1), z1 = Math.min(z0 + 1, nz - 1);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const at = (x: number, y: number, z: number) => this.data[(z * ny + y) * nx + x] / 255;
    const lerp = THREE.MathUtils.lerp;
    return lerp(
      lerp(lerp(at(x0, y0, z0), at(x1, y0, z0), tx), lerp(at(x0, y1, z0), at(x1, y1, z0), tx), ty),
      lerp(lerp(at(x0, y0, z1), at(x1, y0, z1), tx), lerp(at(x0, y1, z1), at(x1, y1, z1), tx), ty),
      tz,
    );
  }

  commit(): void {
    this.texture.needsUpdate = true;
  }
}

export const skyVolume = new SkyVolume();

/** Ambient light reaching the surface: baked per vertex for the static level, from the volume otherwise. */
const ambient = (baked: boolean | undefined): N => (baked ? attribute('sky', 'float') : skyVolume.node);

export interface SurfaceLook {
  /** Metres covered by one repeat of the scan. */
  tile?: number;
  tint?: THREE.ColorRepresentation;
  normalScale?: number;
  /** Multiplier on the scanned roughness. */
  roughness?: number;
  /** The geometry carries a baked `sky` attribute (see world/ambient.ts). */
  baked?: boolean;
  /** Lower bound on roughness: scans of dry stone often carry glossy flecks that read as wet. */
  roughFloor?: number;
  /** Break up the scan's repeat over large surfaces (costs a second set of samples). */
  detile?: boolean;
}

/**
 * Projects a scanned surface along the three world axes. Used for the castle
 * kit, whose own UVs are far too coarse to stand next to, and for anything else
 * without usable UVs.
 */
export function triplanarMaterial(maps: SurfaceMaps, look: SurfaceLook = {}): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld.div(look.tile ?? 2);
  const n = normalWorldGeometry;
  const w0 = pow(abs(n), vec3(6));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const s = sign(n);
  // Each projection keeps a right-handed tangent frame so normal maps are not inverted on back faces.
  const uvX = vec2(p.z.mul(s.x).negate(), p.y);
  const uvY = vec2(p.x, p.z.mul(s.y).negate());
  const uvZ = vec2(p.x.mul(s.z), p.y);
  // A second, larger and shifted copy of the scan is mixed in patches so no feature repeats on a grid.
  const patch = look.detile ? smoothstep(-0.12, 0.12, mx_noise_float(positionWorld.mul(0.31))) : null;
  const alt = (uvNode: N): N => uvNode.mul(0.617).add(vec2(0.37, 0.71));
  const pick = (t: THREE.Texture, uvNode: N): N => (patch ? mix(texture(t, uvNode), texture(t, alt(uvNode)), patch) : texture(t, uvNode));
  const tri = (t: THREE.Texture): N => pick(t, uvX).mul(w.x).add(pick(t, uvY).mul(w.y)).add(pick(t, uvZ).mul(w.z));

  m.colorNode = tri(maps.diff).rgb.mul(new THREE.Color(look.tint ?? 0xffffff));

  const ns = look.normalScale ?? 1;
  const tn = (uvNode: N): N => pick(maps.nor, uvNode).xy.mul(2).sub(1).mul(ns);
  const tx = tn(uvX);
  const ty = tn(uvY);
  const tz = tn(uvZ);
  const bent = n
    .add(vec3(0, tx.y, tx.x.mul(s.x).negate()).mul(w.x))
    .add(vec3(ty.x, 0, ty.y.mul(s.y).negate()).mul(w.y))
    .add(vec3(tz.x.mul(s.z), tz.y, 0).mul(w.z));
  m.normalNode = transformDirection(normalize(bent), cameraViewMatrix);

  if (maps.arm) {
    const arm = tri(maps.arm);
    m.aoNode = arm.r.mul(ambient(look.baked));
    m.roughnessNode = clamp(arm.g.mul(look.roughness ?? 1), look.roughFloor ?? 0.04, 1);
    m.metalnessNode = arm.b;
  } else {
    m.aoNode = ambient(look.baked);
    m.roughness = look.roughness ?? 1;
    m.metalness = 0;
  }
  return m;
}

/** A PBR material from a scanned tiling surface, for geometry that carries UVs in metres. */
export function uvMaterial(maps: SurfaceMaps, look: SurfaceLook & { side?: THREE.Side } = {}): THREE.MeshStandardNodeMaterial {
  const tile = look.tile ?? 2;
  const clone = (t: THREE.Texture) => {
    // Clones share the GPU texture but carry their own UV transform.
    const c = t.clone();
    c.repeat.setScalar(1 / tile);
    return c;
  };
  const m = new THREE.MeshStandardNodeMaterial();
  m.map = clone(maps.diff);
  m.normalMap = clone(maps.nor);
  m.normalScale.setScalar(look.normalScale ?? 1);
  if (maps.arm) {
    const arm = clone(maps.arm);
    m.aoMap = arm;
    m.roughnessMap = arm;
    m.metalnessMap = arm;
    m.metalness = 1;
    m.aoNode = materialAO.mul(ambient(look.baked));
  } else {
    m.metalness = 0;
    m.aoNode = ambient(look.baked);
  }
  m.roughness = look.roughness ?? 1;
  if (look.tint !== undefined) m.color.set(look.tint);
  if (look.side !== undefined) m.side = look.side;
  return m;
}

/** Converts a loaded glTF material so it takes part in the level's ambient light. */
export function litMaterial(src: THREE.Material): THREE.MeshStandardNodeMaterial {
  if ((src as any).isNodeMaterial) return src as THREE.MeshStandardNodeMaterial;
  const m = new THREE.MeshStandardNodeMaterial();
  for (const key in src) {
    if (key === 'uuid' || key === 'type' || key === 'id' || key.startsWith('is')) continue;
    const v = (src as any)[key];
    if (typeof v === 'function') continue;
    (m as any)[key] = v;
  }
  m.aoNode = (m.aoMap ? materialAO : float(1)).mul(skyVolume.node);
  return m;
}

export interface GroundLayers {
  mud: SurfaceMaps;
  cobble: SurfaceMaps;
  grass: SurfaceMaps;
}

/**
 * The ground: wet mud, with cobbles and grass painted in through vertex colour
 * (r = cobble, g = grass). Low spots in the mud hold standing water.
 */
export function groundMaterial(layers: GroundLayers): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const xz = positionWorld.xz;
  const paint = vertexColor();

  const sampleLayer = (maps: SurfaceMaps, tile: number) => {
    const uvNode = vec2(xz.x, xz.y.negate()).div(tile);
    return {
      color: texture(maps.diff, uvNode).rgb,
      normal: texture(maps.nor, uvNode).xy.mul(2).sub(1),
      arm: texture(maps.arm!, uvNode).rgb,
    };
  };
  const mud = sampleLayer(layers.mud, 3.2);
  const cobble = sampleLayer(layers.cobble, 2.4);
  const grass = sampleLayer(layers.grass, 3.6);

  // Break the painted edges up with noise, and let mud fill the gaps between stones first.
  const breakup = mx_noise_float(vec3(xz.mul(0.9), 0)).mul(0.5).add(mx_noise_float(vec3(xz.mul(3.7), 3)).mul(0.25));
  const wCobble = smoothstep(0.42, 0.6, paint.r.add(breakup.mul(0.5)).add(cobble.arm.r.sub(0.75).mul(0.9)));
  const wGrass = smoothstep(0.4, 0.62, paint.g.add(breakup.mul(0.6)));

  // Standing water in the mud's low places.
  const low = mx_noise_float(vec3(xz.mul(0.23), 7)).add(mx_noise_float(vec3(xz.mul(0.71), 11)).mul(0.5));
  const wet = smoothstep(0.18, 0.42, low).mul(float(1).sub(wCobble)).mul(float(1).sub(wGrass)).mul(paint.b);
  const puddle = smoothstep(0.55, 0.9, wet.add(float(1).sub(mud.arm.r).mul(0.6)).mul(wet));

  // Large-scale tonal variation hides the repeat of the scans.
  const tone = mix(float(0.78), float(1.12), smoothstep(-0.6, 0.6, mx_noise_float(vec3(xz.mul(0.11), 19))));

  let color = mix(mud.color.mul(vec3(0.82, 0.78, 0.74)), cobble.color.mul(vec3(0.5, 0.48, 0.45)), wCobble);
  color = mix(color, grass.color.mul(vec3(0.74, 0.8, 0.62)), wGrass);
  color = color.mul(tone).mul(mix(float(1), float(0.42), max(puddle, wet.mul(0.5))));
  m.colorNode = color;

  let nrm = mix(mud.normal.mul(1.2), cobble.normal, wCobble);
  nrm = mix(nrm, grass.normal, wGrass).mul(float(1).sub(puddle));
  const bent = normalWorldGeometry.add(vec3(nrm.x, 0, nrm.y.negate()));
  m.normalNode = transformDirection(normalize(bent), cameraViewMatrix);

  let arm = mix(mud.arm, cobble.arm, wCobble);
  arm = mix(arm, grass.arm, wGrass);
  m.aoNode = mix(arm.r, float(1), puddle).mul(attribute('sky', 'float'));
  m.roughnessNode = mix(mix(arm.g, arm.g.mul(0.55), wet), float(0.05), puddle);
  m.metalnessNode = float(0);
  return m;
}
