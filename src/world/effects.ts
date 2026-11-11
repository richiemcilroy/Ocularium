import * as THREE from 'three/webgpu';
import { T } from '../render/tsl';
import { skyVolume } from '../render/materials';
import { GROUP, type Physics } from '../physics/physics';

const { float, instancedDynamicBufferAttribute, length, mx_noise_float, smoothstep, uv, vec3 } = T;

import type { SurfaceKind } from './builder';

const MAX = 640;
const STAINS = 420;

const enum Kind {
  Spark,
  Dust,
  Chip,
  Blood,
}

/**
 * Short-lived debris: sparks off stone and steel, dust and splinters, blood in
 * the air, and the stains blood leaves where it lands.
 */
export class Effects {
  private mesh: THREE.InstancedMesh;
  private fx: THREE.InstancedBufferAttribute;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private span = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private kind = new Uint8Array(MAX);
  private tint = new Float32Array(MAX * 3);
  private next = 0;
  private live = 0;

  private stains: THREE.InstancedMesh;
  private stainFx: THREE.InstancedBufferAttribute;
  private stainNext = 0;
  private stainCount = 0;

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private c = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(scene: THREE.Scene, private physics: Physics) {
    this.fx = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.fx.setUsage(THREE.DynamicDrawUsage);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const f = instancedDynamicBufferAttribute(this.fx, 'vec4');
    const r = length(uv().sub(0.5).mul(2));
    mat.colorNode = f.rgb;
    mat.opacityNode = f.a.mul(smoothstep(1.0, 0.35, r));
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);

    // Blood on the ground: wet, dark, irregular.
    this.stainFx = new THREE.InstancedBufferAttribute(new Float32Array(STAINS * 4), 4);
    const sm = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const sf = instancedDynamicBufferAttribute(this.stainFx, 'vec4');
    const p = uv().sub(0.5).mul(2);
    const edge = length(p).add(mx_noise_float(vec3(p.mul(2.3), sf.x)).mul(0.42)).add(mx_noise_float(vec3(p.mul(7), sf.x.add(9))).mul(0.12));
    sm.colorNode = vec3(0.15, 0.009, 0.007).mul(sf.y);
    sm.roughnessNode = float(0.4);
    sm.metalnessNode = float(0);
    sm.opacityNode = smoothstep(0.78, 0.5, edge).mul(sf.z);
    sm.aoNode = skyVolume.node;
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.stains = new THREE.InstancedMesh(g, sm, STAINS);
    this.stains.frustumCulled = false;
    this.stains.castShadow = false;
    this.stains.receiveShadow = true;
    this.stains.count = 0;
    this.stains.renderOrder = 2;
    scene.add(this.stains);
  }

  private emit(kind: Kind, p: THREE.Vector3, v: THREE.Vector3, life: number, size: number, r: number, g: number, b: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.live = Math.min(MAX, this.live + 1);
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x;
    this.vel[i * 3 + 1] = v.y;
    this.vel[i * 3 + 2] = v.z;
    this.life[i] = this.span[i] = life;
    this.size[i] = size;
    this.kind[i] = kind;
    this.tint[i * 3] = r;
    this.tint[i * 3 + 1] = g;
    this.tint[i * 3 + 2] = b;
  }

  /** A direction scattered about `n` by up to `spread` (0 = along n, 1 = hemisphere). */
  private scatter(n: THREE.Vector3, spread: number, speed: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).multiplyScalar(spread).add(n);
    if (out.dot(n) < 0) out.addScaledVector(n, -2 * out.dot(n));
    return out.normalize().multiplyScalar(speed);
  }

  /** How bright unlit debris should be at a point so it sits in the scene's light. */
  private lightAt(p: THREE.Vector3): number {
    return 0.12 + 0.75 * skyVolume.sample(p);
  }

  /** Steel on stone or steel. */
  sparks(point: THREE.Vector3, normal: THREE.Vector3, count: number, energy = 1): void {
    for (let i = 0; i < count; i++) {
      this.scatter(normal, 0.9, (1.5 + Math.random() * 5) * energy, this.a);
      const heat = 0.5 + Math.random() * 0.5;
      this.emit(Kind.Spark, point, this.a, 0.12 + Math.random() * 0.38, 0.006 + Math.random() * 0.006, 9 * heat, 4.2 * heat * heat, 0.9 * heat * heat * heat);
    }
  }

  dust(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, count: number, speed = 1): void {
    const l = this.lightAt(point);
    for (let i = 0; i < count; i++) {
      this.scatter(normal, 0.8, (0.2 + Math.random() * 0.9) * speed, this.a);
      const k = l * (0.8 + Math.random() * 0.4);
      this.emit(Kind.Dust, point, this.a, 0.5 + Math.random() * 0.9, 0.05 + Math.random() * 0.08, color.r * k, color.g * k, color.b * k);
    }
  }

  /** Splinters, grit, clods. */
  chips(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, count: number, speed = 1): void {
    const l = this.lightAt(point);
    for (let i = 0; i < count; i++) {
      this.scatter(normal, 0.8, (0.8 + Math.random() * 2.6) * speed, this.a);
      const k = l * (0.6 + Math.random() * 0.6);
      this.emit(Kind.Chip, point, this.a, 0.5 + Math.random() * 0.7, 0.008 + Math.random() * 0.014, color.r * k, color.g * k, color.b * k);
    }
  }

  /** Blood thrown from a wound in roughly `dir`. */
  blood(point: THREE.Vector3, dir: THREE.Vector3, count: number, speed = 1): void {
    const l = this.lightAt(point);
    for (let i = 0; i < count; i++) {
      this.scatter(dir, 0.55, (0.6 + Math.random() * 3.2) * speed, this.a);
      this.a.y += 0.6;
      const k = l * (0.7 + Math.random() * 0.5);
      this.emit(Kind.Blood, point, this.a, 1.4, 0.008 + Math.random() * 0.016, 0.3 * k, 0.012 * k, 0.01 * k);
    }
    // A fine mist that hangs for a moment.
    for (let i = 0; i < Math.min(4, count / 3); i++) {
      this.scatter(dir, 0.5, 0.3 + Math.random() * 0.6, this.a);
      this.emit(Kind.Dust, point, this.a, 0.25 + Math.random() * 0.25, 0.04 + Math.random() * 0.05, 0.22 * l, 0.02 * l, 0.02 * l);
    }
  }

  /** A single drop let fall, as from a wound or a wet blade. */
  drip(point: THREE.Vector3): void {
    const l = this.lightAt(point);
    this.a.set((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3);
    this.emit(Kind.Blood, point, this.a, 2, 0.012, 0.3 * l, 0.012 * l, 0.01 * l);
  }

  /** Blood lying on a surface. */
  stain(point: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    const i = this.stainNext;
    this.stainNext = (this.stainNext + 1) % STAINS;
    this.stainCount = Math.min(STAINS, this.stainCount + 1);
    this.q.setFromUnitVectors(this.a.set(0, 1, 0), normal);
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(this.a, Math.random() * Math.PI * 2));
    this.b.copy(point).addScaledVector(normal, 0.006);
    this.m.compose(this.b, this.q, this.s.set(size * (0.8 + Math.random() * 0.6), 1, size * (0.8 + Math.random() * 0.6)));
    this.stains.setMatrixAt(i, this.m);
    this.stainFx.setXYZW(i, Math.random() * 50, 0.75 + Math.random() * 0.4, 0.82 + Math.random() * 0.14, 0);
    this.stains.count = this.stainCount;
    this.stains.instanceMatrix.needsUpdate = true;
    this.stainFx.needsUpdate = true;
  }

  update(dt: number, camera: THREE.Camera): void {
    if (this.live === 0) {
      this.mesh.count = 0;
      return;
    }
    const cam = camera.position;
    let n = 0;
    let alive = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      alive++;
      const k = this.kind[i];
      const i3 = i * 3;
      const drag = k === Kind.Dust ? 3.2 : k === Kind.Spark ? 1.6 : 0.5;
      const gravity = k === Kind.Dust ? -0.25 : k === Kind.Spark ? 6.5 : 9.81;
      const d = Math.exp(-drag * dt);
      this.vel[i3] *= d;
      this.vel[i3 + 1] = this.vel[i3 + 1] * d - gravity * dt;
      this.vel[i3 + 2] *= d;
      const px = this.pos[i3], py = this.pos[i3 + 1], pz = this.pos[i3 + 2];
      this.a.set(this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]);
      const speed = this.a.length();
      // Heavy bits and blood stop where they land.
      if (k !== Kind.Dust && speed * dt > 1e-4) {
        this.b.set(px, py, pz);
        this.c.copy(this.a).divideScalar(speed);
        const hit = this.physics.raycast(this.b, this.c, speed * dt + 0.01, GROUP.WORLD);
        if (hit) {
          if (k === Kind.Blood) {
            this.life[i] = 0;
            this.stain(hit.point, hit.normal, 0.03 + this.size[i] * 6 * (0.6 + Math.random()));
            continue;
          }
          // Bounce, losing most of the energy.
          this.a.addScaledVector(hit.normal, -1.5 * this.a.dot(hit.normal)).multiplyScalar(0.45);
          this.vel[i3] = this.a.x;
          this.vel[i3 + 1] = this.a.y;
          this.vel[i3 + 2] = this.a.z;
          if (k === Kind.Chip && speed < 1.2) this.vel[i3] = this.vel[i3 + 1] = this.vel[i3 + 2] = 0;
        }
      }
      this.pos[i3] = px + this.vel[i3] * dt;
      this.pos[i3 + 1] = py + this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] = pz + this.vel[i3 + 2] * dt;

      const age = 1 - this.life[i] / this.span[i];
      this.b.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      let w = this.size[i], h = this.size[i], alpha = 1;
      if (k === Kind.Dust) {
        w = h = this.size[i] * (1 + age * 5);
        alpha = 0.34 * (1 - age) * Math.min(1, age * 12);
        this.q.copy(camera.quaternion);
      } else {
        // Streak along the direction of travel, facing the lens.
        const stretch = k === Kind.Spark ? 0.035 : k === Kind.Blood ? 0.012 : 0.004;
        h = this.size[i] + Math.min(0.4, speed * stretch);
        if (k === Kind.Spark) alpha = Math.min(1, (1 - age) * 3);
        this.a.set(this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]);
        if (speed < 1e-3) this.a.set(0, 1, 0);
        else this.a.divideScalar(speed);
        this.c.subVectors(cam, this.b).normalize();
        this.s.crossVectors(this.a, this.c);
        if (this.s.lengthSq() < 1e-6) this.s.set(1, 0, 0);
        this.s.normalize();
        this.c.crossVectors(this.s, this.a);
        this.m.makeBasis(this.s, this.a, this.c);
        this.q.setFromRotationMatrix(this.m);
      }
      this.m.compose(this.b, this.q, this.s.set(w, h, 1));
      this.mesh.setMatrixAt(n, this.m);
      this.fx.setXYZW(n, this.tint[i3], this.tint[i3 + 1], this.tint[i3 + 2], alpha);
      n++;
    }
    this.live = alive;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fx.needsUpdate = true;
  }
}

const GREY = new THREE.Color(0.5, 0.48, 0.45);
const WOOD = new THREE.Color(0.36, 0.26, 0.17);
const SOIL = new THREE.Color(0.2, 0.16, 0.12);
const LIME = new THREE.Color(0.72, 0.69, 0.62);
const STRAW = new THREE.Color(0.55, 0.45, 0.25);

/** What flies off a surface when steel hits it. `energy` is roughly 0..1.5. */
export function strikeSurface(fx: Effects, surface: SurfaceKind, point: THREE.Vector3, normal: THREE.Vector3, energy: number): void {
  const n = (base: number) => Math.round(base * (0.4 + energy));
  switch (surface) {
    case 'stone':
      fx.sparks(point, normal, n(9), 0.6 + energy * 0.5);
      fx.dust(point, normal, GREY, n(3));
      fx.chips(point, normal, GREY, n(4));
      break;
    case 'metal':
      fx.sparks(point, normal, n(16), 0.7 + energy * 0.6);
      break;
    case 'wood':
      fx.chips(point, normal, WOOD, n(9));
      fx.dust(point, normal, WOOD, n(2));
      break;
    case 'plaster':
      fx.dust(point, normal, LIME, n(6));
      fx.chips(point, normal, LIME, n(7));
      break;
    case 'thatch':
      fx.chips(point, normal, STRAW, n(10), 0.6);
      fx.dust(point, normal, STRAW, n(2));
      break;
    default:
      fx.chips(point, normal, SOIL, n(10), 0.8);
      fx.dust(point, normal, SOIL, n(3));
  }
}
