import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Assets } from '../core/assets';

export type Side = 'l' | 'r';

const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;

interface Limb {
  upper: THREE.Bone;
  lower: THREE.Bone;
  end: THREE.Bone;
  l1: number;
  l2: number;
  /** Inverse of the rest frame (bone direction, hinge axis) of each segment, in that bone's own space. */
  upperInv: THREE.Quaternion;
  lowerInv: THREE.Quaternion;
  /** World orientation of the lower segment after the last solve. */
  lowerWorld: THREE.Quaternion;
}

/** A finger or thumb: three bones, and a model of them in the figure's rest space for working out grips. */
interface Chain {
  bones: THREE.Bone[];
  rest: THREE.Quaternion[];
  /** Axis of each joint, in its bone's own space, about which a positive turn closes the digit. */
  local: THREE.Vector3[];
  /** Long axis of the first two bones in their own space. */
  roll: THREE.Vector3[];
  /** Axis of the first joint, in its own space, that swings the digit sideways (a finger) or lifts it off the palm (the thumb). */
  swing: THREE.Vector3;
  /** The three joints and the tip, the joint axes and the swing axis, at rest. */
  p: THREE.Vector3[];
  ax: THREE.Vector3[];
  sw: THREE.Vector3;
  /** Length of the first two bones at rest, about which the thumb rolls to face the fingers. */
  along: THREE.Vector3[];
  /** Half thickness of each segment. */
  radius: number[];
}

interface Capsule {
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
}

interface Hand {
  bone: THREE.Bone;
  /** Inverse of the rest frame (knuckle direction, index-to-little-finger direction) in the hand's own space. */
  inv: THREE.Quaternion;
  /** +1 if knuckle direction x finger row points out of the palm. */
  sign: number;
  /** Wrist, knuckle direction, finger row and palm normal at rest. */
  wrist: THREE.Vector3;
  F: THREE.Vector3;
  K: THREE.Vector3;
  N: THREE.Vector3;
  fingers: Chain[];
  thumb: Chain;
  /** Sideways turn that brings each finger in against its neighbours. */
  close: number[];
  /** The flesh of the palm and the ball of the thumb, which closing fingers stop against. */
  palm: Capsule[];
  twist: THREE.Bone | null;
  twistRest: THREE.Quaternion;
  rest: THREE.Quaternion;
  /** Forearm direction in the forearm's own space. */
  axis: THREE.Vector3;
}

/** Something held: a round handle lying across the hand. Distances in metres from the wrist. */
export interface Handle {
  /** Towards the knuckles. */
  along: number;
  /** Out of the palm. */
  off: number;
  /** Towards the little finger. */
  across: number;
  /** Which way the handle runs: (towards the knuckles, towards the little finger, out of the palm). */
  axis: [number, number, number];
  radius: number;
}

/** A hand shape: how far every joint is turned from the open hand. */
export interface Grasp {
  /** Index to little finger, knuckle to tip. */
  flex: number[][];
  spread: number[];
  /** Lift off the palm, roll to face the fingers, then the three joints. */
  thumb: number[];
}

const m = new THREE.Matrix4();
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), e3 = new THREE.Vector3();
const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
const s1 = new THREE.Vector3(), s2 = new THREE.Vector3(), s3 = new THREE.Vector3();
const pts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Shortest distance between two line segments. */
function segSeg(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): number {
  const d1 = s1.subVectors(q1, p1), d2 = s2.subVectors(q2, p2), r = s3.subVectors(p1, p2);
  const A = d1.dot(d1), E = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (A > 1e-12 && E > 1e-12) {
    const c = d1.dot(r), B = d1.dot(d2), denom = A * E - B * B;
    s = denom > 1e-12 ? clamp01((B * f - c * E) / denom) : 0;
    t = (B * s + f) / E;
    if (t < 0) {
      t = 0;
      s = clamp01(-c / A);
    } else if (t > 1) {
      t = 1;
      s = clamp01((B - c) / A);
    }
  } else if (E > 1e-12) t = clamp01(f / E);
  else if (A > 1e-12) s = clamp01(-d1.dot(r) / A);
  return r.addScaledVector(d1, s).addScaledVector(d2, -t).length();
}

/** How the thumb's roll is shared between its first two bones. */
const ROLL = [0.6, 0.4];

/** Where a digit's joints and tip are, in rest space, for the given joint turns. */
function place(ch: Chain, swing: number, roll: number, flex: number[], out: THREE.Vector3[]): void {
  out[0].copy(ch.p[0]);
  qa.setFromAxisAngle(ch.sw, swing);
  for (let j = 0; j < 3; j++) {
    if (roll && j < 2) qa.multiply(qb.setFromAxisAngle(ch.along[j], roll * ROLL[j]));
    qa.multiply(qb.setFromAxisAngle(ch.ax[j], flex[j]));
    out[j + 1].subVectors(ch.p[j + 1], ch.p[j]).applyQuaternion(qa).add(out[j]);
  }
}

/**
 * Closes a digit the way a hand closes on something: each joint in turn, from
 * the knuckle out, bends until the flesh beyond it meets an obstacle or the
 * joint reaches its limit. `press` is how far skin gives.
 */
function shut(ch: Chain, swing: number, roll: number, flex: number[], limit: number[], obstacles: Capsule[], first: number, press: number): void {
  for (let j = 0; j < 3; j++) {
    const clear = (angle: number): number => {
      flex[j] = angle;
      place(ch, swing, roll, flex, pts);
      let least = Infinity;
      for (let k = Math.max(j, first); k < 3; k++) for (const o of obstacles) least = Math.min(least, segSeg(pts[k], pts[k + 1], o.a, o.b) - ch.radius[k] - o.r);
      return least;
    };
    let lo = flex[j], hi = lo, hit = false;
    if (clear(lo) >= -press) {
      while (hi < limit[j]) {
        hi = Math.min(limit[j], hi + 0.04);
        if (clear(hi) < -press) {
          hit = true;
          break;
        }
        lo = hi;
      }
      if (hit) {
        for (let n = 0; n < 8; n++) {
          const mid = (lo + hi) / 2;
          if (clear(mid) < -press) hi = mid;
          else lo = mid;
        }
      }
    }
    flex[j] = lo;
  }
}

/** Rotation whose X axis is `ax` and whose Y axis is `ay` made square to it. */
function frame(ax: THREE.Vector3, ay: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  x.copy(ax).normalize();
  y.copy(ay).addScaledVector(x, -ay.dot(x));
  if (y.lengthSq() < 1e-10) {
    y.set(x.y, -x.x, 0);
    if (y.lengthSq() < 1e-6) y.set(0, x.z, -x.y);
  }
  y.normalize();
  z.crossVectors(x, y);
  return out.setFromRotationMatrix(m.makeBasis(x, y, z));
}

/**
 * A posable human figure. There are no canned animations: every frame starts
 * from the rest pose, the trunk is placed, and the limbs are solved to wherever
 * the hands and feet have to be.
 *
 * `root` sits at the feet and faces -Z, like everything else in the game.
 */
export class Rig {
  readonly root = new THREE.Group();
  readonly bones: Record<string, THREE.Bone> = {};
  readonly meshes: THREE.SkinnedMesh[] = [];
  private restQ = new Map<THREE.Bone, THREE.Quaternion>();
  private restP = new Map<THREE.Bone, THREE.Vector3>();
  /** Rest transforms in the root's space, for anything that needs the build of the figure. */
  readonly restWorldP: Record<string, THREE.Vector3> = {};
  readonly restWorldQ: Record<string, THREE.Quaternion> = {};
  private arms: Record<Side, Limb>;
  private legs: Record<Side, Limb>;
  private hands: Record<Side, Hand>;
  readonly armLength: number;
  readonly legLength: number;

  static async create(assets: Assets, id = 'characters/soldier'): Promise<Rig> {
    const g = await assets.model(id);
    return new Rig(cloneSkinned(g.scene));
  }

  constructor(model: THREE.Object3D) {
    // Exported figures face +Z.
    model.rotation.y = Math.PI;
    this.root.add(model);
    this.root.updateMatrixWorld(true);
    model.traverse((o) => {
      const bone = o as THREE.Bone;
      if (bone.isBone) {
        this.bones[bone.name] = bone;
        this.restQ.set(bone, bone.quaternion.clone());
        this.restP.set(bone, bone.position.clone());
        this.restWorldP[bone.name] = bone.getWorldPosition(new THREE.Vector3());
        this.restWorldQ[bone.name] = bone.getWorldQuaternion(new THREE.Quaternion());
      }
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) {
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.meshes.push(mesh);
      }
    });
    this.arms = { l: this.limb('upperarm_l', 'lowerarm_l', 'hand_l'), r: this.limb('upperarm_r', 'lowerarm_r', 'hand_r') };
    this.legs = { l: this.limb('thigh_l', 'calf_l', 'foot_l'), r: this.limb('thigh_r', 'calf_r', 'foot_r') };
    this.hands = { l: this.hand('l'), r: this.hand('r') };
    this.armLength = this.arms.r.l1 + this.arms.r.l2;
    this.legLength = this.legs.r.l1 + this.legs.r.l2;
  }

  private bone(name: string): THREE.Bone {
    const bone = this.bones[name];
    if (!bone) throw new Error(`rig has no bone ${name}`);
    return bone;
  }

  private limb(upperName: string, lowerName: string, endName: string): Limb {
    const upper = this.bone(upperName), lower = this.bone(lowerName), end = this.bone(endName);
    const pa = this.restWorldP[upperName], pb = this.restWorldP[lowerName], pc = this.restWorldP[endName];
    const u = new THREE.Vector3().subVectors(pb, pa);
    const f = new THREE.Vector3().subVectors(pc, pb);
    const l1 = u.length(), l2 = f.length();
    u.normalize();
    f.normalize();
    const h = new THREE.Vector3().crossVectors(u, f).normalize();
    const uq = this.restWorldQ[upperName].clone().invert(), lq = this.restWorldQ[lowerName].clone().invert();
    const upperInv = frame(u.clone().applyQuaternion(uq), h.clone().applyQuaternion(uq), new THREE.Quaternion()).invert();
    const lowerInv = frame(f.clone().applyQuaternion(lq), h.clone().applyQuaternion(lq), new THREE.Quaternion()).invert();
    return { upper, lower, end, l1, l2, upperInv, lowerInv, lowerWorld: new THREE.Quaternion() };
  }

  private hand(side: Side): Hand {
    const bone = this.bone(`hand_${side}`);
    const P = this.restWorldP, Q = this.restWorldQ;
    const wrist = P[`hand_${side}`];
    const F = new THREE.Vector3().subVectors(P[`middle_01_${side}`], wrist).normalize();
    const K = new THREE.Vector3().subVectors(P[`pinky_01_${side}`], P[`index_01_${side}`]);
    K.addScaledVector(F, -K.dot(F)).normalize();
    // Fingers at rest are a little bent, and the way they bend is the way the palm faces.
    const bend = new THREE.Vector3();
    for (const f of FINGERS) {
      const p1 = P[`${f}_01_${side}`], p2 = P[`${f}_02_${side}`], p3 = P[`${f}_03_${side}`];
      bend.add(new THREE.Vector3().subVectors(p3, p2).normalize()).sub(new THREE.Vector3().subVectors(p2, p1).normalize());
    }
    const N = new THREE.Vector3().crossVectors(F, K);
    const sign = N.dot(bend) >= 0 ? 1 : -1;
    N.multiplyScalar(sign);
    const hq = Q[`hand_${side}`].clone().invert();
    const inv = frame(F.clone().applyQuaternion(hq), K.clone().applyQuaternion(hq), new THREE.Quaternion()).invert();

    // Every digit bone points down its own Y and hinges about its own X; `towards` settles which way round closes it.
    const chain = (name: string, towards: THREE.Vector3, tip: number, radius: number[], lift: THREE.Vector3): Chain => {
      const names = [1, 2, 3].map((i) => `${name}_0${i}_${side}`);
      const bones = names.map((n) => this.bone(n));
      const p = names.map((n) => P[n].clone());
      const end = new THREE.Vector3(0, 1, 0).applyQuaternion(Q[names[2]]);
      p.push(p[2].clone().addScaledVector(end, tip * p[2].distanceTo(p[1])));
      const ax = names.map((n, j) => {
        const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(Q[n]);
        const dir = new THREE.Vector3().subVectors(p[j + 1], p[j]);
        if (new THREE.Vector3().crossVectors(axis, dir).dot(towards) < 0) axis.negate();
        return axis;
      });
      const local = ax.map((v, j) => v.clone().applyQuaternion(Q[names[j]].clone().invert()));
      // A finger swings sideways about the palm normal; the thumb lifts off the palm about its own Z.
      const sw = name === 'thumb' ? new THREE.Vector3(0, 0, 1).applyQuaternion(Q[names[0]]) : N.clone();
      if (name === 'thumb' && new THREE.Vector3().crossVectors(sw, new THREE.Vector3().subVectors(p[1], p[0])).dot(lift) < 0) sw.negate();
      const swing = sw.clone().applyQuaternion(Q[names[0]].clone().invert());
      // Rolling the thumb the positive way turns its pad from facing along the knuckles to facing the fingertips.
      const along = [0, 1].map((j) => {
        const dir = new THREE.Vector3().subVectors(p[j + 1], p[j]).normalize();
        const pad = new THREE.Vector3().crossVectors(ax[j], dir);
        if (new THREE.Vector3().crossVectors(dir, pad).dot(F) < 0) dir.negate();
        return dir;
      });
      const roll = along.map((v, j) => v.clone().applyQuaternion(Q[names[j]].clone().invert()));
      return { bones, rest: bones.map((bn) => bn.quaternion.clone()), local, swing, roll, p, ax, sw, along, radius };
    };
    const fingers = FINGERS.map((f, i) => chain(f, N, 0.9, i === 3 ? [0.0075, 0.007, 0.0065] : [0.0088, 0.0082, 0.0075], N));
    const thumb = chain('thumb', K, 0.72, [0.012, 0.0105, 0.0095], N);

    // Closed fingers lie side by side, converging a little; open ones fan out.
    const heading = (ch: Chain) => {
      const dir = new THREE.Vector3().subVectors(ch.p[1], ch.p[0]);
      return Math.atan2(dir.dot(K), dir.dot(F));
    };
    const mid = heading(fingers[1]);
    const close = fingers.map((ch) => sign * (mid + ch.p[0].clone().sub(fingers[1].p[0]).dot(K) * 2.2 - heading(ch)));

    const palm: Capsule[] = fingers.map((ch) => {
      const across = ch.p[0].clone().sub(wrist).dot(K);
      return {
        a: wrist.clone().addScaledVector(F, 0.03).addScaledVector(K, across * 0.6).addScaledVector(N, -0.003),
        b: ch.p[0].clone().addScaledVector(F, -0.026).addScaledVector(N, -0.003 - ch.p[0].clone().sub(wrist).dot(N)),
        r: 0.012,
      };
    });
    palm.push({ a: thumb.p[0].clone(), b: thumb.p[1].clone(), r: 0.013 });

    const axis = new THREE.Vector3().subVectors(wrist, P[`lowerarm_${side}`]).normalize().applyQuaternion(Q[`lowerarm_${side}`].clone().invert());
    const twist = this.bones[`lowerarm_twist_01_${side}`] ?? null;
    return { bone, inv, sign, wrist, F, K, N, fingers, thumb, close, palm, twist, twistRest: twist ? twist.quaternion.clone() : new THREE.Quaternion(), rest: bone.quaternion.clone(), axis };
  }

  /** Back to the rest pose. Call first, every frame. */
  reset(): void {
    for (const [bone, q] of this.restQ) {
      bone.quaternion.copy(q);
      bone.position.copy(this.restP.get(bone)!);
    }
  }

  /** Hides (or shows) parts by node-name prefix. `shadowOnly` keeps them in the shadow pass, so a wearer without a visible head still casts a whole shadow. */
  show(prefix: string, visible: boolean, shadowOnly = false): void {
    this.root.traverse((o) => {
      if (!o.name.startsWith(prefix) || !(o as THREE.Mesh).isMesh) return;
      if (shadowOnly) {
        o.visible = true;
        o.layers.set(visible ? 0 : 1);
      } else o.visible = visible;
    });
  }

  worldPosition(name: string, out: THREE.Vector3): THREE.Vector3 {
    const bone = this.bone(name);
    bone.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(bone.matrixWorld);
  }

  worldQuaternion(name: string, out: THREE.Quaternion): THREE.Quaternion {
    return this.bone(name).getWorldQuaternion(out);
  }

  /** Turns a bone to a given world orientation. */
  setWorldQuaternion(name: string, q: THREE.Quaternion): void {
    const bone = this.bone(name);
    bone.parent!.getWorldQuaternion(q0);
    bone.quaternion.copy(q0.invert()).multiply(q);
  }

  /** Turns a bone by `q` (world space) on top of where it is now. */
  rotateWorld(name: string, q: THREE.Quaternion): void {
    const bone = this.bone(name);
    bone.getWorldQuaternion(q1);
    bone.parent!.getWorldQuaternion(q0);
    bone.quaternion.copy(q0.invert()).multiply(q2.copy(q).multiply(q1));
  }

  private solve(l: Limb, target: THREE.Vector3, pole: THREE.Vector3, endQ: THREE.Quaternion | null): number {
    const parent = l.upper.parent!;
    parent.updateWorldMatrix(true, false);
    a.copy(l.upper.position).applyMatrix4(parent.matrixWorld);
    b.subVectors(target, a);
    const want = b.length();
    const dist = THREE.MathUtils.clamp(want, Math.abs(l.l1 - l.l2) + 1e-3, (l.l1 + l.l2) * 0.999);
    if (want > 1e-6) b.divideScalar(want);
    else b.set(0, -1, 0);
    c.copy(pole).addScaledVector(b, -pole.dot(b));
    if (c.lengthSq() < 1e-8) {
      c.set(b.y, -b.x, 0);
      if (c.lengthSq() < 1e-6) c.set(0, b.z, -b.y);
    }
    c.normalize();
    const along = (l.l1 * l.l1 + dist * dist - l.l2 * l.l2) / (2 * dist);
    const out = Math.sqrt(Math.max(0, l.l1 * l.l1 - along * along));
    // Joint position, then the two segment directions and the hinge they share.
    d.copy(a).addScaledVector(b, along).addScaledVector(c, out);
    const hinge = e1.crossVectors(c, b).normalize();
    const u1 = e2.subVectors(d, a).normalize();
    const f1 = e3.copy(a).addScaledVector(b, dist).sub(d).normalize();
    parent.getWorldQuaternion(q0);
    const uw = frame(u1, hinge, q1).multiply(l.upperInv);
    l.upper.quaternion.copy(q0.invert()).multiply(uw);
    const uwInv = q2.copy(uw).invert();
    frame(f1, hinge, l.lowerWorld).multiply(l.lowerInv);
    l.lower.quaternion.copy(uwInv).multiply(l.lowerWorld);
    if (endQ) l.end.quaternion.copy(q0.copy(l.lowerWorld).invert()).multiply(endQ);
    return want - dist;
  }

  /**
   * Puts a wrist at `wrist` with the hand turned to `handQ` (both world space);
   * `pole` says which way the elbow should point. Returns how far short the arm fell.
   */
  arm(side: Side, wrist: THREE.Vector3, handQ: THREE.Quaternion | null, pole: THREE.Vector3): number {
    const short = this.solve(this.arms[side], wrist, pole, handQ);
    const h = this.hands[side];
    if (h.twist) {
      // Part of the hand's turn about the forearm is taken up along the forearm, as the radius rolls over the ulna.
      q0.copy(h.bone.quaternion).multiply(q1.copy(h.rest).invert());
      const dot = q0.x * h.axis.x + q0.y * h.axis.y + q0.z * h.axis.z;
      q1.set(h.axis.x * dot, h.axis.y * dot, h.axis.z * dot, q0.w);
      if (q1.lengthSq() > 1e-8) {
        q1.normalize();
        h.twist.quaternion.copy(q2.identity().slerp(q1, 0.55)).multiply(h.twistRest);
      }
    }
    return short;
  }

  leg(side: Side, ankle: THREE.Vector3, footQ: THREE.Quaternion | null, pole: THREE.Vector3): number {
    return this.solve(this.legs[side], ankle, pole, footQ);
  }

  shoulder(side: Side, out: THREE.Vector3): THREE.Vector3 {
    return this.worldPosition(`upperarm_${side}`, out);
  }

  /** World orientation for a hand whose knuckles run along `knuckles` and whose palm faces `palm`. */
  handQuaternion(side: Side, knuckles: THREE.Vector3, palm: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
    const h = this.hands[side];
    a.copy(knuckles).normalize();
    b.copy(palm).addScaledVector(a, -palm.dot(a)).normalize();
    c.crossVectors(b, a).multiplyScalar(h.sign);
    return frame(a, c, out).multiply(h.inv);
  }

  /** Offset from the wrist to a point `along` metres down the palm, `out` metres off its surface and `across` towards the little finger, for a hand turned to `handQ`. */
  palmOffset(side: Side, handQ: THREE.Quaternion, along: number, off: number, across: number, out: THREE.Vector3): THREE.Vector3 {
    const h = this.hands[side];
    // Rest frame: X knuckles, Y finger row, Z = X x Y = sign * palm normal.
    q0.copy(handQ).multiply(q1.copy(h.inv).invert());
    return out.set(along, across, off * h.sign).applyQuaternion(q0);
  }

  /**
   * Works out how the hand closes: round a handle if one is given, else into a
   * fist. Worked out once for a thing held, then applied with `hold`.
   * `lift` is how far the thumb is drawn off the palm before it closes.
   */
  grasp(side: Side, handle: Handle | null = null, lift = 0.1, roll = 0, reach = 1): Grasp {
    const h = this.hands[side];
    const obstacles: Capsule[] = [];
    if (handle) {
      obstacles.push(...h.palm);
      const at = h.wrist.clone().addScaledVector(h.F, handle.along).addScaledVector(h.K, handle.across).addScaledVector(h.N, handle.off);
      const dir = new THREE.Vector3().addScaledVector(h.F, handle.axis[0]).addScaledVector(h.K, handle.axis[1]).addScaledVector(h.N, handle.axis[2]).normalize();
      obstacles.unshift({ a: at.clone().addScaledVector(dir, -0.3), b: at.clone().addScaledVector(dir, 0.3), r: handle.radius });
    }
    const g: Grasp = { flex: [], spread: [], thumb: [] };
    const others: Capsule[] = handle ? [obstacles[0]] : [];
    for (let i = 0; i < 4; i++) {
      const ch = h.fingers[i];
      const flex = [0, 0, 0];
      const spread = h.close[i] * reach;
      shut(ch, spread, 0, flex, handle ? [1.25, 1.8, 1.2] : [1.25, 1.65, 1.1], obstacles, 0, 0.0012);
      g.flex.push(flex);
      g.spread.push(spread);
      place(ch, spread, 0, flex, pts);
      for (let k = 0; k < 3; k++) others.push({ a: pts[k].clone(), b: pts[k + 1].clone(), r: ch.radius[k] });
    }
    // The thumb comes round last, over whatever the fingers have left it.
    const flex = [-0.3, 0, 0];
    shut(h.thumb, lift, roll, flex, [0.95, 1.0, 1.3], others, 1, 0.0015);
    g.thumb.push(lift, roll, flex[0], flex[1], flex[2]);
    return g;
  }

  /** A hand with nothing to do: fingers a little bent, more so towards the little finger. */
  relaxed(side: Side): Grasp {
    const h = this.hands[side];
    const g: Grasp = { flex: [], spread: [], thumb: [-0.3, 0.2, 0.12, 0.15, 0.25] };
    for (let i = 0; i < 4; i++) {
      const v = 1 + 0.16 * i;
      g.flex.push([0.26 * v, 0.36 * v, 0.22 * v]);
      g.spread.push(h.close[i] * 0.7);
    }
    return g;
  }

  /** Shapes a hand: `weight` 0 is the open rest hand and 1 the grasp; one value per finger from index to little finger, or one for all. */
  hold(side: Side, g: Grasp, weight: number | number[] = 1, thumb = typeof weight === 'number' ? weight : 1): void {
    const h = this.hands[side];
    for (let i = 0; i < 4; i++) {
      const w = typeof weight === 'number' ? weight : weight[i];
      const ch = h.fingers[i];
      ch.bones[0].quaternion.copy(ch.rest[0]).multiply(q0.setFromAxisAngle(ch.swing, g.spread[i] * w)).multiply(q1.setFromAxisAngle(ch.local[0], g.flex[i][0] * w));
      for (let j = 1; j < 3; j++) ch.bones[j].quaternion.copy(ch.rest[j]).multiply(q0.setFromAxisAngle(ch.local[j], g.flex[i][j] * w));
    }
    const t = h.thumb;
    for (let j = 0; j < 3; j++) {
      const q = t.bones[j].quaternion.copy(t.rest[j]);
      if (j === 0) q.multiply(q0.setFromAxisAngle(t.swing, g.thumb[0] * thumb));
      if (j < 2) q.multiply(q0.setFromAxisAngle(t.roll[j], g.thumb[1] * ROLL[j] * thumb));
      q.multiply(q0.setFromAxisAngle(t.local[j], g.thumb[j + 2] * thumb));
    }
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
