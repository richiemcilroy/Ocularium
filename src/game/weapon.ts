import * as THREE from 'three/webgpu';
import type { Assets } from '../core/assets';
import type { Input } from '../core/input';
import { GROUP, RAPIER, groups, type Physics, type RayHit } from '../physics/physics';
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
  /** 1 for a plain blow, up to 2 for one wound up as far as it will go. */
  power: number;
}

/** What became of a blow: stopped by something hard, turned by armour, bitten into flesh, or gone clean through. */
export type Blow = 'blocked' | 'glanced' | 'cut' | 'through';

/** Anyone a blade can land on. */
export interface Target {
  struck(strike: Strike, part: string): Blow;
}

/** What a hit volume belongs to; kept against its collider in `Physics.owners`. */
export interface Owned {
  who: Target;
  part: string;
}

export interface ArmsEvents {
  swing?(thrust: boolean, charge: number): void;
  impact?(surface: SurfaceKind, point: THREE.Vector3, energy: number): void;
  guard?(raised: boolean): void;
  draw?(): void;
  /** A blow meant for the wearer stopped on the shield or the blade. */
  blocked?(point: THREE.Vector3, energy: number, on: 'shield' | 'blade'): void;
  /** Blood reached the lens. */
  spatter?(amount: number): void;
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

export const ease = (u: number) => u * u * (3 - 2 * u);
/** A cut starts drawn back this far round from straight ahead, and ends this far through. */
export const THETA0 = (-118 * Math.PI) / 180;
export const THETA1 = (68 * Math.PI) / 180;
const FORWARD = new THREE.Vector3(0, 0.1, -1).normalize();
const D = new THREE.Vector3(), E = new THREE.Vector3();

/** Pose part-way through a cut that travels across the body in direction `travel` (unit, in the view plane). */
export function cutPose(travel: THREE.Vector2, theta: number, out: Pose): Pose {
  const t = TV.set(travel.x, travel.y, 0);
  D.copy(FORWARD).multiplyScalar(Math.cos(theta)).addScaledVector(t, Math.sin(theta));
  E.copy(FORWARD).multiplyScalar(-Math.sin(theta)).addScaledVector(t, Math.cos(theta));
  // The hand rides a smaller arc in front of the shoulder and reaches out as the blade comes round.
  out.g.set(0.1, -0.2, -0.3).addScaledVector(t, 0.25 * Math.sin(theta)).addScaledVector(FORWARD, 0.2 * Math.max(0, Math.cos(theta)));
  if (theta < 0) out.g.y += 0.1 * Math.sin(-theta);
  bladeQuat(D, E, out.q);
  return out;
}

export function thrustPose(u: number, out: Pose): Pose {
  // u: -1 drawn back .. 1 fully extended; a little past either end for a blow wound up or driven home.
  const k = (u + 1) / 2;
  out.g.set(THREE.MathUtils.lerp(0.26, 0.06, k), THREE.MathUtils.lerp(-0.2, -0.13, k), THREE.MathUtils.lerp(-0.06, -0.62, k));
  bladeQuat(D.set(-0.07, 0.02, -1), E.set(0.3, -1, 0), out.q);
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

/** The sword held across the body to catch a blow, by someone with no shield to do it. */
export function parryPose(side: number, out: Pose): Pose {
  out.g.set(0.1 + 0.06 * side, -0.06, -0.4);
  bladeQuat(D.set(-0.8 * side, 0.58, -0.12), E.set(0, -0.2, -1), out.q);
  return out;
}

const UPPER = new THREE.Vector3();

/**
 * The shield on its arm: carried at the flank, or (`guard` 0..1) brought across
 * the body. `run` tucks it in for running; `knocked` 0..1 is a board beaten aside.
 */
export function boardPose(guard: number, run: number, knocked: number, out: Pose): Pose {
  const mix = THREE.MathUtils.lerp;
  UPPER.set(mix(-0.2, -0.08, guard) - 0.12 * knocked, mix(-0.95, -0.93, guard), mix(0.2, -0.36, guard) + 0.25 * run);
  return strappedPose(UPPER, mix(0.1, 0.87, guard) - 0.1 * run - 0.5 * knocked, mix(-0.12, -0.38, guard) - 0.2 * run, mix(0, -0.08, guard), out);
}

/** Points along the edge that are swept through the world, from just short of the point to just clear of the cross. */
const SAMPLES = [0.82, 0.71, 0.6, 0.49, 0.38, 0.27, 0.16];

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
  move(physics: Physics, grip: THREE.Vector3, q: THREE.Quaternion, dt: number, mask: number, exclude?: RAPIER.RigidBody, skip?: (collider: RAPIER.Collider) => boolean): Strike | null {
    let best: Strike | null = null;
    let bestT = Infinity;
    for (let i = 0; i < SAMPLES.length; i++) {
      this.p.set(0, SAMPLES[i], 0).applyQuaternion(q).add(grip);
      if (this.armed) {
        this.dir.subVectors(this.p, this.prev[i]);
        const len = this.dir.length();
        if (len > 1e-4) {
          this.dir.divideScalar(len);
          const hit = physics.raycast(this.prev[i], this.dir, len, mask, exclude, skip);
          if (hit && hit.distance / len < bestT) {
            bestT = hit.distance / len;
            best = { hit, speed: len / Math.max(dt, 1e-4), direction: this.dir.clone(), thrust: false, along: SAMPLES[i], power: 1 };
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
 * The hard things a fighter holds between themselves and a blade: the board of
 * the shield and the sword itself. They stop a blow only by being in its way.
 */
export class Ward {
  private shield: RAPIER.Collider | null = null;
  private blade: RAPIER.Collider;
  private centre = new THREE.Vector3();
  private v = new THREE.Vector3();
  private bladeMid = (SWORD.tip + SWORD.cross) / 2;

  constructor(private physics: Physics, who: Target, shield: THREE.Object3D | null) {
    const w = physics.world;
    // Fatter than the steel, so that a blade crossing a blade is caught between the points swept.
    this.blade = w.createCollider(RAPIER.ColliderDesc.cuboid(0.04, (SWORD.tip - SWORD.cross) / 2, 0.028).setCollisionGroups(groups(GROUP.HITBOX, GROUP.WEAPON)));
    this.blade.setEnabled(false);
    physics.tag(this.blade, 'metal');
    physics.owners.set(this.blade.handle, { who, part: 'blade' } satisfies Owned);
    if (shield) {
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
      this.shield = w.createCollider(RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, Math.max(0.03, size.z / 2)).setCollisionGroups(groups(GROUP.HITBOX, GROUP.WEAPON)));
      this.shield.setEnabled(false);
      physics.tag(this.shield, 'wood');
      physics.owners.set(this.shield.handle, { who, part: 'shield' } satisfies Owned);
    }
  }

  /** Moves the volumes to the weapons, and says which of them are being held in the way of a blow. */
  update(sword: THREE.Object3D, shield: THREE.Object3D | null, bladeUp: boolean, shieldUp: boolean): void {
    if (this.blade.isEnabled() !== bladeUp) this.blade.setEnabled(bladeUp);
    if (bladeUp) {
      this.blade.setTranslation(this.v.set(0, this.bladeMid, 0).applyQuaternion(sword.quaternion).add(sword.position));
      this.blade.setRotation(sword.quaternion);
    }
    if (this.shield && shield) {
      if (this.shield.isEnabled() !== shieldUp) this.shield.setEnabled(shieldUp);
      if (shieldUp) {
        this.shield.setTranslation(this.v.copy(this.centre).applyQuaternion(shield.quaternion).add(shield.position));
        this.shield.setRotation(shield.quaternion);
      }
    }
  }

  down(): void {
    this.blade.setEnabled(false);
    this.shield?.setEnabled(false);
  }

  dispose(): void {
    const w = this.physics.world;
    for (const c of [this.blade, this.shield]) {
      if (!c) continue;
      this.physics.owners.delete(c.handle);
      w.removeCollider(c, false);
    }
  }
}

type Phase = 'ready' | 'windup' | 'hold' | 'strike' | 'recover';
type Action = 'cut' | 'thrust';

/** How long a blow has to be held back to be wound up all the way, and how long the arm will hold it there. */
const CHARGE_TIME = 0.85;
const HOLD_LIMIT = 2.8;

/** The wearer switching the camera on, then taking hold of the sword: when each part of it ends, in seconds. */
const INTRO = { cover: 0.55, clear: 1.3, hilt: 1.7, drawn: 2.4 };
/** The sword in its scabbard at the left hip. */
const STOWED: Pose = { g: new THREE.Vector3(-0.12, -0.46, 0.0), q: bladeQuat(new THREE.Vector3(-0.22, -0.82, 0.52), new THREE.Vector3(0, 0, -1), new THREE.Quaternion()) };
/** The free hand at three moments, in the frame of the lens: wrist, which way the knuckles point, which way the palm faces, how closed it is. */
const HAND_KEYS: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3, number]> = [
  [new THREE.Vector3(0.08, -0.085, -0.118), new THREE.Vector3(-0.55, 0.83, 0), new THREE.Vector3(0, 0.05, 1), 0.1],
  [new THREE.Vector3(0.25, -0.34, -0.24), new THREE.Vector3(-0.25, 0.45, -0.85), new THREE.Vector3(-1, 0.1, 0.1), 0.3],
  [new THREE.Vector3(-0.06, -0.44, -0.03), new THREE.Vector3(-0.55, -0.75, 0.2), new THREE.Vector3(0.2, -0.3, 1), 0.7],
];

/**
 * The wearer's sword arm and shield arm. Everything is posed in the frame of
 * the aim, not the lens: the hands go where you point and the camera on the
 * chest catches up afterwards.
 */
export class Arms implements Target {
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
  /** 0..1 how far the blow in hand has been wound up. */
  charge = 0;
  /** Blows begun so far; anyone watching the sword can tell a new one from the last. */
  swings = 0;
  /** The sword hand while it is not on the sword, in world space; `active` says when that is. */
  readonly hand = { active: false, wrist: new THREE.Vector3(), knuckles: new THREE.Vector3(), palm: new THREE.Vector3(), curl: 0 };

  private t = 0;
  private duration = 0;
  private thrusting = false;
  private travel = new THREE.Vector2(-0.86, -0.5);
  private lastSide = 1;
  private queued: Action | null = null;
  private queuedKey = '';
  private key = '';
  private queueAge = 0;
  private trend = new THREE.Vector2();
  /** Where along its path the blow is: an angle for a cut, a reach for a thrust. */
  private at = 0;
  private from0 = 0;
  private to1 = 0;
  private power = 1;
  private broken = 0;
  private intro = INTRO.drawn;
  private drew = true;
  private pose: Pose = { g: new THREE.Vector3(0.2, -0.27, -0.34), q: new THREE.Quaternion() };
  private from: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };
  private target: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };
  private shieldPose: Pose = { g: new THREE.Vector3(-0.32, -0.8, -0.18), q: new THREE.Quaternion() };
  private sweep = new BladeSweep();
  private hitOnce = new Set<unknown>();
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
  private ward: Ward;
  private trunk: RAPIER.Collider;
  private head: RAPIER.Collider;
  private mine = (c: RAPIER.Collider) => (this.physics.owners.get(c.handle) as Owned | undefined)?.who === this;

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
    this.ward = new Ward(physics, this, this.shield);
    // What a blade finds if nothing is in its way: the wearer.
    const w = physics.world;
    const volume = (desc: RAPIER.ColliderDesc, part: string) => {
      const c = w.createCollider(desc.setCollisionGroups(groups(GROUP.HITBOX, GROUP.WEAPON)), player.rigidBody);
      physics.owners.set(c.handle, { who: this, part } satisfies Owned);
      return c;
    };
    this.trunk = volume(RAPIER.ColliderDesc.capsule(0.42, 0.2).setTranslation(0, 0.84, 0), 'body');
    this.head = volume(RAPIER.ColliderDesc.ball(0.115).setTranslation(0, 1.63, 0), 'head');
  }

  /** The sword at rest, as this wearer carries it. */
  private guardPose(out: Pose): Pose {
    const p = this.player;
    // A tired arm lets the point and the hand sink.
    return carryPose(p.sprinting ? 1 : 0, this.guard, Math.max(0, 0.5 - p.stamina) * 0.16, out);
  }

  get attacking(): boolean {
    return this.phase === 'windup' || this.phase === 'hold' || this.phase === 'strike';
  }

  /** True while the wearer's hands are busy with the camera or the scabbard. */
  get busy(): boolean {
    return this.intro < INTRO.drawn;
  }

  /** True while the hand is still on the camera. */
  get covering(): boolean {
    return this.intro < INTRO.clear;
  }

  /** Puts the sword back in its scabbard and the hand on the camera: the start of a recording. */
  stow(): void {
    this.intro = 0;
    this.drew = false;
    this.phase = 'ready';
    this.queued = null;
    this.charge = 0;
    this.guard = 0;
    this.bloody = 0;
    this.broken = 0;
    this.sword.visible = false;
    this.shield.visible = true;
    this.pose.g.copy(STOWED.g);
    this.pose.q.copy(STOWED.q);
    this.player.twist.set(0, 0, 0);
    this.player.encumbered = 0;
  }

  /** The wearer is down: nothing in these hands stops anything any more. */
  drop(): void {
    this.ward.down();
    this.trunk.setEnabled(false);
    this.head.setEnabled(false);
    this.phase = 'ready';
    this.charge = 0;
    this.hand.active = false;
    this.player.twist.set(0, 0, 0);
    this.player.encumbered = 0;
  }

  /** Back on their feet. */
  raise(): void {
    this.trunk.setEnabled(true);
    this.head.setEnabled(true);
  }

  /** A blow meant for the wearer arrived. */
  struck(s: Strike, part: string): Blow {
    const p = this.player;
    if (p.dead) return 'through';
    const force = THREE.MathUtils.clamp(s.speed / 11, 0.35, 1.5) * s.power;
    if (part === 'shield') {
      p.tire(0.045 + 0.06 * force);
      p.jar(1.3 * force);
      this.effects.chips(s.hit.point, s.hit.normal, WOOD, Math.round(4 + 6 * force));
      this.events.blocked?.(s.hit.point, force, 'shield');
      // A heavy blow on a spent arm knocks the board aside.
      if (p.stamina < 0.04 || (s.power > 1.5 && p.stamina < 0.3)) this.broken = 0.9;
      return 'blocked';
    }
    if (part === 'blade') {
      p.tire(0.03 + 0.03 * force);
      p.jar(0.9 * force);
      this.effects.sparks(s.hit.point, s.hit.normal, Math.round(6 + 8 * force), 0.8);
      this.events.blocked?.(s.hit.point, force, 'blade');
      if (this.phase === 'strike' || this.phase === 'hold' || this.phase === 'windup') this.recover(0.55);
      return 'blocked';
    }
    // Gambeson and helmet take the edge off a cut; a point goes in.
    const amount = (part === 'head' ? (s.thrust ? 52 : 40) : s.thrust ? 38 : 26) * force;
    this.effects.blood(s.hit.point, s.direction, Math.round(8 + amount * 0.3), 1.1);
    this.events.spatter?.(Math.min(1, amount / 70));
    if (this.attacking && amount > 18) this.recover(0.5);
    p.hurt(amount, s.direction);
    return 'cut';
  }

  private begin(kind: Action, key: string): void {
    const p = this.player;
    this.thrusting = kind === 'thrust';
    this.key = key;
    this.swings++;
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
    this.charge = 0;
    // Tired arms are slow arms.
    this.slow = 1 + 0.45 * (1 - ease(THREE.MathUtils.clamp(p.stamina / 0.4, 0, 1)));
    this.duration = (this.thrusting ? 0.2 : 0.25) * this.slow;
    this.at = this.thrusting ? -1 : THETA0;
    this.hitOnce.clear();
  }

  /** Lets the blow go. */
  private release(): void {
    const p = this.player;
    const c = this.charge;
    this.phase = 'strike';
    this.t = 0;
    this.power = 1 + c;
    this.from0 = this.at;
    this.to1 = this.thrusting ? 1 + 0.14 * c : THETA1 + 0.24 * c;
    // Further to travel, and covered faster: that is what the wind-up bought.
    this.duration = (this.thrusting ? 0.15 : 0.23) * this.slow * (1 - 0.08 * c);
    this.sweep.reset();
    p.tire((this.thrusting ? 0.035 : 0.045) + 0.07 * c);
    p.lunge((this.thrusting ? 1.3 : 0.9) + 1.1 * c);
    this.events.swing?.(this.thrusting, c);
  }

  private recover(duration: number): void {
    this.phase = 'recover';
    this.t = 0;
    this.duration = duration;
    this.charge = 0;
    this.from.g.copy(this.pose.g);
    this.from.q.copy(this.pose.q);
  }

  private stage(at: number, out: Pose): Pose {
    return this.thrusting ? thrustPose(at, out) : cutPose(this.travel, at, out);
  }

  update(dt: number, input: Input): void {
    const p = this.player;
    if (p.dead) return;

    // Which way the hand has been moving lately.
    const k = Math.exp(-dt / 0.1);
    this.trend.multiplyScalar(k).add(this.v.set(p.look.x, p.look.y, 0));
    const busy = this.busy;
    if (!busy) {
      if (input.hit('Mouse0')) (this.queued = 'cut'), (this.queuedKey = 'Mouse0'), (this.queueAge = 0);
      for (const key of ['Mouse1', 'KeyF']) if (input.hit(key)) (this.queued = 'thrust'), (this.queuedKey = key), (this.queueAge = 0);
    }
    if (this.queued && (this.queueAge += dt) > 0.3) this.queued = null;

    this.broken = Math.max(0, this.broken - dt);
    const wantGuard = input.down('Mouse2') && !this.attacking && !busy && this.broken <= 0;
    const before = this.guard > 0.5;
    this.guard += ((wantGuard ? 1 : 0) - this.guard) * (1 - Math.exp(-dt * (wantGuard ? 14 : this.broken > 0 ? 20 : 8)));
    if (this.guard > 0.5 !== before) this.events.guard?.(!before);

    if (this.queued && (this.phase === 'ready' || (this.phase === 'recover' && this.t > this.duration * 0.5)) && p.stamina > 0.03) {
      this.begin(this.queued, this.queuedKey);
      this.queued = null;
    }

    // Frame of the aim, with the weapon's own inertia: it trails a turning hand and overshoots when the hand stops.
    const sy = this.swayYaw.step(dt, THREE.MathUtils.clamp((p.look.x / Math.max(dt, 1e-3)) * 0.02, -0.16, 0.16));
    const sp = this.swayPitch.step(dt, THREE.MathUtils.clamp((p.look.y / Math.max(dt, 1e-3)) * 0.02, -0.12, 0.12));
    this.frame.setFromEuler(this.e.set(p.aimPitch * 0.92 + sp, p.aimYaw + sy, 0));

    // Sword against a wall: bring the point up rather than push it through the stone.
    let crowd = 0;
    if (!this.attacking && !busy) {
      this.v.set(0, 0, -1).applyQuaternion(this.frame);
      const hit = this.physics.raycast(p.eye, this.v, 1.0, GROUP.WORLD);
      if (hit) crowd = THREE.MathUtils.clamp((1.0 - hit.distance) / 0.6, 0, 1);
    }
    this.crowd += (crowd - this.crowd) * (1 - Math.exp(-dt * 10));

    this.t += dt;
    const u = Math.min(1, this.t / this.duration);
    // How far the blow turns the trunk under the camera: back with the wind-up, through with the stroke.
    const side = Math.sign(this.travel.x) || 1;
    let twistYaw = 0, twistPitch = 0, twistRoll = 0, weigh = 0;
    if (busy) this.introduce(dt);
    else if (this.phase === 'windup') {
      this.stage(this.at, this.target);
      const s = ease(u);
      this.pose.g.lerpVectors(this.from.g, this.target.g, s);
      this.pose.q.slerpQuaternions(this.from.q, this.target.q, s);
      twistYaw = (this.thrusting ? -0.035 : side * 0.04) * s;
      twistPitch = this.thrusting ? 0 : 0.012 * s;
      if (u >= 1) {
        if (input.down(this.key) && p.stamina > 0.06) (this.phase = 'hold'), (this.t = 0);
        else this.release();
      }
    } else if (this.phase === 'hold') {
      // Held back: the arm draws further round and the trunk winds up behind it, for as long as it can.
      this.charge = Math.min(1, this.t / (CHARGE_TIME * this.slow));
      const c = ease(this.charge);
      this.at = this.thrusting ? -1 - 0.32 * c : THETA0 - 0.44 * c;
      this.stage(this.at, this.pose);
      // The strain of holding it shows in the point.
      const shake = this.charge >= 1 ? Math.min(1, (this.t - CHARGE_TIME * this.slow) / 1.2) : 0;
      this.pose.g.x += Math.sin(this.t * 31) * 0.004 * shake;
      this.pose.g.y += Math.sin(this.t * 37 + 1) * 0.004 * shake;
      twistYaw = this.thrusting ? -0.035 - 0.05 * c : side * (0.04 + 0.1 * c);
      twistPitch = this.thrusting ? 0 : 0.012 + 0.02 * c;
      twistRoll = this.thrusting ? 0 : -side * 0.03 * c;
      weigh = 0.4 + 0.6 * c;
      p.tire(dt * 0.035);
      if (!input.down(this.key) || this.t > HOLD_LIMIT || p.stamina <= 0.03) this.release();
    } else if (this.phase === 'strike') {
      const c = this.power - 1;
      // Several steps per frame so the arc is tested as an arc.
      const steps = 4;
      const t0 = this.t - dt;
      let stop: Blow | 'world' | null = null;
      for (let i = 1; i <= steps && !stop; i++) {
        const ui = THREE.MathUtils.clamp((t0 + (dt * i) / steps) / this.duration, 0, 1);
        this.at = this.from0 + (this.to1 - this.from0) * ease(this.thrusting ? Math.min(1, ui * 1.15) : ui);
        this.stage(this.at, this.sub);
        this.toWorld(this.sub, this.v, this.q, 'sword');
        const strike = this.sweep.move(this.physics, this.v, this.q, dt / steps, GROUP.WORLD | GROUP.PROP | GROUP.HITBOX, p.rigidBody, this.mine);
        this.pose.g.copy(this.sub.g);
        this.pose.q.copy(this.sub.q);
        if (strike) stop = this.landed(strike);
      }
      twistYaw = this.thrusting ? -0.035 - 0.05 * c + (0.08 + 0.09 * c) * ease(u) : side * (0.04 + 0.1 * c) - side * (0.1 + 0.2 * c) * ease(u);
      twistPitch = this.thrusting ? -0.01 * ease(u) : 0.012 + 0.02 * c - (0.04 + 0.05 * c) * ease(u);
      twistRoll = this.thrusting ? 0 : -side * 0.03 * c + side * 0.06 * c * ease(u);
      weigh = 0.3;
      if (p.dead) return;
      if (this.phase === 'strike' && (u >= 1 || stop)) this.recover(stop === 'blocked' ? 0.62 : stop ? 0.5 : 0.4 + 0.12 * c);
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
    p.twist.set(twistPitch, twistYaw, twistRoll);
    p.encumbered += (Math.max(weigh, this.guard * 0.45) - p.encumbered) * (1 - Math.exp(-dt * 8));

    // Shield arm.
    const g = ease(this.guard);
    const run = p.sprinting ? 1 : 0;
    const knocked = this.broken > 0 ? ease(Math.min(1, this.broken / 0.3)) : 0;
    boardPose(g, run, knocked, this.target);
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

    // The blade is in the way of a blow only while it is being used; the shield only while it is up.
    this.ward.update(this.sword, this.shield, !busy && (this.phase === 'strike' || this.phase === 'hold' || this.guard > 0.6), this.guard > 0.55);
    const low = 1 - 0.3 * p.crouch;
    this.trunk.setTranslationWrtParent({ x: 0, y: 0.84 * low, z: 0 });
    this.head.setTranslationWrtParent({ x: 0, y: p.chest + 0.25, z: 0 });
  }

  /** The start of a recording: a hand comes off the camera, goes to the hilt, and draws. */
  private introduce(dt: number): void {
    const p = this.player;
    this.intro += dt;
    const t = this.intro;
    const h = this.hand;
    h.active = t < INTRO.hilt;
    if (h.active) {
      // From the lens to clear of it, then down to the hilt.
      const [a, b, u] = t < INTRO.clear ? [0, 1, ease(THREE.MathUtils.clamp((t - INTRO.cover) / (INTRO.clear - INTRO.cover), 0, 1))] : [1, 2, ease((t - INTRO.clear) / (INTRO.hilt - INTRO.clear))];
      const A = HAND_KEYS[a], B = HAND_KEYS[b];
      h.wrist.lerpVectors(A[0], B[0], u).applyQuaternion(p.orientation).add(p.eye);
      h.knuckles.lerpVectors(A[1], B[1], u).normalize().applyQuaternion(p.orientation);
      h.palm.lerpVectors(A[2], B[2], u).normalize().applyQuaternion(p.orientation);
      h.curl = A[3] + (B[3] - A[3]) * u;
      this.pose.g.copy(STOWED.g);
      this.pose.q.copy(STOWED.q);
      return;
    }
    if (!this.drew) {
      this.drew = true;
      this.sword.visible = true;
      this.events.draw?.();
    }
    const u = ease(THREE.MathUtils.clamp((t - INTRO.hilt) / (INTRO.drawn - INTRO.hilt), 0, 1));
    this.guardPose(this.target);
    // Out and up along the line of the scabbard before it comes across.
    this.pose.g.lerpVectors(STOWED.g, this.target.g, u);
    this.pose.g.y += Math.sin(u * Math.PI) * 0.1;
    this.pose.g.z -= Math.sin(u * Math.PI) * 0.12;
    this.pose.q.slerpQuaternions(STOWED.q, this.target.q, ease(u));
    if (this.intro >= INTRO.drawn) this.phase = 'ready';
  }

  private toWorld(pose: Pose, position: THREE.Vector3, quaternion: THREE.Quaternion, hand: 'sword' | 'shield'): void {
    position.copy(pose.g).applyQuaternion(this.frame).add(this.player.eye);
    quaternion.copy(this.frame).multiply(pose.q);
    this.limit?.(hand, position, quaternion);
  }

  /** The blade met something. Says what stopped the stroke, if anything did. */
  private landed(s: Strike): Blow | 'world' | null {
    const p = this.player;
    s.thrust = this.thrusting;
    s.power = this.power;
    const kind = s.hit.collider.collisionGroups() >>> 16;
    const energy = Math.min(1.5, s.speed / 14) * (0.7 + 0.3 * this.power);
    if (kind & GROUP.HITBOX) {
      const owner = this.physics.owners.get(s.hit.collider.handle) as Owned | undefined;
      if (!owner || this.hitOnce.has(owner.who)) return null;
      this.hitOnce.add(owner.who);
      const blow = owner.who.struck(s, owner.part);
      if (blow === 'blocked') {
        p.jar(1.1 * energy);
        p.tire(0.03);
        return blow;
      }
      if (blow === 'glanced') {
        p.jar(0.6 * energy);
        return blow;
      }
      this.bloody = Math.min(1, this.bloody + 0.5);
      p.jar(0.35 * energy);
      return blow === 'through' ? null : blow;
    }
    if (kind & GROUP.PROP) {
      const body = s.hit.collider.parent();
      if (body) {
        const j = Math.min(body.mass() * s.speed * 0.6, 26) * this.power;
        body.applyImpulseAtPoint({ x: s.direction.x * j, y: s.direction.y * j + j * 0.15, z: s.direction.z * j }, s.hit.point, true);
        strikeSurface(this.effects, s.hit.surface, s.hit.point, s.hit.normal, energy * 0.6);
        this.events.impact?.(s.hit.surface, s.hit.point, energy);
        if (body.mass() < 6 * this.power) return null;
      }
      p.jar(0.5 * energy);
      return 'world';
    }
    strikeSurface(this.effects, s.hit.surface, s.hit.point, s.hit.normal, energy);
    this.events.impact?.(s.hit.surface, s.hit.point, energy);
    p.jar(0.9 * energy);
    return 'world';
  }
}

const WOOD = new THREE.Color(0.36, 0.26, 0.17);
