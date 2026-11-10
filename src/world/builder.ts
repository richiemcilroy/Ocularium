import * as THREE from 'three/webgpu';

/** What a surface is made of. Drives footstep, impact and blade sounds. */
export type SurfaceKind = 'stone' | 'wood' | 'dirt' | 'grass' | 'metal' | 'thatch' | 'plaster';

export interface BoxColliderDesc {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  half: THREE.Vector3;
  surface: SurfaceKind;
}

export interface BoxOptions {
  /** Euler rotation in radians, applied in YXZ order. */
  rot?: [number, number, number];
  /** Local axis the material's grain (texture V) follows. Defaults to up on walls, Z on floors. */
  grain?: 'x' | 'y' | 'z';
  /** Emit a physics collider. Defaults to true. */
  collide?: boolean;
  surface?: SurfaceKind;
  /** Skip faces, e.g. the underside of something sitting on the ground: any of +x -x +y -y +z -z. */
  skip?: string[];
}

interface Batch {
  /** Positions pulled slightly off the surface and away from face edges, for the light bake. */
  origins: number[];
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

const MAX_CELL = 0.7;
const INSET = 0.06;

const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/**
 * Accumulates simple architectural solids (beams, wall panels, roof slabs) into
 * one merged mesh per material, with UVs laid out in metres, and records a
 * matching physics collider for each.
 */
export class Builder {
  private batches = new Map<string, Batch>();
  readonly colliders: BoxColliderDesc[] = [];
  private surfaces = new Map<string, SurfaceKind>();

  /** Declares which physical surface a material key stands for. */
  setSurface(material: string, surface: SurfaceKind): void {
    this.surfaces.set(material, surface);
  }

  private batch(material: string): Batch {
    let b = this.batches.get(material);
    if (!b) {
      b = { origins: [], positions: [], normals: [], uvs: [], indices: [] };
      this.batches.set(material, b);
    }
    return b;
  }

  /** An oriented box: centre, full size. */
  box(material: string, c: [number, number, number], s: [number, number, number], o: BoxOptions = {}): void {
    const b = this.batch(material);
    const q = new THREE.Quaternion();
    if (o.rot) q.setFromEuler(new THREE.Euler(o.rot[0], o.rot[1], o.rot[2], 'YXZ'));
    const centre = new THREE.Vector3(...c);
    const half = new THREE.Vector3(s[0] / 2, s[1] / 2, s[2] / 2);
    // Decorrelate the texture between neighbouring boxes.
    const jitterU = ((Math.abs(c[0] * 7.31 + c[2] * 3.17 + c[1] * 1.91) * 1000) % 977) / 977 * 4;
    const jitterV = ((Math.abs(c[0] * 2.71 + c[2] * 5.39 + c[1] * 4.13) * 1000) % 991) / 991 * 4;

    const faces: Array<[string, THREE.Vector3]> = [
      ['+x', AXES.x], ['-x', AXES.x.clone().negate()],
      ['+y', AXES.y], ['-y', AXES.y.clone().negate()],
      ['+z', AXES.z], ['-z', AXES.z.clone().negate()],
    ];
    const p = new THREE.Vector3();
    for (const [name, n] of faces) {
      if (o.skip?.includes(name)) continue;
      // Choose V: the grain axis if it lies in this face, else up, else Z.
      let v: THREE.Vector3;
      if (o.grain && Math.abs(n.dot(AXES[o.grain])) < 0.5) v = AXES[o.grain];
      else if (Math.abs(n.y) < 0.5) v = AXES.y;
      else v = AXES.z;
      const u = new THREE.Vector3().crossVectors(v, n);
      const base = b.positions.length / 3;
      const nw = n.clone().applyQuaternion(q);
      const extent = (a: THREE.Vector3) => Math.abs(a.x) * half.x + Math.abs(a.y) * half.y + Math.abs(a.z) * half.z;
      const hu = extent(u), hv = extent(v), hn = extent(n);
      // Tessellate so baked light has somewhere to vary.
      const nu = Math.max(1, Math.ceil((hu * 2) / MAX_CELL));
      const nv = Math.max(1, Math.ceil((hv * 2) / MAX_CELL));
      for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
          const a = -hu + (2 * hu * i) / nu;
          const c2 = -hv + (2 * hv * j) / nv;
          p.set(0, 0, 0).addScaledVector(n, hn).addScaledVector(u, a).addScaledVector(v, c2);
          b.uvs.push(a + jitterU, c2 + jitterV);
          p.applyQuaternion(q).add(centre);
          b.positions.push(p.x, p.y, p.z);
          b.normals.push(nw.x, nw.y, nw.z);
          const ia = THREE.MathUtils.clamp(a, -Math.max(0, hu - INSET), Math.max(0, hu - INSET));
          const ib = THREE.MathUtils.clamp(c2, -Math.max(0, hv - INSET), Math.max(0, hv - INSET));
          p.set(0, 0, 0).addScaledVector(n, hn + INSET).addScaledVector(u, ia).addScaledVector(v, ib).applyQuaternion(q).add(centre);
          b.origins.push(p.x, p.y, p.z);
        }
      }
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const k = base + j * (nu + 1) + i;
          b.indices.push(k, k + 1, k + nu + 2, k, k + nu + 2, k + nu + 1);
        }
      }
    }

    if (o.collide !== false) {
      this.colliders.push({ position: centre, quaternion: q, half, surface: o.surface ?? this.surfaces.get(material) ?? 'stone' });
    }
  }

  /** A gable: an upright triangle `width` across and `height` tall, facing along local Z, `thick` deep. */
  gable(material: string, base: [number, number, number], width: number, height: number, thick: number, ry = 0): void {
    const b = this.batch(material);
    const q = new THREE.Quaternion().setFromAxisAngle(AXES.y, ry);
    const origin = new THREE.Vector3(...base);
    const p = new THREE.Vector3();
    for (const side of [1, -1]) {
      const start = b.positions.length / 3;
      const n = new THREE.Vector3(0, 0, side).applyQuaternion(q);
      for (const [x, y] of [[-width / 2, 0], [width / 2, 0], [0, height]]) {
        p.set(x, y, (side * thick) / 2);
        b.uvs.push(x * side, y);
        p.applyQuaternion(q).add(origin);
        b.positions.push(p.x, p.y, p.z);
        b.normals.push(n.x, n.y, n.z);
        p.set(x * 0.9, y * 0.9 + 0.05, (side * thick) / 2 + side * INSET).applyQuaternion(q).add(origin);
        b.origins.push(p.x, p.y, p.z);
      }
      if (side > 0) b.indices.push(start, start + 1, start + 2);
      else b.indices.push(start, start + 2, start + 1);
    }
  }

  /** Emits one mesh per material key. Unknown keys throw so typos surface immediately. */
  build(materials: Record<string, THREE.Material>): THREE.Group {
    const group = new THREE.Group();
    group.name = 'built';
    for (const [key, b] of this.batches) {
      const material = materials[key];
      if (!material) throw new Error(`no material for '${key}'`);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
      g.setAttribute('bakeOrigin', new THREE.Float32BufferAttribute(b.origins, 3));
      g.setIndex(b.indices);
      const mesh = new THREE.Mesh(g, material);
      mesh.name = `built:${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}
