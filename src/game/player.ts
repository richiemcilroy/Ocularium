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
/** Height of the camera on the sternum. */
const CHEST_STAND = 1.4;
const CHEST_CROUCH = 0.88;

const WALK = 2.3;
const SPRINT = 4.9;
const SNEAK = 1.2;

export interface PlayerEvents {
  footstep?(surface: SurfaceKind, loudness: number, left: boolean): void;
  land?(surface: SurfaceKind, impact: number): void;
  jump?(): void;
}

/** A damped spring used for every kind of camera kick. */
export class Spring {
  x = 0;
  v = 0;
  constructor(private hz: number, private damping: number) {}
  step(dt: number, target = 0): number {
    const w = Math.PI * 2 * this.hz;
    this.v += (-w * w * (this.x - target) - 2 * this.damping * w * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

const approach = (value: number, target: number, rate: number, dt: number) => target + (value - target) * Math.exp(-rate * dt);

/**
 * The wearer of the camera: a capsule moved by Rapier's character controller,
 * and the chest-mounted camera rig that rides on it. The camera does not sit
 * at the eyes and does not track the aim exactly; the aim leads, the torso
 * follows, and every step, breath and blow reaches the lens.
 */
export class Player {
  /** Feet position, interpolated for rendering. */
  readonly position = new THREE.Vector3();
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
  stamina = 1;
  /** 0 rested .. 1 blown; drives breathing. */
  exertion = 0;
  health = 100;
  dead = false;
  sprinting = false;
  /** Horizontal speed in m/s. */
  speed = 0;
  events: PlayerEvents = {};

  /** How much of the rise and fall of walking the camera supplies itself; a body with legs under it supplies its own. */
  ride = 1;

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
  private stride = 0;
  private leftFoot = false;
  private airTime = 0;
  private restTimer = 0;
  private time = 0;
  private breath = 0;
  private kickPitch = new Spring(5.5, 0.45);
  private kickRoll = new Spring(4.5, 0.5);
  private kickYaw = new Spring(4.5, 0.55);
  private drop = new Spring(3.2, 0.6);
  private lastQ = new THREE.Quaternion();
  private corpse: RAPIER.RigidBody | null = null;
  private filter = groups(GROUP.PLAYER, GROUP.WORLD | GROUP.PROP);

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
    this.velocity.set(0, 0, 0);
    this.body.setTranslation(p, true);
    this.body.setNextKinematicTranslation(p);
    this.yaw = this.aimYaw = yaw;
    this.pitch = this.aimPitch = 0;
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
    const local = direction.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw);
    const k = Math.min(1.6, 0.5 + amount / 40);
    this.kickPitch.v += (local.z > 0 ? 1 : -1) * 3.2 * k;
    this.kickRoll.v += -Math.sign(local.x || 1) * 3.6 * k;
    this.kickYaw.v += local.x * 2.4 * k;
    this.drop.v -= 1.1 * k;
    this.velocity.addScaledVector(direction, 1.6 * k);
    this.exertion = Math.min(1, this.exertion + 0.25);
    if (this.health <= 0) this.die(direction);
  }

  /** Jolt from our own blow stopping dead on something. */
  jar(strength: number): void {
    this.kickPitch.v += (Math.random() - 0.3) * 2.2 * strength;
    this.kickRoll.v += (Math.random() - 0.5) * 3.0 * strength;
    this.kickYaw.v += (Math.random() - 0.5) * 1.6 * strength;
  }

  tire(amount: number): void {
    this.stamina = Math.max(0, this.stamina - amount);
    this.exertion = Math.min(1, this.exertion + amount * 0.8);
    this.restTimer = 0.8;
  }

  private die(direction: THREE.Vector3): void {
    this.dead = true;
    // The wearer goes down and the camera goes with them: hand it to the physics world.
    const w = this.physics.world;
    const b = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(this.eye.x, this.eye.y - 0.1, this.eye.z).setRotation(this.orientation).setLinearDamping(0.3).setAngularDamping(1.6).setCcdEnabled(true),
    );
    w.createCollider(RAPIER.ColliderDesc.cuboid(0.2, 0.26, 0.13).setDensity(900).setFriction(0.9).setRestitution(0.05).setCollisionGroups(groups(GROUP.RAGDOLL, GROUP.WORLD | GROUP.PROP)), b);
    b.setLinvel({ x: this.velocity.x * 0.6 + direction.x * 1.4, y: -0.4, z: this.velocity.z * 0.6 + direction.z * 1.4 }, true);
    b.setAngvel({ x: direction.z * 2.6 + (Math.random() - 0.5), y: (Math.random() - 0.5) * 1.5, z: -direction.x * 2.6 + (Math.random() - 0.5) }, true);
    this.collider.setEnabled(false);
    this.corpse = b;
  }

  /** Per frame, before physics: read the controls. */
  control(input: Input, dt: number): void {
    if (this.dead) {
      input.consumeLook();
      this.look.x = this.look.y = 0;
      this.wish.set(0, 0);
      return;
    }
    const look = input.consumeLook();
    this.look.x = look.x;
    this.look.y = look.y;
    this.aimYaw -= look.x;
    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch - look.y, -1.2, 1.2);

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

    this.wish.set(input.axis('KeyA', 'KeyD'), input.axis('KeyS', 'KeyW'));
    if (this.wish.lengthSq() > 1) this.wish.normalize();
    this.wantSprint = input.down('ShiftLeft') || input.down('ShiftRight');
    if (input.hit('KeyC') || input.hit('ControlLeft')) this.wantCrouch = !this.wantCrouch;
    if (input.hit('Space')) this.wantJump = true;
    const leanTarget = input.axis('KeyQ', 'KeyE');
    this.lean = approach(this.lean, leanTarget, 9, dt);
  }

  /** Once per physics step. */
  fixedStep(dt: number): void {
    if (this.dead) return;
    const p = this.curr;
    this.prev.copy(p);

    // Crouching changes the capsule; standing back up needs headroom.
    let crouching = this.wantCrouch;
    if (!crouching && this.height < STAND - 0.01) {
      const up = this.physics.raycast(new THREE.Vector3(p.x, p.y + this.height - 0.05, p.z), new THREE.Vector3(0, 1, 0), STAND - this.height + 0.1, GROUP.WORLD);
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

    // Desired velocity in the chest's frame.
    const moving = this.wish.lengthSq() > 0.01;
    this.sprinting = this.wantSprint && moving && this.wish.y > 0.5 && this.crouch < 0.2 && this.stamina > 0.04 && this.grounded;
    let top = this.sprinting ? SPRINT : THREE.MathUtils.lerp(WALK, SNEAK, this.crouch);
    if (this.wish.y < -0.1) top *= 0.68;
    else if (Math.abs(this.wish.x) > 0.5 && this.wish.y < 0.5) top *= 0.85;
    top *= 0.75 + 0.25 * Math.min(1, this.stamina * 3);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const tx = (this.wish.x * cos - this.wish.y * sin) * top;
    const tz = (-this.wish.x * sin - this.wish.y * cos) * top;
    const v = this.velocity;
    if (this.grounded) {
      // Boots on mud: quick to bite, quick to stop, but not instant.
      const rate = moving ? 9 : 12;
      v.x = approach(v.x, tx, rate, dt);
      v.z = approach(v.z, tz, rate, dt);
      if (this.wantJump && this.crouch < 0.3 && this.stamina > 0.08) {
        v.y = 3.5;
        this.grounded = false;
        this.tire(0.07);
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
        this.drop.v -= 2.4 * impact;
        this.kickPitch.v -= 1.6 * impact;
        this.events.land?.(this.surfaceBelow(), impact);
        this.stride = 0.5;
      }
      this.airTime = 0;
    }

    // Stride and footfalls.
    if (this.grounded && this.speed > 0.35) {
      this.stride += (this.speed * dt) / stepLength(this.speed, this.crouch);
      if (this.stride >= 1) {
        this.stride -= 1;
        this.leftFoot = !this.leftFoot;
        const loud = THREE.MathUtils.clamp((this.speed / SPRINT) * (1 - this.crouch * 0.55), 0.12, 1);
        this.events.footstep?.(this.surfaceBelow(), loud, this.leftFoot);
        // Each footfall reaches the camera as a small sharp knock.
        const hard = 0.25 + (this.speed / SPRINT) * 1.1;
        this.kickPitch.v -= 0.34 * hard;
        this.kickRoll.v += (this.leftFoot ? 1 : -1) * 0.42 * hard;
        this.drop.v -= 0.2 * hard;
      }
    } else if (this.speed <= 0.35) this.stride = approach(this.stride, 0, 6, dt);

    // Wind.
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - dt / 13);
      this.exertion = Math.min(1, this.exertion + dt / 9);
      this.restTimer = 0.9;
    } else {
      this.restTimer -= dt;
      if (this.restTimer <= 0) this.stamina = Math.min(1, this.stamina + dt / (moving ? 12 : 7));
      this.exertion = Math.max(0, this.exertion - dt / (moving ? 26 : 15));
    }
  }

  /** Where the walker is in a pair of steps, 0..1: the left foot comes down at 0 and the right at one half. */
  get pace(): number {
    return (this.stride + (this.leftFoot ? 0 : 1)) / 2;
  }

  private surfaceBelow(): SurfaceKind {
    const hit = this.physics.raycast(new THREE.Vector3(this.curr.x, this.curr.y + 0.4, this.curr.z), new THREE.Vector3(0, -1, 0), 0.9, GROUP.WORLD | GROUP.PROP);
    return hit ? this.level.surface(hit) : 'dirt';
  }

  /** Per frame, after physics: place the camera. */
  frame(dt: number): void {
    this.time += dt;
    const t = this.time;
    if (this.corpse) {
      const tr = this.corpse.translation(), ro = this.corpse.rotation();
      this.eye.set(tr.x, tr.y, tr.z);
      this.orientation.set(ro.x, ro.y, ro.z, ro.w);
      this.measureSpin(dt);
      return;
    }
    this.position.lerpVectors(this.prev, this.curr, this.physics.alpha);

    const run = Math.min(1, this.speed / SPRINT);
    const gait = this.grounded ? Math.min(1, this.speed / 0.8) : 0;
    const phase = this.stride * Math.PI * 2;
    // The torso is lowest at each footfall and sways over the standing leg.
    const bobY = -Math.cos(phase) * (0.014 + 0.03 * run) * gait * this.ride;
    const swayPhase = (this.stride + (this.leftFoot ? 0 : 1)) * Math.PI;
    const bobX = -Math.sin(swayPhase) * (0.016 + 0.014 * run) * gait;
    const bobRoll = Math.sin(swayPhase) * (0.008 + 0.02 * run) * gait;
    const bobYaw = -Math.sin(swayPhase) * (0.006 + 0.022 * run) * gait;

    // Breathing lifts the chest; harder and faster when blown.
    this.breath += dt * (0.24 + 0.62 * this.exertion) * Math.PI * 2;
    const breathing = Math.sin(this.breath) * (0.0035 + 0.011 * this.exertion);

    // Nobody stands perfectly still.
    const tremor = 0.004 + 0.007 * this.exertion + 0.006 * run;
    const jitterPitch = noise(t * 1.1, 3.7) * tremor + noise(t * 6.3, 9.1) * tremor * 0.3;
    const jitterYaw = noise(t * 0.9, 17.2) * tremor + noise(t * 5.7, 23.9) * tremor * 0.3;
    const jitterRoll = noise(t * 0.7, 41.3) * tremor * 0.8;

    const kp = this.kickPitch.step(dt), kr = this.kickRoll.step(dt), ky = this.kickYaw.step(dt), dy = this.drop.step(dt);

    // Leaning tips the torso over the hip; stop at walls.
    let lean = this.lean;
    if (Math.abs(lean) > 0.02) {
      const side = new THREE.Vector3(Math.cos(this.yaw) * Math.sign(lean), 0, -Math.sin(this.yaw) * Math.sign(lean));
      const hit = this.physics.raycast(new THREE.Vector3(this.position.x, this.position.y + this.chest, this.position.z), side, 0.62, GROUP.WORLD);
      if (hit) lean *= Math.max(0, (hit.distance - 0.2) / 0.42);
    }
    const strafe = this.grounded ? THREE.MathUtils.clamp((this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw)) / SPRINT, -1, 1) : 0;

    const yaw = this.yaw + bobYaw + jitterYaw + ky * 0.02;
    const pitch = this.pitch + jitterPitch + kp * 0.02 + breathing * 0.5 - run * 0.05;
    const roll = -lean * 0.2 + bobRoll + jitterRoll + kr * 0.02 - strafe * 0.035;
    const e = new THREE.Euler(pitch, yaw, roll, 'YXZ');
    this.orientation.setFromEuler(e);

    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.eye
      .copy(this.position)
      .addScaledVector(right, bobX + lean * 0.3)
      .addScaledVector(forward, 0.13 + Math.sin(this.pitch) * -0.06);
    this.eye.y += this.chest + bobY + breathing + dy * 0.02 - Math.abs(lean) * 0.05 - run * 0.03;
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
