import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import type { BoxColliderDesc, SurfaceKind } from '../world/builder';

export { RAPIER };

/** Collision group bits. */
export const GROUP = {
  WORLD: 1 << 0,
  PROP: 1 << 1,
  PLAYER: 1 << 2,
  /** Per-bone hit volumes of living characters: only blades and rays see them. */
  HITBOX: 1 << 3,
  RAGDOLL: 1 << 4,
  WEAPON: 1 << 5,
  /** The capsule a living character other than the wearer moves around in. */
  BODY: 1 << 6,
};
export const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);

/**
 * Each fighter has a bit of their own. A sword carries its owner's bit and is
 * stopped by everyone else's steel and boards, never by its owner's.
 */
export const fighterBit = (index: number) => 1 << (7 + (index % 9));
export const FIGHTERS = 0xff80;

/** Called when something solid is hit hard: what was hit, how hard (newtons), where, and the direction of the push. */
export type ImpactHandler = (other: RAPIER.Collider, force: number, point: THREE.Vector3, normal: THREE.Vector3) => void;

const SOLID = GROUP.WORLD | GROUP.PROP;

export interface RayHit {
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  collider: RAPIER.Collider;
  surface: SurfaceKind;
}

export interface DynamicProp {
  object: THREE.Object3D;
  body: RAPIER.RigidBody;
  surface: SurfaceKind;
}

export class Physics {
  readonly world: RAPIER.World;
  readonly props: DynamicProp[] = [];
  private surfaces = new Map<number, SurfaceKind>();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  /** Arbitrary gameplay data attached to colliders (which character and bone a hitbox belongs to). */
  readonly owners = new Map<number, unknown>();
  readonly step = 1 / 60;
  private accumulator = 0;
  private events!: RAPIER.EventQueue;
  private impacts = new Map<number, ImpactHandler>();
  private at = new THREE.Vector3();
  private push = new THREE.Vector3();

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.step;
    this.events = new RAPIER.EventQueue(true);
  }

  /** Reports hard knocks on a collider. */
  onImpact(collider: RAPIER.Collider, handler: ImpactHandler, threshold = 45): void {
    collider.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    collider.setContactForceEventThreshold(threshold);
    this.impacts.set(collider.handle, handler);
  }

  offImpact(collider: RAPIER.Collider): void {
    this.impacts.delete(collider.handle);
  }

  private report(): void {
    this.events.drainContactForceEvents((ev) => {
      const h1 = ev.collider1(), h2 = ev.collider2();
      const f1 = this.impacts.get(h1), f2 = this.impacts.get(h2);
      if (!f1 && !f2) return;
      const c1 = this.world.getCollider(h1), c2 = this.world.getCollider(h2);
      if (!c1 || !c2) return;
      const force = ev.maxForceMagnitude();
      const d = ev.maxForceDirection();
      this.push.set(d.x, d.y, d.z);
      let found = false;
      this.world.contactPair(c1, c2, (manifold) => {
        if (found || manifold.numSolverContacts() === 0) return;
        const p = manifold.solverContactPoint(0);
        if (!p) return;
        this.at.set(p.x, p.y, p.z);
        found = true;
      });
      if (!found) {
        const t = (f1 ? c1 : c2).translation();
        this.at.set(t.x, t.y, t.z);
      }
      f1?.(c2, force, this.at, this.push);
      f2?.(c1, force, this.at, this.push);
    });
  }

  surfaceOf(collider: RAPIER.Collider): SurfaceKind {
    return this.surfaces.get(collider.handle) ?? 'stone';
  }

  tag(collider: RAPIER.Collider, surface: SurfaceKind): RAPIER.Collider {
    this.surfaces.set(collider.handle, surface);
    return collider;
  }

  addStaticBox(d: BoxColliderDesc): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(d.half.x, d.half.y, d.half.z)
      .setTranslation(d.position.x, d.position.y, d.position.z)
      .setRotation(d.quaternion)
      .setFriction(0.9)
      .setCollisionGroups(groups(GROUP.WORLD, 0xffff));
    return this.tag(this.world.createCollider(desc), d.surface);
  }

  /** Static triangle-mesh collider from every mesh under `root`, in world space. */
  addStaticMesh(root: THREE.Object3D, surface: SurfaceKind): RAPIER.Collider[] {
    root.updateWorldMatrix(true, true);
    const v = new THREE.Vector3();
    const made: RAPIER.Collider[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute('position');
      const verts = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        verts[i * 3] = v.x;
        verts[i * 3 + 1] = v.y;
        verts[i * 3 + 2] = v.z;
      }
      const index = mesh.geometry.getIndex();
      const indices = index ? Uint32Array.from(index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
      const desc = RAPIER.ColliderDesc.trimesh(verts, indices).setFriction(0.9).setCollisionGroups(groups(GROUP.WORLD, 0xffff));
      made.push(this.tag(this.world.createCollider(desc), surface));
    });
    return made;
  }

  /** Bounding box of everything under `object`, in its own scaled frame. */
  private localBox(object: THREE.Object3D): { size: THREE.Vector3; centre: THREE.Vector3 } {
    object.updateWorldMatrix(true, true);
    const local = new THREE.Box3();
    const inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
    const tmp = new THREE.Box3();
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
      local.union(tmp);
    });
    return { size: local.getSize(new THREE.Vector3()).multiply(object.scale), centre: local.getCenter(new THREE.Vector3()).multiply(object.scale) };
  }

  /** A fixed box collider around a placed object (furniture, rocks). `shrink` trims soft outlines. */
  addStaticProp(object: THREE.Object3D, surface: SurfaceKind, shrink = 1): RAPIER.Collider {
    const { size, centre } = this.localBox(object);
    const c = centre.applyQuaternion(object.quaternion).add(object.position);
    const desc = RAPIER.ColliderDesc.cuboid((size.x / 2) * shrink, size.y / 2, (size.z / 2) * shrink)
      .setTranslation(c.x, c.y, c.z)
      .setRotation(object.quaternion)
      .setFriction(0.8)
      .setCollisionGroups(groups(GROUP.WORLD, 0xffff));
    return this.tag(this.world.createCollider(desc), surface);
  }

  /** A free rigid body shaped from the object's bounding box. The object's origin must be the body origin. */
  addProp(object: THREE.Object3D, shape: 'box' | 'cylinder', density: number, surface: SurfaceKind): DynamicProp {
    const { size, centre } = this.localBox(object);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(object.position.x, object.position.y, object.position.z)
        .setRotation(object.quaternion)
        .setLinearDamping(0.05)
        .setAngularDamping(0.4)
        .setCanSleep(true),
    );
    const desc =
      shape === 'cylinder'
        ? RAPIER.ColliderDesc.cylinder(size.y / 2, Math.max(size.x, size.z) / 2)
        : RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2);
    desc
      .setTranslation(centre.x, centre.y, centre.z)
      .setDensity(density)
      .setFriction(0.7)
      .setRestitution(0.05)
      .setCollisionGroups(groups(GROUP.PROP, 0xffff));
    this.tag(this.world.createCollider(desc, body), surface);
    body.sleep();
    const prop = { object, body, surface };
    this.props.push(prop);
    return prop;
  }

  /** A free rigid body with a collider of the caller's choosing, carrying `object` with it from where it is now. */
  addLoose(object: THREE.Object3D, collider: RAPIER.ColliderDesc, surface: SurfaceKind, velocity?: THREE.Vector3, spin?: THREE.Vector3): DynamicProp {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(object.position.x, object.position.y, object.position.z)
        .setRotation(object.quaternion)
        .setLinearDamping(0.05)
        .setAngularDamping(0.5)
        .setCcdEnabled(true)
        .setCanSleep(true),
    );
    if (velocity) body.setLinvel(velocity, true);
    if (spin) body.setAngvel(spin, true);
    this.tag(this.world.createCollider(collider.setFriction(0.7).setRestitution(0.1).setCollisionGroups(groups(GROUP.PROP, GROUP.WORLD | GROUP.PROP | GROUP.RAGDOLL)), body), surface);
    const prop = { object, body, surface };
    this.props.push(prop);
    return prop;
  }

  /** Takes a free body back out of the world. */
  removeProp(prop: DynamicProp): void {
    const i = this.props.indexOf(prop);
    if (i >= 0) this.props.splice(i, 1);
    this.world.removeRigidBody(prop.body);
  }

  /** Nearest hit along a ray. `mask` selects collision groups; defaults to solid world and props. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number, mask = SOLID, exclude?: RAPIER.RigidBody, skip?: (collider: RAPIER.Collider) => boolean): RayHit | null {
    this.ray.origin.x = origin.x;
    this.ray.origin.y = origin.y;
    this.ray.origin.z = origin.z;
    this.ray.dir.x = dir.x;
    this.ray.dir.y = dir.y;
    this.ray.dir.z = dir.z;
    const hit = this.world.castRayAndGetNormal(this.ray, maxDistance, true, undefined, groups(0xffff, mask), undefined, exclude, skip ? (c) => !skip(c) : undefined);
    if (!hit) return null;
    return {
      distance: hit.timeOfImpact,
      point: new THREE.Vector3().copy(origin).addScaledVector(dir, hit.timeOfImpact),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      collider: hit.collider,
      surface: this.surfaceOf(hit.collider),
    };
  }

  /** Distance to the nearest static-world hit, or -1. Allocation-free, for the bulk rays of the light bake. */
  occlusion(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number): number {
    this.ray.origin.x = ox;
    this.ray.origin.y = oy;
    this.ray.origin.z = oz;
    this.ray.dir.x = dx;
    this.ray.dir.y = dy;
    this.ray.dir.z = dz;
    const hit = this.world.castRay(this.ray, maxDistance, false, undefined, groups(0xffff, GROUP.WORLD));
    return hit ? hit.timeOfImpact : -1;
  }

  /** How far the current frame sits between the last two fixed steps, for interpolating rendered positions. */
  get alpha(): number {
    return this.accumulator / this.step;
  }

  /** Advances the simulation in fixed steps; returns how many steps ran. */
  update(dt: number, onStep?: () => void): number {
    this.accumulator = Math.min(this.accumulator + dt, this.step * 4);
    let steps = 0;
    while (this.accumulator >= this.step) {
      onStep?.();
      this.world.step(this.events);
      this.report();
      this.accumulator -= this.step;
      steps++;
    }
    if (steps > 0) {
      for (const p of this.props) {
        if (p.body.isSleeping()) continue;
        const t = p.body.translation();
        const r = p.body.rotation();
        p.object.position.set(t.x, t.y, t.z);
        p.object.quaternion.set(r.x, r.y, r.z, r.w);
      }
    }
    return steps;
  }
}
