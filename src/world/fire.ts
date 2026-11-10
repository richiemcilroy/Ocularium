import * as THREE from 'three/webgpu';
import { T } from '../render/tsl';

const { float, mix, mx_fractal_noise_float, pow, smoothstep, uniform, uv, vec3, abs } = T;

const flameTime = uniform(0);

/** A procedural flame: two crossed cards that always face the viewer about the vertical, plus its light. */
export class Flame {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  private cards: THREE.Mesh;
  private base: number;
  private seed: number;
  private origin = new THREE.Vector3();

  /**
   * @param height visible flame height in metres
   * @param intensity light intensity relative to the sky (see level lighting notes)
   * @param range distance at which the light is cut off
   */
  constructor(height: number, intensity: number, range: number, seed: number) {
    this.base = intensity;
    this.seed = seed;
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    const p = uv();
    const x = p.x.sub(0.5).mul(2);
    const y = p.y;
    const t = flameTime.add(seed * 7.3);
    const n = mx_fractal_noise_float(vec3(p.x.mul(3.1), y.mul(2.4).sub(t.mul(2.1)), t.mul(0.5).add(seed)), 3, 2, 0.5);
    const lick = mx_fractal_noise_float(vec3(p.x.mul(7), y.mul(5).sub(t.mul(3.4)), t.add(seed * 3)), 2, 2, 0.5);
    const width = pow(float(1).sub(y), 0.75).mul(0.62);
    const offset = x.add(n.mul(0.34).mul(y.add(0.15)));
    const body = float(1).sub(smoothstep(width.mul(0.35), width, abs(offset)));
    const top = float(1).sub(smoothstep(float(0.5).add(n.mul(0.3)), float(0.98), y));
    const shape = body.mul(top).mul(smoothstep(0.0, 0.07, y)).mul(float(0.75).add(lick.mul(0.5))).clamp(0, 1);
    const heat = shape.mul(float(1.15).sub(y.mul(0.8))).clamp(0, 1);
    const color = mix(vec3(1.0, 0.16, 0.01), vec3(1.0, 0.62, 0.16), smoothstep(0.15, 0.7, heat));
    // Far brighter than anything else in frame, so the sensor clips it to a white-yellow core.
    m.colorNode = mix(color, vec3(1.0, 0.92, 0.7), smoothstep(0.7, 1.0, heat)).mul(pow(heat, 1.6)).mul(26);
    m.opacityNode = shape;

    const g = new THREE.PlaneGeometry(height * 0.55, height);
    g.translate(0, height / 2, 0);
    this.cards = new THREE.Mesh(g, m);
    this.cards.renderOrder = 5;
    this.cards.castShadow = false;
    this.group.add(this.cards);

    this.light = new THREE.PointLight(0xff8f3a, intensity, range, 2);
    this.light.position.set(0, height * 0.45, 0);
    this.group.add(this.light);
  }

  update(time: number, camera: THREE.Camera): void {
    flameTime.value = time;
    this.group.getWorldPosition(this.origin);
    this.cards.rotation.y = Math.atan2(camera.position.x - this.origin.x, camera.position.z - this.origin.z);
    // Flicker: slow breathing plus fast flutter, never periodic-looking.
    const s = this.seed * 31.7;
    const f = 1 + 0.16 * Math.sin(time * 9.1 + s) * Math.sin(time * 5.3 + s * 1.7) + 0.1 * Math.sin(time * 23.7 + s * 0.3) + 0.06 * Math.sin(time * 41.3 + s);
    this.light.intensity = this.base * f;
    this.light.position.x = 0.02 * Math.sin(time * 13.1 + s);
    this.light.position.z = 0.02 * Math.cos(time * 11.7 + s);
  }
}
