import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { litMaterial } from '../render/materials';

const BASE = `${import.meta.env.BASE_URL}assets/`;

export interface SurfaceMaps {
  diff: THREE.Texture;
  nor: THREE.Texture;
  arm: THREE.Texture | null;
  disp: THREE.Texture | null;
}

/**
 * Central loader. Everything is cached by id so the same scan is only ever
 * decoded and uploaded once.
 */
export class Assets {
  private ktx2: KTX2Loader;
  private gltf: GLTFLoader;
  private hdr = new HDRLoader();
  private texCache = new Map<string, Promise<THREE.Texture>>();
  private modelCache = new Map<string, Promise<GLTF>>();
  private maxAniso: number;
  loaded = 0;
  total = 0;
  onProgress: ((loaded: number, total: number) => void) | null = null;

  constructor(renderer: THREE.WebGPURenderer) {
    this.ktx2 = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).detectSupport(renderer);
    this.gltf = new GLTFLoader().setKTX2Loader(this.ktx2);
    this.maxAniso = Math.min(8, renderer.getMaxAnisotropy());
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.total++;
    this.onProgress?.(this.loaded, this.total);
    return p.finally(() => {
      this.loaded++;
      this.onProgress?.(this.loaded, this.total);
    });
  }

  private texture(path: string, srgb: boolean): Promise<THREE.Texture> {
    let p = this.texCache.get(path);
    if (!p) {
      p = this.track(
        this.ktx2.loadAsync(BASE + path).then((t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.anisotropy = this.maxAniso;
          return t;
        }),
      );
      this.texCache.set(path, p);
    }
    return p;
  }

  async surfaceMaps(id: string, height = false): Promise<SurfaceMaps> {
    const [diff, nor, arm, disp] = await Promise.all([
      this.texture(`tex/${id}/diff.ktx2`, true),
      this.texture(`tex/${id}/nor.ktx2`, false),
      this.texture(`tex/${id}/arm.ktx2`, false).catch(() => null),
      height ? this.texture(`tex/${id}/disp.ktx2`, false).catch(() => null) : Promise.resolve(null),
    ]);
    return { diff, nor, arm, disp };
  }

  model(id: string): Promise<GLTF> {
    let p = this.modelCache.get(id);
    if (!p) {
      p = this.track(
        this.gltf.loadAsync(id.includes('/') ? `${BASE}${id}.glb` : `${BASE}models/${id}.glb`).then((g) => {
          const lits = new Map<THREE.Material, THREE.MeshStandardNodeMaterial>();
          g.scene.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            const converted = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((mat) => {
              let lit = lits.get(mat);
              if (!lit) lits.set(mat, (lit = litMaterial(mat)));
              return lit;
            });
            mesh.material = converted.length === 1 ? converted[0] : converted;
            for (const std of converted) {
              for (const t of [std.map, std.normalMap, std.roughnessMap, std.metalnessMap, std.aoMap]) if (t) t.anisotropy = this.maxAniso;
              // Foliage scans are alpha-tested cards; real glass stays blended.
              if ((std.alphaTest > 0 || std.transparent) && !std.name.includes('glass')) {
                std.alphaTest = Math.max(std.alphaTest, 0.4);
                std.transparent = false;
                std.side = THREE.DoubleSide;
              }
            }
          });
          return g;
        }),
      );
      this.modelCache.set(id, p);
    }
    return p;
  }

  /** Returns a fresh instance of a model (or of one named node inside it), sharing geometry and materials. */
  async instance(id: string, nodeName?: string): Promise<THREE.Object3D> {
    const g = await this.model(id);
    const src = nodeName ? g.scene.getObjectByName(nodeName) : g.scene;
    if (!src) throw new Error(`node ${nodeName} not found in ${id}`);
    return src.clone(true);
  }

  sky(id: string): Promise<THREE.DataTexture> {
    return this.track(
      this.hdr.loadAsync(`${BASE}sky/${id}.hdr`).then((t) => {
        t.mapping = THREE.EquirectangularReflectionMapping;
        return t;
      }),
    );
  }
}
