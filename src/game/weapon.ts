import * as THREE from 'three/webgpu';
import type { Assets } from '../core/assets';
import type { Input } from '../core/input';
import { GROUP, type Physics, type RayHit } from '../physics/physics';
import type { SurfaceKind } from '../world/builder';
import { strikeSurface, type Effects } from '../world/effects';
import { Spring, type Player } from './player';

/** Where and how a weapon is held, in the frame of whoever holds it (x right, y up, -z ahead). */
export interface Pose {
  /** Middle of the grip. */
  g: THREE.Vector3;
  q: THREE.Quaternion;
}

export interface Strike {
  hit: RayHit;
  /** Speed of the blade at the point of contact, m/s. */
  speed: number;
  /** Direction the blade was travelling. */
  direction: THREE.Vector3;
  thrust: boolean;
  /** Distance of the contact from the grip. */
  along: number;
}

export interface ArmsEvents {
  swing?(thrust: boolean): void;
  impact?(surface: SurfaceKind, point: THREE.Vector3, energy: number): void;
  /** A blade reached a living body. Return true if the blade carries on through. */
  flesh?(strike: Strike): boolean;
  guard?(raised: boolean): void;
}

/** The arming sword, in metres along the blade from the middle of the grip (the model's origin). */
export const SWORD = { id: 'arming_sword', cross: 0.0575, tip: 0.8375, pommel: -0.098 };
/**
 * Shield as scaled for the arm, in its own frame (x to the wearer's right
 * along the forearm, y up the board, z off its back towards the wearer):
 * where the fist closes on the hand strap, and where the elbow rests.
 */
export const SHIELD = { scale: 0.8, strap: new THREE.Vector3(0.102, 0.2, 0.057), elbow: new THREE.Vector3(-0.242, 0.2, 0.05) };
/** Left shoulder as seen from the chest camera, and the length of the upper arm. */
const SHOULDER = new THREE.Vector3(-0.192, 0.018, 0.171);
const UPPER_ARM = 0.257;

const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
const M = new THREE.Matrix4();
const TV = new THREE.Vector3();

/** Orientation with the blade (+Y) along `d` and the leading edge (+X) towards `e`. */
export function bladeQuat(d: THREE.Vector3, e: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  Y.copy(d).normalize();
  X.copy(e).addScaledVector(Y, -e.dot(Y));
  if (X.lengthSq() < 1e-8) X.set(1, 0, 0).addScaledVector(Y, -Y.x);
  X.normalize();
  Z.crossVectors(X, Y);
  return out.setFromRotationMatrix(M.makeBasis(X, Y, Z));
}

/**
 * Pose of a shield strapped along the forearm. The elbow hangs from the
 * shoulder along `upper`; the forearm points `yaw` inwards of straight ahead
 * and `pitch` above level, and the board is rolled about it by `roll`.
 */
export function strappedPose(upper: THREE.Vector3, yaw: number, pitch: number, roll: number, out: Pose): Pose {
  X.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  Y.set(0, 1, 0).addScaledVector(X, -X.y).normalize();
  Z.crossVectors(X, Y);
  Y.multiplyScalar(Math.cos(roll)).addScaledVector(Z, Math.sin(roll));
  Z.crossVectors(X, Y);
  out.q.setFromRotationMatrix(M.makeBasis(X, Y, Z));
  out.g.copy(upper).normalize().multiplyScalar(UPPER_ARM).add(SHOULDER).sub(TV.copy(SHIELD.elbow).applyQuaternion(out.q));
  return out;
}

const ease = (u: number) => u * u * (3 - 2 * u);
const THETA0 = (-118 * Math.PI) / 180;
const THETA1 = (68 * Math.PI) / 180;
const FORWARD = new THREE.Vector3(0, 0.1, -1).normalize();

/** Pose part-way through a cut that travels across the body in direction `travel` (unit, in the view plane). */
export function cutPose(travel: THREE.Vector2, theta: number, out: Pose): Pose {
  const t = TV.set(travel.x, travel.y, 0);
  const d = new THREE.Vector3().copy(FORWARD).multiplyScalar(Math.cos(theta)).addScaledVector(t, Math.sin(theta));
  const e = new THREE.Vector3().copy(FORWARD).multiplyScalar(-Math.sin(theta)).addScaledVector(t, Math.cos(theta));
  // The hand rides a smaller arc in front of the shoulder and reaches out as the blade comes round.
  out.g.set(0.1, -0.2, -0.3).addScaledVector(t, 0.25 * Math.sin(theta)).addScaledVector(FORWARD, 0.2 * Math.max(0, Math.cos(theta)));
  if (theta < 0) out.g.y += 0.1 * Math.sin(-theta);
  bladeQuat(d, e, out.q);
  return out;
}

export function thrustPose(u: number, out: Pose): Pose {
  // u: -1 drawn back .. 1 fully extended.
  const k = (u + 1) / 2;
  out.g.set(THREE.MathUtils.lerp(0.26, 0.06, k), THREE.MathUtils.lerp(-0.2, -0.13, k), THREE.MathUtils.lerp(-0.06, -0.62, k));
  bladeQuat(new THREE.Vector3(-0.07, 0.02, -1), new THREE.Vector3(0.3, -1, 0), out.q);
  return out;
}

type Phase = 'ready' | 'windup' | 'strike' | 'recover';

/** Points along the edge that are swept through the world, from just short of the point to just clear of the cross. */
const SAMPLES = [0.82, 0.69, 0.55, 0.41, 0.27, 0.13];

/**
 * Tests a moving blade against the world. Keeps the previous positions of a
 * few points along the edge and casts between them, so a fast swing cannot
 * pass through anything.
 */
export class BladeSweep {
  private prev: THREE.Vector3[] = SAMPLES.map(() => new THREE.Vector3());
  private armed = false;
  private p = new THREE.Vector3();
  private dir = new THREE.Vector3();

  reset(): void {
    this.armed = false;
  }

  /** Moves the blade to a new pose (world space) and returns the first thing it met on the way. */
  move(physics: Physics, grip: THREE.Vector3, q: THREE.Quaternion, dt: number, mask: number, exclude?: Parameters<Physics['raycast']>[4]): Strike | null {
    let best: Strike | null = null;
    let bestT = Infinity;
    for (let i = 0; i < SAMPLES.length; i++) {
      this.p.set(0, SAMPLES[i], 0).applyQuaternion(q).add(grip);
      if (this.armed) {
        this.dir.subVectors(this.p, this.prev[i]);
        const len = this.dir.length();
        if (len > 1e-4) {
          this.dir.divideScalar(len);
          const hit = physics.raycast(this.prev[i], this.dir, len, mask, exclude);
          if (hit && hit.distance / len < bestT) {
            bestT = hit.distance / len;
            best = { hit, speed: len / Math.max(dt, 1e-4), direction: this.dir.clone(), thrust: false, along: SAMPLES[i] };
          }
        }
      }
      this.prev[i].copy(this.p);
    }
    this.armed = true;
    return best;
  }
}

/**
 * The wearer's sword arm and shield arm. Everything is posed in the frame of
 * the aim, not the lens: the hands go where you point and the camera on the
 * chest catches up afterwards.
 */
export class Arms {
  readonly sword = new THREE.Group();
  readonly shield = new THREE.Group();
  events: ArmsEvents = {};
  /** Set by the body that carries these: pulls a weapon back to where the arm can actually hold it. */
  limit: ((hand: 'sword' | 'shield', position: THREE.Vector3, quaternion: THREE.Quaternion) => void) | null = null;
  phase: Phase = 'ready';
  /** 0 lowered .. 1 shield raised. */
  guard = 0;
  /** Blood on the blade, 0..1. */
  bloody = 0;

  private t = 0;
  private duration = 0;
  private thrusting = false;
  private travel = new THREE.Vector2(-0.86, -0.5);
  private lastSide = 1;
  private queued: 'cut' | 'thrust' | null = null;
  private queueAge = 0;
  private trend = new THREE.Vector2();
  private pose: Pose = { g: new THREE.Vector3(0.2, -0.27, -0.34), q: new THREE.Quaternion() };
  private from: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };
  private target: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };
  private shieldPose: Pose = { g: new THREE.Vector3(-0.32, -0.8, -0.18), q: new THREE.Quaternion() };
  private sweep = new BladeSweep();
  private struck = new Set<unknown>();
  private slow = 1;
  private swayYaw = new Spring(2.6, 0.55);
  private swayPitch = new Spring(2.6, 0.55);
  private bob = 0;
  private crowd = 0;
  private frame = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private sub: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };

  static async create(scene: THREE.Scene, assets: Assets, physics: Physics, player: Player, effects: Effects): Promise<Arms> {
    const [sword, shield] = await Promise.all([assets.instance(SWORD.id), assets.instance('kite_shield')]);
    return new Arms(scene, physics, player, effects, sword, shield);
  }

  private constructor(scene: THREE.Scene, private physics: Physics, private player: Player, private effects: Effects, sword: THREE.Object3D, shield: THREE.Object3D) {
    this.sword.add(sword);
    shield.scale.setScalar(SHIELD.scale);
    // The painted face is turned to the enemy; we see the boards and straps.
    shield.rotation.y = Math.PI;
    this.shield.add(shield);
    for (const g of [this.sword, this.shield]) {
      g.traverse((o) => {
        o.frustumCulled = false;
        o.castShadow = true;
      });
      scene.add(g);
    }
    this.guardPose(this.pose);
  }

  /** The sword at rest: point up and a little across, ready to cut or to cover. */
  private guardPose(out: Pose): Pose {
    const p = this.player;
    const run = p.sprinting ? 1 : 0;
    const g = this.guard;
    // The hand rides in front of the sword-side ribs with the point up and across. Running, the sword is
    // carried low with the point ahead and the edge down; behind the shield it is drawn back and held upright.
    out.g.set(0.12 + 0.1 * run + 0.05 * g, -0.145 - 0.13 * run - 0.02 * g, -0.32 + 0.1 * run + 0.1 * g);
    const d = this.v.set(-0.42 + 0.47 * run + 0.3 * g, 0.8 - 0.92 * run + 0.1 * g, -0.5 - 0.3 * run + 0.2 * g);
    bladeQuat(d, this.w.set(-0.3 + 0.3 * run, -0.3 - 0.7 * run, -0.9 + 0.7 * run), out.q);
    return out;
  }

  get attacking(): boolean {
    return this.phase === 'windup' || this.phase === 'strike';
  }

  /** Whether a blow arriving along `direction` (world, pointing at us) meets the shield. */
  covers(direction: THREE.Vector3): boolean {
    if (this.guard < 0.6) return false;
    const yaw = this.player.aimYaw;
    // Shield arm side gets a wider arc than the sword side.
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const facing = -(direction.x * fx + direction.z * fz);
    return facing > 0.3;
  }

  private begin(kind: 'cut' | 'thrust'): void {
    const p = this.player;
    this.thrusting = kind === 'thrust';
    if (!this.thrusting) {
      // The cut follows the hand: whichever way the mouse was moving is the way the blade travels.
      const t = this.travel;
      if (this.trend.length() > 0.012) t.set(this.trend.x, -this.trend.y).normalize();
      else {
        this.lastSide = -this.lastSide;
        t.set(this.lastSide * 0.9, 0);
      }
      t.y -= 0.42;
      t.normalize();
      this.lastSide = Math.sign(t.x) || this.lastSide;
    }
    this.from.g.copy(this.pose.g);
    this.from.q.copy(this.pose.q);
    this.phase = 'windup';
    this.t = 0;
    const tired = p.stamina < 0.15 ? 1.35 : 1;
    this.duration = (this.thrusting ? 0.2 : 0.25) * tired;
    this.slow = tired;
    this.struck.clear();
    p.tire(this.thrusting ? 0.035 : 0.05);
  }

  private stageTarget(u: number, out: Pose): Pose {
    if (this.thrusting) return thrustPose(this.phase === 'windup' ? -1 : -1 + 2 * ease(Math.min(1, u * 1.15)), out);
    return cutPose(this.travel, this.phase === 'windup' ? THETA0 : THETA0 + (THETA1 - THETA0) * ease(u), out);
  }

  update(dt: number, input: Input): void {
    const p = this.player;
    if (p.dead) return;

    // Which way the hand has been moving lately.
    const k = Math.exp(-dt / 0.1);
    this.trend.multiplyScalar(k).add(this.v.set(p.look.x, p.look.y, 0));
    if (input.hit('Mouse0')) (this.queued = 'cut'), (this.queueAge = 0);
    if (input.hit('Mouse1') || input.hit('KeyF')) (this.queued = 'thrust'), (this.queueAge = 0);
    if (this.queued && (this.queueAge += dt) > 0.3) this.queued = null;

    const wantGuard = input.down('Mouse2') && !this.attacking;
    const before = this.guard > 0.5;
    this.guard += ((wantGuard ? 1 : 0) - this.guard) * (1 - Math.exp(-dt * (wantGuard ? 14 : 8)));
    if (this.guard > 0.5 !== before) this.events.guard?.(!before);

    if (this.queued && (this.phase === 'ready' || (this.phase === 'recover' && this.t > this.duration * 0.5)) && p.stamina > 0.03) {
      this.begin(this.queued);
      this.queued = null;
    }

    // Frame of the aim, with the weapon's own inertia: it trails a turning hand and overshoots when the hand stops.
    const sy = this.swayYaw.step(dt, THREE.MathUtils.clamp((p.look.x / Math.max(dt, 1e-3)) * 0.02, -0.16, 0.16));
    const sp = this.swayPitch.step(dt, THREE.MathUtils.clamp((p.look.y / Math.max(dt, 1e-3)) * 0.02, -0.12, 0.12));
    this.frame.setFromEuler(this.e.set(p.aimPitch * 0.92 + sp, p.aimYaw + sy, 0));

    // Sword against a wall: bring the point up rather than push it through the stone.
    let crowd = 0;
    if (!this.attacking) {
      this.v.set(0, 0, -1).applyQuaternion(this.frame);
      const hit = this.physics.raycast(p.eye, this.v, 1.0, GROUP.WORLD);
      if (hit) crowd = THREE.MathUtils.clamp((1.0 - hit.distance) / 0.6, 0, 1);
    }
    this.crowd += (crowd - this.crowd) * (1 - Math.exp(-dt * 10));

    this.t += dt;
    const u = Math.min(1, this.t / this.duration);
    let stop = false;
    if (this.phase === 'windup') {
      this.stageTarget(0, this.target);
      const s = ease(u);
      this.pose.g.lerpVectors(this.from.g, this.target.g, s);
      this.pose.q.slerpQuaternions(this.from.q, this.target.q, s);
      if (u >= 1) {
        this.phase = 'strike';
        this.t = 0;
        this.duration = (this.thrusting ? 0.15 : 0.23) * this.slow;
        this.sweep.reset();
        this.events.swing?.(this.thrusting);
      }
    } else if (this.phase === 'strike') {
      // Several steps per frame so the arc is tested as an arc.
      const steps = 4;
      const t0 = this.t - dt;
      for (let i = 1; i <= steps && !stop; i++) {
        const ui = THREE.MathUtils.clamp((t0 + (dt * i) / steps) / this.duration, 0, 1);
        this.stageTarget(ui, this.sub);
        this.toWorld(this.sub, this.v, this.q, 'sword');
        const strike = this.sweep.move(this.physics, this.v, this.q, dt / steps, GROUP.WORLD | GROUP.PROP | GROUP.HITBOX, p.rigidBody);
        this.pose.g.copy(this.sub.g);
        this.pose.q.copy(this.sub.q);
        if (strike) stop = this.landed(strike);
      }
      if (u >= 1 || stop) {
        this.phase = 'recover';
        this.t = 0;
        this.duration = stop ? 0.5 : 0.4;
        this.from.g.copy(this.pose.g);
        this.from.q.copy(this.pose.q);
      }
    } else if (this.phase === 'recover') {
      this.guardPose(this.target);
      const s = ease(u);
      this.pose.g.lerpVectors(this.from.g, this.target.g, s);
      this.pose.q.slerpQuaternions(this.from.q, this.target.q, s);
      if (u >= 1) this.phase = 'ready';
    } else {
      this.guardPose(this.target);
      const r = 1 - Math.exp(-dt * 9);
      this.pose.g.lerp(this.target.g, r);
      this.pose.q.slerp(this.target.q, r);
    }

    // Shield arm.
    const g = ease(this.guard);
    const run = p.sprinting ? 1 : 0;
    // Carried, the elbow hangs at the side and the board covers the flank; raised, the forearm comes across the body.
    const mix = THREE.MathUtils.lerp;
    this.v.set(mix(-0.2, -0.08, g), mix(-0.95, -0.93, g), mix(0.2, -0.36, g) + 0.25 * run);
    strappedPose(this.v, mix(0.1, 0.87, g) - 0.1 * run, mix(-0.12, -0.38, g) - 0.2 * run, mix(0, -0.08, g), this.target);
    const r = 1 - Math.exp(-dt * 12);
    this.shieldPose.g.lerp(this.target.g, r);
    this.shieldPose.q.slerp(this.target.q, r);

    // The hands carry the walk: a small figure of eight, and the breath.
    this.bob += dt;
    const gait = Math.min(1, p.speed / 2.4);
    const sway = Math.sin(this.bob * (5 + p.speed)) * 0.006 * gait;
    const dip = Math.abs(Math.cos(this.bob * (5 + p.speed) * 0.5)) * 0.012 * gait + Math.sin(this.bob * 1.7) * 0.002;

    this.sub.g.copy(this.pose.g);
    this.sub.q.copy(this.pose.q);
    if (this.crowd > 0.01) {
      // High port: point straight up, hand in to the chest.
      this.sub.g.lerp(this.v.set(0.2, -0.3, -0.16), this.crowd);
      this.sub.q.slerp(bladeQuat(this.v.set(-0.12, 0.98, 0.1), this.w.set(0.6, 0, -0.8), this.q), this.crowd);
    }
    this.sub.g.x += sway;
    this.sub.g.y -= dip;
    this.toWorld(this.sub, this.sword.position, this.sword.quaternion, 'sword');

    this.sub.g.copy(this.shieldPose.g);
    this.sub.g.x -= sway * 0.7;
    this.sub.g.y -= dip * 0.8;
    this.sub.g.z += this.crowd * 0.12;
    this.sub.q.copy(this.shieldPose.q);
    this.toWorld(this.sub, this.shield.position, this.shield.quaternion, 'shield');
  }

  private toWorld(pose: Pose, position: THREE.Vector3, quaternion: THREE.Quaternion, hand: 'sword' | 'shield'): void {
    position.copy(pose.g).applyQuaternion(this.frame).add(this.player.eye);
    quaternion.copy(this.frame).multiply(pose.q);
    this.limit?.(hand, position, quaternion);
  }

  /** The blade met something. Returns true if that ends the stroke. */
  private landed(s: Strike): boolean {
    const p = this.player;
    s.thrust = this.thrusting;
    const kind = s.hit.collider.collisionGroups() >>> 16;
    const energy = Math.min(1.5, s.speed / 14);
    if (kind & GROUP.HITBOX) {
      const owner = this.physics.owners.get(s.hit.collider.handle);
      const who = (owner as any)?.who ?? owner;
      if (this.struck.has(who)) return false;
      this.struck.add(who);
      const through = this.events.flesh?.(s) ?? false;
      this.bloody = Math.min(1, this.bloody + 0.5);
      p.jar(0.35);
      return !through;
    }
    if (kind & GROUP.PROP) {
      const body = s.hit.collider.parent();
      if (body) {
        const j = Math.min(body.mass() * s.speed * 0.6, 26);
        body.applyImpulseAtPoint({ x: s.direction.x * j, y: s.direction.y * j + j * 0.15, z: s.direction.z * j }, s.hit.point, true);
        strikeSurface(this.effects, s.hit.surface, s.hit.point, s.hit.normal, energy * 0.6);
        this.events.impact?.(s.hit.surface, s.hit.point, energy);
        if (body.mass() < 6) return false;
      }
      p.jar(0.5 * energy);
      return true;
    }
    strikeSurface(this.effects, s.hit.surface, s.hit.point, s.hit.normal, energy);
    this.events.impact?.(s.hit.surface, s.hit.point, energy);
    p.jar(0.9 * energy);
    return true;
  }
}
