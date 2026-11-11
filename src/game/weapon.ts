import * as THREE from 'three/webgpu';
import type { Assets } from '../core/assets';
import type { Input } from '../core/input';
import { GROUP, RAPIER, groups, type Physics } from '../physics/physics';
import type { Effects } from '../world/effects';
import { noise } from '../world/terrain';
import type { Player } from './player';
import { Board, REACH, SWORD, Steel, bladeQuat, bloodied, carryPose, ease, lungePose, severity, swingPose, withinReach, type Blow, type Owned, type Pose, type Strike, type Target, type Voice } from './steel';

export { SWORD, bladeQuat, carryPose, ease };
export type { Blow, Owned, Pose, Strike, Target };

export interface ArmsEvents {
  swing?(thrust: boolean, charge: number): void;
  guard?(raised: boolean): void;
  draw?(): void;
  /** Blood reached the lens. */
  spatter?(amount: number): void;
}

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
const UPPER = new THREE.Vector3();

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

/**
 * The shield on its arm: carried at the flank, or (`guard` 0..1) brought across
 * the body. `run` tucks it in for running; `knocked` 0..1 is a board beaten
 * aside; `towards` turns a raised board a little to meet what is coming.
 */
export function boardPose(guard: number, run: number, knocked: number, out: Pose, towards = 0): Pose {
  const mix = THREE.MathUtils.lerp;
  UPPER.set(mix(-0.2, -0.08, guard) - 0.12 * knocked, mix(-0.95, -0.93, guard), mix(0.2, -0.36, guard) + 0.25 * run);
  return strappedPose(UPPER, mix(0.1, 0.87, guard) - 0.1 * run - 0.5 * knocked + 0.3 * towards * guard, mix(-0.12, -0.38, guard) - 0.2 * run, mix(0, -0.08, guard), out);
}

type Mode = 'guard' | 'cut' | 'thrust';
type Stage = 'hold' | 'throw' | 'recover';

/** How long a blow has to be held back before everything is behind it, and how long the arm will hold it there. */
const CHARGE_TIME = 0.9;
const HOLD_LIMIT = 3.2;
/** How far a turn of the mouse carries the hand, in metres per radian. */
const DRAG = 1.7;

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
 * The wearer's sword arm and shield arm.
 *
 * There are no strokes stored here to be played back. Holding the cut button
 * takes the sword hand out of the business of turning the body and gives it
 * to the mouse: the hand goes where the mouse takes it, and the sword, which
 * has weight, follows as well as an arm can make it. Drawing the hand out to
 * one side and letting go throws it across to the other; dragging it there
 * oneself does the same. How fast the blade is going when it arrives, and what
 * it does there, comes out of that and nothing else.
 */
export class Arms implements Target {
  readonly sword = new THREE.Group();
  readonly shield = new THREE.Group();
  readonly steel: Steel;
  events: ArmsEvents = {};
  voice: Voice | null = null;
  /** Set by the body that carries these: pulls a weapon back to where the arm can actually hold it. */
  limit: ((hand: 'sword' | 'shield', position: THREE.Vector3, quaternion: THREE.Quaternion) => void) | null = null;
  /** 0 lowered .. 1 shield raised. */
  guard = 0;
  /** Blood on the blade, 0..1. */
  bloody = 0;
  /** 0..1 how much is being put behind the blow in hand. */
  charge = 0;
  /** Blows begun so far; anyone watching the sword can tell a new one from the last. */
  swings = 0;
  /** The sword hand while it is not on the sword, in world space; `active` says when that is. */
  readonly hand = { active: false, wrist: new THREE.Vector3(), knuckles: new THREE.Vector3(), palm: new THREE.Vector3(), curl: 0 };
  /** Where the sword hand has been carried to, off centre: x to the right, y up, in metres. */
  readonly offset = new THREE.Vector2();

  private mode: Mode = 'guard';
  private stage: Stage = 'hold';
  private t = 0;
  private duration = 0.2;
  private key = '';
  private user = new THREE.Vector2();
  private dragged = 0;
  private wind = new THREE.Vector2(1, 0.4);
  private lastSide = 1;
  private from = new THREE.Vector2();
  private to = new THREE.Vector2();
  private via = new THREE.Vector2();
  private pre = 0;
  private heading = new THREE.Vector2();
  private reach = -1;
  private reachFrom = -1;
  private reachTo = 1;
  private steer = new THREE.Vector2();
  private trend = new THREE.Vector2();
  private broken = 0;
  private intro = INTRO.drawn;
  private drew = true;
  private time = 0;
  private pose: Pose = { g: new THREE.Vector3(0.2, -0.27, -0.34), q: new THREE.Quaternion() };
  private rest: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };
  private target: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };
  private shieldPose: Pose = { g: new THREE.Vector3(-0.32, -0.8, -0.18), q: new THREE.Quaternion() };
  private bob = 0;
  private crowd = 0;
  private frame = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private v2 = new THREE.Vector2();
  private origin = new THREE.Vector2();
  private sub: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };
  private board: Board;
  private blood: { value: number };
  private trunk: RAPIER.Collider;
  private head: RAPIER.Collider;

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
    this.blood = bloodied(this.sword);
    this.steel = new Steel(physics, this.sword, this, 0, effects, () => this.voice);
    this.steel.onFlesh = (strike, owner) => {
      const blow = owner.who.struck(strike, owner.part);
      if (blow === 'cut' || blow === 'through') {
        this.bloody = Math.min(1, this.bloody + 0.3);
        player.jar(0.3);
      } else if (blow === 'glanced') player.jar(0.6);
      return blow;
    };
    this.steel.onStop = (kind, energy) => {
      player.jar((kind === 'world' ? 0.9 : kind === 'prop' ? 0.35 : kind === 'shield' ? 1 : 0.8) * energy);
      if (kind === 'shield' || kind === 'blade') player.tire(0.025 * energy);
    };
    this.board = new Board(physics, this.shield, this, 0);
    // What a blade finds if nothing is in its way: the wearer.
    const w = physics.world;
    const volume = (desc: RAPIER.ColliderDesc, part: string) => {
      const c = w.createCollider(desc.setCollisionGroups(groups(GROUP.HITBOX, GROUP.WEAPON)), player.rigidBody);
      physics.owners.set(c.handle, { who: this, part } satisfies Owned);
      return c;
    };
    this.trunk = volume(RAPIER.ColliderDesc.capsule(0.42, 0.2).setTranslation(0, 0.84, 0), 'body');
    this.head = volume(RAPIER.ColliderDesc.ball(0.115).setTranslation(0, 1.63, 0), 'head');
    carryPose(0, 0, 0, this.pose);
  }

  /** What the sword arm is doing, for anyone watching it. */
  get phase(): 'ready' | 'hold' | 'strike' | 'recover' {
    return this.mode === 'guard' ? 'ready' : this.stage === 'hold' ? 'hold' : this.stage === 'throw' ? 'strike' : 'recover';
  }

  get attacking(): boolean {
    return this.mode !== 'guard' && this.stage !== 'recover';
  }

  /** Drawn back, with a blow ready to go. */
  get loaded(): boolean {
    return this.mode !== 'guard' && this.stage === 'hold' && (this.mode === 'thrust' || this.offset.length() > 0.3);
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
    this.mode = 'guard';
    this.charge = 0;
    this.guard = 0;
    this.bloody = 0;
    this.broken = 0;
    this.offset.set(0, 0);
    this.sword.visible = false;
    this.shield.visible = true;
    this.steel.live = false;
    this.board.live = true;
    this.player.twist.set(0, 0, 0);
    this.player.encumbered = 0;
    this.player.grip = 0;
  }

  /** The wearer is down: nothing in these hands stops anything any more. */
  drop(): void {
    this.steel.live = false;
    this.board.live = false;
    this.trunk.setEnabled(false);
    this.head.setEnabled(false);
    this.mode = 'guard';
    this.charge = 0;
    this.hand.active = false;
    this.player.twist.set(0, 0, 0);
    this.player.encumbered = 0;
    this.player.grip = 0;
  }

  /** Back on their feet. */
  raise(): void {
    this.trunk.setEnabled(true);
    this.head.setEnabled(true);
  }

  /** A blade reached the wearer. */
  struck(s: Strike, part: string): Blow {
    const p = this.player;
    if (p.dead) return 'through';
    const sev = severity(s);
    if (sev < 0.12) return 'nothing';
    // Gambeson and helmet take the edge off a cut; a point goes in.
    const amount = Math.min(96, (part === 'head' ? (s.thrust ? 42 : 26) : s.thrust ? 30 : 17) * sev);
    this.effects.blood(s.hit.point, s.direction, Math.round(6 + amount * 0.4), 1.1);
    this.events.spatter?.(Math.min(1, amount / 70));
    this.voice?.flesh(s.hit.point, Math.min(1.5, sev));
    // A real wound stops whatever the arm was about.
    if (this.mode !== 'guard' && amount > 14) this.mode = 'guard';
    p.hurt(amount, s.direction);
    return 'cut';
  }

  /** Somebody's blade stopped on the shield or the sword. */
  parried(on: 'shield' | 'blade', energy: number): void {
    const p = this.player;
    if (on === 'shield') {
      p.tire(0.07 * energy);
      p.jar(1.1 * energy);
      // A heavy blow on a spent arm knocks the board aside.
      if (p.stamina < 0.04 || (energy > 1.1 && p.stamina < 0.3)) this.broken = 0.9;
    } else {
      p.tire(0.045 * energy);
      p.jar(0.7 * energy);
    }
  }

  private begin(mode: Mode, key: string): void {
    const flowing = this.mode === 'cut' && this.stage === 'recover';
    this.mode = mode;
    this.stage = 'hold';
    this.key = key;
    this.t = 0;
    this.charge = 0;
    this.dragged = 0;
    this.swings++;
    // A cut begun out of the last one starts from where the last one ended.
    if (flowing) this.user.copy(this.offset);
    else this.user.set(0, 0);
    this.steer.set(0, 0);
    this.reach = -1;
    // Left to itself the hand draws back to one side: away from where the mouse has been heading, or else
    // the side it did not use last time, and never at quite the same angle twice.
    if (this.trend.length() > 0.012) this.wind.set(-this.trend.x, this.trend.y).normalize();
    else {
      this.lastSide = -this.lastSide;
      this.wind.set(this.lastSide, 0.15 + Math.random() * 0.75).normalize();
    }
    this.wind.rotateAround(this.origin, (Math.random() - 0.5) * 0.35);
    if (flowing) this.wind.set(0, 0);
    this.lastSide = Math.sign(this.wind.x) || this.lastSide;
  }

  /** How strongly the arm can drive the sword just now. */
  private strength(): number {
    const p = this.player;
    return (0.72 + 0.28 * ease(THREE.MathUtils.clamp(p.stamina / 0.4, 0, 1))) * (0.85 + 0.15 * (p.health / 100));
  }

  /** Lets the blow go. */
  private release(): void {
    const p = this.player, c = this.charge;
    this.stage = 'throw';
    this.t = 0;
    this.steel.power = 1 + c;
    const s = this.strength() * (1 + 0.35 * c);
    if (this.mode === 'thrust') {
      this.reachFrom = this.reach;
      this.reachTo = 1 + 0.16 * c;
      this.duration = 0.15 / s;
      p.tire(0.03 + 0.06 * c);
      p.lunge(1.3 + 1.1 * c);
    } else {
      this.from.copy(this.offset);
      // Let go before the hand had gone anywhere, it is drawn back first and thrown from there.
      this.pre = this.from.length() < 0.22 ? 0.42 : 0;
      if (this.wind.lengthSq() < 0.01) this.wind.set(-this.lastSide, 0.4).normalize();
      this.via.copy(this.wind).multiplyScalar(0.5);
      const start = this.pre ? this.via : this.from;
      // Across to the far side, a little further for a hard blow, and never along quite the same line.
      this.to.copy(start).normalize().multiplyScalar(-(0.56 + 0.08 * c)).rotateAround(this.origin, (Math.random() - 0.5) * 0.4);
      this.to.x *= REACH.x / 0.62;
      withinReach(this.to);
      this.duration = (0.21 + 0.06 * Math.random() + (this.pre ? 0.14 : 0)) / s;
      this.user.set(0, 0);
      p.tire(0.035 + 0.07 * c);
      p.lunge(0.9 + 1.1 * c);
    }
    this.events.swing?.(this.mode === 'thrust', c);
  }

  update(dt: number, input: Input): void {
    const p = this.player;
    if (p.dead) return;
    this.time += dt;

    // Which way the hand has been moving lately.
    const k = Math.exp(-dt / 0.1);
    this.trend.multiplyScalar(k).add(this.v2.set(p.look.x, p.look.y));
    const busy = this.busy;
    const free = this.mode === 'guard' || this.stage === 'recover';
    if (!busy && free && p.stamina > 0.04) {
      if (input.hit('Mouse0')) this.begin('cut', 'Mouse0');
      else for (const key of ['Mouse1', 'KeyF']) if (input.hit(key)) this.begin('thrust', key);
    }

    this.broken = Math.max(0, this.broken - dt);
    const wantGuard = input.down('Mouse2') && !busy && this.broken <= 0;
    const before = this.guard > 0.5;
    this.guard += ((wantGuard ? 1 : 0) - this.guard) * (1 - Math.exp(-dt * (wantGuard ? 14 : this.broken > 0 ? 20 : 8)));
    if (this.guard > 0.5 !== before) this.events.guard?.(!before);

    this.frame.setFromEuler(this.e.set(p.aimPitch * 0.92, p.aimYaw, 0));

    // Sword against a wall: bring the point up rather than push it through the stone.
    let crowd = 0;
    if (this.mode === 'guard' && !busy) {
      this.v.set(0, 0, -1).applyQuaternion(this.frame);
      const hit = this.physics.raycast(p.eye, this.v, 1.0, GROUP.WORLD);
      if (hit) crowd = THREE.MathUtils.clamp((1.0 - hit.distance) / 0.6, 0, 1);
    }
    this.crowd += (crowd - this.crowd) * (1 - Math.exp(-dt * 10));

    this.t += dt;
    const u = Math.min(1, this.t / this.duration);
    const steel = this.steel;
    const s = this.strength();
    const drag = this.v2.set(p.look.x, -p.look.y).multiplyScalar(DRAG);
    let weigh = 0, grip = 0;
    // The sword at rest, which everything comes back to: never quite still, and lower as the arm tires.
    const tired = Math.max(0, 0.5 - p.stamina);
    carryPose(p.sprinting ? 1 : 0, this.guard, tired * 0.16, this.rest);
    const wander = 0.006 + 0.02 * tired + 0.012 * p.exertion;
    this.rest.g.x += noise(this.time * 0.7, 1.3) * wander;
    this.rest.g.y += noise(this.time * 0.9, 7.1) * wander + Math.sin(p.breathPhase * Math.PI * 2) * 0.004;
    this.rest.q.multiply(this.q.setFromEuler(this.e.set(noise(this.time * 0.6, 4.4) * wander * 3, 0, noise(this.time * 0.5, 9.9) * wander * 4)));

    if (busy) this.introduce(dt);
    else if (this.mode === 'guard') {
      this.pose.g.copy(this.rest.g);
      this.pose.q.copy(this.rest.q);
      this.offset.multiplyScalar(Math.exp(-dt * 8));
      steel.linAcc = 42 * s;
      steel.angAcc = 60 * s;
      steel.maxSpeed = 5.5;
      steel.maxSpin = 12;
      steel.power = 1;
    } else if (this.mode === 'cut') {
      if (this.stage === 'hold') {
        // The hand is the mouse's now. Left alone, it draws back by itself; taken anywhere, it goes there.
        this.user.add(drag);
        withinReach(this.user);
        this.dragged += drag.length();
        const own = 1 - ease(THREE.MathUtils.clamp((this.dragged - 0.08) / 0.3, 0, 1));
        this.offset.copy(this.wind).multiplyScalar(0.52 * ease(Math.min(1, this.t / 0.3)) * own).add(this.user);
        withinReach(this.offset);
        this.charge = Math.min(1, this.t / CHARGE_TIME);
        this.heading.copy(this.offset).negate();
        steel.linAcc = 60 * s;
        steel.angAcc = 100 * s;
        steel.maxSpeed = 9 * s;
        steel.maxSpin = 20 * s;
        steel.power = 1 + this.charge;
        weigh = 0.35 + 0.5 * this.charge;
        grip = 1;
        // Moving the sword about costs a little; holding it drawn back costs as long as it is held.
        const cost = drag.length() * 0.012 + (this.offset.length() > 0.3 ? dt * 0.03 : 0);
        if (cost > 0) p.tire(cost);
        if (!input.down(this.key) || this.t > HOLD_LIMIT || p.stamina <= 0.03) this.release();
      } else if (this.stage === 'throw') {
        const c = this.charge;
        // Thrown across, and still steered a little by the mouse on the way.
        this.user.add(drag.multiplyScalar(0.6)).multiplyScalar(Math.exp(-dt * 3));
        const split = this.pre;
        if (u < split) this.offset.lerpVectors(this.from, this.via, ease(u / split));
        else {
          const start = split ? this.via : this.from;
          const w = (u - split) / (1 - split);
          this.offset.lerpVectors(start, this.to, w * w * (3 - 2 * w));
          this.heading.subVectors(this.to, start);
        }
        this.offset.add(this.user);
        withinReach(this.offset);
        const drive = s * (1 + 0.55 * c);
        steel.linAcc = 88 * drive;
        steel.angAcc = 150 * drive;
        steel.maxSpeed = 11.5 * drive;
        steel.maxSpin = 27 * drive;
        weigh = 0.3;
        grip = 1;
        if (u >= 1) {
          this.stage = 'recover';
          this.t = 0;
          this.duration = 0.32 + 0.12 * c;
        }
      } else {
        this.offset.multiplyScalar(Math.exp(-dt * 6));
        steel.linAcc = 50 * s;
        steel.angAcc = 75 * s;
        steel.maxSpeed = 7;
        steel.maxSpin = 14;
        steel.power = 1;
        grip = 1 - u;
        if (u >= 1) this.mode = 'guard';
      }
      swingPose(this.offset, this.heading, this.pose);
      if (this.stage === 'recover') {
        const b = ease(u);
        this.pose.g.lerp(this.rest.g, b);
        this.pose.q.slerp(this.rest.q, b);
      }
    } else {
      // The thrust: drawn back, the point steered by the mouse, then driven out.
      if (this.stage === 'hold') {
        this.charge = Math.min(1, this.t / CHARGE_TIME);
        this.steer.add(drag.multiplyScalar(0.5)).clampLength(0, 0.4);
        this.reach += (-1 - 0.32 * ease(this.charge) - this.reach) * (1 - Math.exp(-dt * 14));
        steel.linAcc = 60 * s;
        steel.angAcc = 100 * s;
        steel.maxSpeed = 8 * s;
        steel.maxSpin = 18 * s;
        weigh = 0.3 + 0.4 * this.charge;
        grip = 0.8;
        if (this.charge > 0.2) p.tire(dt * 0.03);
        if (!input.down(this.key) || this.t > HOLD_LIMIT || p.stamina <= 0.03) this.release();
      } else if (this.stage === 'throw') {
        const drive = s * (1 + 0.5 * this.charge);
        this.reach = this.reachFrom + (this.reachTo - this.reachFrom) * ease(u);
        steel.linAcc = 110 * drive;
        steel.angAcc = 130 * drive;
        steel.maxSpeed = 10 * drive;
        steel.maxSpin = 20;
        weigh = 0.3;
        grip = 0.8;
        if (u >= 1) {
          this.stage = 'recover';
          this.t = 0;
          this.duration = 0.38;
        }
      } else {
        steel.linAcc = 50 * s;
        steel.angAcc = 75 * s;
        steel.maxSpeed = 7;
        steel.power = 1;
        if (u >= 1) this.mode = 'guard';
      }
      lungePose(this.reach, this.steer, this.pose);
      if (this.stage === 'recover') {
        const b = ease(u);
        this.pose.g.lerp(this.rest.g, b);
        this.pose.q.slerp(this.rest.q, b);
      }
    }

    // The trunk goes with the hand: back with it as it is drawn out, and through with it as it comes across.
    const o = this.offset;
    if (this.mode === 'thrust') p.twist.set(0, this.stage === 'recover' ? 0 : -0.04 + 0.07 * (this.reach + 1), 0);
    else p.twist.set(o.y * 0.05, -o.x * 0.26, o.x * 0.05);
    p.encumbered += (Math.max(weigh, this.guard * 0.45) - p.encumbered) * (1 - Math.exp(-dt * 8));
    p.grip = grip;

    // Shield arm.
    const g = ease(this.guard);
    const run = p.sprinting ? 1 : 0;
    const knocked = this.broken > 0 ? ease(Math.min(1, this.broken / 0.3)) : 0;
    boardPose(g, run, knocked, this.target);
    const r = 1 - Math.exp(-dt * 12);
    this.shieldPose.g.lerp(this.target.g, r);
    this.shieldPose.q.slerp(this.target.q, r);

    // The hands carry the walk: a small figure of eight.
    this.bob += dt;
    const gait = Math.min(1, p.speed / 2.4);
    const sway = Math.sin(this.bob * (5 + p.speed)) * 0.006 * gait;
    const dip = Math.abs(Math.cos(this.bob * (5 + p.speed) * 0.5)) * 0.012 * gait;

    this.sub.g.copy(this.pose.g);
    this.sub.q.copy(this.pose.q);
    if (this.crowd > 0.01) {
      // High port: point straight up, hand in to the chest.
      this.sub.g.lerp(this.v.set(0.2, -0.3, -0.16), this.crowd);
      this.sub.q.slerp(bladeQuat(this.v.set(-0.12, 0.98, 0.1), this.w.set(0.6, 0, -0.8), this.q), this.crowd);
    }
    this.sub.g.x += sway;
    this.sub.g.y -= dip;
    // Where the sword is asked to be. Where it is, is the steel's business.
    this.toWorld(this.sub, this.v, this.q, 'sword');
    steel.aim(this.v, this.q);
    if (steel.held) {
      steel.frame(this.physics.alpha);
      this.limit?.('sword', this.sword.position, this.sword.quaternion);
    }
    this.blood.value = this.bloody;

    this.sub.g.copy(this.shieldPose.g);
    this.sub.g.x -= sway * 0.7;
    this.sub.g.y -= dip * 0.8;
    this.sub.g.z += this.crowd * 0.12;
    this.sub.q.copy(this.shieldPose.q);
    this.toWorld(this.sub, this.shield.position, this.shield.quaternion, 'shield');

    const low = 1 - 0.3 * p.crouch;
    this.trunk.setTranslationWrtParent({ x: 0, y: 0.84 * low, z: 0 });
    this.head.setTranslationWrtParent({ x: 0, y: p.chest + 0.25, z: 0 });
  }

  /** Once per physics step: the sword is driven and the board is carried. */
  fixedStep(dt: number): void {
    if (this.player.dead) return;
    this.steel.step(dt, this.player.rigidBody);
    this.board.follow(this.shield);
  }

  /** The start of a recording: a hand comes off the camera, goes to the hilt, and draws. */
  private introduce(dt: number): void {
    const p = this.player;
    this.intro += dt;
    const t = this.intro;
    const h = this.hand;
    h.active = t < INTRO.hilt;
    this.pose.g.copy(STOWED.g);
    this.pose.q.copy(STOWED.q);
    if (h.active) {
      // From the lens to clear of it, then down to the hilt.
      const [a, b, u] = t < INTRO.clear ? [0, 1, ease(THREE.MathUtils.clamp((t - INTRO.cover) / (INTRO.clear - INTRO.cover), 0, 1))] : [1, 2, ease((t - INTRO.clear) / (INTRO.hilt - INTRO.clear))];
      const A = HAND_KEYS[a], B = HAND_KEYS[b];
      h.wrist.lerpVectors(A[0], B[0], u).applyQuaternion(p.orientation).add(p.eye);
      h.knuckles.lerpVectors(A[1], B[1], u).normalize().applyQuaternion(p.orientation);
      h.palm.lerpVectors(A[2], B[2], u).normalize().applyQuaternion(p.orientation);
      h.curl = A[3] + (B[3] - A[3]) * u;
      return;
    }
    if (!this.drew) {
      // The hand closes on the hilt: from here the sword is in the world, and comes out of the scabbard
      // because the arm takes it out.
      this.drew = true;
      this.toWorld(STOWED, this.v, this.q, 'sword');
      this.steel.place(this.v, this.q);
      this.steel.live = true;
      this.sword.visible = true;
      this.events.draw?.();
    }
    const u = ease(THREE.MathUtils.clamp((t - INTRO.hilt) / (INTRO.drawn - INTRO.hilt), 0, 1));
    // Out and up along the line of the scabbard before it comes across.
    this.pose.g.lerpVectors(STOWED.g, this.rest.g, u);
    this.pose.g.y += Math.sin(u * Math.PI) * 0.1;
    this.pose.g.z -= Math.sin(u * Math.PI) * 0.12;
    this.pose.q.slerpQuaternions(STOWED.q, this.rest.q, u);
    this.steel.linAcc = 40;
    this.steel.angAcc = 60;
    this.steel.maxSpeed = 5;
    this.steel.maxSpin = 12;
  }

  /** Puts the sword in the hand at once, where it is carried. For a start with no recording to begin. */
  ready(): void {
    carryPose(0, 0, 0, this.pose);
    this.frame.setFromEuler(this.e.set(this.player.aimPitch * 0.92, this.player.aimYaw, 0));
    this.toWorld(this.pose, this.v, this.q, 'sword');
    this.steel.place(this.v, this.q);
    this.steel.live = true;
    this.steel.frame(1);
  }

  private toWorld(pose: Pose, position: THREE.Vector3, quaternion: THREE.Quaternion, hand: 'sword' | 'shield'): void {
    position.copy(pose.g).applyQuaternion(this.frame).add(this.player.eye);
    quaternion.copy(this.frame).multiply(pose.q);
    this.limit?.(hand, position, quaternion);
  }
}
