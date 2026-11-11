import * as THREE from 'three/webgpu';
import type { Assets } from '../core/assets';
import { GROUP, RAPIER, groups, type Physics } from '../physics/physics';
import type { Effects } from '../world/effects';
import type { EnemySpawn, Level } from '../world/level';
import { Figure, dropSword } from './body';
import { Spring, type Player } from './player';
import { Fallen, Ragdoll, type Limb } from './ragdoll';
import { Rig } from './rig';
import { Board, Gore, REACH, Steel, bloodied, carryPose, ease, lungePose, parryPose, severity, swingPose, withinReach, type Blow, type Owned, type Pose, type Strike, type Target, type Voice } from './steel';
import { boardPose, type Arms } from './weapon';

export type { Voice };

const CHEST = 1.375;
const WALK = 1.15;
const ADVANCE = 2.3;
const RUN = 3.7;
/** How close a soldier wants to stand to the man he is fighting, and how close he steps to hit him. */
const MEASURE = 1.95;
const CLOSE = 1.3;

type State = 'post' | 'patrol' | 'alert' | 'chase' | 'fight' | 'return' | 'broken' | 'down' | 'dead';
/** What the sword arm is doing: at rest, drawing back, letting go, coming back. */
type Act = 'guard' | 'wind' | 'throw' | 'recover';

interface Volume {
  collider: RAPIER.Collider;
  part: string;
  /** A limb runs from one bone to the next; a box sits on one bone. */
  from: string;
  to?: string;
  rise?: number;
}

/** Which piece of a falling body a struck part belongs to. */
const LIMB: Record<string, Limb> = {
  head: 'head', torso: 'chest', hips: 'pelvis', arm_r: 'upperarm_r', forearm_r: 'lowerarm_r', arm_l: 'upperarm_l', forearm_l: 'lowerarm_l',
  thigh_l: 'thigh_l', thigh_r: 'thigh_r', shin_l: 'calf_l', shin_r: 'calf_r',
};
/** The bone each part is carried by. */
const BONE: Record<string, string> = {
  head: 'head', torso: 'spine_03', hips: 'pelvis', arm_r: 'upperarm_r', forearm_r: 'lowerarm_r', arm_l: 'upperarm_l', forearm_l: 'lowerarm_l',
  thigh_l: 'thigh_l', thigh_r: 'thigh_r', shin_l: 'calf_l', shin_r: 'calf_r',
};

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const ORIGIN = new THREE.Vector2();
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
const m4 = new THREE.Matrix4(), unit = new THREE.Vector3();
const approach = (value: number, target: number, rate: number, dt: number) => target + (value - target) * Math.exp(-rate * dt);
const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/**
 * One of the men holding the castle. He is posed the way the wearer is: a
 * chest put where it has to be, feet that stay where they were planted, hands
 * on what they hold. His sword is the same kind of thing as the wearer's: a
 * weight his arm drives about, so that no two of his blows are alike and all
 * of them can be stopped. What he does with it is decided here.
 */
export class Soldier implements Target {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly sword = new THREE.Group();
  readonly shield: THREE.Group | null;
  yaw = 0;
  state: State = 'post';
  act: Act = 'guard';
  /** 100 whole .. 0 dead. Wounds take it at once and go on taking it as they bleed. */
  vitality = 100;
  stamina = 1;
  /** Knows where the wearer is. */
  aware = false;
  /** How often he reads a blow coming, and how keen he is to give one. */
  skill: number;
  nerve: number;

  private figure: Figure;
  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private filter = groups(GROUP.BODY, GROUP.WORLD | GROUP.PROP | GROUP.PLAYER | GROUP.BODY);
  private volumes: Volume[] = [];
  private steel: Steel;
  private board: Board | null = null;
  private gore: Gore;
  private blood: { value: number };
  private bloody = 0;
  private prev = new THREE.Vector3();
  private curr = new THREE.Vector3();
  private grounded = true;
  private want = new THREE.Vector2();
  private faceTo = 0;
  private turn = 5;
  private knock = new THREE.Vector3();
  private aimPitch = 0;
  private zone = 0;
  private eye = new THREE.Vector3();
  private chest = new THREE.Quaternion();
  private frame = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private pose: Pose = { g: new THREE.Vector3(0.2, -0.3, -0.3), q: new THREE.Quaternion() };
  private rest: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };
  private target: Pose = { g: new THREE.Vector3(), q: new THREE.Quaternion() };
  private boardAt: Pose = { g: new THREE.Vector3(-0.32, -0.8, -0.18), q: new THREE.Quaternion() };
  /** Where his sword hand is carried, off centre, and where it is being taken. */
  private o = new THREE.Vector2();
  private oFrom = new THREE.Vector2();
  private oTo = new THREE.Vector2();
  private heading = new THREE.Vector2();
  private thrusting = false;
  private reach = -1;
  private reachFrom = -1;
  private t = 0;
  private duration = 0.4;
  private power = 1;
  private feint = false;
  private more = 0;
  private seed = Math.random() * 100;
  private clock = 0;
  private threat = new THREE.Vector2();
  private guard = 0;
  private wantGuard = 0;
  private ready = 0;
  private stagger = 0;
  private daze = 0;
  private bleed = 0;
  private limp = 0;
  private reel = 0;
  private disarmed = false;
  private shieldDead = false;
  private flinchPitch = new Spring(3.2, 0.5);
  private flinchYaw = new Spring(3.2, 0.5);
  private flinchRoll = new Spring(3.2, 0.5);
  private stance = 0;
  private timer = 0;
  private senseIn = 0;
  private sees = false;
  private dist = 99;
  private bearing = 0;
  private lost = 0;
  private lastSeen = new THREE.Vector3();
  private circle = 1;
  private circleIn = 0;
  private attackIn = 1;
  private away = 0;
  private sawSwing = -1;
  private patrolAt = 0;
  private path: number[] = [];
  private pathIn = 0;
  private stuck = 0;
  private blocked = 0;
  private wounds: { bone: string; rate: number; drip: number; pulse: number; out: THREE.Vector3 }[] = [];
  private floored: Ragdoll | null = null;
  private flooredFor = 0;
  private rising = 0;
  private lying: ReturnType<Rig['capture']> | null = null;
  private strapped = new THREE.Matrix4();

  constructor(
    private garrison: Garrison,
    private scene: THREE.Scene,
    private physics: Physics,
    private level: Level,
    private player: Player,
    private arms: Arms,
    private effects: Effects,
    readonly rig: Rig,
    sword: THREE.Object3D,
    shield: THREE.Object3D | null,
    private spawn: EnemySpawn,
    index: number,
    skill: number,
    nerve: number,
  ) {
    this.skill = skill;
    this.nerve = nerve;
    scene.add(rig.root);
    this.figure = new Figure(rig, physics);
    this.gore = new Gore(rig.bones, rig.meshes);
    this.sword.add(sword);
    scene.add(this.sword);
    if (shield) {
      this.shield = new THREE.Group();
      this.shield.add(shield);
      scene.add(this.shield);
    } else this.shield = null;
    for (const g of [this.sword, this.shield])
      g?.traverse((o) => {
        o.frustumCulled = false;
        o.castShadow = true;
      });
    this.blood = bloodied(this.sword);

    const w = physics.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.3).setTranslation(0, 0.9, 0).setCollisionGroups(this.filter).setFriction(0), this.body);
    const ctl = w.createCharacterController(0.02);
    ctl.setUp({ x: 0, y: 1, z: 0 });
    ctl.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    ctl.setMinSlopeSlideAngle((42 * Math.PI) / 180);
    ctl.enableAutostep(0.34, 0.18, false);
    ctl.enableSnapToGround(0.3);
    ctl.setApplyImpulsesToDynamicBodies(true);
    ctl.setCharacterMass(85);
    this.controller = ctl;

    const volume = (desc: RAPIER.ColliderDesc, part: string, from: string, to?: string, rise?: number) => {
      const collider = w.createCollider(desc.setCollisionGroups(groups(GROUP.HITBOX, GROUP.WEAPON)));
      physics.owners.set(collider.handle, { who: this, part } satisfies Owned);
      this.volumes.push({ collider, part, from, to, rise });
    };
    const P = rig.restWorldP;
    const limb = (part: string, from: string, to: string, r: number, extend = 0) => volume(RAPIER.ColliderDesc.capsule(Math.max(0.02, (P[from].distanceTo(P[to]) + extend) / 2 - r * 0.5), r), part, from, to);
    volume(RAPIER.ColliderDesc.ball(0.125), 'head', 'head', undefined, 0.085);
    volume(RAPIER.ColliderDesc.cuboid(0.18, 0.2, 0.12), 'torso', 'spine_03', undefined, 0.15);
    volume(RAPIER.ColliderDesc.cuboid(0.165, 0.12, 0.115), 'hips', 'pelvis', undefined, 0.02);
    for (const s of ['l', 'r']) {
      limb(`arm_${s}`, `upperarm_${s}`, `lowerarm_${s}`, 0.052);
      limb(`forearm_${s}`, `lowerarm_${s}`, `hand_${s}`, 0.044, 0.08);
      limb(`thigh_${s}`, `thigh_${s}`, `calf_${s}`, 0.078);
      limb(`shin_${s}`, `calf_${s}`, `foot_${s}`, 0.056);
    }
    this.steel = new Steel(physics, this.sword, this, index, effects, () => garrison.voice);
    this.steel.onFlesh = (strike, owner) => {
      // The garrison's swords are not for each other.
      if (owner.who instanceof Soldier) return 'nothing';
      const blow = owner.who.struck(strike, owner.part);
      if (blow === 'cut' || blow === 'through') this.bloody = Math.min(1, this.bloody + 0.3);
      return blow;
    };
    this.steel.onStop = (kind, energy) => {
      if ((kind !== 'shield' && kind !== 'blade') || energy < 0.3) return;
      // A blow that stops dead leaves him open for a moment.
      this.stamina = Math.max(0, this.stamina - 0.05 * energy);
      this.stagger = Math.max(this.stagger, 0.3 * energy);
      this.more = 0;
    };
    if (this.shield) this.board = new Board(physics, this.shield, this, index);
    this.figure.gait.onStep = (_foot, point, speed) => {
      if (speed < 0.5) return;
      const hit = physics.raycast(a.set(point.x, point.y + 0.4, point.z), DOWN, 0.9, GROUP.WORLD);
      garrison.voice?.step(point, hit ? level.surface(hit) : 'dirt', THREE.MathUtils.clamp(speed / 4.5, 0.15, 1));
    };

    this.place(spawn.position, spawn.yaw);
    this.state = spawn.patrol.length ? 'patrol' : 'post';
    carryPose(0.55, 0, 0.02, this.pose);
    this.frame.setFromAxisAngle(UP, this.yaw);
    this.settle(0);
    this.toWorld(this.pose, a, q, 'sword');
    this.steel.place(a, q);
    this.steel.frame(1);
  }

  get dead(): boolean {
    return this.state === 'dead';
  }

  /** In the act of hitting. */
  get striking(): boolean {
    return this.act === 'wind' || this.act === 'throw';
  }

  /** Where his head is, for anything that needs to find his face. */
  head(out: THREE.Vector3): THREE.Vector3 {
    return this.rig.worldPosition('head', out);
  }

  private place(p: THREE.Vector3, yaw: number): void {
    const y = this.physics.raycast(a.set(p.x, p.y + 1.2, p.z), DOWN, 4, GROUP.WORLD)?.point.y ?? p.y;
    this.curr.set(p.x, y, p.z);
    this.prev.copy(this.curr);
    this.position.copy(this.curr);
    this.body.setTranslation(this.curr, true);
    this.body.setNextKinematicTranslation(this.curr);
    this.yaw = this.faceTo = yaw;
    this.figure.gait.place(this.curr, yaw);
  }

  // ------------------------------------------------------------------ what he knows

  private sense(): void {
    const p = this.player;
    a.subVectors(p.position, this.position);
    this.dist = Math.hypot(a.x, a.z);
    this.bearing = Math.atan2(-a.x, -a.z);
    let seen = false;
    // He picks a stranger out at a bowshot's third; once he is looking for them, much further.
    if (!p.dead && this.dist < (this.aware ? 30 : 17) && Math.abs(a.y) < 6) {
      // Eyes to chest, with nothing of the castle between.
      b.set(this.position.x, this.position.y + 1.6, this.position.z);
      c.set(p.position.x, p.position.y + 1.25, p.position.z).sub(b);
      const d = c.length();
      seen = !this.physics.raycast(b, c.divideScalar(d), d, GROUP.WORLD);
    }
    const ahead = Math.abs(wrap(this.bearing - this.yaw)) < 1.2;
    // Once he knows the wearer is there he does not need to be looking straight at them.
    this.sees = seen && (this.aware || ahead || this.dist < 3.2 || (p.sprinting && this.dist < 8));
    if (this.sees) {
      this.lastSeen.copy(p.position);
      this.lost = 0;
    }
    // Where the wearer's blade is, as he sees it: which side of him and how high.
    if (this.dist < 3.5) {
      const s = this.arms.sword;
      a.set(0, 0.5, 0).applyQuaternion(s.quaternion).add(s.position).sub(this.eye).applyQuaternion(q.copy(this.frame).invert());
      this.threat.set(THREE.MathUtils.clamp(a.x / 0.45, -1, 1), THREE.MathUtils.clamp((a.y + 0.1) / 0.45, -1, 1));
    }
  }

  /** Told of the wearer by a shout or the sound of steel. */
  rouse(where: THREE.Vector3): void {
    if (this.dead || this.state === 'broken' || this.state === 'down' || this.aware) return;
    this.aware = true;
    this.lastSeen.copy(where);
    this.lost = 0;
    if (this.state === 'post' || this.state === 'patrol' || this.state === 'return') {
      this.state = 'alert';
      this.timer = rand(0.5, 1.1);
    }
  }

  private notice(): void {
    this.aware = true;
    this.state = 'alert';
    this.timer = rand(0.45, 0.8);
    this.garrison.voice?.at('voice/alert', this.mouth(a), 1);
    this.garrison.rouse(this.position, 8.5, this.player.position, this);
  }

  // ------------------------------------------------------------------ what he decides

  private think(dt: number): void {
    const p = this.player;
    this.senseIn -= dt;
    if (this.senseIn <= 0) {
      this.senseIn = rand(0.06, 0.11);
      this.sense();
    }
    this.want.set(0, 0);
    this.wantGuard = 0;
    this.turn = 5;
    this.timer -= dt;
    this.stagger = Math.max(0, this.stagger - dt);
    this.daze = Math.max(0, this.daze - dt);
    this.reel = Math.max(0, this.reel - dt * 0.55);
    if (!this.sees) this.lost += dt;
    const idle = this.state === 'post' || this.state === 'patrol' || this.state === 'return';
    if (idle && this.sees) this.notice();
    if (p.dead && this.aware) {
      // It is over. He stands a moment and goes back to where he was.
      this.aware = false;
      if (this.state !== 'broken') (this.state = 'return'), (this.timer = rand(2.5, 5));
    }

    switch (this.state) {
      case 'post':
        // Shifts his weight and looks about.
        if (this.timer <= 0) {
          this.timer = rand(3, 8);
          this.faceTo = this.spawn.yaw + rand(-0.7, 0.7);
        }
        this.turn = 1.2;
        break;
      case 'patrol': {
        const to = this.spawn.patrol[this.patrolAt];
        if (this.timer > 0) break;
        if (this.go(to, WALK, 0.5)) {
          this.patrolAt = (this.patrolAt + 1) % this.spawn.patrol.length;
          this.timer = rand(1.5, 5);
        }
        break;
      }
      case 'return':
        if (this.timer > 0) break;
        if (this.go(this.spawn.position, WALK * 1.2, 0.5)) {
          this.state = this.spawn.patrol.length ? 'patrol' : 'post';
          this.faceTo = this.spawn.yaw;
        }
        break;
      case 'alert':
        this.faceTo = this.sees ? this.bearing : Math.atan2(-(this.lastSeen.x - this.position.x), -(this.lastSeen.z - this.position.z));
        if (this.timer <= 0) this.state = 'chase';
        break;
      case 'chase':
        if (this.sees && this.dist < 2.7) {
          this.state = 'fight';
          this.attackIn = rand(0.25, 0.9);
          break;
        }
        if (this.lost > 7) {
          this.aware = false;
          this.state = 'return';
          this.timer = rand(1.5, 3);
          break;
        }
        // Runs to close the ground and comes in at a walk, sword up.
        this.go(this.sees ? p.position : this.lastSeen, this.dist > 7 ? RUN : ADVANCE, 0.6);
        if (this.sees && this.dist < 7) this.faceTo = this.bearing;
        break;
      case 'fight':
        this.fight(dt);
        break;
      case 'broken': {
        // Disarmed or cut too badly to go on: he backs away from the blade for as long as his legs hold.
        this.faceTo = this.bearing;
        if (this.dist < 6) this.want.set(Math.sin(this.bearing), Math.cos(this.bearing)).multiplyScalar(1.5);
        break;
      }
    }
    if (this.stagger > 0) this.want.multiplyScalar(0.15);
  }

  /** Face to face with the wearer. */
  private fight(dt: number): void {
    const p = this.player, arms = this.arms;
    if ((!this.sees && this.lost > 1.2) || this.dist > 4.4) {
      this.state = 'chase';
      return;
    }
    this.faceTo = this.bearing;
    this.turn = this.act === 'throw' ? 1.6 : this.daze > 0 ? 1.5 : 5.5;
    const tired = this.stamina < 0.2;
    const hurt = this.vitality < 45;
    // Only so many can get at one man at once; the rest wait their turn a little further out.
    const waiting = this.garrison.rank(this) >= 2;
    let measure = waiting ? 3.3 : tired ? 2.8 : hurt ? 2.35 : MEASURE;
    this.away = Math.max(0, this.away - dt);
    if (this.away > 0) measure = Math.max(measure, 2.7);

    // Reading the wearer's sword: drawn back, or already on its way.
    const fast = arms.steel.tipSpeed > 5.5;
    const threatened = !p.dead && this.dist < 3.1 && (arms.attacking || fast);
    if (threatened && this.sawSwing !== arms.swings) {
      this.sawSwing = arms.swings;
      // He either reads it or he does not, and a tired, hurt or dazed man reads less.
      const read = this.skill * (this.board && !this.shieldDead ? 1 : 0.75) * (tired ? 0.6 : 1) * (this.daze > 0 ? 0.3 : 1) * (hurt ? 1.15 : 1);
      this.ready = Math.random() < read ? rand(0.08, 0.24) * (1.4 - this.skill) : -1;
      // Caught drawing back himself, he may give it up to cover, or go through with it.
      if (this.act === 'wind' && this.ready >= 0 && Math.random() > this.nerve * 0.7) this.recover(0.2);
    }
    if (threatened && this.ready >= 0 && !this.striking) {
      this.ready -= dt;
      if (this.ready <= 0) this.wantGuard = 1;
      // A blow being wound up is a good one to be further away from, if he has nothing to put in its way.
      if (arms.loaded && arms.charge > 0.4 && (!this.board || hurt)) measure = Math.max(measure, 2.6);
    }

    // Keeping the measure, and never standing still in it.
    this.circleIn -= dt;
    if (this.circleIn <= 0) {
      this.circleIn = rand(1.0, 3.2);
      this.circle = Math.random() < 0.5 ? -1 : 1;
      if (Math.random() < 0.2) this.circle = 0;
    }
    const closing = this.striking;
    const range = closing ? CLOSE : measure;
    const radial = THREE.MathUtils.clamp((this.dist - range) * 3.4, -2.1, closing ? 2.6 : 1.6);
    const fx = -Math.sin(this.bearing), fz = -Math.cos(this.bearing);
    let side = this.circle * (closing ? 0.25 : 0.8);
    // Something is between them: go round it rather than lean on it.
    const held = this.blocked > 0.35;
    if (held) side = (this.circle || 1) * 1.7;
    this.want.set(fx * radial * (held ? 0.4 : 1) + fz * side, fz * radial * (held ? 0.4 : 1) - fx * side);
    // He does not stand in another man's way, which spreads them round the wearer.
    this.garrison.spread(this, this.want);

    // His own blows.
    this.attackIn -= dt * (p.winded || p.stamina < 0.2 ? 1.8 : 1);
    if (this.act === 'guard' && this.stagger <= 0 && this.daze <= 0 && !waiting && this.wantGuard === 0 && this.dist < 2.45 && Math.abs(wrap(this.bearing - this.yaw)) < 0.5 && this.stamina > 0.1 && this.garrison.mayStrike(this)) {
      // He strikes when his own time comes round; at once into an opening or a turned back; and sometimes
      // straight into a blow that is taking too long to come.
      const open = arms.phase === 'recover' || arms.busy || (arms.steel.tipSpeed < 1.2 && arms.offset.length() > 0.35);
      const behind = Math.abs(wrap(this.bearing + Math.PI - p.aimYaw)) > 1.9;
      const riposte = (open || behind) && Math.random() < this.nerve * dt * 10;
      const stop = arms.loaded && arms.charge > 0.5 && Math.random() < this.nerve * dt * 1.8;
      if (this.attackIn <= 0 || riposte || stop) this.begin(stop);
    }
  }

  /** Walks or runs towards a place, round whatever is in the way. Returns true on arrival. */
  private go(to: THREE.Vector3, speed: number, within: number): boolean {
    const dx = to.x - this.position.x, dz = to.z - this.position.z;
    if (Math.hypot(dx, dz) < within) return true;
    let goal = to;
    if (!this.clear(this.position, to)) {
      this.pathIn -= 1 / 60;
      if (this.pathIn <= 0 || !this.path.length) {
        this.pathIn = 0.7;
        this.path = this.garrison.route(this.position, to);
      }
      const nodes = this.level.nav.nodes;
      // Cut the corner when the node after next is already in plain view.
      while (this.path.length > 1 && this.clear(this.position, nodes[this.path[1]])) this.path.shift();
      while (this.path.length && Math.hypot(nodes[this.path[0]].x - this.position.x, nodes[this.path[0]].z - this.position.z) < 0.55) this.path.shift();
      if (this.path.length) goal = nodes[this.path[0]];
    }
    const gx = goal.x - this.position.x, gz = goal.z - this.position.z;
    const d = Math.hypot(gx, gz) || 1;
    const s = speed * (1 - 0.45 * this.limp) * (0.6 + 0.4 * (this.vitality / 100));
    this.want.set((gx / d) * s, (gz / d) * s);
    this.faceTo = Math.atan2(-gx, -gz);
    // Wedged against something: go round it.
    if (this.velocity.lengthSq() < 0.05) {
      this.stuck += 1 / 60;
      if (this.stuck > 0.8) {
        this.want.set(-gz / d, gx / d).multiplyScalar(s * (Math.floor(this.stuck / 0.8) % 2 ? 1 : -1));
        if (this.stuck > 2.4) (this.stuck = 0), (this.pathIn = 0);
      }
    } else this.stuck = Math.max(0, this.stuck - 1 / 30);
    return false;
  }

  /** Whether a man could walk straight from one place to another. */
  private clear(from: THREE.Vector3, to: THREE.Vector3): boolean {
    if (Math.abs(to.y - from.y) > 1.1) return false;
    for (const h of [0.25, 0.6, 1.2]) {
      a.set(from.x, from.y + h, from.z);
      b.set(to.x, to.y + h, to.z).sub(a);
      const d = b.length();
      if (d < 0.05) continue;
      const hit = this.physics.raycast(a, b.divideScalar(d), d, GROUP.WORLD);
      // Rising ground is not in the way; a hearth, a bench or a wall is.
      if (hit && hit.normal.y < 0.7) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ his sword

  /** How strongly his arm can drive the sword just now. */
  private strength(): number {
    return (0.66 + 0.26 * ease(THREE.MathUtils.clamp(this.stamina / 0.4, 0, 1))) * (0.75 + 0.25 * (this.vitality / 100));
  }

  /**
   * Starts a blow. Nothing about it is fixed: which side it is drawn back to
   * and how high, how far, how long he takes over it, where on the wearer it
   * is meant for, whether it is a cut or a point, whether the first drawing
   * back is a lie, and whether another follows it.
   */
  private begin(quick: boolean): void {
    const heavy = !quick && Math.random() < 0.18 && this.stamina > 0.4;
    this.thrusting = quick || Math.random() < 0.28;
    this.power = heavy ? 1.7 : 1;
    // Low when a shield is up in front of him, otherwise wherever he fancies.
    const pick = Math.random();
    this.zone = this.arms.guard > 0.5 && pick < 0.6 ? -0.34 : pick < 0.22 ? 0.12 : pick < 0.8 ? 0 : -0.3;
    const slow = 1 / this.strength();
    if (this.thrusting) {
      this.reachFrom = -1;
      this.oTo.set(rand(-0.2, 0.2), rand(-0.15, 0.15));
    } else {
      const overhead = Math.random() < 0.14;
      const side = Math.random() < 0.5 ? 1 : -1;
      const angle = overhead ? Math.PI / 2 + rand(-0.3, 0.3) : side > 0 ? rand(-0.25, 1.15) : Math.PI - rand(-0.25, 1.15);
      const far = rand(0.42, 0.58) + (heavy ? 0.06 : 0);
      this.oTo.set(Math.cos(angle) * far * (REACH.x / 0.62), Math.sin(angle) * far * 0.85);
      withinReach(this.oTo);
      this.feint = !heavy && Math.random() < this.skill * 0.32;
    }
    this.more = !heavy && !quick && Math.random() < 0.34 * this.nerve ? (Math.random() < 0.25 ? 2 : 1) : 0;
    this.oFrom.copy(this.o);
    this.act = 'wind';
    this.t = 0;
    this.duration = (heavy ? rand(0.75, 0.95) : quick ? 0.26 : rand(0.34, 0.56)) * slow;
    this.stamina = Math.max(0, this.stamina - (heavy ? 0.14 : 0.06));
    this.garrison.struck(this);
    if (heavy || Math.random() < 0.3) this.garrison.voice?.at('voice/effort', this.mouth(a), heavy ? 1 : 0.7);
  }

  private recover(duration: number): void {
    this.act = 'recover';
    this.t = 0;
    this.duration = duration;
    this.more = 0;
    this.feint = false;
    this.attackIn = rand(0.9, 2.6) / (0.5 + this.nerve);
    // Often he steps back out of reach once he has had his say.
    if (Math.random() < 0.5) this.away = rand(0.5, 1.1);
  }

  private mouth(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + 1.62, this.position.z);
  }

  /** Where the sword is asked to be this frame. */
  private wield(dt: number): void {
    this.t += dt;
    this.clock += dt;
    const u = Math.min(1, this.t / this.duration);
    const steel = this.steel;
    const s = this.strength();
    const fighting = this.state === 'fight' || this.state === 'chase' || this.state === 'alert';
    // At rest: carried low until there is someone to point it at, and never held quite still.
    const run = fighting ? (this.state === 'chase' && this.dist > 7 ? 0.8 : 0) : 0.6;
    const low = fighting ? Math.max(0, 0.4 - this.stamina) * 0.2 + (this.stagger > 0 ? 0.12 : 0) : 0.03;
    carryPose(run, this.board ? this.guard : 0, low, this.rest);
    const wander = 0.008 + 0.02 * (1 - this.stamina) + (this.daze > 0 ? 0.03 : 0);
    this.rest.g.x += Math.sin(this.clock * 0.9 + this.seed) * wander;
    this.rest.g.y += Math.sin(this.clock * 1.3 + this.seed * 2) * wander;
    this.rest.q.multiply(q.setFromEuler(this.e.set(Math.sin(this.clock * 0.7 + this.seed) * wander * 3, 0, Math.sin(this.clock * 1.1 + this.seed * 3) * wander * 4)));
    if (!this.board && this.guard > 0.01) {
      // No shield: the sword goes to meet what is coming.
      parryPose(this.threat, this.target);
      this.rest.g.lerp(this.target.g, this.guard);
      this.rest.q.slerp(this.target.q, this.guard);
    }

    if (this.act === 'guard') {
      this.o.multiplyScalar(Math.exp(-dt * 8));
      this.pose.g.copy(this.rest.g);
      this.pose.q.copy(this.rest.q);
      const quick = this.guard > 0.3 ? 1.5 : 1;
      steel.linAcc = 42 * s * quick;
      steel.angAcc = 62 * s * quick;
      steel.maxSpeed = 5.5 * quick;
      steel.maxSpin = 12 * quick;
      steel.power = 1;
    } else if (this.thrusting) {
      if (this.act === 'wind') {
        this.reach = this.reachFrom - (0.05 + (this.power > 1 ? 0.3 : 0)) * ease(u);
        this.o.lerpVectors(this.oFrom, this.oTo, ease(u));
        if (u >= 1) this.loose(0.16 / s);
      } else if (this.act === 'throw') {
        this.reach = this.reachFrom + (1.08 - this.reachFrom) * ease(u);
        if (u >= 1) this.recover(rand(0.45, 0.65));
      } else if (u >= 1) this.act = 'guard';
      const hard = this.act === 'throw' ? 1 : 0.55;
      steel.linAcc = 105 * s * hard * (0.8 + 0.2 * this.power);
      steel.angAcc = 120 * s * hard;
      steel.maxSpeed = 9.5 * s * (0.7 + 0.3 * hard);
      steel.maxSpin = 18;
      lungePose(this.reach, this.o, this.pose);
    } else {
      if (this.act === 'wind') {
        this.o.lerpVectors(this.oFrom, this.oTo, ease(u));
        this.heading.copy(this.o).negate();
        if (u >= 1) {
          if (this.feint) {
            // The first drawing back was to be believed. He takes it across to the other side.
            this.feint = false;
            this.oFrom.copy(this.o);
            this.oTo.set(-this.oTo.x * rand(0.8, 1), this.oTo.y * rand(0.5, 1.1));
            this.t = 0;
            this.duration = rand(0.2, 0.3);
          } else this.across(rand(0.21, 0.28) / s);
        }
      } else if (this.act === 'throw') {
        this.o.lerpVectors(this.oFrom, this.oTo, u * u * (3 - 2 * u));
        this.heading.subVectors(this.oTo, this.oFrom);
        if (u >= 1) {
          if (this.more > 0 && this.stagger <= 0 && this.stamina > 0.15) {
            // And back again, along a different line.
            this.more--;
            this.stamina = Math.max(0, this.stamina - 0.05);
            this.across(rand(0.26, 0.34) / s);
          } else this.recover(rand(0.5, 0.7));
        }
      } else {
        this.o.multiplyScalar(Math.exp(-dt * 6));
        if (u >= 1) this.act = 'guard';
      }
      const hard = this.act === 'throw' ? 1 : 0.6;
      const drive = s * (0.75 + 0.25 * this.power);
      steel.linAcc = 84 * drive * hard;
      steel.angAcc = 140 * drive * hard;
      steel.maxSpeed = 11 * drive * (0.7 + 0.3 * hard);
      steel.maxSpin = 26 * drive * (0.7 + 0.3 * hard);
      swingPose(this.o, this.heading, this.pose);
    }
    if (this.act === 'recover') {
      const w = ease(u);
      this.pose.g.lerp(this.rest.g, w);
      this.pose.q.slerp(this.rest.q, w);
      steel.power = 1;
    }
    const guarding = this.wantGuard > 0 && this.stagger <= 0 && !this.striking;
    this.guard += ((guarding ? 1 : 0) - this.guard) * (1 - Math.exp(-dt * (guarding ? 16 : 7)));
  }

  /** Lets a cut go: from wherever the hand is, across to the far side, and never along the same line twice. */
  private across(duration: number): void {
    this.oFrom.copy(this.o);
    this.oTo.copy(this.o).normalize().multiplyScalar(-rand(0.5, 0.6)).rotateAround(ORIGIN, rand(-0.45, 0.45));
    withinReach(this.oTo);
    this.loose(duration);
  }

  private loose(duration: number): void {
    this.act = 'throw';
    this.t = 0;
    this.duration = duration;
    this.reachFrom = this.reach;
    this.steel.power = this.power;
    this.garrison.voice?.at('sword/swing', this.sword.position, this.thrusting ? 0.5 : 0.8, this.thrusting ? 1.2 : 1);
  }

  private toWorld(pose: Pose, position: THREE.Vector3, quaternion: THREE.Quaternion, hand: 'sword' | 'shield'): void {
    position.copy(pose.g).applyQuaternion(this.frame).add(this.eye);
    quaternion.copy(this.frame).multiply(pose.q);
    this.figure.limit(hand, position, quaternion);
  }

  // ------------------------------------------------------------------ what is done to him

  /** The wearer's blade stopped on his shield or his sword. */
  parried(on: 'shield' | 'blade', energy: number, _point: THREE.Vector3, direction: THREE.Vector3): void {
    if (this.dead) return;
    this.rouse(this.player.position);
    this.stamina = Math.max(0, this.stamina - (on === 'shield' ? 0.07 : 0.055) * energy);
    this.flinchPitch.v += 1.2 * energy;
    this.knock.addScaledVector(direction, 0.9 * energy).setY(0);
    this.reel += 0.22 * energy;
    if (this.striking && energy > 0.35) this.recover(0.45);
    // A blow with everything behind it beats the guard aside, and so does any blow on an arm with nothing left.
    if (energy > 1.15 || this.stamina <= 0.02) {
      this.stagger = Math.max(this.stagger, 0.7);
      this.flinchRoll.v += 2.5;
    }
  }

  struck(s: Strike, part: string): Blow {
    if (this.dead) return 'through';
    const sev = severity(s);
    if (sev < 0.1) return 'nothing';
    const voice = this.garrison.voice;
    const point = s.hit.point;
    this.rouse(this.player.position);
    this.garrison.rouse(this.position, 7, this.player.position, this);

    let amount: number;
    let blow: Blow = 'cut';
    if (part === 'head') {
      this.rig.worldPosition('head', a);
      // The kettle hat covers the crown and its brim the temples. A cut that comes down on it rings;
      // one that comes in under the brim, or a point, finds the face and the neck.
      if (!s.thrust && point.y > a.y + 0.07) {
        amount = 8 * sev;
        this.daze = Math.max(this.daze, 0.4 + 0.35 * sev);
        this.reel += 0.3 * sev;
        this.effects.sparks(point, s.hit.normal, Math.round(4 + 5 * sev), 0.7);
        voice?.clash(point, Math.min(1.2, sev * 0.6));
        if (sev > 3.4) amount = 75;
        blow = 'glanced';
      } else amount = (s.thrust ? 95 : 62) * sev;
    } else if (part === 'torso' || part === 'hips') {
      // Thirty layers of linen turn most of an edge. They do not turn a point.
      amount = (s.thrust ? 58 : 21) * sev;
    } else if (part.includes('arm')) {
      amount = (s.thrust ? 24 : 27) * sev;
      if (amount > 32) {
        if (part.endsWith('_r')) this.disarm(s);
        else this.shieldDead = true;
      }
    } else {
      amount = (s.thrust ? 26 : 29) * sev;
      if (amount > 26) this.limp = Math.min(1, this.limp + 0.6);
      this.reel += 0.35 * sev;
    }

    this.vitality -= amount;
    if (blow !== 'glanced') {
      const bone = BONE[part] ?? 'spine_03';
      this.bleed += amount * 0.035;
      // The wound itself: a line where the edge went in, a hole where a point did, and the cloth round it filling.
      this.gore.mark(bone, point, s.thrust ? s.direction : s.blade, s.thrust ? 0.03 : THREE.MathUtils.clamp(0.07 + 0.04 * sev, 0.07, 0.24), 0.045 + 0.02 * Math.min(4, sev));
      this.wounds.push({ bone, rate: Math.min(7, amount * 0.08), drip: 0, pulse: amount > 34 ? rand(4, 9) : 0, out: s.hit.normal.clone() });
      this.effects.blood(point, s.direction, Math.round(12 + amount * 0.55), 0.9 + 0.35 * Math.min(3, sev));
      this.effects.blood(point, a.copy(s.hit.normal), Math.round(5 + amount * 0.15), 0.6);
      voice?.flesh(point, Math.min(1.5, sev));
      // Close enough, some of it reaches the lens.
      if (this.dist < 1.9) this.arms.events.spatter?.(Math.min(1, amount / 110));
    }
    // The blow moves him, turns him and stops what he was doing.
    const local = a.copy(s.direction).applyAxisAngle(UP, -this.yaw);
    const jolt = Math.min(2.2, sev);
    this.flinchPitch.v += (local.z > 0 ? 1 : -1) * (1.5 + 2.2 * jolt);
    this.flinchRoll.v += -Math.sign(local.x || 1) * (1 + 1.8 * jolt);
    this.flinchYaw.v += -local.x * 2 * jolt;
    this.knock.addScaledVector(s.direction, 0.9 * jolt).setY(0);
    this.reel += 0.22 * jolt;
    this.stagger = Math.max(this.stagger, 0.22 + amount / 110);
    if (amount > 10 && this.striking) this.recover(0.4);
    this.stamina = Math.max(0, this.stamina - 0.05);

    if (this.vitality <= 0) {
      this.die(s, part, jolt);
      // A blow with enough behind it does not stop in him.
      return sev > 2.6 && !s.thrust ? 'through' : 'cut';
    }
    if (blow !== 'glanced') voice?.at('voice/pain', this.mouth(b), 0.9);
    // Knocked off his feet: by a leg going from under him, or by more than a man can stand up to.
    if (this.state !== 'down' && (this.reel > 1 || (this.limp >= 1 && amount > 30))) this.floor(s.direction, jolt);
    else if (this.vitality < 30 && this.state !== 'broken' && this.state !== 'down' && Math.random() > this.nerve) this.yield();
    return blow;
  }

  private disarm(s: Strike): void {
    if (this.disarmed) return;
    this.disarmed = true;
    this.sword.visible = false;
    this.steel.live = false;
    dropSword(this.scene, this.physics, this.sword, a.copy(s.direction).multiplyScalar(2.5).setY(1.2));
    this.garrison.later(0.5, () => this.garrison.voice?.fall(this.position, 'sword/drop', 0.9));
    this.yield();
  }

  /** He has had enough. */
  private yield(): void {
    if (this.state !== 'down') this.state = 'broken';
    this.act = 'guard';
    this.bleed = Math.max(this.bleed, 3.5);
  }

  /** Goes down, alive: the world has him until he can get his feet under him again. */
  private floor(direction: THREE.Vector3, force: number): void {
    const ragdoll = new Ragdoll(this.physics, this.rig, a.copy(this.velocity).add(this.knock));
    ragdoll.push('chest', a.copy(direction).multiplyScalar(22 + 18 * force).setY(-10));
    ragdoll.push(Math.random() < 0.5 ? 'thigh_l' : 'thigh_r', a.copy(direction).multiplyScalar(-20));
    ragdoll.onThud = (point, strength) => this.garrison.voice?.fall(point, 'body/fall', 0.5 + 0.5 * strength);
    this.floored = ragdoll;
    this.flooredFor = rand(1.7, 3.1) + this.limp;
    this.state = 'down';
    this.act = 'guard';
    this.reel = 0;
    this.collider.setEnabled(false);
    if (this.shield) {
      const arm = this.rig.bones.lowerarm_l;
      arm.updateWorldMatrix(true, false);
      this.shield.updateMatrixWorld(true);
      this.strapped.copy(arm.matrixWorld).invert().multiply(this.shield.matrixWorld);
    }
  }

  /** Gets up from where he fell. */
  private rise(): void {
    const ragdoll = this.floored!;
    this.lying = this.rig.capture();
    this.rig.worldPosition('pelvis', a);
    ragdoll.dispose();
    this.floored = null;
    this.rising = 1;
    this.state = this.disarmed || this.vitality < 30 ? 'broken' : 'fight';
    this.stagger = 1.1;
    this.attackIn = rand(1, 2);
    this.collider.setEnabled(true);
    this.velocity.set(0, 0, 0);
    this.knock.set(0, 0, 0);
    this.place(a, this.bearing);
  }

  /** Bleeding, tiring, and going down when there is nothing left. */
  private suffer(dt: number): void {
    if (this.bleed > 0) {
      this.vitality -= this.bleed * dt;
      // Wounds clot, slowly, if they are not too bad.
      this.bleed = Math.max(this.vitality < 35 ? 1.2 : 0, this.bleed - dt * 0.12);
      this.gore.spread(dt, 0.004 + this.bleed * 0.0025);
      for (const w of this.wounds) {
        w.drip -= dt * w.rate;
        if (w.drip <= 0) {
          w.drip = rand(0.6, 1.4);
          this.rig.worldPosition(w.bone, a);
          this.effects.drip(a);
        }
        // A deep wound throws blood in time with the heart for a while.
        if (w.pulse > 0) {
          const before = Math.floor(w.pulse * 2.4);
          w.pulse -= dt;
          if (Math.floor(w.pulse * 2.4) !== before) {
            this.rig.worldPosition(w.bone, a);
            this.effects.blood(a, b.copy(w.out).setY(w.out.y + 0.3), Math.round(3 + w.pulse * 1.2), 0.5 + w.pulse * 0.06);
          }
        }
      }
      if (this.vitality <= 0) this.die(null, 'torso', 0.4);
    }
    if (this.act === 'guard' && this.guard < 0.3) this.stamina = Math.min(1, this.stamina + dt / 16);
  }

  private die(s: Strike | null, part: string, force: number): void {
    if (this.dead) return;
    const g = this.garrison;
    const was = this.state;
    this.state = 'dead';
    this.aware = false;
    const w = this.physics.world;
    for (const v of this.volumes) {
      this.physics.owners.delete(v.collider.handle);
      w.removeCollider(v.collider, false);
    }
    this.volumes.length = 0;
    w.removeCharacterController(this.controller);
    w.removeRigidBody(this.body);

    const ragdoll = this.floored ?? new Ragdoll(this.physics, this.rig, a.copy(this.velocity).add(this.knock));
    this.floored = null;
    if (s) {
      // The blow that killed him carries the part it landed on, and the rest follows.
      ragdoll.push(LIMB[part] ?? 'chest', a.copy(s.direction).multiplyScalar(22 + 26 * force), s.hit.point);
      ragdoll.push('chest', a.copy(s.direction).multiplyScalar(12 * force).setY(-14));
    } else if (was !== 'down') ragdoll.push('chest', a.set(-Math.sin(this.yaw), -0.4, -Math.cos(this.yaw)).multiplyScalar(22));
    const fallen = new Fallen(this.rig, ragdoll);
    if (this.shield) fallen.carry(this.shield, 'lowerarm_l');
    this.board?.dispose();
    if (!this.disarmed) {
      dropSword(this.scene, this.physics, this.sword, a.copy(this.velocity).setY(0.5));
      g.later(0.55, () => g.voice?.fall(this.position, 'sword/drop', 0.8));
    }
    this.steel.dispose();
    this.sword.removeFromParent();
    ragdoll.onThud = (point, strength) => g.voice?.fall(point, 'body/fall', 0.5 + 0.5 * strength);
    g.bury(fallen, BONE[part] ?? 'spine_03', s ? 1 : 0.6);
    // Not every man dies quietly, and some take a while over it.
    const quick = part === 'head' || force > 1.6;
    if (!quick || Math.random() < 0.5) g.voice?.at('voice/death', this.mouth(b), 1);
    if (!quick) for (let i = 1; i <= 2; i++) g.later(rand(1.4, 2.6) * i, () => g.voice?.at('voice/pain', fallen.rig.worldPosition('head', new THREE.Vector3()), 0.55 / i, 0.85));
  }

  // ------------------------------------------------------------------ moving and standing

  /** Once per physics step. */
  fixedStep(dt: number): void {
    if (this.dead) return;
    if (!this.disarmed) this.steel.step(dt);
    if (this.board && this.shield) this.board.follow(this.shield);
    if (this.state === 'down') {
      this.suffer(dt);
      this.flooredFor -= dt;
      if (!this.dead && this.flooredFor <= 0) this.rise();
      return;
    }
    const p = this.curr;
    this.prev.copy(p);
    this.think(dt);
    this.suffer(dt);
    if (this.dead) return;

    const d = wrap(this.faceTo - this.yaw);
    this.yaw += THREE.MathUtils.clamp(d, -this.turn * dt, this.turn * dt);
    const v = this.velocity;
    const k = this.knock;
    k.multiplyScalar(Math.exp(-5 * dt));
    if (this.grounded) {
      v.x = approach(v.x, this.want.x + k.x, 8, dt);
      v.z = approach(v.z, this.want.y + k.z, 8, dt);
      v.y = Math.max(v.y - 9.81 * dt, -2);
    } else v.y -= 9.81 * dt;
    this.controller.computeColliderMovement(this.collider, { x: v.x * dt, y: v.y * dt, z: v.z * dt }, undefined, this.filter);
    const m = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    p.x += m.x;
    p.y += m.y;
    p.z += m.z;
    this.body.setNextKinematicTranslation(p);
    v.x = m.x / dt;
    v.z = m.z / dt;
    if (this.grounded && v.y < 0) v.y = 0;
    // Trying to go somewhere and not getting there.
    const wanted = this.want.length();
    if (wanted > 0.5 && Math.hypot(v.x, v.z) < wanted * 0.3) this.blocked = Math.min(1.2, this.blocked + dt);
    else this.blocked = Math.max(0, this.blocked - dt * 0.6);
  }

  /** Per frame: stands the figure where the capsule is and puts the weapons in its hands. */
  update(dt: number, alpha: number): void {
    if (this.dead) return;
    if (this.floored) {
      // On the ground: the bones are the world's, and the sword goes where the hand does.
      this.floored.update(dt);
      this.rig.worldPosition('pelvis', this.position);
      this.rig.worldPosition('hand_r', a);
      this.rig.worldQuaternion('hand_r', q);
      this.steel.linAcc = 30;
      this.steel.angAcc = 30;
      this.steel.maxSpeed = 5;
      this.steel.maxSpin = 8;
      this.steel.power = 1;
      this.steel.aim(a.add(b.set(0, 0.08, 0).applyQuaternion(q)), this.sword.quaternion);
      if (!this.disarmed) this.steel.frame(alpha);
      if (this.shield) {
        const arm = this.rig.bones.lowerarm_l;
        arm.updateWorldMatrix(true, false);
        m4.multiplyMatrices(arm.matrixWorld, this.strapped).decompose(this.shield.position, this.shield.quaternion, unit);
      }
      this.blood.value = this.bloody;
      this.track();
      return;
    }
    this.position.lerpVectors(this.prev, this.curr, alpha);
    this.settle(dt, alpha);
  }

  private settle(dt: number, alpha = 1): void {
    const fig = this.figure;
    const fighting = this.state === 'fight' || this.state === 'alert' || (this.state === 'chase' && this.dist < 7);
    this.stance = approach(this.stance, fighting ? 1 : 0, 4, dt);
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const run = Math.min(1, speed / 4.5);
    const fp = this.flinchPitch.step(dt), fy = this.flinchYaw.step(dt), fr = this.flinchRoll.step(dt);
    const hurt = 1 - this.vitality / 100;
    // The trunk goes with the hand, as the wearer's does.
    const twist = this.thrusting && this.act !== 'guard' ? 0.06 * (this.reach + 1) : -this.o.x * 0.26;
    // On guard he sits into his legs and leans in; hurt, he folds over it.
    const lean = -0.03 - 0.05 * this.stance - 0.06 * run - 0.12 * hurt * hurt - (this.stagger > 0 ? 0.08 : 0) + (this.daze > 0 ? Math.sin(this.daze * 9) * 0.04 : 0);
    const dy = this.player.position.y - this.position.y;
    this.aimPitch = approach(this.aimPitch, this.aware ? THREE.MathUtils.clamp(Math.atan2(dy, Math.max(1, this.dist)), -0.5, 0.5) + (this.striking ? this.zone : 0) : 0, 6, dt);
    this.chest.setFromEuler(this.e.set(lean + fp * 0.06, this.yaw + twist + fy * 0.06, fr * 0.06 - this.o.x * 0.05));
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    this.eye.set(this.position.x + fx * 0.13, this.position.y + CHEST - 0.05 * this.stance - 0.05 * hurt + fig.gait.sway.y, this.position.z + fz * 0.13);
    this.eye.y -= fig.stand(dt, this.eye, this.chest, this.position, this.yaw, this.velocity, this.grounded, undefined, this.stance * 0.2);

    this.frame.setFromEuler(this.e.set(this.aimPitch * 0.9, this.yaw + twist * 0.4, 0));
    this.wield(dt);
    // Where the sword is asked to be; where it is, is the steel's business.
    this.toWorld(this.pose, a, q, 'sword');
    this.steel.aim(a, q);
    if (!this.disarmed && dt > 0) {
      this.steel.frame(alpha);
      fig.limit('sword', this.sword.position, this.sword.quaternion);
    }
    this.blood.value = this.bloody;
    if (this.shield) {
      const g = this.shieldDead ? 0 : ease(this.guard);
      boardPose(g, 0, this.stagger > 0.3 ? 1 : 0, this.target, -this.threat.x);
      const r = 1 - Math.exp(-dt * 14);
      this.boardAt.g.lerp(this.target.g, dt > 0 ? r : 1);
      this.boardAt.q.slerp(this.target.q, dt > 0 ? r : 1);
      this.toWorld(this.boardAt, this.shield.position, this.shield.quaternion, 'shield');
    }
    fig.wield(this.disarmed ? null : this.sword, this.shield, this.chest);
    if (this.disarmed) fig.hang('r', this.chest, 0);
    if (!this.shield) fig.hang('l', this.chest, Math.sin(this.clock * 3) * 0.1 * run);
    // He looks at what he is fighting.
    if (this.aware && this.stagger <= 0) {
      const look = THREE.MathUtils.clamp(wrap(this.bearing - this.yaw), -0.9, 0.9);
      this.rig.rotateWorld('head', q.setFromAxisAngle(UP, look * 0.8));
    }
    // Getting up: out of the heap he was lying in and into his stance.
    if (this.rising > 0 && this.lying) {
      this.rising = Math.max(0, this.rising - dt / 0.95);
      this.rig.blend(this.lying, ease(this.rising));
    }
    this.track();
  }

  /** Moves the hit volumes on to the bones. */
  private track(): void {
    const rig = this.rig;
    for (const v of this.volumes) {
      rig.worldPosition(v.from, a);
      if (v.to) {
        rig.worldPosition(v.to, b);
        c.subVectors(b, a);
        const len = c.length() || 1;
        v.collider.setTranslation(b.add(a).multiplyScalar(0.5));
        v.collider.setRotation(q.setFromUnitVectors(UP, c.divideScalar(len)));
      } else {
        rig.worldQuaternion(v.from, q).multiply(q2.copy(rig.restWorldQ[v.from]).invert());
        v.collider.setTranslation(a.add(b.set(0, v.rise ?? 0, 0).applyQuaternion(q)));
        v.collider.setRotation(q);
      }
    }
  }
}

interface Grave {
  fallen: Fallen;
  bone: string;
  age: number;
  next: number;
  flow: number;
}

/** Everyone holding the castle, and what is left of them. */
export class Garrison {
  readonly soldiers: Soldier[] = [];
  readonly fallen: Fallen[] = [];
  voice: Voice | null = null;
  private graves: Grave[] = [];
  private pending: { at: number; run: () => void }[] = [];
  private time = 0;
  private lastStrike = -10;
  private v = new THREE.Vector3();

  private constructor(private physics: Physics, private level: Level, private player: Player, private effects: Effects) {}

  static async create(scene: THREE.Scene, assets: Assets, physics: Physics, level: Level, player: Player, arms: Arms, effects: Effects): Promise<Garrison> {
    const g = new Garrison(physics, level, player, effects);
    const source = (await assets.model('characters/soldier')).scene;
    const loader = new THREE.TextureLoader();
    const cloths = await Promise.all(
      ['woad', 'russet'].map((name) =>
        loader.loadAsync(`${import.meta.env.BASE_URL}assets/characters/soldier_cloth_base_${name}.jpg`).then((t) => {
          t.flipY = false;
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          return t;
        }),
      ),
    );
    const dyed = new Map<string, THREE.Material>();
    // Who stands where: the ones with shields are the harder men.
    const kit: Array<{ shield: boolean; skill: number; nerve: number }> = [
      { shield: true, skill: 0.55, nerve: 0.6 },
      { shield: false, skill: 0.45, nerve: 0.75 },
      { shield: true, skill: 0.65, nerve: 0.55 },
      { shield: false, skill: 0.5, nerve: 0.85 },
      { shield: true, skill: 0.78, nerve: 0.7 },
    ];
    for (let i = 0; i < level.enemySpawns.length; i++) {
      const k = kit[i % kit.length];
      const rig = Rig.from(source);
      // The garrison's colours, so that they are not taken for the wearer's own dead.
      const clothes = rig.root.getObjectByName('body_clothes') as THREE.Mesh | undefined;
      if (clothes) {
        const key = `${(clothes.material as THREE.Material).uuid}:${i % 2}`;
        let m = dyed.get(key);
        if (!m) {
          m = (clothes.material as THREE.Material).clone();
          (m as THREE.MeshStandardNodeMaterial).map = cloths[i % 2];
          dyed.set(key, m);
        }
        clothes.material = m;
      }
      const sword = await assets.instance('arming_sword');
      let shield: THREE.Object3D | null = null;
      if (k.shield) {
        shield = await assets.instance('kite_shield');
        shield.scale.setScalar(0.8);
        shield.rotation.y = Math.PI;
      }
      g.soldiers.push(new Soldier(g, scene, physics, level, player, arms, effects, rig, sword, shield, level.enemySpawns[i], i + 1, k.skill, k.nerve));
    }
    return g;
  }

  get standing(): number {
    return this.soldiers.filter((s) => !s.dead).length;
  }

  /** Where a soldier stands among those fighting the wearer, nearest first. */
  rank(s: Soldier): number {
    let ahead = 0;
    const d = s.position.distanceToSquared(this.player.position);
    for (const o of this.soldiers) if (o !== s && !o.dead && o.state === 'fight' && o.position.distanceToSquared(this.player.position) < d) ahead++;
    return ahead;
  }

  /** Turns a soldier's step away from the men beside him. */
  spread(s: Soldier, want: THREE.Vector2): void {
    for (const o of this.soldiers) {
      if (o === s || o.dead || o.state === 'down') continue;
      const dx = s.position.x - o.position.x, dz = s.position.z - o.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.7 && d > 0.01) want.x += (dx / d) * (1.7 - d) * 1.6, (want.y += (dz / d) * (1.7 - d) * 1.6);
    }
  }

  /** Two men do not swing at the same instant; they would hit each other. */
  mayStrike(_s: Soldier): boolean {
    if (this.time - this.lastStrike < 0.45) return false;
    return this.soldiers.filter((o) => !o.dead && o.striking).length < 2;
  }

  struck(_s: Soldier): void {
    this.lastStrike = this.time;
  }

  /** Tells every soldier within `radius` of `from` where the wearer is. */
  rouse(from: THREE.Vector3, radius: number, where: THREE.Vector3, except?: Soldier): void {
    for (const s of this.soldiers) if (s !== except && !s.dead && s.position.distanceTo(from) < radius) s.rouse(where);
  }

  later(delay: number, run: () => void): void {
    this.pending.push({ at: this.time + delay, run });
  }

  /** Takes charge of a body. */
  bury(fallen: Fallen, bone: string, flow: number): void {
    this.fallen.push(fallen);
    this.graves.push({ fallen, bone, age: 0, next: 0.5, flow });
  }

  /** Way-points from one place to another through the castle. */
  route(from: THREE.Vector3, to: THREE.Vector3): number[] {
    const { nodes, links } = this.level.nav;
    const nearest = (p: THREE.Vector3) => {
      let best = 0, least = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const d = Math.hypot(nodes[i].x - p.x, nodes[i].z - p.z) + Math.abs(nodes[i].y - p.y) * 3;
        if (d < least) (least = d), (best = i);
      }
      return best;
    };
    const start = nearest(from), goal = nearest(to);
    const cost = nodes.map(() => Infinity);
    const came = nodes.map(() => -1);
    const open = [start];
    cost[start] = 0;
    while (open.length) {
      open.sort((x, y) => cost[x] - cost[y]);
      const n = open.shift()!;
      if (n === goal) break;
      for (const m of links[n]) {
        const d = cost[n] + nodes[n].distanceTo(nodes[m]);
        if (d < cost[m]) {
          cost[m] = d;
          came[m] = n;
          if (!open.includes(m)) open.push(m);
        }
      }
    }
    const path: number[] = [];
    for (let n = goal; n >= 0; n = came[n]) path.unshift(n);
    return path;
  }

  fixedStep(dt: number): void {
    for (const s of this.soldiers) s.fixedStep(dt);
  }

  update(dt: number, alpha: number): void {
    this.time += dt;
    for (const s of this.soldiers) s.update(dt, alpha);
    for (const f of this.fallen) f.update(dt);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at > this.time) continue;
      const [job] = this.pending.splice(i, 1);
      job.run();
    }
    // A body bleeds into the ground it lies on for a while.
    for (let i = this.graves.length - 1; i >= 0; i--) {
      const g = this.graves[i];
      g.age += dt;
      if (g.age > 16) {
        this.graves.splice(i, 1);
        continue;
      }
      if (g.age < g.next) continue;
      g.next = g.age + 0.35 + g.age * 0.12;
      g.fallen.rig.worldPosition(g.bone, this.v);
      const hit = this.physics.raycast(this.v, DOWN, 1.2, GROUP.WORLD);
      if (hit) this.effects.stain(hit.point.add(a.set(rand(-0.12, 0.12), 0, rand(-0.12, 0.12))), hit.normal, (0.16 + Math.min(0.5, g.age * 0.045)) * g.flow);
    }
  }
}
