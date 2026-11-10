import * as THREE from 'three/webgpu';
import type { Assets } from '../core/assets';
import { GROUP, type Physics } from '../physics/physics';
import type { Level } from '../world/level';
import { Gait } from './gait';
import type { Player } from './player';
import { Rig, type Grasp, type Handle, type Side } from './rig';
import { SHIELD, type Arms } from './weapon';

/** Where the camera sits on the figure at rest: on the breastbone, clear of the cloth. */
const MOUNT = new THREE.Vector3(0, 1.4, -0.19);
/** How much of the chest's turn away from the heading of the hips each part of the trunk takes. */
const TRUNK: [string, number][] = [['pelvis', 0.25], ['spine_01', 0.5], ['spine_02', 0.78], ['spine_03', 1]];

/** The sword's grip in the right hand: across the palm, tipped a little towards the point. */
export const SWORD_GRIP: Handle = { along: 0.085, off: 0.0265, across: 0.008, axis: [-0.35, 1, 0], radius: 0.012 };
/** The shield's hand strap in the left fist: straight across the palm. */
export const STRAP_GRIP: Handle = { along: 0.085, off: 0.026, across: 0.008, axis: [0, 1, 0], radius: 0.011 };

/** Sole to ball of the foot, and how high the ball's hinge sits. */
const BALL = 0.13, BALL_HEIGHT = 0.01;
const SIDES: Side[] = ['l', 'r'];
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
const smooth = (lo: number, hi: number, v: number) => {
  const t = THREE.MathUtils.clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * A whole person posed from the outside in: the chest is put where it has to
 * be, the feet stay where they were planted, the hands go to what they hold,
 * and everything between is solved to fit.
 */
export class Figure {
  readonly gait: Gait;
  private heading = new THREE.Quaternion();
  /** The camera mount as carried by the top of the spine. */
  private mount: THREE.Vector3;
  private clavicle: Record<Side, THREE.Quaternion>;
  private footRest: Record<Side, THREE.Quaternion>;
  private ankleHeight: number;
  private ankles = [new THREE.Vector3(), new THREE.Vector3()];
  private toe = [0, 0];
  private sink = 0;
  private handQ = new THREE.Quaternion();
  private wrist = new THREE.Vector3();
  private swordGrasp: Grasp;
  private strapGrasp: Grasp;

  constructor(readonly rig: Rig, physics: Physics) {
    const origin = new THREE.Vector3();
    this.gait = new Gait((x, z, near) => physics.raycast(origin.set(x, near + 0.5, z), DOWN, 1.3, GROUP.WORLD)?.point.y ?? near);
    this.mount = MOUNT.clone().sub(rig.restWorldP.spine_03).applyQuaternion(rig.restWorldQ.spine_03.clone().invert());
    this.clavicle = { l: rig.bones.clavicle_l.quaternion.clone(), r: rig.bones.clavicle_r.quaternion.clone() };
    this.footRest = { l: rig.restWorldQ.foot_l.clone(), r: rig.restWorldQ.foot_r.clone() };
    this.ankleHeight = rig.restWorldP.foot_r.y;
    this.swordGrasp = rig.grasp('r', SWORD_GRIP, 0.7, 1);
    this.strapGrasp = rig.grasp('l', STRAP_GRIP, 0.2, 0.8);
  }

  /**
   * Trunk and legs. The chest goes where the camera on it is (`eye`,
   * `orientation`), over hips heading `yaw` and feet walking at `feet`.
   * Returns how far the chest had to come down for the legs to reach the
   * ground; whoever owns the camera should lower it by as much.
   */
  stand(dt: number, eye: THREE.Vector3, orientation: THREE.Quaternion, feet: THREE.Vector3, yaw: number, velocity: THREE.Vector3, grounded: boolean, pace?: number, crouch = 0): number {
    const rig = this.rig;
    rig.reset();
    this.heading.setFromAxisAngle(UP, yaw);
    rig.root.quaternion.copy(this.heading);
    rig.root.position.copy(feet);
    for (const [name, share] of TRUNK) rig.setWorldQuaternion(name, q.copy(this.heading).slerp(orientation, share).multiply(rig.restWorldQ[name]));
    // Slide the whole figure so the mount is at the camera.
    rig.worldPosition('spine_03', a);
    rig.worldQuaternion('spine_03', q);
    b.copy(this.mount).applyQuaternion(q).add(a);
    rig.root.position.add(eye).sub(b);

    this.gait.update(dt, feet, yaw, velocity, grounded, pace, crouch);
    const reach = rig.legLength * 0.992;
    let need = 0;
    for (let i = 0; i < 2; i++) {
      const f = this.gait.feet[i];
      const ankle = this.ankles[i].copy(f.position);
      ankle.y += this.ankleHeight + f.lift;
      this.toe[i] = 0;
      rig.worldPosition(`thigh_${SIDES[i]}`, a);
      if (grounded && !f.planted && a.distanceTo(ankle) > reach * 0.96) {
        // A foot in the air is not holding anything down: the knee folds and it comes up after the hip.
        ankle.sub(a).setLength(reach * 0.96).add(a);
      } else if (grounded && a.distanceTo(ankle) > reach && (ankle.x - a.x) * Math.sin(f.yaw) + (ankle.z - a.z) * Math.cos(f.yaw) > 0) {
        // A leg left behind comes up on to its toes before it pulls the body down.
        const turn = (angle: number) => this.heel(i, angle, b).distanceTo(a);
        let lo = 0, hi = 0, best = 0, least = Infinity;
        for (let k = 1; k <= 10; k++) {
          hi = k * 0.1;
          const dist = turn(hi);
          if (dist < least) (least = dist), (best = hi);
          if (dist <= reach) break;
          lo = hi;
        }
        if (least <= reach) {
          for (let n = 0; n < 5; n++) {
            const mid = (lo + hi) / 2;
            if (turn(mid) <= reach) hi = mid;
            else lo = mid;
          }
          best = hi;
        }
        this.toe[i] = best;
        this.heel(i, best, ankle);
      }
      const flat = Math.hypot(a.x - ankle.x, a.z - ankle.z);
      if (grounded && f.planted && flat < reach) need = Math.max(need, a.y - ankle.y - Math.sqrt(reach * reach - flat * flat));
    }
    // The body rides down on to legs that cannot reach, and back up, without a jolt.
    this.sink += (need - this.sink) * (1 - Math.exp(-dt * (need > this.sink ? 30 : 12)));
    rig.root.position.y -= this.sink;

    X.set(1, 0, 0).applyQuaternion(this.heading);
    Z.set(0, 0, -1).applyQuaternion(this.heading);
    for (let i = 0; i < 2; i++) {
      const f = this.gait.feet[i];
      q.setFromAxisAngle(UP, f.yaw).multiply(q2.setFromAxisAngle(a.set(1, 0, 0), -(f.pitch + this.toe[i]))).multiply(this.footRest[SIDES[i]]);
      // Knees point ahead and a little apart.
      rig.leg(SIDES[i], this.ankles[i], q, a.copy(Z).addScaledVector(X, i === 0 ? -0.3 : 0.3));
    }
    return this.sink;
  }

  /** Where the ankle of foot `i` is once its heel has come up by `angle` about the ball of the foot. */
  private heel(i: number, angle: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.gait.feet[i];
    const s = Math.sin(f.yaw), co = Math.cos(f.yaw);
    // From the ball: back along the foot and up to the ankle, swung forward and up.
    const back = BALL * Math.cos(angle) - (this.ankleHeight - BALL_HEIGHT) * Math.sin(angle);
    const up = BALL * Math.sin(angle) + (this.ankleHeight - BALL_HEIGHT) * Math.cos(angle);
    return out.set(f.position.x - s * (BALL - back), f.position.y + f.lift + BALL_HEIGHT + up, f.position.z - co * (BALL - back));
  }

  /** Rolls a shoulder towards a far reach, and says how far past the arm's length `wrist` still is. */
  private shrug(side: Side, wrist: THREE.Vector3): number {
    const rig = this.rig;
    const name = `clavicle_${side}`;
    rig.bones[name].quaternion.copy(this.clavicle[side]);
    rig.shoulder(side, a);
    let dist = a.distanceTo(wrist);
    const t = smooth(0.82, 1.1, dist / rig.armLength);
    if (t > 0) {
      rig.worldPosition(name, b);
      c.subVectors(a, b).cross(d.subVectors(wrist, a));
      if (c.lengthSq() > 1e-10) {
        rig.rotateWorld(name, q.setFromAxisAngle(c.normalize(), 0.28 * t));
        dist = rig.shoulder(side, a).distanceTo(wrist);
      }
    }
    return dist - rig.armLength * 0.985;
  }

  /** Where the right wrist has to be, and how the hand is turned, to hold a sword posed like this. */
  private swordWrist(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    X.set(1, 0, 0).applyQuaternion(quaternion);
    Y.set(0, 1, 0).applyQuaternion(quaternion);
    Z.set(0, 0, 1).applyQuaternion(quaternion);
    // Hammer grip: knuckles along the leading edge tipped a little towards the point, palm on the flat.
    this.rig.handQuaternion('r', a.copy(X).addScaledVector(Y, 0.35), b.copy(Z).negate(), this.handQ);
    this.rig.palmOffset('r', this.handQ, SWORD_GRIP.along, SWORD_GRIP.off, SWORD_GRIP.across, a);
    this.wrist.copy(position).sub(a);
  }

  /** Likewise the left wrist for a shield: fist round the hand strap, knuckles along the board, palm to the wearer. */
  private shieldWrist(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    X.set(1, 0, 0).applyQuaternion(quaternion);
    Z.set(0, 0, 1).applyQuaternion(quaternion);
    this.rig.handQuaternion('l', X, Z, this.handQ);
    this.rig.palmOffset('l', this.handQ, STRAP_GRIP.along, STRAP_GRIP.off, STRAP_GRIP.across, a);
    this.wrist.copy(SHIELD.strap).applyQuaternion(quaternion).add(position).sub(a);
  }

  /** Pulls a sword (or shield) pose back to where this figure's arm can hold it. Call after `stand`. */
  limit(hand: 'sword' | 'shield', position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    const side: Side = hand === 'sword' ? 'r' : 'l';
    if (hand === 'sword') this.swordWrist(position, quaternion);
    else this.shieldWrist(position, quaternion);
    const over = this.shrug(side, this.wrist);
    if (over > 0) position.addScaledVector(a.sub(this.wrist).normalize(), over);
  }

  /** Arms and hands on to the weapons. `chest` is the orientation given to `stand`. */
  wield(sword: THREE.Object3D, shield: THREE.Object3D, chest: THREE.Quaternion): void {
    const rig = this.rig;
    this.swordWrist(sword.position, sword.quaternion);
    this.shrug('r', this.wrist);
    // Elbow down, out and a little behind.
    rig.arm('r', this.wrist, this.handQ, d.set(0.5, -1, 0.4).applyQuaternion(chest));
    rig.hold('r', this.swordGrasp);

    this.shieldWrist(shield.position, shield.quaternion);
    this.shrug('l', this.wrist);
    // The forearm lies along the back of the board, so the elbow goes to where the board wants it.
    rig.shoulder('l', a);
    d.copy(SHIELD.elbow).applyQuaternion(shield.quaternion).add(shield.position).sub(a);
    rig.arm('l', this.wrist, this.handQ, d);
    rig.hold('l', this.strapGrasp);
  }
}

/** The wearer's own body, as the camera on its chest sees it. */
export class Body {
  private constructor(readonly figure: Figure, private player: Player, private arms: Arms) {}

  static async create(scene: THREE.Scene, assets: Assets, physics: Physics, level: Level, player: Player, arms: Arms): Promise<Body> {
    const id = (await exists(`${import.meta.env.BASE_URL}assets/characters/soldier.glb`)) ? 'characters/soldier' : '_rigtest';
    const rig = await Rig.create(assets, id);
    if (id === '_rigtest') standIn(rig);
    // The camera never sees the head it hangs under, but the sun does.
    rig.show('head_', false, true);
    level.sun.shadow.camera.layers.enable(1);
    scene.add(rig.root);
    const figure = new Figure(rig, physics);
    arms.limit = (hand, position, quaternion) => figure.limit(hand, position, quaternion);
    return new Body(figure, player, arms);
  }

  /** After the player has moved and before the weapons are posed: stands the body under the camera. */
  begin(dt: number): void {
    const p = this.player;
    if (p.dead) return;
    p.eye.y -= this.figure.stand(dt, p.eye, p.orientation, p.position, p.yaw, p.velocity, p.grounded, p.pace, p.crouch);
  }

  /** After the weapons are posed: takes hold of them. */
  finish(): void {
    if (this.player.dead) return;
    this.figure.wield(this.arms.sword, this.arms.shield, this.player.orientation);
  }
}

async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('html');
  } catch {
    return false;
  }
}

/** The untextured test figure, coloured so it can be told apart until the real one is in. */
function standIn(rig: Rig): void {
  const skin = new THREE.MeshStandardNodeMaterial({ color: 0x9c6f56, roughness: 0.6 });
  const cloth = new THREE.MeshStandardNodeMaterial({ color: 0x3d3229, roughness: 0.95 });
  const gear = new THREE.MeshStandardNodeMaterial({ color: 0x241d18, roughness: 0.8 });
  for (const mesh of rig.meshes) {
    const name = `${mesh.parent?.name ?? ''} ${mesh.name}`;
    mesh.material = name.includes('skin') || name.includes('face') ? skin : name.includes('gear') || name.includes('helmet') ? gear : cloth;
  }
}
