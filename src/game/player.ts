import * as THREE from 'three/webgpu';
import type { Input } from '../core/input';
import { GROUP, RAPIER, groups, type Physics } from '../physics/physics';
import type { SurfaceKind } from '../world/builder';
import type { Level } from '../world/level';
import { noise } from '../world/terrain';
import { stepLength } from './gait';

const RADIUS = 0.3;
const STAND = 1.8;
const CROUCH = 1.12;
/** Height of the camera on the sternum, standing easy with the knees unlocked. */
const CHEST_STAND = 1.375;
const CHEST_CROUCH = 0.88;

const WALK = 2.3;
const SPRINT = 4.9;
const SNEAK = 1.2;
/** The run that is left once the legs are spent. */
const JOG = 3.3;

/** Share of a breath spent drawing it in. */
const INHALE = 0.42;

export interface PlayerEvents {
  footstep?(surface: SurfaceKind, loudness: number, left: boolean): void;
  land?(surface: SurfaceKind, impact: number): void;
  jump?(): void;
  /** A blow got through. */
  hurt?(amount: number): void;
  /** The wearer is dead; `direction` is the way the last blow was travelling. */
  death?(direction: THREE.Vector3): void;
}

/** A damped spring used for every kind of camera kick. Stepped finely, so a slow frame cannot throw it. */
export class Spring {
  x = 0;
  v = 0;
  constructor(private hz: number, private damping: number) {}
  step(dt: number, target = 0): number {
    const w = Math.PI * 2 * this.hz;
    for (let left = dt; left > 1e-6; ) {
      const h = Math.min(left, 1 / 300);
      this.v += (-w * w * (this.x - target) - 2 * this.damping * w * this.v) * h;
      this.x += this.v * h;
      left -= h;
    }
    return this.x;
  }
  reset(x = 0): void {
    this.x = x;
    this.v = 0;
  }
}

/**
 * Follows a moving target the way a mass follows a hand: without ever stepping,
 * whatever the target does. Critically damped, and exact for any frame time.
 */
export class Follow {
  x = 0;
  v = 0;
  step(dt: number, target: number, omega: number): number {
    const d = this.x - target;
    const e = Math.exp(-omega * dt);
    const t = (this.v + omega * d) * dt;
    this.v = (this.v - omega * t) * e;
    this.x = target + (d + t) * e;
    return this.x;
  }
  snap(x: number): void {
    this.x = x;
    this.v = 0;
  }
}

const approach = (value: number, target: number, rate: number, dt: number) => target + (value - target) * Math.exp(-rate * dt);
const smooth = (lo: number, hi: number, v: number) => {
  const t = THREE.MathUtils.clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The wearer of the camera: a capsule moved by Rapier's character controller,
 * and the chest-mounted camera rig that rides on it. The camera does not sit
 * at the eyes and does not track the aim exactly; the aim leads, the torso
 * follows, and every step, breath and blow reaches the lens.
 *
 * The camera is bolted to a body, and a body has mass. Nothing here moves the
 * lens by a step: ground height, speed, lean and turn all reach it through
 * followers and springs, so what is seen is always the motion of something heavy.
 */
export class Player {
  /** Feet position, interpolated for rendering. */
  readonly position = new THREE.Vector3();
  /** Where the body stands for the camera and the figure: `position`, with the ground's steps eased out. */
  readonly feet = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Where the hands are pointing. */
  aimYaw = 0;
  aimPitch = 0;
  /** Where the chest (and so the camera) is pointing. */
  yaw = 0;
  pitch = 0;
  grounded = true;
  crouch = 0;
  lean = 0;
  /** 1 fresh .. 0 spent: what the legs and arms have left. Running, striking, jumping and taking blows on the shield spend it. */
  stamina = 1;
  /** 0 rested .. 1 blown: how hard the wearer is breathing. Lags behind what was spent, as breath does. */
  exertion = 0;
  /** Out of wind: no running until some of it has come back. */
  winded = false;
  health = 100;
  /** The most health rest can bring back; every wound takes some of it for good. */
  healthCap = 100;
  dead = false;
  sprinting = false;
  /** Horizontal speed in m/s. */
  speed = 0;
  /** 0..1 how much something in the hands is slowing the feet (a blow being held back, a raised shield). */
  encumbered = 0;
  /** 0..1 how much of the mouse the sword hand has taken from the business of turning. */
  grip = 0;
  /** Where in a breath the wearer is, 0..1; the chest rises until `INHALE` and falls after. */
  breathPhase = 0;
  /** True on the frame a breath starts to go out. */
  exhaled = false;
  events: PlayerEvents = {};

  /** Set by whatever swings the arms: how far the blow turns the trunk (pitch, yaw, roll in radians). */
  readonly twist = new THREE.Vector3();
  /** When the wearer is down, whoever owns the fallen body says where the camera on it is. */
  fallen: ((eye: THREE.Vector3, orientation: THREE.Quaternion) => void) | null = null;

  /** Mouse movement this frame, in radians (x right, y down). */
  readonly look = { x: 0, y: 0 };

  /** Camera pose for this frame. */
  readonly eye = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  /** Camera angular velocity (pitch, yaw, roll) in rad/s, for motion blur. */
  readonly spin = new THREE.Vector3();

  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private prev = new THREE.Vector3();
  private curr = new THREE.Vector3();
  private wantJump = false;
  private wish = new THREE.Vector2();
  private wantSprint = false;
  private wantCrouch = false;
  private height = STAND;
  /** Steps taken, as a running count with the fraction of the step in progress. */
  private walked = 0;
  private walkedPrev = 0;
  private airTime = 0;
  private restTimer = 0;
  private stun = 0;
  private time = 0;
  private kickPitch = new Spring(6.5, 0.4);
  private kickRoll = new Spring(5.5, 0.45);
  private kickYaw = new Spring(5, 0.5);
  private drop = new Spring(3.4, 0.55);
  private ride = new Follow();
  private camYaw = new Follow();
  private camPitch = new Follow();
  private run = new Follow();
  private gait = new Follow();
  private strafe = new Follow();
  private leanBy = new Follow();
  private twistPitch = new Follow();
  private twistYaw = new Follow();
  private twistRoll = new Follow();
  private lastQ = new THREE.Quaternion();
  private corpse: RAPIER.RigidBody | null = null;
  private filter = groups(GROUP.PLAYER, GROUP.WORLD | GROUP.PROP | GROUP.BODY);
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private physics: Physics, private level: Level) {
    const w = physics.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.collider = w.createCollider(
      RAPIER.ColliderDesc.capsule(STAND / 2 - RADIUS, RADIUS).setTranslation(0, STAND / 2, 0).setCollisionGroups(this.filter).setFriction(0),
      this.body,
    );
    const c = w.createCharacterController(0.02);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    c.setMinSlopeSlideAngle((42 * Math.PI) / 180);
    c.enableAutostep(0.34, 0.18, false);
    c.enableSnapToGround(0.3);
    c.setApplyImpulsesToDynamicBodies(true);
    c.setCharacterMass(85);
    this.controller = c;
    this.teleport(level.spawn.position, level.spawn.yaw);
  }

  teleport(p: THREE.Vector3, yaw: number): void {
    this.prev.copy(p);
    this.curr.copy(p);
    this.position.copy(p);
    this.feet.copy(p);
    this.velocity.set(0, 0, 0);
    this.body.setTranslation(p, true);
    this.body.setNextKinematicTranslation(p);
    this.yaw = this.aimYaw = yaw;
    this.pitch = this.aimPitch = 0;
    this.ride.snap(p.y);
    this.camYaw.snap(yaw);
    this.camPitch.snap(0);
    for (const f of [this.run, this.gait, this.strafe, this.leanBy, this.twistPitch, this.twistYaw, this.twistRoll]) f.snap(0);
    for (const s of [this.kickPitch, this.kickRoll, this.kickYaw, this.drop]) s.reset();
    this.walked = this.walkedPrev = 0;
    this.lean = 0;
    this.grounded = true;
    this.airTime = 0;
  }

  /** A fresh wearer at `p`: whole, rested, and standing. */
  revive(p: THREE.Vector3, yaw: number): void {
    if (this.corpse) {
      this.physics.world.removeRigidBody(this.corpse);
      this.corpse = null;
    }
    this.fallen = null;
    this.dead = false;
    this.health = this.healthCap = 100;
    this.stamina = 1;
    this.exertion = 0;
    this.winded = false;
    this.stun = 0;
    this.encumbered = 0;
    this.grip = 0;
    this.restTimer = 0;
    this.breathPhase = 0;
    this.twist.set(0, 0, 0);
    this.wantCrouch = false;
    this.height = STAND;
    this.crouch = 0;
    this.collider.setHalfHeight(STAND / 2 - RADIUS);
    this.collider.setTranslationWrtParent({ x: 0, y: STAND / 2, z: 0 });
    this.collider.setEnabled(true);
    this.teleport(p, yaw);
  }

  get rigidBody(): RAPIER.RigidBody {
    return this.body;
  }

  /** Aim offset from the lens axis: how far the hands lead the camera. */
  get lead(): { yaw: number; pitch: number } {
    return { yaw: this.aimYaw - this.yaw, pitch: this.aimPitch - this.pitch };
  }

  /** Height of the chest above the feet right now. */
  get chest(): number {
    return THREE.MathUtils.lerp(CHEST_STAND, CHEST_CROUCH, this.crouch);
  }

  /** A blow landed: jolt the camera away from `direction` (world space, pointing from attacker to us). */
  hurt(amount: number, direction: THREE.Vector3): void {
    if (this.dead) return;
    this.health -= amount;
    this.healthCap = Math.max(20, this.healthCap - amount * 0.55);
    const local = this.v1.copy(direction).applyAxisAngle(UP, -this.yaw);
    const k = Math.min(1.7, 0.5 + amount / 40);
    this.kickPitch.v += (local.z > 0 ? 1 : -1) * 2.6 * k;
    this.kickRoll.v += -Math.sign(local.x || 1) * 2.4 * k;
    this.kickYaw.v += -local.x * 2.0 * k;
    this.drop.v -= 0.55 * k;
    this.velocity.addScaledVector(direction, 2.2 * k);
    this.stun = Math.max(this.stun, 0.25 + 0.2 * k);
    this.stamina = Math.max(0, this.stamina - 0.06 * k);
    this.exertion = Math.min(1, this.exertion + 0.12 * k);
    this.restTimer = 1.2;
    this.events.hurt?.(amount);
    if (this.health <= 0) this.die(direction);
  }

  /** Jolt from a blow stopping dead: our own on stone, or someone else's on our shield. */
  jar(strength: number): void {
    this.kickPitch.v += (Math.random() - 0.3) * 0.9 * strength;
    this.kickRoll.v += (Math.random() - 0.5) * 1.1 * strength;
    this.kickYaw.v += (Math.random() - 0.5) * 0.8 * strength;
    this.drop.v -= 0.12 * strength;
  }

  /** A step into a blow: the body goes with the sword, as far as boots on the ground allow. */
  lunge(speed: number): void {
    if (!this.grounded || this.dead) return;
    this.velocity.x -= Math.sin(this.yaw) * speed;
    this.velocity.z -= Math.cos(this.yaw) * speed;
  }

  /** Spends some of what the wearer has left. */
  tire(amount: number): void {
    if (amount <= 0) return;
    this.stamina = Math.max(0, this.stamina - amount);
    this.exertion = Math.min(1, this.exertion + amount * 0.3);
    this.restTimer = Math.max(this.restTimer, 1.0);
  }

  /** Ends the wearer. The camera stays on the body wherever it falls. */
  die(direction: THREE.Vector3): void {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.sprinting = false;
    this.collider.setEnabled(false);
    this.events.death?.(direction);
    if (this.fallen) return;
    // Nobody is modelling the body: let the camera itself drop.
    const w = this.physics.world;
    const b = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(this.eye.x, this.eye.y - 0.1, this.eye.z).setRotation(this.orientation).setLinearDamping(0.3).setAngularDamping(1.6).setCcdEnabled(true),
    );
    w.createCollider(RAPIER.ColliderDesc.cuboid(0.2, 0.26, 0.13).setDensity(900).setFriction(0.9).setRestitution(0.05).setCollisionGroups(groups(GROUP.RAGDOLL, GROUP.WORLD | GROUP.PROP)), b);
    b.setLinvel({ x: this.velocity.x * 0.6 + direction.x * 1.4, y: -0.4, z: this.velocity.z * 0.6 + direction.z * 1.4 }, true);
    b.setAngvel({ x: direction.z * 2.6 + (Math.random() - 0.5), y: (Math.random() - 0.5) * 1.5, z: -direction.x * 2.6 + (Math.random() - 0.5) }, true);
    this.corpse = b;
  }

  /** Per frame, before physics: read the controls. `held` keeps the feet still (the wearer is busy with the camera). */
  control(input: Input, dt: number, held = false): void {
    if (this.dead) {
      input.consumeLook();
      this.look.x = this.look.y = 0;
      this.wish.set(0, 0);
      return;
    }
    const look = input.consumeLook();
    this.look.x = look.x;
    this.look.y = look.y;
    // With the sword hand on the mouse the body still turns, but only a little.
    const turn = 1 - 0.74 * this.grip;
    this.aimYaw -= look.x * turn;
    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch - look.y * turn, -1.2, 1.2);

    // The hands lead; the chest turns once they have gone far enough, then settles behind them.
    const dzYaw = 0.11, dzPitch = 0.085;
    let ey = this.aimYaw - this.yaw, ep = this.aimPitch - this.pitch;
    if (ey > dzYaw) this.yaw += ey - dzYaw;
    else if (ey < -dzYaw) this.yaw += ey + dzYaw;
    if (ep > dzPitch) this.pitch += ep - dzPitch;
    else if (ep < -dzPitch) this.pitch += ep + dzPitch;
    ey = this.aimYaw - this.yaw;
    ep = this.aimPitch - this.pitch;
    const settle = 1 - Math.exp(-dt * (1.4 + this.speed * 0.5));
    this.yaw += ey * settle;
    this.pitch += ep * settle;

    if (held) {
      this.wish.set(0, 0);
      this.wantSprint = false;
      this.wantJump = false;
      return;
    }
    this.wish.set(input.axis('KeyA', 'KeyD'), input.axis('KeyS', 'KeyW'));
    if (this.wish.lengthSq() > 1) this.wish.normalize();
    this.wantSprint = input.down('ShiftLeft') || input.down('ShiftRight');
    if (input.hit('KeyC') || input.hit('ControlLeft')) this.wantCrouch = !this.wantCrouch;
    if (input.hit('Space')) this.wantJump = true;
    this.lean = approach(this.lean, input.axis('KeyQ', 'KeyE'), 9, dt);
  }

  /** Once per physics step. */
  fixedStep(dt: number): void {
    if (this.dead) return;
    const p = this.curr;
    this.prev.copy(p);
    this.walkedPrev = this.walked;

    // Crouching changes the capsule; standing back up needs headroom.
    let crouching = this.wantCrouch;
    if (!crouching && this.height < STAND - 0.01) {
      const up = this.physics.raycast(this.v1.set(p.x, p.y + this.height - 0.05, p.z), UP, STAND - this.height + 0.1, GROUP.WORLD);
      if (up) crouching = true;
    }
    const targetHeight = crouching ? CROUCH : STAND;
    if (Math.abs(targetHeight - this.height) > 0.001) {
      this.height = approach(this.height, targetHeight, 10, dt);
      if (Math.abs(targetHeight - this.height) < 0.004) this.height = targetHeight;
      this.collider.setHalfHeight(this.height / 2 - RADIUS);
      this.collider.setTranslationWrtParent({ x: 0, y: this.height / 2, z: 0 });
    }
    this.crouch = (STAND - this.height) / (STAND - CROUCH);

    // Out of wind means no running until a fair share of it has come back; without the gap between
    // the two marks the wearer would stutter in and out of a run on the last of their breath.
    if (this.stamina < 0.03) this.winded = true;
    else if (this.stamina > 0.3) this.winded = false;

    // Desired velocity in the chest's frame.
    const moving = this.wish.lengthSq() > 0.01;
    this.sprinting = this.wantSprint && moving && this.wish.y > 0.5 && this.crouch < 0.2 && !this.winded && this.grounded && this.stun <= 0 && this.encumbered < 0.5;
    // A run fades into a jog as the legs empty, well before they give out.
    let top = this.sprinting ? THREE.MathUtils.lerp(JOG, SPRINT, smooth(0.05, 0.45, this.stamina)) : THREE.MathUtils.lerp(WALK, SNEAK, this.crouch);
    if (this.wish.y < -0.1) top *= 0.68;
    else if (Math.abs(this.wish.x) > 0.5 && this.wish.y < 0.5) top *= 0.85;
    top *= 0.82 + 0.18 * smooth(0, 0.3, this.stamina);
    top *= 0.8 + 0.2 * (this.health / 100);
    top *= 1 - 0.35 * this.encumbered;
    if (this.stun > 0) top *= 0.35;
    this.stun = Math.max(0, this.stun - dt);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const tx = (this.wish.x * cos - this.wish.y * sin) * top;
    const tz = (-this.wish.x * sin - this.wish.y * cos) * top;
    const v = this.velocity;
    if (this.grounded) {
      // Boots on mud: quick to bite, quick to stop, but not instant.
      const rate = moving ? 9 : 12;
      v.x = approach(v.x, tx, rate, dt);
      v.z = approach(v.z, tz, rate, dt);
      if (this.wantJump && this.crouch < 0.3 && this.stamina > 0.1 && this.stun <= 0) {
        v.y = 3.5;
        this.grounded = false;
        this.tire(0.06);
        this.events.jump?.();
      } else v.y = Math.max(v.y - 9.81 * dt, -2);
    } else {
      v.x = approach(v.x, tx, 0.9, dt);
      v.z = approach(v.z, tz, 0.9, dt);
      v.y -= 9.81 * dt;
    }
    this.wantJump = false;

    const fallSpeed = -v.y;
    this.controller.computeColliderMovement(this.collider, { x: v.x * dt, y: v.y * dt, z: v.z * dt }, undefined, this.filter);
    const m = this.controller.computedMovement();
    // Boots grip: standing on a slope, the wearer stays where they are rather than creeping down it.
    if (this.grounded && !moving && Math.hypot(v.x, v.z) < 0.3) m.x = m.z = 0;
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();
    p.x += m.x;
    p.y += m.y;
    p.z += m.z;
    // Keep to the playable land.
    const r = Math.hypot(p.x, p.z - 5);
    if (r > 92) {
      p.x *= 92 / r;
      p.z = 5 + (p.z - 5) * (92 / r);
    }
    this.body.setNextKinematicTranslation(p);
    // What actually happened becomes the velocity, so walls stop us dead rather than storing speed.
    v.x = m.x / dt;
    v.z = m.z / dt;
    if (this.grounded && v.y < 0) v.y = 0;
    else if (!this.grounded && m.y < v.y * dt * 0.5 && v.y > 0) v.y = 0; // head hit something
    this.speed = Math.hypot(v.x, v.z);

    if (!this.grounded) this.airTime += dt;
    else {
      if (!wasGrounded && this.airTime > 0.12) {
        const impact = Math.min(1.5, fallSpeed / 5);
        this.drop.v -= 1.1 * impact;
        this.kickPitch.v -= 0.8 * impact;
        this.events.land?.(this.surfaceBelow(), impact);
        this.walked = Math.floor(this.walked) + 0.5;
        this.walkedPrev = this.walked;
      }
      this.airTime = 0;
    }

    // Stride and footfalls.
    const step = Math.floor(this.walked);
    if (this.grounded && this.speed > 0.35) {
      this.walked += (this.speed * dt) / stepLength(this.speed, this.crouch);
      if (Math.floor(this.walked) !== step) {
        const left = this.leftFoot;
        const loud = THREE.MathUtils.clamp((this.speed / SPRINT) * (1 - this.crouch * 0.55), 0.12, 1);
        this.events.footstep?.(this.surfaceBelow(), loud, left);
        // Each footfall reaches the camera through the body and the mount as a short knock.
        const hard = 0.25 + (this.speed / SPRINT) * 1.1;
        this.kickPitch.v -= 0.2 * hard;
        this.kickRoll.v += (left ? 1 : -1) * 0.16 * hard;
        this.drop.v -= 0.09 * hard;
      }
    } else if (this.speed <= 0.35) this.walked = step + approach(this.walked - step, 0, 6, dt);

    this.breathe(dt, moving);
  }

  /** What is spent, what comes back, and how hard the wearer breathes for it. */
  private breathe(dt: number, moving: boolean): void {
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - dt / 24);
      this.restTimer = 1.0;
    } else {
      this.restTimer -= dt;
      // Wind comes back fastest standing still, and slower the more has been lost to wounds.
      if (this.restTimer <= 0) this.stamina = Math.min(1, this.stamina + (dt / (moving ? 26 : 15)) * (0.55 + 0.45 * (this.health / 100)));
    }
    // Breath follows what has been spent, a few seconds behind it: a short dash barely shows, a long run
    // leaves the wearer blown, and it takes longer to come back down than the legs take to recover.
    const work = this.sprinting ? 0.3 : this.grounded ? 0.06 * Math.min(1, this.speed / WALK) : 0.15;
    const pain = 0.35 * (1 - this.health / 100);
    const want = Math.max(work, 1 - this.stamina, pain);
    this.exertion = approach(this.exertion, want, want > this.exertion ? 1 / 4 : 1 / (moving ? 18 : 12), dt);
  }

  private get leftFoot(): boolean {
    return Math.floor(this.walked) % 2 === 1;
  }

  /** Where the walker is in a pair of steps, 0..1: the left foot comes down at 0 and the right at one half. */
  get pace(): number {
    return (((this.walked + 1) % 2) + 2) % 2 / 2;
  }

  private surfaceBelow(): SurfaceKind {
    const hit = this.physics.raycast(this.v1.set(this.curr.x, this.curr.y + 0.4, this.curr.z), this.v2.set(0, -1, 0), 0.9, GROUP.WORLD | GROUP.PROP);
    return hit ? this.level.surface(hit) : 'dirt';
  }

  /** Per frame, after physics: place the camera. */
  frame(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.exhaled = false;
    if (this.dead) {
      if (this.fallen) this.fallen(this.eye, this.orientation);
      else if (this.corpse) {
        const tr = this.corpse.translation(), ro = this.corpse.rotation();
        this.eye.set(tr.x, tr.y, tr.z);
        this.orientation.set(ro.x, ro.y, ro.z, ro.w);
      }
      this.measureSpin(dt);
      return;
    }
    const alpha = this.physics.alpha;
    this.position.lerpVectors(this.prev, this.curr, alpha);
    // The controller lifts the capsule on to a step all at once; a body takes the rise over a stride.
    const y = this.ride.step(dt, this.position.y, this.grounded ? 15 : 45);
    this.feet.set(this.position.x, y, this.position.z);

    // Posture follows speed the way a trunk does, not the way a number does: meeting a wall does not snap it upright.
    const run = this.run.step(dt, Math.min(1, this.speed / SPRINT), 8);
    const gait = this.gait.step(dt, this.grounded ? Math.min(1, this.speed / 0.8) : 0, 10);
    const camYaw = this.camYaw.step(dt, this.yaw, 34);
    const camPitch = this.camPitch.step(dt, this.pitch, 34);
    const walked = this.walkedPrev + (this.walked - this.walkedPrev) * alpha;
    const phase = walked * Math.PI * 2;
    // The torso is lowest at each footfall and sways over the standing leg.
    const bobY = -Math.cos(phase) * (0.014 + 0.03 * run) * gait;
    const swayPhase = (walked + 1) * Math.PI;
    const bobX = -Math.sin(swayPhase) * (0.016 + 0.014 * run) * gait;
    const bobRoll = Math.sin(swayPhase) * (0.008 + 0.02 * run) * gait;
    const bobYaw = -Math.sin(swayPhase) * (0.007 + 0.024 * run) * gait;

    // Breathing lifts the chest and tips the camera on it; deeper and faster the harder the wearer is blown.
    const e = this.exertion;
    const before = this.breathPhase;
    this.breathPhase = (before + dt * (0.21 + 0.6 * Math.pow(e, 1.3))) % 1;
    this.exhaled = before < INHALE && this.breathPhase >= INHALE;
    const b = this.breathPhase;
    const full = b < INHALE ? smooth(0, 1, b / INHALE) : 1 - smooth(0, 1, (b - INHALE) / (1 - INHALE));
    const lift = (full - 0.5) * (0.004 + 0.016 * e);

    // Nobody stands perfectly still.
    const tremor = 0.0028 + 0.004 * e + 0.003 * run + 0.004 * (1 - this.health / 100);
    const jitterPitch = noise(t * 1.1, 3.7) * tremor + noise(t * 6.3, 9.1) * tremor * 0.3;
    const jitterYaw = noise(t * 0.9, 17.2) * tremor + noise(t * 5.7, 23.9) * tremor * 0.3;
    const jitterRoll = noise(t * 0.7, 41.3) * tremor * 0.8;

    const kp = this.kickPitch.step(dt), kr = this.kickRoll.step(dt), ky = this.kickYaw.step(dt), dy = this.drop.step(dt);
    const tp = this.twistPitch.step(dt, this.twist.x, 16), ty = this.twistYaw.step(dt, this.twist.y, 16), tr = this.twistRoll.step(dt, this.twist.z, 16);

    // Leaning tips the torso over the hip; stop at walls.
    let want = this.lean;
    if (Math.abs(want) > 0.02) {
      const side = this.v1.set(Math.cos(this.yaw) * Math.sign(want), 0, -Math.sin(this.yaw) * Math.sign(want));
      const hit = this.physics.raycast(this.v2.set(this.feet.x, this.feet.y + this.chest, this.feet.z), side, 0.62, GROUP.WORLD);
      if (hit) want *= Math.max(0, (hit.distance - 0.2) / 0.42);
    }
    const lean = this.leanBy.step(dt, want, 20);
    const strafe = this.strafe.step(dt, this.grounded ? THREE.MathUtils.clamp((this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw)) / SPRINT, -1, 1) : 0, 9);

    const yaw = camYaw + bobYaw + jitterYaw + ky + ty;
    const pitch = camPitch + jitterPitch + kp + lift * 0.55 - run * 0.05 + tp;
    const roll = -lean * 0.2 + bobRoll + jitterRoll + kr - strafe * 0.035 + tr;
    this.orientation.setFromEuler(this.e.set(pitch, yaw, roll));

    const right = this.v1.set(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const forward = this.v2.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));
    this.eye
      .copy(this.feet)
      .addScaledVector(right, bobX + lean * 0.3)
      .addScaledVector(forward, 0.13 + Math.sin(camPitch) * -0.06);
    this.eye.y += this.chest + bobY + lift + dy - Math.abs(lean) * 0.05 - run * 0.03;
    this.measureSpin(dt);
  }

  private measureSpin(dt: number): void {
    // Rotation since last frame, in the camera's own axes.
    const d = this.lastQ.invert().multiply(this.orientation);
    const s = 2 / Math.max(dt, 1e-3);
    const sign = d.w < 0 ? -1 : 1;
    this.spin.set(d.x * s * sign, d.y * s * sign, d.z * s * sign);
    this.lastQ.copy(this.orientation);
  }
}
