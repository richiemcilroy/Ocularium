import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/assets';
import type { Physics, RayHit } from '../physics/physics';
import { groundMaterial, skyVolume, triplanarMaterial, uvMaterial } from '../render/materials';
import { bakeSkyVolume, bakeVertexSky } from './ambient';
import { Builder, type SurfaceKind } from './builder';
import { Flame } from './fire';
import { bench, frameWall, gableRoof, trestleTable } from './structures';
import { GATE_X, WARD, buildGroundGeometry, groundSurfaceAt, heightAt, random, roadX } from './terrain';

export type Zone = 'open' | 'yard' | 'gate' | 'hall';

export interface EnemySpawn {
  position: THREE.Vector3;
  yaw: number;
  /** Points walked between while undisturbed; none means standing at a post. */
  patrol: THREE.Vector3[];
}

export interface NavGraph {
  nodes: THREE.Vector3[];
  links: number[][];
}

export interface Level {
  root: THREE.Group;
  spawn: { position: THREE.Vector3; yaw: number };
  enemySpawns: EnemySpawn[];
  flames: Flame[];
  sun: THREE.DirectionalLight;
  nav: NavGraph;
  /** What a ray or foot landed on, resolving the painted ground into stone, grass or dirt. */
  surface(hit: RayHit): SurfaceKind;
  zoneAt(p: THREE.Vector3): Zone;
  update(time: number, camera: THREE.Camera): void;
  /** How long the light bake took, for the log. */
  bakeMs: number;
}

/** Hall footprint (wall centre lines), wall plate height and floor level. */
export const HALL = { x0: -19.5, x1: -11.5, z0: -7, z1: 7, plate: 3.2, rise: 3.2, floor: 0.04 };

const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.4).normalize();

interface KitPlacement {
  piece: string;
  x: number;
  z: number;
  ry: number;
  scale?: [number, number, number];
}

/** Curtain wall, wall walk and towers from the modular fort kit. See terrain.ts for the ward dimensions. */
function wardLayout(): KitPlacement[] {
  const S = Math.PI / 2, N = -Math.PI / 2, W = 0, E = Math.PI;
  const { x: X, z: Z, thick: T } = WARD;
  const tower: [number, number, number] = [0.62, 0.92, 0.62];
  return [
    // South wall, gate right of centre.
    { piece: 'wall_thin_straight_01', x: -X, z: Z, ry: S },
    { piece: 'wall_thin_straight_04', x: -7.41, z: Z, ry: S },
    { piece: 'wall_thin_gate_01', x: 0, z: Z, ry: S },
    { piece: 'wall_thin_straight_02', x: 7.41, z: Z, ry: S },
    // North wall with a stair and walk on its inner face.
    { piece: 'wall_thin_straight_02', x: X, z: -Z, ry: N },
    { piece: 'wall_thin_straight_01', x: 7.41, z: -Z, ry: N },
    { piece: 'wall_thin_straight_02', x: -7.41, z: -Z, ry: N },
    { piece: 'wall_stairs_straight_01', x: 17.2, z: -Z + T, ry: N },
    { piece: 'wall_walkway_straight_01', x: 2.38, z: -Z + T, ry: N },
    { piece: 'wall_walkway_end_01', x: -12.18, z: -Z + T, ry: N },
    // West and east walls.
    { piece: 'wall_thin_straight_01', x: -X, z: -Z, ry: W },
    { piece: 'wall_thin_straight_02', x: -X, z: 0, ry: W },
    { piece: 'wall_thin_straight_02', x: X, z: Z, ry: E },
    { piece: 'wall_thin_straight_01', x: X, z: 0, ry: E },
    { piece: 'tower_round', x: -21.2, z: -13.8, ry: 0.3, scale: tower },
    { piece: 'tower_round', x: 21.2, z: -13.8, ry: 1.9, scale: tower },
    { piece: 'tower_round', x: -21.2, z: 13.8, ry: 3.4, scale: tower },
    { piece: 'tower_round', x: 21.2, z: 13.8, ry: 5.1, scale: tower },
  ];
}

/** Copies a mesh's geometry into world space, positions and normals only. */
function worldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const src = mesh.geometry;
  const pos = src.getAttribute('position');
  const nor = src.getAttribute('normal');
  const m = mesh.matrixWorld;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const P = new Float32Array(pos.count * 3);
  const Nn = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m).toArray(P, i * 3);
    v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize().toArray(Nn, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  const index = src.getIndex();
  g.setIndex(index ? Array.from(index.array) : Array.from({ length: pos.count }, (_, i) => i));
  return g;
}

export async function buildLevel(scene: THREE.Scene, assets: Assets, physics: Physics, onStatus: (text: string) => void): Promise<Level> {
  const root = new THREE.Group();
  root.name = 'level';
  scene.add(root);
  onStatus('Loading the castle');

  const tex = (id: string) => assets.surfaceMaps(id);
  const [slates, ashlar, stonePlaster, planksDark, daub, thatch, boards, dirt, studded, mud, cobble, grass, iron] = await Promise.all([
    tex('castle_wall_slates'),
    tex('medieval_blocks_03'),
    tex('plastered_stone_wall'),
    tex('weathered_planks'),
    tex('white_plaster_rough_01'),
    tex('thatch_roof_angled'),
    tex('dark_planks'),
    tex('dirt_floor'),
    tex('medieval_wood'),
    tex('brown_mud_02'),
    tex('cobblestone_floor_08'),
    tex('forrest_ground_01'),
    tex('rusty_metal_02'),
  ]);

  // ---------------------------------------------------------------- ward
  const kit = (await assets.model('modular_fort_01')).scene;
  const kitParts = new Map<string, THREE.BufferGeometry[]>();
  for (const p of wardLayout()) {
    const src = kit.getObjectByName(p.piece) ?? kit.getObjectByName(`modular_fort_01_${p.piece}`);
    if (!src) throw new Error(`fort kit has no piece '${p.piece}'`);
    const o = src.clone(true);
    o.position.set(p.x, 0, p.z);
    o.rotation.set(0, p.ry, 0);
    if (p.scale) o.scale.set(...p.scale);
    o.updateMatrixWorld(true);
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      const name = (mesh.material as THREE.Material).name;
      const key = name.includes('trim') ? 'trim' : name.includes('plaster') ? 'plaster' : 'wall';
      if (!kitParts.has(key)) kitParts.set(key, []);
      kitParts.get(key)!.push(worldGeometry(mesh));
    });
  }
  // The kit's own textures are stretched far too thin for a camera at chest height, so the
  // stone is re-skinned with scans projected in world space.
  const kitMaterials: Record<string, THREE.Material> = {
    wall: triplanarMaterial(slates, { tile: 2.6, detile: true, roughFloor: 0.8 }),
    trim: triplanarMaterial(ashlar, { tile: 2.4, tint: 0xd8d4cc, detile: true, roughFloor: 0.8 }),
    plaster: triplanarMaterial(stonePlaster, { tile: 2.5 }),
  };
  const ward = new THREE.Group();
  ward.name = 'ward';
  for (const [key, parts] of kitParts) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), kitMaterials[key]);
    mesh.name = `ward:${key}`;
    mesh.castShadow = mesh.receiveShadow = true;
    ward.add(mesh);
  }
  root.add(ward);
  physics.addStaticMesh(ward, 'stone');

  // ---------------------------------------------------------------- timber buildings
  const b = new Builder();
  for (const [key, surface] of [['beam', 'wood'], ['boards', 'wood'], ['door', 'wood'], ['daub', 'plaster'], ['plinth', 'stone'], ['thatch', 'thatch'], ['earth', 'dirt'], ['iron', 'metal']] as const) {
    b.setSurface(key, surface);
  }
  const H = HALL;
  const F = H.floor;
  const win = { y0: 1.25, y1: 2.05 };
  const door = { y0: 0, y1: 2.05 };
  frameWall(b, { axis: 'z', at: H.x1, from: H.z0, to: H.z1, top: H.plate, ends: [true, true], openings: [{ a: -5.5, b: -4.5, ...win }, { a: 1.8, b: 3.2, ...door }, { a: 5.0, b: 6.0, ...win }] });
  frameWall(b, { axis: 'z', at: H.x0, from: H.z0, to: H.z1, top: H.plate, ends: [true, true] });
  frameWall(b, { axis: 'x', at: H.z0, from: H.x0, to: H.x1, top: H.plate, openings: [{ a: -13.9, b: -12.7, ...door }] });
  frameWall(b, { axis: 'x', at: H.z1, from: H.x0, to: H.x1, top: H.plate, openings: [{ a: -16.1, b: -14.9, ...win }] });
  frameWall(b, { axis: 'x', at: -2.5, from: H.x0 + 0.1, to: H.x1 - 0.1, top: H.plate, plinth: 0, infill: 'boards', infillThick: 0.05, ends: [true, true], openings: [{ a: -16.3, b: -15.1, ...door }] });
  gableRoof(b, { ...H, eaves: 0.55, verge: 0.4, thick: 0.36 });
  b.gable('daub', [(H.x0 + H.x1) / 2, H.plate, H.z0], H.x1 - H.x0, H.rise, 0.12);
  b.gable('daub', [(H.x0 + H.x1) / 2, H.plate, H.z1], H.x1 - H.x0, H.rise, 0.12);
  b.box('earth', [(H.x0 + H.x1) / 2, F - 0.07, 0], [H.x1 - H.x0 - 0.1, 0.14, H.z1 - H.z0 - 0.1], { skip: ['-y'] });
  // Main door, standing open into the hall.
  b.box('door', [-12.3, F + 1.01, 1.72], [0.06, 2.0, 1.36], { rot: [0, Math.PI / 2 + 0.1, 0], grain: 'y' });
  b.box('iron', [-12.3, F + 1.55, 1.685], [0.012, 0.05, 1.2], { rot: [0, Math.PI / 2 + 0.1, 0], collide: false });
  b.box('iron', [-12.3, F + 0.45, 1.685], [0.012, 0.05, 1.2], { rot: [0, Math.PI / 2 + 0.1, 0], collide: false });

  trestleTable(b, -17.9, F, 3.4, 2.9);
  bench(b, -18.55, F, 3.4, 2.6);
  bench(b, -17.25, F, 3.4, 2.6);
  trestleTable(b, -13.2, F, 5.2, 2.2);
  bench(b, -13.85, F, 5.2, 2.0);
  // Store-room shelf along the north gable.
  b.box('boards', [-17.4, F + 1.3, -6.72], [3.2, 0.04, 0.34], { grain: 'z' });
  b.box('boards', [-17.4, F + 0.75, -6.72], [3.2, 0.04, 0.34], { grain: 'z' });
  for (const x of [-18.9, -17.4, -15.9]) b.box('beam', [x, F + 0.67, -6.72], [0.05, 1.34, 0.32], { grain: 'y', collide: false });

  // Lean-to against the east wall: store for fuel and tools.
  const shedBack = WARD.x - WARD.thick - 0.1, shedFront = 15.6;
  const shedPitch = Math.atan2(0.75, shedBack - shedFront + 0.5);
  for (const z of [-5, -2, 1, 4]) {
    b.box('beam', [shedFront, 1.15, z], [0.18, 2.3, 0.18], { grain: 'y' });
    b.box('beam', [shedBack, 1.5, z], [0.16, 3.0, 0.16], { grain: 'y', collide: false });
    b.box('beam', [(shedFront + shedBack) / 2 - 0.2, 2.66, z], [(shedBack - shedFront + 0.6) / Math.cos(shedPitch), 0.12, 0.1], { rot: [0, 0, shedPitch], grain: 'x', collide: false });
  }
  b.box('beam', [shedFront, 2.3, -0.5], [0.16, 0.16, 9.4], { grain: 'z', collide: false });
  b.box('beam', [shedBack, 3.0, -0.5], [0.14, 0.14, 9.4], { grain: 'z', collide: false });
  b.box('boards', [(shedFront + shedBack) / 2 - 0.25, 2.77, -0.5], [(shedBack - shedFront + 0.9) / Math.cos(shedPitch), 0.05, 9.8], { rot: [0, 0, shedPitch], grain: 'z' });
  for (const z of [-5, 4]) b.box('boards', [(shedFront + shedBack) / 2, 1.15, z], [shedBack - shedFront, 2.3, 0.05], { grain: 'x' });

  // Wall torches: a staff in an iron bracket.
  const torches: Array<{ p: THREE.Vector3; n: [number, number] }> = [
    { p: new THREE.Vector3(-17.6, 1.75, -2.56), n: [0, -1] },
    { p: new THREE.Vector3(-19.39, 1.8, 0.4), n: [1, 0] },
  ];
  for (const t of torches) {
    const [nx, nz] = t.n;
    b.box('beam', [t.p.x + nx * 0.13, t.p.y, t.p.z + nz * 0.13], [0.045, 0.5, 0.045], { rot: [nz * 0.38, 0, -nx * 0.38], grain: 'y', collide: false });
    b.box('iron', [t.p.x + nx * 0.07, t.p.y - 0.08, t.p.z + nz * 0.07], [0.03 + Math.abs(nx) * 0.12, 0.03, 0.03 + Math.abs(nz) * 0.12], { collide: false });
    b.box('iron', [t.p.x + nx * 0.225, t.p.y + 0.24, t.p.z + nz * 0.225], [0.075, 0.07, 0.075], { rot: [nz * 0.38, 0, -nx * 0.38], collide: false });
  }

  const built = b.build({
    beam: uvMaterial(planksDark, { tile: 1.5, baked: true, tint: 0xb8aa98 }),
    boards: uvMaterial(boards, { tile: 1.6, baked: true }),
    door: uvMaterial(studded, { tile: 1.9, baked: true }),
    daub: uvMaterial(daub, { tile: 2.4, baked: true, tint: 0xd9d2c2 }),
    plinth: uvMaterial(slates, { tile: 2.2, baked: true }),
    thatch: uvMaterial(thatch, { tile: 2.0, baked: true }),
    earth: uvMaterial(dirt, { tile: 2.6, baked: true, tint: 0x6d6258 }),
    iron: uvMaterial(iron, { tile: 0.8, baked: true, tint: 0x4a4744 }),
  });
  root.add(built);
  for (const c of b.colliders) physics.addStaticBox(c);

  // ---------------------------------------------------------------- ground
  const ground = new THREE.Mesh(buildGroundGeometry(), groundMaterial({ mud, cobble, grass }));
  ground.name = 'ground';
  ground.receiveShadow = true;
  root.add(ground);
  const groundHandle = physics.addStaticMesh(ground, 'dirt')[0].handle;

  // ---------------------------------------------------------------- props
  onStatus('Furnishing');
  /** A fresh copy of a model (or one node of it), re-origined to the centre of its base. */
  const piece = async (id: string, node?: string, scale = 1): Promise<THREE.Group> => {
    const inner = await assets.instance(id, node);
    if (node) inner.position.set(0, 0, 0);
    const g = new THREE.Group();
    g.add(inner);
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    inner.position.x -= (box.min.x + box.max.x) / 2;
    inner.position.y -= box.min.y;
    inner.position.z -= (box.min.z + box.max.z) / 2;
    g.scale.setScalar(scale);
    g.name = node ?? id;
    return g;
  };
  const put = (g: THREE.Group, x: number, y: number, z: number, ry = 0): THREE.Group => {
    g.position.set(x, y, z);
    g.rotation.y = ry;
    root.add(g);
    return g;
  };
  type Loose = [id: string, node: string | undefined, x: number, y: number, z: number, ry: number, shape: 'box' | 'cylinder', density: number, surface: SurfaceKind];
  const T1 = F + 0.772; // table top
  const loose: Loose[] = [
    // Store room.
    ['wooden_barrels_01', 'wooden_barrels_01_barrel01', -18.75, F, -6.1, 0.4, 'cylinder', 260, 'wood'],
    ['wooden_barrels_01', 'wooden_barrels_01_barrel02', -17.9, F, -6.15, 2.1, 'cylinder', 260, 'wood'],
    ['wooden_barrels_01', 'wooden_barrels_01_barrel01', -18.8, F, -5.25, 4.0, 'cylinder', 260, 'wood'],
    ['wooden_crate_02', undefined, -12.35, F, -3.45, 0.05, 'box', 110, 'wood'],
    ['wooden_crate_02', undefined, -12.4, F + 0.47, -3.5, 0.2, 'box', 110, 'wood'],
    ['wooden_bucket_01', undefined, -16.6, F, -6.3, 1.0, 'cylinder', 70, 'wood'],
    // Hall tables.
    ['jug_01', undefined, -17.85, T1, 2.9, 0.6, 'cylinder', 500, 'stone'],
    ['brass_goblets', 'brass_goblet_01', -18.1, T1, 3.5, 0, 'cylinder', 900, 'metal'],
    ['brass_goblets', 'brass_goblet_02', -17.7, T1, 4.1, 1.3, 'cylinder', 900, 'metal'],
    ['brass_goblets', 'brass_goblet_03', -13.2, T1, 5.6, 2.2, 'cylinder', 900, 'metal'],
    ['wooden_bowl_01', undefined, -18.05, T1, 4.3, 0.4, 'cylinder', 300, 'wood'],
    ['wooden_bowl_01', undefined, -13.15, T1, 4.8, 2.4, 'cylinder', 300, 'wood'],
    ['wooden_candlestick', undefined, -17.9, T1, 2.4, 0, 'cylinder', 400, 'wood'],
    ['wooden_stool_01', undefined, -14.4, F, 3.9, 0.7, 'box', 60, 'wood'],
    // Yard.
    ['wooden_stool_01', undefined, 0.35, 0, 0.3, 0.3, 'box', 60, 'wood'],
    ['wooden_stool_01', undefined, 2.75, 0, 0.5, 1.2, 'box', 60, 'wood'],
    ['wooden_stool_01', undefined, 1.3, 0, 2.3, 2.6, 'box', 60, 'wood'],
    ['wooden_bucket_01', undefined, 2.7, 0, 1.9, 0.5, 'cylinder', 70, 'wood'],
    ['wine_barrel_01', undefined, 9.2, 0, 11.0, 0.3, 'cylinder', 260, 'wood'],
    ['wine_barrel_01', undefined, 10.1, 0, 11.2, 1.9, 'cylinder', 260, 'wood'],
    ['wooden_barrels_01', 'wooden_barrels_01_barrel02', 9.7, 0, 10.25, 3.3, 'cylinder', 260, 'wood'],
    ['wooden_crate_02', undefined, -6.2, 0, 11.2, 1.62, 'box', 110, 'wood'],
    ['wooden_crate_02', undefined, -7.5, 0, 11.3, 1.5, 'box', 110, 'wood'],
    ['wooden_crate_02', undefined, -6.8, 0.47, 11.25, 1.7, 'box', 110, 'wood'],
    // Shed.
    ['wooden_barrels_01', 'wooden_barrels_01_barrel01', 18.7, 0, -4.2, 0.9, 'cylinder', 260, 'wood'],
    ['wooden_barrels_01', 'wooden_barrels_01_barrel02', 18.75, 0, -3.3, 2.9, 'cylinder', 260, 'wood'],
    ['wooden_crate_02', undefined, 18.6, 0, 0.6, 0.02, 'box', 110, 'wood'],
    ['wooden_crate_02', undefined, 18.55, 0, 2.2, -0.05, 'box', 110, 'wood'],
    ['wooden_bucket_02', undefined, 16.4, 0, 3.2, 0.2, 'cylinder', 70, 'wood'],
    ['wicker_basket_01', undefined, 17.3, 0, -1.2, 0.8, 'box', 40, 'wood'],
  ];
  for (const [id, node, x, y, z, ry, shape, density, surface] of loose) {
    physics.addProp(put(await piece(id, node), x, y, z, ry), shape, density, surface);
  }
  type Fixed = [id: string, node: string | undefined, x: number, y: number, z: number, ry: number, surface: SurfaceKind | null, scale?: number];
  const fixed: Fixed[] = [
    ['stone_fire_pit', undefined, -15.5, F, 2.6, 0.3, 'stone'],
    ['stone_fire_pit', undefined, 1.5, 0, 1.0, 1.1, 'stone'],
    ['WoodenTable_03', undefined, -18.2, F, 6.5, Math.PI, 'wood'],
    ['wooden_lantern_01', undefined, -18.5, F + 0.83, 6.5, 0.5, null],
    ['treasure_chest', undefined, -18.7, F, -3.25, Math.PI / 2, 'wood'],
    ['spinning_wheel_01', undefined, -14.6, F, -5.9, 2.2, 'wood'],
    ['tree_stump_01', undefined, 12.6, 0, 5.6, 0.7, 'wood', 0.55],
  ];
  for (const [id, node, x, y, z, ry, surface, scale] of fixed) {
    const g = put(await piece(id, node, scale ?? 1), x, y, z, ry);
    if (surface) physics.addStaticProp(g, surface, 0.92);
  }
  // The hatchet left in the chopping block.
  const hatchet = await piece('hatchet');
  put(hatchet, 12.62, 0.3, 5.58, 0.4).rotation.set(0.2, 0.4, 1.9);

  // ---------------------------------------------------------------- the land outside
  const rnd = random(90210);
  const clear = (x: number, z: number, margin: number) =>
    !(Math.abs(x) < WARD.x + margin && Math.abs(z) < WARD.z + margin) && !(z > WARD.z - 1 && Math.abs(x - roadX(z)) < 2.4 + margin);
  const spot = (rMin: number, rMax: number, margin: number): [number, number] => {
    for (;;) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rMin * rMin + rnd() * (rMax * rMax - rMin * rMin));
      const x = Math.cos(a) * r, z = 5 + Math.sin(a) * r;
      if (clear(x, z, margin)) return [x, z];
    }
  };
  const rocks = (await assets.model('rock_moss_set_01')).scene.children.map((c) => c.name);
  for (let i = 0; i < 30; i++) {
    const [x, z] = spot(27, 88, 1.5);
    const scale = 0.3 + rnd() * rnd() * 0.9;
    const g = put(await piece('rock_moss_set_01', rocks[i % rocks.length], scale), x, heightAt(x, z) - 0.22 * scale, z, rnd() * 6.28);
    physics.addStaticProp(g, 'stone', 0.72);
  }
  for (let i = 0; i < 9; i++) {
    const [x, z] = spot(27, 75, 1.5);
    const stump = i % 3 !== 0;
    const g = put(await piece(stump ? 'tree_stump_01' : 'dead_tree_trunk', undefined, 0.8 + rnd() * 0.5), x, heightAt(x, z) - 0.04, z, rnd() * 6.28);
    physics.addStaticProp(g, 'wood', 0.8);
  }

  /** Scatters one model node many times as a single instanced draw. */
  const scatter = async (id: string, count: number, rMin: number, rMax: number, size: [number, number], shadows: boolean) => {
    const nodes = (await assets.model(id)).scene.children.filter((c) => !/LOD[1-9]/.test(c.name));
    const each = Math.ceil(count / nodes.length);
    const q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), tmp = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    for (const node of nodes) {
      const holder = node.clone(true);
      holder.position.set(0, 0, 0);
      holder.updateMatrixWorld(true);
      const matrices: THREE.Matrix4[] = [];
      for (let i = 0; i < each; i++) {
        const [x, z] = spot(rMin, rMax, 0.15);
        const k = size[0] + rnd() * (size[1] - size[0]);
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        matrices.push(new THREE.Matrix4().compose(p.set(x, heightAt(x, z) - 0.02, z), q, s.set(k, k * (0.85 + rnd() * 0.3), k)));
      }
      holder.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (!mesh.isMesh) return;
        const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, matrices.length);
        matrices.forEach((mt, i) => im.setMatrixAt(i, tmp.multiplyMatrices(mt, mesh.matrixWorld)));
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = shadows;
        im.receiveShadow = true;
        im.name = `scatter:${node.name}`;
        root.add(im);
      });
    }
  };
  await scatter('fern_02', 220, 23, 70, [0.8, 1.5], false);
  await scatter('weed_plant_02', 320, 23, 60, [1.6, 3.2], false);
  await scatter('nettle_plant', 200, 23, 55, [2.4, 4.2], false);
  await scatter('shrub_01', 12, 25, 70, [0.7, 1.3], false);
  await scatter('dry_branches_medium_01', 30, 25, 70, [0.7, 1.2], true);

  // ---------------------------------------------------------------- light
  const sun = new THREE.DirectionalLight(0xfff0dc, 0.9);
  sun.position.copy(SUN_DIR).multiplyScalar(90).add(new THREE.Vector3(0, 0, 4));
  sun.target.position.set(0, 0, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -44; sc.right = 44; sc.top = 44; sc.bottom = -44; sc.near = 10; sc.far = 170;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  root.add(sun, sun.target);

  const flames: Flame[] = [];
  const fire = (x: number, y: number, z: number, height: number, intensity: number, range: number) => {
    const f = new Flame(height, intensity, range, flames.length + 1);
    f.group.position.set(x, y, z);
    root.add(f.group);
    flames.push(f);
    return f;
  };
  fire(-15.5, F + 0.22, 2.6, 0.75, 1.6, 16);
  fire(1.5, 0.22, 1.0, 0.6, 0.8, 11);
  for (const t of torches) fire(t.p.x + t.n[0] * 0.225, t.p.y + 0.27, t.p.z + t.n[1] * 0.225, 0.3, 0.28, 9);

  // ---------------------------------------------------------------- bake
  onStatus('Measuring the light');
  await new Promise((r) => setTimeout(r, 0));
  const t0 = performance.now();
  physics.world.step();
  skyVolume.configure(new THREE.Vector3(-30, 0, -22), new THREE.Vector3(30, 9, 30), new THREE.Vector3(0.6, 0.5, 0.6));
  await bakeSkyVolume(physics, 16, (f) => onStatus(`Measuring the light ${Math.round(f * 60)}%`));
  let done = 0;
  for (const mesh of built.children) {
    await bakeVertexSky(physics, mesh as THREE.Mesh, 16);
    onStatus(`Measuring the light ${60 + Math.round((++done / built.children.length) * 30)}%`);
  }
  await bakeVertexSky(physics, ground, 12, new THREE.Box3(new THREE.Vector3(-34, -2, -26), new THREE.Vector3(34, 4, 34)));
  const bakeMs = performance.now() - t0;

  // ---------------------------------------------------------------- gameplay data
  const at = (x: number, z: number, y = 0) => new THREE.Vector3(x, y, z);
  const navPoints: Array<[number, number, number?]> = [
    [4.4, 30], [GATE_X, 17.2], [GATE_X, 10.8], [2.6, 6.2], [-1.6, 2.6], [-10.2, 2.5], [-12.7, 2.5, F], [-14.1, 0.1, F], [-15.6, 5.2, F], [-15.7, -1.7, F],
    [-15.7, -3.3, F], [-15.1, -5.0, F], [-13.3, -6.2, F], [-13.3, -8.0], [-9, -8], [0, -6.5], [11, -1], [14.3, -0.5], [11, 8], [-6, 8],
  ];
  const pairs: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [6, 8], [7, 8], [7, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15], [14, 5],
    [15, 4], [15, 16], [16, 17], [16, 3], [16, 18], [18, 2], [18, 3], [19, 3], [19, 5], [19, 2], [4, 19], [4, 14],
  ];
  const nav: NavGraph = { nodes: navPoints.map(([x, z, y]) => at(x, z, y ?? 0)), links: navPoints.map(() => []) };
  for (const [i, j] of pairs) {
    nav.links[i].push(j);
    nav.links[j].push(i);
  }

  const enemySpawns: EnemySpawn[] = [
    { position: at(GATE_X, 8), yaw: Math.PI, patrol: [at(GATE_X, 8), at(-4, 6), at(8, 4.5)] },
    { position: at(0.2, -0.7), yaw: 2.4, patrol: [] },
    { position: at(14.6, -1), yaw: -Math.PI / 2, patrol: [at(14.6, -1), at(9, -7), at(-2, -8)] },
    { position: at(-14, 4.6, F), yaw: 1.2, patrol: [] },
    { position: at(-16, -5, F), yaw: 0, patrol: [] },
  ];

  const spawnZ = 34;
  const spawnX = roadX(spawnZ);
  return {
    root,
    spawn: { position: at(spawnX, spawnZ, heightAt(spawnX, spawnZ)), yaw: 0 },
    enemySpawns,
    flames,
    sun,
    nav,
    surface: (hit) => (hit.collider.handle === groundHandle ? groundSurfaceAt(hit.point.x, hit.point.z) : hit.surface),
    zoneAt: (p) => {
      if (p.x > H.x0 && p.x < H.x1 && p.z > H.z0 && p.z < H.z1 && p.y < H.plate + H.rise) return 'hall';
      if (Math.abs(p.x - GATE_X) < 2.2 && p.z > WARD.z - WARD.thick - 0.3 && p.z < WARD.z + 0.3) return 'gate';
      if (Math.abs(p.x) < WARD.x && Math.abs(p.z) < WARD.z) return 'yard';
      return 'open';
    },
    update: (time, camera) => {
      for (const f of flames) f.update(time, camera);
    },
    bakeMs,
  };
}
