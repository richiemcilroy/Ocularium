import * as THREE from 'three/webgpu';
import { GROUP, RAPIER, groups, type Physics } from '../physics/physics';
import type { Rig } from './rig';

export type Limb = 'pelvis' | 'chest' | 'head' | 'upperarm_l' | 'upperarm_r' | 'lowerarm_l' | 'lowerarm_r' | 'thigh_l' | 'thigh_r' | 'calf_l' | 'calf_r';

interface Spec {
  /** The bone this piece of the body carries. */
  bone: string;
  /** What it hangs from. */
  parent: Limb | null;
  /** The bone at the far end of it, for limbs; trunk pieces are boxes instead. */
  to?: string;
  /** Limb: thickness, and how far past the far joint it runs (a hand, a foot). Box: half extents and where it sits from the bone. */
  radius?: number;
  extend?: number;
  half?: [number, number, number];
  offset?: [number, number, number];
  mass: number;
  /** A hinge, with how far it opens either way from the rest pose; everything else is a ball joint. */
  hinge?: [number, number];
  /** How strongly the joint is held towards the rest pose, and how much it resists moving at all. */
  tone: [number, number];
}

const SPECS: Record<Limb, Spec> = {
  pelvis: { bone: 'pelvis', parent: null, half: [0.15, 0.1, 0.1], offset: [0, 0.02, 0], mass: 12, tone: [0, 0] },
  chest: { bone: 'spine_01', parent: 'pelvis', half: [0.17, 0.21, 0.11], offset: [0, 0.23, 0], mass: 28, tone: [46, 9] },
  head: { bone: 'neck_01', parent: 'chest', half: [0.085, 0.12, 0.1], offset: [0, 0.15, -0.02], mass: 5.5, tone: [34, 7] },
  upperarm_l: { bone: 'upperarm_l', parent: 'chest', to: 'lowerarm_l', radius: 0.045, mass: 2.6, tone: [5, 2.6] },
  upperarm_r: { bone: 'upperarm_r', parent: 'chest', to: 'lowerarm_r', radius: 0.045, mass: 2.6, tone: [5, 2.6] },
  lowerarm_l: { bone: 'lowerarm_l', parent: 'upperarm_l', to: 'hand_l', radius: 0.038, extend: 0.1, mass: 2, hinge: [-0.72, 1.7], tone: [0, 2] },
  lowerarm_r: { bone: 'lowerarm_r', parent: 'upperarm_r', to: 'hand_r', radius: 0.038, extend: 0.1, mass: 2, hinge: [-0.72, 1.7], tone: [0, 2] },
  thigh_l: { bone: 'thigh_l', parent: 'pelvis', to: 'calf_l', radius: 0.07, mass: 9, tone: [9, 4] },
  thigh_r: { bone: 'thigh_r', parent: 'pelvis', to: 'calf_r', radius: 0.07, mass: 9, tone: [9, 4] },
  calf_l: { bone: 'calf_l', parent: 'thigh_l', to: 'foot_l', radius: 0.05, extend: 0.06, mass: 5, hinge: [-0.03, 2.3], tone: [0, 3] },
  calf_r: { bone: 'calf_r', parent: 'thigh_r', to: 'foot_r', radius: 0.05, extend: 0.06, mass: 5, hinge: [-0.03, 2.3], tone: [0, 3] },
};

/** Trunk first, so every bone is turned after the one it hangs from. */
const ORDER: Limb[] = ['pelvis', 'chest', 'head', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r'];

const Y = new THREE.Vector3(0, 1, 0);
const a = new THREE.Vector3(), b = new THREE.Vector3();
const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();

/**
 * A body with nobody in it. Built from a figure exactly as it stands, so the
 * fall starts from the pose the blow found it in; from then on the physics
 * world owns the bones.
 *
 * Every piece keeps the frame the whole figure has at rest, turned by however
 * far its bone is from rest. With all pieces sharing one frame at rest, a
 * hinge's opening is measured from the rest pose and its stops mean what they say.
 */
export class Ragdoll {
  readonly bodies = {} as Record<Limb, RAPIER.RigidBody>;
  private joints: RAPIER.ImpulseJoint[] = [];
  private last = new THREE.Vector3();
  private quiet = 0;
  private thudAt = 0;
  private time = 0;
  /** Called when the trunk hits something hard enough to hear. */
  onThud: ((point: THREE.Vector3, strength: number) => void) | null = null;

  constructor(private physics: Physics, private rig: Rig, velocity: THREE.Vector3) {
    const w = physics.world;
    const P = rig.restWorldP, Q = rig.restWorldQ;
    for (const name of ORDER) {
      const s = SPECS[name];
      rig.worldPosition(s.bone, a);
      rig.worldQuaternion(s.bone, q).multiply(q2.copy(Q[s.bone]).invert());
      const body = w.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(a.x, a.y, a.z)
          .setRotation(q)
          .setLinvel(velocity.x, velocity.y, velocity.z)
          .setLinearDamping(0.08)
          .setAngularDamping(1.1)
          .setCcdEnabled(true),
      );
      let desc: RAPIER.ColliderDesc;
      if (s.to) {
        // A limb: along the bone at rest, from its own joint to the next and a little beyond.
        b.subVectors(P[s.to], P[s.bone]);
        const len = b.length() + (s.extend ?? 0);
        b.normalize();
        q2.setFromUnitVectors(Y, b);
        const r = s.radius!;
        desc = RAPIER.ColliderDesc.capsule(Math.max(0.01, len / 2 - r), r).setTranslation(b.x * (len / 2), b.y * (len / 2), b.z * (len / 2)).setRotation(q2);
      } else {
        desc = RAPIER.ColliderDesc.cuboid(...s.half!).setTranslation(...s.offset!);
      }
      desc.setMass(s.mass).setFriction(0.85).setRestitution(0.02).setCollisionGroups(groups(GROUP.RAGDOLL, GROUP.WORLD | GROUP.PROP | GROUP.RAGDOLL));
      physics.tag(w.createCollider(desc, body), 'dirt');
      this.bodies[name] = body;
    }
    for (const name of ORDER) {
      const s = SPECS[name];
      if (!s.parent) continue;
      const parent = this.bodies[s.parent], child = this.bodies[name];
      // The joint sits at the child's own bone; where that is on the parent comes from the rest pose.
      a.subVectors(P[s.bone], P[SPECS[s.parent].bone]);
      const zero = { x: 0, y: 0, z: 0 };
      let joint: RAPIER.ImpulseJoint;
      if (s.hinge) {
        // Elbows and knees close about their bone's own X.
        b.set(1, 0, 0).applyQuaternion(Q[s.bone]);
        joint = w.createImpulseJoint(RAPIER.JointData.revolute({ x: a.x, y: a.y, z: a.z }, zero, { x: b.x, y: b.y, z: b.z }), parent, child, true);
        (joint as RAPIER.RevoluteImpulseJoint).setLimits(s.hinge[0], s.hinge[1]);
        if (s.tone[1] > 0) (joint as RAPIER.RevoluteImpulseJoint).configureMotorVelocity(0, s.tone[1]);
      } else {
        joint = w.createImpulseJoint(RAPIER.JointData.spherical({ x: a.x, y: a.y, z: a.z }, zero), parent, child, true);
        // What is left of a body's own hold on itself: enough that it folds like a person and not like a chain.
        // (Set through the joint set itself: this build hands ball joints back without their motor methods.)
        const raw = (joint as any).rawSet;
        if (raw?.jointConfigureMotorPosition) {
          for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
            raw.jointConfigureMotorModel(joint.handle, axis, RAPIER.MotorModel.AccelerationBased);
            raw.jointConfigureMotorPosition(joint.handle, axis, 0, s.tone[0], s.tone[1]);
          }
        }
      }
      joint.setContactsEnabled(false);
      this.joints.push(joint);
    }
    this.last.copy(velocity);
  }

  /** Knocks one piece of the body: `impulse` in newton-seconds, at `point` if given. */
  push(limb: Limb, impulse: THREE.Vector3, point?: THREE.Vector3): void {
    const body = this.bodies[limb];
    if (point) body.applyImpulseAtPoint(impulse, point, true);
    else body.applyImpulse(impulse, true);
  }

  /** Which piece of the body a bone belongs to. */
  static limbOf(bone: string): Limb {
    if (bone.startsWith('head') || bone.startsWith('neck')) return 'head';
    if (bone.startsWith('spine') || bone.startsWith('clavicle')) return 'chest';
    if (bone.startsWith('hand') || bone.startsWith('lowerarm')) return bone.endsWith('_l') ? 'lowerarm_l' : 'lowerarm_r';
    if (bone.startsWith('upperarm')) return bone.endsWith('_l') ? 'upperarm_l' : 'upperarm_r';
    if (bone.startsWith('thigh')) return bone.endsWith('_l') ? 'thigh_l' : 'thigh_r';
    if (bone.startsWith('calf') || bone.startsWith('foot') || bone.startsWith('ball')) return bone.endsWith('_l') ? 'calf_l' : 'calf_r';
    return 'pelvis';
  }

  /** True once the body has come to rest. */
  get still(): boolean {
    return this.quiet > 1.5;
  }

  /** Where the chest is and which way it faces (the figure's own forward and up). */
  chest(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    const body = this.bodies.chest;
    const t = body.translation(), r = body.rotation();
    position.set(t.x, t.y, t.z);
    quaternion.set(r.x, r.y, r.z, r.w);
  }

  /** Poses the figure from the bodies. Call after the physics step. */
  update(dt: number): void {
    const rig = this.rig;
    this.time += dt;
    const pelvis = this.bodies.pelvis;
    const v = pelvis.linvel();
    // A trunk that was moving and has just stopped has hit something.
    const lost = this.last.length() - Math.hypot(v.x, v.y, v.z);
    if (lost > 0.9 && this.time - this.thudAt > 0.3) {
      this.thudAt = this.time;
      const t = pelvis.translation();
      this.onThud?.(a.set(t.x, t.y, t.z), Math.min(1, lost / 3.5));
    }
    this.last.set(v.x, v.y, v.z);
    let moving = false;
    for (const name of ORDER) if (!this.bodies[name].isSleeping()) moving = true;
    this.quiet = moving && this.last.lengthSq() > 0.0004 ? 0 : this.quiet + dt;
    if (!moving && this.quiet > 3) return;

    rig.reset();
    rig.root.quaternion.identity();
    for (const name of ORDER) {
      const s = SPECS[name];
      const r = this.bodies[name].rotation();
      rig.setWorldQuaternion(s.bone, q.set(r.x, r.y, r.z, r.w).multiply(rig.restWorldQ[s.bone]));
    }
    const t = pelvis.translation();
    rig.worldPosition('pelvis', a);
    rig.root.position.add(b.set(t.x, t.y, t.z)).sub(a);
  }

  dispose(): void {
    const w = this.physics.world;
    for (const j of this.joints) w.removeImpulseJoint(j, false);
    for (const name of ORDER) w.removeRigidBody(this.bodies[name]);
    this.joints.length = 0;
  }
}

/** Something a figure had on it when it fell, and still has: a shield on its arm. */
interface Carried {
  object: THREE.Object3D;
  bone: THREE.Bone;
  local: THREE.Matrix4;
}

const m = new THREE.Matrix4();
const scale = new THREE.Vector3();

/** A figure that has gone down, and whatever stayed strapped to it. */
export class Fallen {
  private carried: Carried[] = [];
  private asleep = false;

  constructor(readonly rig: Rig, readonly ragdoll: Ragdoll) {}

  /** Keeps `object` fixed to one of the figure's bones, as it is now. */
  carry(object: THREE.Object3D, bone: string): void {
    const b = this.rig.bones[bone];
    b.updateWorldMatrix(true, false);
    object.updateMatrixWorld(true);
    this.carried.push({ object, bone: b, local: new THREE.Matrix4().copy(b.matrixWorld).invert().multiply(object.matrixWorld) });
  }

  update(dt: number): void {
    if (this.asleep) return;
    this.ragdoll.update(dt);
    for (const c of this.carried) {
      c.bone.updateWorldMatrix(true, false);
      m.multiplyMatrices(c.bone.matrixWorld, c.local).decompose(c.object.position, c.object.quaternion, scale);
    }
    // Once it has lain still for a while it will not move again unless something moves it.
    this.asleep = this.ragdoll.still && this.ragdollAsleep();
  }

  private ragdollAsleep(): boolean {
    for (const body of Object.values(this.ragdoll.bodies)) if (!body.isSleeping()) return false;
    return true;
  }

  /** Something has disturbed the body; start following it again. */
  wake(): void {
    this.asleep = false;
  }

  dispose(): void {
    this.ragdoll.dispose();
    this.rig.dispose();
    for (const c of this.carried) c.object.removeFromParent();
  }
}
