import * as THREE from 'three/webgpu';
import type { Assets } from '../core/assets';

/** Debug scene: one model as authored, on a neutral ground, for inspecting assets. */
export async function buildKitPreview(scene: THREE.Scene, assets: Assets, id: string): Promise<void> {
  const gltf = await assets.model(id);
  scene.add(gltf.scene);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardNodeMaterial({ color: 0x5b5a55, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  const sun = new THREE.DirectionalLight(0xfff1e0, 1.2);
  sun.position.set(30, 60, 20);
  scene.add(sun);
}

/** Debug scene: the posable figure with a sword in its hand, to check the limb and finger solvers by eye. */
export async function buildRigPreview(scene: THREE.Scene, assets: Assets, id: string, pose: string): Promise<(time: number) => void> {
  const { Rig } = await import('../game/rig');
  const { bladeQuat, SWORD } = await import('../game/weapon');
  const rig = await Rig.create(assets, id);
  scene.add(rig.root);
  (window as any).__rig = rig;
  const sword = new THREE.Group();
  sword.add(await assets.instance(SWORD.id));
  scene.add(sword);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardNodeMaterial({ color: 0x5b5a55, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const sun = new THREE.DirectionalLight(0xfff1e0, 1.2);
  sun.position.set(30, 60, 20);
  scene.add(sun);
  const marks = [0, 1, 2, 3].map(() => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.012), new THREE.MeshBasicNodeMaterial({ color: 0xff2020 }));
    scene.add(s);
    return s;
  });

  const params = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
  // The test export has no textures; give it a skin tone and a key light so the fingers can be read.
  if (params.has('tint')) {
    const skin = new THREE.MeshStandardNodeMaterial({ color: 0xb98a6e, roughness: 0.55 });
    for (const mesh of rig.meshes) mesh.material = skin;
    sun.intensity = 3;
    sun.position.set(-2, 4, -3);
  }
  const handle = { along: num('along', 0.085), off: num('off', 0.0265), across: num('across', 0.008), axis: [num('tilt', -0.35), 1, 0] as [number, number, number], radius: num('radius', 0.012) };
  const held = rig.grasp('r', handle, num('lift', 0.7), num('roll', 1));
  const fist = rig.grasp('r', null, num('flift', 0.1), num('froll', 0));
  const relaxed = rig.relaxed('r');
  (window as any).__grasp = { held, fist };
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(handle.radius, handle.radius, 0.24, 20), new THREE.MeshStandardNodeMaterial({ color: 0x3a2a1c, roughness: 0.6 }));
  bar.visible = false;
  scene.add(bar);

  const v = new THREE.Vector3(), w = new THREE.Vector3(), o = new THREE.Vector3();
  const q = new THREE.Quaternion(), hq = new THREE.Quaternion();
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
  return (time) => {
    const t = pose === 'still' ? 0 : time;
    rig.reset();
    if (pose === 'hand' || pose === 'bar') {
      // Right forearm held out level, palm up (or wrapped round a bar), for studying the fingers.
      sword.visible = false;
      const up = pose === 'hand';
      rig.handQuaternion('r', v.set(0, 0, -1), up ? w.set(0, 1, 0) : w.set(-1, 0, 0), hq);
      v.set(0.22, 1.15, -0.42);
      rig.arm('r', v, hq, w.set(0.5, -1, 0.4));
      if (up) rig.hold('r', params.has('relaxed') ? relaxed : fist, num('curl', 0), num('thumb', 0));
      else {
        bar.visible = true;
        rig.hold('r', held, num('curl', 1), num('thumb', 1));
        rig.palmOffset('r', hq, handle.along, handle.off, handle.across, o);
        bar.position.copy(v).add(o);
        bar.quaternion.setFromUnitVectors(Y.set(0, 1, 0), rig.palmOffset('r', hq, handle.axis[0], handle.axis[2], handle.axis[1], X).normalize());
      }
      return;
    }
    // Sword: grip in front of the right shoulder, blade up and a little forward, swinging gently.
    sword.position.set(0.24 + 0.08 * Math.sin(t * 1.3), 1.16 + 0.08 * Math.sin(t * 0.9), -0.36);
    bladeQuat(v.set(-0.2 + 0.5 * Math.sin(t * 0.7), 0.9, -0.4), w.set(0.3, -0.2, -1), sword.quaternion);
    X.set(1, 0, 0).applyQuaternion(sword.quaternion);
    Y.set(0, 1, 0).applyQuaternion(sword.quaternion);
    Z.set(0, 0, 1).applyQuaternion(sword.quaternion);
    // Hammer grip: knuckles along the leading edge tipped a little towards the point, palm on the flat.
    rig.handQuaternion('r', v.copy(X).addScaledVector(Y, 0.35), w.copy(Z).negate(), hq);
    rig.palmOffset('r', hq, handle.along, handle.off, handle.across, o);
    v.copy(sword.position).sub(o);
    rig.arm('r', v, hq, w.set(0.5, -1, 0.4));
    rig.hold('r', held, pose === 'open' ? 0 : 1);
    marks[0].position.copy(v);
    // Left hand reaches forward, palm in.
    rig.handQuaternion('l', v.set(0.2, 0.2, -1), w.set(1, 0, 0), q);
    rig.arm('l', v.set(-0.25, 1.15 + 0.1 * Math.sin(t), -0.4), q, w.set(-0.6, -1, 0.3));
    rig.hold('l', rig.grasp('l'), 0.5 + 0.5 * Math.sin(t * 2));
    // Feet: left planted, right stepping.
    const lift = Math.max(0, Math.sin(t * 2));
    rig.leg('l', v.set(-0.12, 0.085, 0.05), null, w.set(-0.15, 0, -1));
    rig.leg('r', v.set(0.12, 0.085 + 0.2 * lift, -0.25 * lift), null, w.set(0.15, 0, -1));
  };
}
