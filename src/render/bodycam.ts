import * as THREE from 'three/webgpu';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { T } from './tsl';

const { Fn, clamp, dot, exp, float, floor, fract, length, log2, max, mix, mrt, normalView, output, pass, sRGBTransferOETF, sin, smoothstep, tan, uniform, uv, vec2, vec3, vec4 } = T;

type Node = any;

export interface BodycamOptions {
  /** Diagonal field of view of the fisheye image, in degrees. */
  diagonalFov: number;
  /** Internal scene resolution relative to the canvas. */
  renderScale: number;
  ao: boolean;
  /** Set false to bypass the lens entirely (debug views). */
  lens: boolean;
}

const BLUR_TAPS = 5;

/**
 * Renders the scene the way a chest-worn camera records it: a wide fisheye
 * projection with lateral chromatic aberration, shutter motion blur, a small
 * sensor's noise that rises with gain, slow auto exposure, a hard-clipping
 * tone curve and block compression in the shadows.
 *
 * The scene itself is rendered rectilinear and wider than the final image; the
 * lens pass resamples it into the fisheye projection.
 */
export class BodycamPipeline {
  readonly pipeline: THREE.RenderPipeline;
  readonly options: BodycamOptions;

  // Lens uniforms
  private aspect = uniform(16 / 9);
  private k = uniform(0.5); // radians of view angle per unit of image radius
  private tanPhi = uniform(1); // tan of the rectilinear half vertical FOV
  private resolution = uniform(new THREE.Vector2(1920, 1080));
  private frameSeed = uniform(0);

  /** Lateral chromatic aberration strength at the image edge. */
  readonly chroma = uniform(0.003);
  /** Per-frame camera motion in source UV units (x, y) and roll in radians. */
  readonly blur = uniform(new THREE.Vector3());
  /** Linear exposure multiplier, driven by the auto exposure loop. */
  readonly exposure = uniform(1);
  /** Sensor noise amplitude (display space). Rises with gain. */
  readonly noise = uniform(0.035);
  readonly vignette = uniform(0.55);
  readonly blockiness = uniform(0.5);
  readonly saturation = uniform(0.82);
  /** 0..1 damage flash / blackout used when the wearer is hit. */
  readonly blackout = uniform(0);
  readonly aoStrength = uniform(1);

  // Auto exposure state
  private meterTarget: THREE.RenderTarget;
  private meterQuad: THREE.QuadMesh;
  private meterPending = false;
  private meterFrame = 0;
  private measuredLog = -1.2;
  private exposureLog = 0.6;
  /** Target scene brightness after exposure (log2 of mid grey). */
  autoExposureKey = -2.35;
  autoExposureMin = -2.2;
  autoExposureMax = 4.6;

  private scenePass: Node;

  constructor(
    private renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    options: Partial<BodycamOptions> = {},
  ) {
    this.options = { diagonalFov: 122, renderScale: 1, ao: true, lens: true, ...options };

    const scenePass = pass(scene, camera, { samples: 0 });
    scenePass.setResolutionScale(this.options.renderScale);
    this.scenePass = scenePass;
    if (this.options.ao) scenePass.setMRT(mrt({ output, normal: normalView }));

    const sceneColor = scenePass.getTextureNode('output');
    let aoTexture: Node = null;
    if (this.options.ao) {
      const aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera);
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = 0.55;
      aoPass.thickness.value = 1.2;
      aoPass.distanceFallOff.value = 1;
      aoPass.samples.value = 8;
      aoTexture = aoPass.getTextureNode();
    }

    // Occluded scene colour, before the lens.
    const shaded = (uvNode: Node): Node => {
      const c = sceneColor.sample(uvNode).rgb;
      if (!aoTexture) return c;
      const occlusion = mix(float(1), aoTexture.sample(uvNode).r, this.aoStrength);
      return c.mul(occlusion);
    };

    const rand = Fn(([p]: [Node]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)));

    const lens = Fn(() => {
      const centered = uv().sub(0.5).mul(vec2(this.aspect.mul(2), 2));
      const r = length(centered);
      const dir = centered.div(max(r, 1e-5));

      // Equidistant fisheye -> rectilinear source radius, per colour channel.
      const theta = r.mul(this.k);
      const rs = tan(theta).div(this.tanPhi);
      const edge = r.mul(r);
      const toUv = (radius: Node) => dir.mul(radius).div(vec2(this.aspect.mul(2), 2)).add(0.5);
      const uvR = toUv(rs.mul(float(1).add(this.chroma.mul(edge))));
      const uvG = toUv(rs);
      const uvB = toUv(rs.mul(float(1).sub(this.chroma.mul(edge))));

      // Shutter blur: translation from yaw/pitch plus rotation about the optical axis from roll.
      const rollVec = vec2(uvG.y.sub(0.5).negate().div(this.aspect), uvG.x.sub(0.5).mul(this.aspect)).mul(this.blur.z);
      const blurVec = this.blur.xy.add(rollVec);

      const acc = vec3(0).toVar();
      for (let i = 0; i < BLUR_TAPS; i++) {
        const t = i / (BLUR_TAPS - 1) - 0.5;
        const o = blurVec.mul(t);
        acc.addAssign(vec3(shaded(uvR.add(o)).r, shaded(uvG.add(o)).g, shaded(uvB.add(o)).b));
      }
      const color = acc.div(BLUR_TAPS).toVar();

      // Outside the rendered source there is nothing to record.
      const inside = smoothstep(0.0, 0.004, uvG.x)
        .mul(smoothstep(0.0, 0.004, uvG.y))
        .mul(smoothstep(0.0, 0.004, float(1).sub(uvG.x)))
        .mul(smoothstep(0.0, 0.004, float(1).sub(uvG.y)));
      color.mulAssign(inside);

      // Exposure, then a short-latitude sensor response: soft knee, hard clip.
      color.mulAssign(this.exposure);
      const mapped = float(1).sub(exp(color.mul(-1.55))).mul(1.06);
      color.assign(clamp(mapped, 0, 1));

      // Cheap sensors lose colour, most of all in the highlights.
      const luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color.assign(mix(vec3(luma), color, this.saturation.mul(float(1).sub(smoothstep(0.75, 1.0, luma).mul(0.6)))));

      // Slight cool cast and lifted contrast of an uncorrected sensor.
      color.assign(color.mul(vec3(0.985, 1.0, 1.02)));
      color.assign(mix(color, smoothstep(0.0, 1.0, color), 0.35));

      // Block compression: shadows collapse into flat 8px macroblocks.
      const px = uv().mul(this.resolution);
      const blockPx = floor(px.div(8));
      const blockNoise = rand(blockPx.add(this.frameSeed.mul(0.37)));
      const darkness = float(1).sub(smoothstep(0.02, 0.32, luma));
      const blockShift = blockNoise.sub(0.5).mul(0.035).mul(darkness).mul(this.blockiness);
      color.addAssign(blockShift);

      // Sensor noise: fine luma grain plus coarser chroma blotches, both moving every frame.
      const grainPx = floor(px.div(1.5));
      const n1 = rand(grainPx.add(this.frameSeed)).sub(0.5);
      const chromaPx = floor(px.div(3));
      const n2 = rand(chromaPx.add(this.frameSeed.mul(1.7).add(11.3))).sub(0.5);
      const n3 = rand(chromaPx.add(this.frameSeed.mul(2.3).add(47.1))).sub(0.5);
      const shadowWeight = mix(float(1.35), float(0.45), smoothstep(0.0, 0.8, luma));
      color.addAssign(vec3(n1).add(vec3(n2, n2.add(n3).mul(-0.5), n3).mul(0.55)).mul(this.noise).mul(shadowWeight));

      // Lens falloff.
      const rc = length(vec2(this.aspect, 1));
      const falloff = smoothstep(1.02, 0.42, r.div(rc));
      color.mulAssign(mix(float(1), falloff, this.vignette));

      color.mulAssign(float(1).sub(this.blackout));
      return vec4(sRGBTransferOETF(clamp(color, 0, 1)), 1);
    });

    const plain = Fn(() => {
      const c = shaded(uv()).mul(this.exposure);
      return vec4(sRGBTransferOETF(clamp(float(1).sub(exp(c.mul(-1.55))).mul(1.06), 0, 1)), 1);
    });

    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = this.options.lens ? lens() : plain();

    // Metering: a tiny log-luminance image of the unexposed scene, read back asynchronously.
    this.meterTarget = new THREE.RenderTarget(32, 18, { depthBuffer: false, type: THREE.UnsignedByteType });
    const meterMaterial = new THREE.MeshBasicNodeMaterial();
    const lum = dot(shaded(uv()), vec3(0.2126, 0.7152, 0.0722));
    meterMaterial.colorNode = vec4(vec3(clamp(log2(max(lum, 1e-5)).add(12).div(16), 0, 1)), 1);
    this.meterQuad = new THREE.QuadMesh(meterMaterial);

    this.resize();
  }

  /** Call when the canvas size or the lens field of view changes. */
  resize(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const aspect = size.x / Math.max(1, size.y);
    this.aspect.value = aspect;
    this.resolution.value.copy(size);

    if (this.options.lens) {
      const thetaCorner = THREE.MathUtils.degToRad(this.options.diagonalFov / 2);
      const rc = Math.hypot(aspect, 1);
      this.k.value = thetaCorner / rc;
      // The source must reach the fisheye's corners.
      const tanPhi = Math.tan(thetaCorner) / rc;
      this.tanPhi.value = tanPhi;
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanPhi));
    }
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Half-angles (radians) of the final image, for aiming and culling logic. */
  get imageHalfFov(): { h: number; v: number } {
    return { h: this.k.value * this.aspect.value, v: this.k.value };
  }

  /**
   * @param dt seconds since the last frame
   * @param motion camera angular velocity in rad/s about its local axes (pitch, yaw, roll)
   */
  render(dt: number, motion: THREE.Vector3): void {
    this.frameSeed.value = (this.frameSeed.value + 1.618) % 289;

    // 1/60 s exposure at up to 60 fps: blur length follows actual rotation during the shutter.
    const shutter = Math.min(dt, 1 / 30) * 0.9;
    const tanPhi = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // Small-angle: rotating by a radians shifts the image centre by a / tanPhi of the half height.
    const toUvY = 1 / (2 * tanPhi);
    const toUvX = toUvY / this.aspect.value;
    this.blur.value.set(-motion.y * shutter * toUvX, motion.x * shutter * toUvY, motion.z * shutter);

    this.pipeline.render();
    this.updateExposure(dt);
  }

  private updateExposure(dt: number): void {
    // Meter every 4th frame; the readback takes a frame or two to arrive.
    if (!this.meterPending && this.meterFrame++ % 4 === 0) {
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.meterTarget);
      this.meterQuad.render(this.renderer);
      this.renderer.setRenderTarget(prev);
      this.meterPending = true;
      this.renderer
        .readRenderTargetPixelsAsync(this.meterTarget, 0, 0, 32, 18)
        .then((buf) => {
          const data = buf as Uint8Array;
          let sum = 0;
          let wsum = 0;
          for (let y = 0; y < 18; y++) {
            for (let x = 0; x < 32; x++) {
              // Centre-weighted, as on a real metering sensor.
              const dx = (x - 15.5) / 16;
              const dy = (y - 8.5) / 9;
              const w = 1 / (1 + 2.2 * (dx * dx + dy * dy));
              sum += ((data[(y * 32 + x) * 4] / 255) * 16 - 12) * w;
              wsum += w;
            }
          }
          this.measuredLog = sum / wsum;
        })
        .catch(() => {})
        .finally(() => {
          this.meterPending = false;
        });
    }

    // The camera closes down quickly when blinded and opens up slowly in the dark.
    const target = THREE.MathUtils.clamp(this.autoExposureKey - this.measuredLog, this.autoExposureMin, this.autoExposureMax);
    const rate = target < this.exposureLog ? 3.2 : 1.1;
    this.exposureLog += (target - this.exposureLog) * (1 - Math.exp(-rate * dt));
    this.exposure.value = 2 ** this.exposureLog;

    // Gain brings noise with it.
    const gain = THREE.MathUtils.clamp((this.exposureLog - 0.5) / 4, 0, 1);
    this.noise.value = 0.02 + 0.07 * gain * gain;
  }

  /** Current exposure in stops, for debugging. */
  get exposureStops(): number {
    return this.exposureLog;
  }
}
