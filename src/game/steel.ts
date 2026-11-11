import * as THREE from 'three/webgpu';
import { FIGHTERS, GROUP, RAPIER, fighterBit, groups, type Physics, type RayHit } from '../physics/physics';
import { T } from '../render/tsl';
import type { SurfaceKind } from '../world/builder';
import { strikeSurface, type Effects } from '../world/effects';

/** Where and how a weapon is held, in the frame of whoever holds it (x right, y up, -z ahead). */
export interface Pose {
  /** Middle of the grip. */
  g: THREE.Vector3;
  q: THREE.Quaternion;
}

export interface Strike {
  hit: RayHit;
  /** Speed of the blade where it met the body, m/s. */
  speed: number;
  /** Direction the blade was travelling. */
  direction: THREE.Vector3;
  /** Point first, rather than edge. */
  thrust: boolean;
  /** Distance of the contact from the grip. */
  along: number;
  /** 0 the flat of the blade .. 1 the edge square on. */
  edge: number;
  /** Which way the blade itself was lying. */
  blade: THREE.Vector3;
  /** How much of the body was behind it: 1 an ordinary blow, up to 2 for one wound up as far as it will go. */
  power: number;
}

/** What became of a blow: turned by armour, bitten into flesh, gone clean through, or too slight to matter. */
export type Blow = 'glanced' | 'cut' | 'through' | 'nothing';

/** Anyone a blade can land on, or whose steel and shield it can be stopped by. */
export interface Target {
  struck(strike: Strike, part: string): Blow;
  /** Somebody's blade was stopped on this fighter's shield or sword. `energy` is roughly 0..1.5. */
  parried(on: 'shield' | 'blade', energy: number, point: THREE.Vector3, direction: THREE.Vector3): void;
}

/** What a hit volume, a blade or a board belongs to; kept against its collider in `Physics.owners`. */
export interface Owned {
  who: Target;
  part: string;
}

/** What a fight sounds like; the soundscape answers to this. */
export interface Voice {
  at(key: string, point: THREE.Vector3, volume?: number, rate?: number): number;
  flesh(point: THREE.Vector3, energy?: number): void;
  clash(point: THREE.Vector3, energy?: number): void;
  shield(point: THREE.Vector3, energy?: number): void;
  fall(point: THREE.Vector3, kind?: 'body/fall' | 'body/hit' | 'sword/drop', volume?: number): void;
  step(point: THREE.Vector3, surface: SurfaceKind, loudness: number): void;
  blade(surface: SurfaceKind, point: THREE.Vector3, energy: number): void;
}

/** The arming sword, in metres along the blade from the middle of the grip (the model's origin). */
export const SWORD = { id: 'arming_sword', cross: 0.0575, tip: 0.8375, pommel: -0.098, mass: 1.25 };

const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
const M = new THREE.Matrix4();
const D = new THREE.Vector3(), E = new THREE.Vector3();
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
const q1 = new THREE.Quaternion();

export const ease = (u: number) => u * u * (3 - 2 * u);

/** Orientation with the blade (+Y) along `d` and the leading edge (+X) towards `e`. */
export function bladeQuat(d: THREE.Vector3, e: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  Y.copy(d).normalize();
  X.copy(e).addScaledVector(Y, -e.dot(Y));
  if (X.lengthSq() < 1e-8) X.set(1, 0, 0).addScaledVector(Y, -Y.x);
  X.normalize();
  Z.crossVectors(X, Y);
  return out.setFromRotationMatrix(M.makeBasis(X, Y, Z));
}

/** How far the sword hand can be carried off centre, across and up or down, in metres. */
export const REACH = new THREE.Vector2(0.62, 0.5);

/** Keeps a hand offset inside what the arm can cover. */
export function withinReach(o: THREE.Vector2): THREE.Vector2 {
  const k = Math.hypot(o.x / REACH.x, o.y / REACH.y);
  if (k > 1) o.multiplyScalar(1 / k);
  return o;
}

/**
 * Where the sword is asked to be for a hand carried `o` off centre (x right,
 * y up). In the middle the point is forward; out to a side the hand comes back
 * towards the shoulder and the blade lies out and behind it, drawn back to
 * cut. `heading` is the way the hand is travelling, which the edge leads.
 * Nothing here is a cut: a cut is what the steel does when the hand is taken
 * from one side to the other faster than the blade can follow.
 */
export function swingPose(o: THREE.Vector2, heading: THREE.Vector2, out: Pose): Pose {
  const m = Math.min(1, Math.hypot(o.x / REACH.x, o.y / REACH.y));
  // Out on the sword side the hand comes back towards the shoulder. Across the body it stays out in front
  // and low, the arm reaching over rather than folding up against the chest.
  const across = o.x < 0 ? Math.min(1, -o.x / REACH.x) : 0;
  out.g.set(0.1 + o.x * (0.92 - 0.25 * across), -0.2 + o.y * 0.85 - 0.07 * across, -0.36 + 0.3 * m * m * (1 - 0.85 * across) - 0.1 * (1 - m) - 0.06 * across);
  D.set(o.x * 1.7, 0.3 + o.y * 1.7, -0.62 + 1.45 * m);
  if (heading.lengthSq() > 1e-6) E.set(heading.x, heading.y, -0.15);
  else E.set(-o.x, -o.y - 0.2, -0.3);
  bladeQuat(D, E, out.q);
  return out;
}

/** The sword drawn back to thrust (`u` -1) or driven out (`u` 1), with the point steered a little by `steer`. */
export function lungePose(u: number, steer: THREE.Vector2, out: Pose): Pose {
  const k = (u + 1) / 2;
  out.g.set(THREE.MathUtils.lerp(0.26, 0.06, k) + steer.x * 0.2, THREE.MathUtils.lerp(-0.2, -0.13, k) + steer.y * 0.2, THREE.MathUtils.lerp(-0.06, -0.64, k));
  bladeQuat(D.set(-0.07 + steer.x * 0.55, 0.02 + steer.y * 0.55, -1), E.set(0.3, -1, 0), out.q);
  return out;
}

/**
 * The sword at rest: point up and a little across, ready to cut or to cover.
 * `run` 0..1 carries it low with the point ahead and the edge down; `guard`
 * 0..1 draws it back upright behind a raised shield; `low` lets it sink.
 */
export function carryPose(run: number, guard: number, low: number, out: Pose): Pose {
  out.g.set(0.12 + 0.1 * run + 0.05 * guard, -0.145 - 0.13 * run - 0.02 * guard - low, -0.32 + 0.1 * run + 0.1 * guard);
  D.set(-0.42 + 0.47 * run + 0.3 * guard, 0.8 - 0.92 * run + 0.1 * guard - low * 2, -0.5 - 0.3 * run + 0.2 * guard);
  bladeQuat(D, E.set(-0.3 + 0.3 * run, -0.3 - 0.7 * run, -0.9 + 0.7 * run), out.q);
  return out;
}

/**
 * The sword put in the way of a blow coming from `from` (x right, y up, in the
 * holder's frame, roughly -1..1): the hand goes towards it and the blade lies
 * across its path, point up for a high blow and down for a low one.
 */
export function parryPose(from: THREE.Vector2, out: Pose): Pose {
  const side = from.x >= 0 ? 1 : -1;
  const lowBlow = from.y < -0.35;
  out.g.set(0.08 + 0.2 * THREE.MathUtils.clamp(from.x, -1, 1), -0.1 + 0.16 * THREE.MathUtils.clamp(from.y, -1, 1), -0.42);
  D.set(-0.55 * side, lowBlow ? -0.85 : 0.8, -0.18);
  bladeQuat(D, E.set(side, 0, -0.3), out.q);
  return out;
}

/** Points along the edge that are swept through the world, from just short of the point to just clear of the cross. */
const SAMPLES = [0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34, 0.26, 0.18];

/**
 * A sword as a thing with weight. The hand asks for it to be somewhere; the
 * steel gets there as fast as an arm can drive it and no faster, trails behind
 * a fast hand, carries on past where it was meant to stop, and is stopped by
 * stone, wood, boards and other steel. What it does to a body depends on how
 * fast it was really going, where along the blade it met it, and whether the
 * edge was leading.
 */
export class Steel {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  /** How hard the arm can drive it: m/s² at the hand, rad/s² about it, and the most it will be asked to do. */
  linAcc = 60;
  angAcc = 95;
  maxSpeed = 9;
  maxSpin = 20;
  /** How much of the body is behind the blade just now, 1..2. */
  power = 1;
  /** Speed of the point, m/s. */
  tipSpeed = 0;
  /** False while there is no hand on it. */
  held = true;
  /** A blade met a body: say what became of it. */
  onFlesh: ((strike: Strike, owner: Owned) => Blow) | null = null;
  /** The blade was stopped by something solid. `kind` is what; `energy` roughly 0..1.5. */
  onStop: ((kind: 'world' | 'prop' | 'shield' | 'blade', energy: number, point: THREE.Vector3) => void) | null = null;

  private tg = new THREE.Vector3();
  private tq = new THREE.Quaternion();
  private prevP = new THREE.Vector3();
  private prevQ = new THREE.Quaternion();
  private currP = new THREE.Vector3();
  private currQ = new THREE.Quaternion();
  private samples = SAMPLES.map(() => new THREE.Vector3());
  private armed = false;
  private recent = new Map<Target, number>();
  private time = 0;
  private rang = -1;
  private dir = new THREE.Vector3();
  private p = new THREE.Vector3();
  private mine: (col: RAPIER.Collider) => boolean;

  constructor(private physics: Physics, readonly object: THREE.Object3D, private who: Target, index: number, private effects: Effects, private voice: () => Voice | null) {
    const w = physics.world;
    const bit = fighterBit(index);
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setGravityScale(0).setCcdEnabled(true).setCanSleep(false).setLinearDamping(0.2).setAngularDamping(0.6));
    const mid = (SWORD.tip + SWORD.cross) / 2, half = (SWORD.tip - SWORD.cross) / 2;
    // Thicker than the steel, so that two blades moving fast still find each other.
    this.collider = w.createCollider(
      RAPIER.ColliderDesc.cuboid(0.032, half, 0.016)
        .setTranslation(0, mid, 0)
        .setMass(SWORD.mass)
        .setFriction(0.25)
        .setRestitution(0.3)
        .setCollisionGroups(groups(GROUP.WEAPON | bit, GROUP.WORLD | GROUP.PROP | (FIGHTERS & ~bit))),
      this.body,
    );
    physics.tag(this.collider, 'metal');
    physics.owners.set(this.collider.handle, { who, part: 'blade' } satisfies Owned);
    this.mine = (col) => (physics.owners.get(col.handle) as Owned | undefined)?.who === who;
    physics.onImpact(this.collider, (other, force, point) => this.stopped(other, force, point));
  }

  /** Something solid stopped the blade. */
  private stopped(other: RAPIER.Collider, force: number, point: THREE.Vector3): void {
    // Blades leaning on each other are not being struck; only a real knock counts.
    const energy = Math.min(1.5, force / 650);
    if (!this.held || energy < 0.14 || this.time - this.rang < 0.09) return;
    this.rang = this.time;
    const voice = this.voice();
    const owner = this.physics.owners.get(other.handle) as Owned | undefined;
    // Which way the blade was going where it was stopped.
    this.velocityAt(point, this.dir);
    const speed = this.dir.length();
    if (speed > 1e-3) this.dir.divideScalar(speed);
    c.copy(this.dir).negate();
    if (owner && owner.part === 'shield') {
      this.effects.chips(point, c, WOOD, Math.round(3 + 8 * energy));
      voice?.shield(point, energy);
      owner.who.parried('shield', energy, point, this.dir);
      this.onStop?.('shield', energy, point);
    } else if (owner && owner.part === 'blade') {
      // Two blades, two reports of the same meeting: only one of them makes the noise.
      if (this.collider.handle < other.handle) {
        this.effects.sparks(point, c, Math.round(4 + 14 * energy), 0.6 + 0.5 * energy);
        voice?.clash(point, energy);
      }
      owner.who.parried('blade', energy, point, this.dir);
      this.onStop?.('blade', energy, point);
    } else {
      const surface = this.physics.surfaceOf(other);
      const prop = (other.collisionGroups() >>> 16) & GROUP.PROP;
      strikeSurface(this.effects, surface, point, c, energy * (prop ? 0.6 : 1));
      voice?.blade(surface, point, energy);
      this.onStop?.(prop ? 'prop' : 'world', energy, point);
    }
  }

  /** Asks for the grip to be at `g` with the blade turned to `q` (world space). */
  aim(g: THREE.Vector3, q: THREE.Quaternion): void {
    this.tg.copy(g);
    this.tq.copy(q);
  }

  /** Puts it somewhere at once, at rest. */
  place(g: THREE.Vector3, q: THREE.Quaternion): void {
    this.body.setTranslation(g, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevP.copy(g);
    this.currP.copy(g);
    this.prevQ.copy(q);
    this.currQ.copy(q);
    this.tg.copy(g);
    this.tq.copy(q);
    this.armed = false;
  }

  /** In or out of the world: a sword in its scabbard stops nothing and cuts nothing. */
  set live(on: boolean) {
    if (this.collider.isEnabled() !== on) this.collider.setEnabled(on);
    this.held = on;
    if (!on) this.armed = false;
  }

  /** Velocity of the point of the sword body that is at `point` (world). */
  velocityAt(point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const v = this.body.linvel(), w = this.body.angvel(), com = this.body.worldCom();
    a.set(point.x - com.x, point.y - com.y, point.z - com.z);
    return out.set(w.x, w.y, w.z).cross(a).add(b.set(v.x, v.y, v.z));
  }

  /** Takes the way out of the blade: `keep` of its speed is left, as when it bites into something. */
  drag(keep: number): void {
    const v = this.body.linvel(), w = this.body.angvel();
    this.body.setLinvel({ x: v.x * keep, y: v.y * keep, z: v.z * keep }, true);
    this.body.setAngvel({ x: w.x * keep, y: w.y * keep, z: w.z * keep }, true);
  }

  /**
   * Once per physics step, before the world moves: sees what the blade passed
   * through since the last step, then drives it towards where it was asked to be.
   */
  step(dt: number, exclude?: RAPIER.RigidBody): void {
    this.time += dt;
    const body = this.body;
    const t = body.translation(), r = body.rotation();
    this.prevP.copy(this.currP);
    this.prevQ.copy(this.currQ);
    this.currP.set(t.x, t.y, t.z);
    this.currQ.set(r.x, r.y, r.z, r.w);
    if (!this.held) return;
    this.cut(dt, exclude);

    // The wrist: turn towards the asked-for line, as fast as it can be turned and no faster.
    q1.copy(this.tq).multiply(X_QUAT.copy(this.currQ).invert());
    if (q1.w < 0) q1.set(-q1.x, -q1.y, -q1.z, -q1.w);
    const s = Math.hypot(q1.x, q1.y, q1.z);
    const angle = 2 * Math.atan2(s, q1.w);
    const w = body.angvel();
    a.set(0, 0, 0);
    if (s > 1e-5) a.set(q1.x / s, q1.y / s, q1.z / s).multiplyScalar(Math.min(this.maxSpin, (angle * 0.32) / dt));
    b.set(a.x - w.x, a.y - w.y, a.z - w.z);
    const dw = b.length(), most = this.angAcc * dt;
    if (dw > most) b.multiplyScalar(most / dw);
    const wx = w.x + b.x, wy = w.y + b.y, wz = w.z + b.z;
    body.setAngvel({ x: wx, y: wy, z: wz }, true);

    // The arm: carry the grip towards where it should be. The body's own velocity is that of its centre
    // of mass, which is up the blade from the hand.
    const com = body.worldCom(), v = body.linvel();
    const rx = com.x - t.x, ry = com.y - t.y, rz = com.z - t.z;
    // Velocity of the grip now.
    const gx = v.x - (wy * rz - wz * ry), gy = v.y - (wz * rx - wx * rz), gz = v.z - (wx * ry - wy * rx);
    a.set(this.tg.x - t.x, this.tg.y - t.y, this.tg.z - t.z).multiplyScalar(0.42 / dt);
    const want = a.length();
    if (want > this.maxSpeed) a.multiplyScalar(this.maxSpeed / want);
    b.set(a.x - gx, a.y - gy, a.z - gz);
    const dv = b.length(), push = this.linAcc * dt;
    if (dv > push) b.multiplyScalar(push / dv);
    const nx = gx + b.x, ny = gy + b.y, nz = gz + b.z;
    body.setLinvel({ x: nx + (wy * rz - wz * ry), y: ny + (wz * rx - wx * rz), z: nz + (wx * ry - wy * rx) }, true);
    this.tipSpeed = Math.hypot(nx, ny, nz) + Math.hypot(wx, wy, wz) * SWORD.tip;
  }

  /** What the edge passed through between the last step and this one. */
  private cut(dt: number, exclude?: RAPIER.RigidBody): void {
    let best: RayHit | null = null, bestT = Infinity, bestI = 0, bestLen = 0;
    for (let i = 0; i < SAMPLES.length; i++) {
      this.p.set(0, SAMPLES[i], 0).applyQuaternion(this.currQ).add(this.currP);
      if (this.armed) {
        a.subVectors(this.p, this.samples[i]);
        const len = a.length();
        if (len > 1e-3) {
          a.divideScalar(len);
          const hit = this.physics.raycast(this.samples[i], a, len, GROUP.HITBOX, exclude, this.mine);
          if (hit && hit.distance / len < bestT) {
            bestT = hit.distance / len;
            best = hit;
            bestI = i;
            bestLen = len;
            this.dir.copy(a);
          }
        }
      }
      this.samples[i].copy(this.p);
    }
    this.armed = true;
    if (!best || !this.onFlesh) return;
    const owner = this.physics.owners.get(best.collider.handle) as Owned | undefined;
    if (!owner) return;
    // One pass of the blade is one blow, however many pieces of the same man it crosses.
    const last = this.recent.get(owner.who);
    if (last !== undefined && this.time - last < 0.3) return;
    const speed = bestLen / dt;
    if (speed < 1.6) return;
    Y.set(0, 1, 0).applyQuaternion(this.currQ);
    X.set(1, 0, 0).applyQuaternion(this.currQ);
    const point = this.dir.dot(Y);
    const across = Math.sqrt(Math.max(1e-6, 1 - point * point));
    const strike: Strike = {
      hit: best,
      speed,
      direction: this.dir.clone(),
      thrust: point > 0.72 && SAMPLES[bestI] > 0.55,
      along: SAMPLES[bestI],
      edge: Math.min(1, Math.abs(this.dir.dot(X)) / across),
      blade: Y.clone(),
      power: this.power,
    };
    const blow = this.onFlesh(strike, owner);
    if (blow === 'nothing') return;
    this.recent.set(owner.who, this.time);
    // Steel slows in a body: stopped dead by a helmet, most of the way by cloth and flesh.
    this.drag(blow === 'glanced' ? 0.1 : blow === 'cut' ? 0.3 : 0.7);
  }

  /** Per frame: puts the sword everyone sees where the steel is. */
  frame(alpha: number): void {
    this.object.position.lerpVectors(this.prevP, this.currP, alpha);
    this.object.quaternion.slerpQuaternions(this.prevQ, this.currQ, alpha);
  }

  dispose(): void {
    this.physics.offImpact(this.collider);
    this.physics.owners.delete(this.collider.handle);
    this.physics.world.removeRigidBody(this.body);
  }
}

const X_QUAT = new THREE.Quaternion();
const WOOD = new THREE.Color(0.36, 0.26, 0.17);

/**
 * How bad a blow is, from what the steel was really doing. A cut is as bad as
 * the square of its speed and the truth of its edge; a point needs far less
 * speed. Around 1 is a fair blow, 3 and up a terrible one.
 */
export function severity(s: Strike): number {
  const body = 0.75 + 0.25 * s.power;
  if (s.thrust) return Math.pow(s.speed / 4.6, 2) * body;
  return Math.pow(s.speed / 9.5, 2) * (0.22 + 0.78 * s.edge) * body;
}

/** A shield as something solid: other people's steel stops on it. */
export class Board {
  readonly body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private centre = new THREE.Vector3();
  private v = new THREE.Vector3();

  constructor(private physics: Physics, shield: THREE.Object3D, who: Target, index: number) {
    const w = physics.world;
    const bit = fighterBit(index);
    // The board as it lies in the shield's own frame.
    const p = shield.position.clone(), q = shield.quaternion.clone();
    shield.position.set(0, 0, 0);
    shield.quaternion.identity();
    shield.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(shield);
    shield.position.copy(p);
    shield.quaternion.copy(q);
    shield.updateMatrixWorld(true);
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(this.centre);
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.collider = w.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, Math.max(0.025, size.z / 2)).setFriction(0.5).setRestitution(0.1).setCollisionGroups(groups(bit, FIGHTERS & ~bit)),
      this.body,
    );
    physics.tag(this.collider, 'wood');
    physics.owners.set(this.collider.handle, { who, part: 'shield' } satisfies Owned);
  }

  /** Follows the shield on the arm. */
  follow(shield: THREE.Object3D): void {
    this.body.setNextKinematicTranslation(this.v.copy(this.centre).applyQuaternion(shield.quaternion).add(shield.position));
    this.body.setNextKinematicRotation(shield.quaternion);
  }

  set live(on: boolean) {
    if (this.collider.isEnabled() !== on) this.collider.setEnabled(on);
  }

  dispose(): void {
    this.physics.owners.delete(this.collider.handle);
    this.physics.world.removeRigidBody(this.body);
  }
}

const { clamp, dot, float, length, materialColor, materialRoughness, max, mix, mx_noise_float, positionGeometry, select, smoothstep, step, uniform, uniformArray, vec3 } = T;

const MARKS = 6;
const mw = new THREE.Matrix4(), mb = new THREE.Matrix4();

/**
 * What blades leave on a body. Each cut is kept where it was made on the
 * figure as it stands at rest, so it stays put on the cloth however the man
 * moves; it opens dark along the line of the cut and the cloth round and
 * below it takes up the blood.
 */
export class Gore {
  private from: THREE.Vector4[] = [];
  private to: THREE.Vector4[] = [];
  private next = 0;
  private mesh: THREE.SkinnedMesh;

  constructor(private bones: Record<string, THREE.Bone>, meshes: THREE.SkinnedMesh[]) {
    for (let i = 0; i < MARKS; i++) {
      this.from.push(new THREE.Vector4(0, -50, 0, 0.001));
      this.to.push(new THREE.Vector4(0, -50, 0, 0));
    }
    const A = uniformArray(this.from), B = uniformArray(this.to);
    const P = positionGeometry;
    let soak: any = float(0), open: any = float(0);
    const rough = mx_noise_float(P.mul(21)).mul(0.5).add(0.75);
    for (let i = 0; i < MARKS; i++) {
      const a4 = A.element(i), b4 = B.element(i);
      const pa = P.sub(a4.xyz), ba = b4.xyz.sub(a4.xyz);
      const h = clamp(dot(pa, ba).div(max(dot(ba, ba), 1e-6)), 0, 1);
      const off = pa.sub(ba.mul(h));
      // Blood runs down from a wound further than it spreads up or sideways.
      const run = vec3(off.x, select(off.y.lessThan(0), off.y.mul(0.3), off.y), off.z);
      const reach = a4.w.mul(rough);
      soak = max(soak, smoothstep(reach, reach.mul(0.3), length(run)).mul(b4.w));
      open = max(open, smoothstep(0.016, 0.006, length(off)).mul(step(0.01, b4.w)));
    }
    const made = new Map<THREE.Material, THREE.Material>();
    for (const mesh of meshes) {
      const src = mesh.material as THREE.MeshStandardNodeMaterial;
      let m = made.get(src) as THREE.MeshStandardNodeMaterial | undefined;
      if (!m) {
        m = src.clone();
        m.colorNode = mix(mix(materialColor, vec3(0.17, 0.012, 0.01), soak.mul(0.93)), vec3(0.035, 0.002, 0.002), open);
        m.roughnessNode = mix(materialRoughness, float(0.32), soak);
        made.set(src, m);
      }
      mesh.material = m;
    }
    this.mesh = meshes[0];
  }

  /**
   * A cut on `bone`, at `point` and running along `along` (world space) for
   * `length` metres, with blood spreading `spread` metres from it.
   */
  mark(bone: string, point: THREE.Vector3, along: THREE.Vector3, length: number, spread: number): void {
    const bn = this.bones[bone];
    const sk = this.mesh.skeleton;
    const index = sk.bones.indexOf(bn);
    if (!bn || index < 0) return;
    bn.updateWorldMatrix(true, false);
    // From the world, through the bone as it is now, back to the bone as the mesh was made.
    mw.copy(bn.matrixWorld).invert();
    mb.copy(sk.boneInverses[index]).invert();
    const i = this.next;
    this.next = (this.next + 1) % MARKS;
    a.copy(point).addScaledVector(along, -length / 2).applyMatrix4(mw).applyMatrix4(mb);
    b.copy(point).addScaledVector(along, length / 2).applyMatrix4(mw).applyMatrix4(mb);
    this.from[i].set(a.x, a.y, a.z, spread);
    this.to[i].set(b.x, b.y, b.z, 1);
  }

  /** Wounds go on bleeding into the cloth for a while. */
  spread(dt: number, rate: number): void {
    for (let i = 0; i < MARKS; i++) if (this.to[i].w > 0) this.from[i].w = Math.min(0.34, this.from[i].w + dt * rate);
  }
}

/** Blood on a blade: how much, 0..1. Returns the control for it. */
export function bloodied(sword: THREE.Object3D): { value: number } {
  const wet = uniform(0);
  const made = new Map<THREE.Material, THREE.Material>();
  sword.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardNodeMaterial;
    let m = made.get(src) as THREE.MeshStandardNodeMaterial | undefined;
    if (!m) {
      m = src.clone();
      const n = mx_noise_float(positionGeometry.mul(34)).mul(0.5).add(0.5);
      const mask = smoothstep(float(1.05).sub(wet.mul(0.6)), float(1.15).sub(wet.mul(0.55)), n.add(wet.mul(0.2)));
      m.colorNode = mix(materialColor, vec3(0.11, 0.006, 0.005), mask.mul(0.85));
      made.set(src, m);
    }
    mesh.material = m;
  });
  return wet;
}
