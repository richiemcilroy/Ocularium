import * as THREE from 'three/webgpu';

export interface Foot {
  /** Where the sole meets (or will meet) the ground. */
  position: THREE.Vector3;
  /** Heading of the foot. */
  yaw: number;
  /** Height of the sole above its ground while swinging. */
  lift: number;
  /** Toe-down (positive) or toe-up tilt during the swing. */
  pitch: number;
  planted: boolean;
}

interface Step {
  from: THREE.Vector3;
  fromYaw: number;
  t: number;
  duration: number;
  height: number;
}

const HALF_STANCE = 0.095;
/** How far the hips travel over a planted foot at a walk: what a leg can cover from heel strike to toe-off. */
const TRAVEL = 0.8;
/** The share of that travel for which the foot is ahead of the hip. */
const AHEAD = 0.32;

/** Length of one step at a given speed. A walk lengthens gently; past a jog the strides open out. */
export function stepLength(speed: number, crouch = 0): number {
  return 0.52 + 0.15 * Math.min(speed, 2.3) + 0.27 * Math.max(0, speed - 2.3) - 0.12 * crouch;
}
const v = new THREE.Vector3();
const home = new THREE.Vector3();

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Where the feet go. A foot stays exactly where it was put down until it is
 * time to pick it up; then it swings to where the body will need it next. No
 * sliding, at any speed or direction, and it works on stairs and slopes.
 */
export class Gait {
  readonly feet: [Foot, Foot] = [this.make(), this.make()];
  private steps: [Step | null, Step | null] = [null, null];
  private phase = 0;
  private started = false;
  /** Called when a foot comes down: 0 left, 1 right. */
  onStep: ((foot: number, position: THREE.Vector3, speed: number) => void) | null = null;
  /** How far the pelvis should sink and shift this frame. */
  readonly sway = new THREE.Vector3();

  constructor(private ground: (x: number, z: number, near: number) => number) {}

  private make(): Foot {
    return { position: new THREE.Vector3(), yaw: 0, lift: 0, pitch: 0, planted: true };
  }

  /** Puts both feet under the body at once. */
  place(root: THREE.Vector3, yaw: number): void {
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      this.homeOf(i, root, yaw, f.position);
      f.yaw = yaw;
      f.lift = f.pitch = 0;
      f.planted = true;
      this.steps[i] = null;
    }
    this.started = true;
  }

  private homeOf(i: number, root: THREE.Vector3, yaw: number, out: THREE.Vector3): THREE.Vector3 {
    const side = i === 0 ? -1 : 1;
    out.set(root.x + Math.cos(yaw) * HALF_STANCE * side, 0, root.z - Math.sin(yaw) * HALF_STANCE * side);
    out.y = this.ground(out.x, out.z, root.y);
    return out;
  }

  private lift(i: number, duration: number, height: number): void {
    const f = this.feet[i];
    this.steps[i] = { from: f.position.clone(), fromYaw: f.yaw, t: 0, duration, height };
    f.planted = false;
  }

  /**
   * @param root feet-level position of the body
   * @param yaw heading of the hips
   * @param velocity horizontal velocity of the body
   * @param grounded false while jumping or falling: the feet simply hang
   * @param pace where in the pair of steps the walker is, 0..1 with the left foot coming down at 0 and the
   *   right at one half, if something else (the camera's own bob, footfall sounds) is already keeping time
   */
  update(dt: number, root: THREE.Vector3, yaw: number, velocity: THREE.Vector3, grounded: boolean, pace?: number, crouch = 0): void {
    if (!this.started) this.place(root, yaw);
    const speed = Math.hypot(velocity.x, velocity.z);
    const moving = speed > 0.3;
    // Two steps to the cycle. A foot stays down only as long as the leg can cover the ground going by,
    // so past a brisk walk there is a moment with both feet in the air: a run.
    const step = stepLength(speed, crouch);
    const cycle = (2 * step) / Math.max(speed, 0.3);
    const travel = TRAVEL + 0.03 * Math.max(0, speed - 2.3);
    const duty = THREE.MathUtils.clamp(travel / (2 * step), 0.26, 0.62);
    const swing = cycle * (1 - duty);

    if (!grounded) {
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        this.homeOf(i, root, yaw, home);
        f.position.set(home.x, root.y, home.z);
        f.yaw = yaw;
        f.lift = 0;
        f.pitch = 0.35;
        f.planted = false;
        this.steps[i] = null;
      }
      this.sway.set(0, 0, 0);
      return;
    }

    if (moving) {
      const before = this.phase;
      this.phase = pace === undefined ? (this.phase + dt / cycle) % 1 : (pace + 1 - duty) % 1;
      // Left foot leaves the ground at phase 0, right at one half. A clock that slips back a little has crossed nothing.
      const forwards = (this.phase - before + 1) % 1 < 0.5;
      for (let i = 0; i < 2; i++) {
        const start = i * 0.5;
        const crossed = forwards && (before <= this.phase ? before <= start && this.phase > start : before <= start || this.phase > start);
        if ((crossed || (i === 0 && before === 0 && pace === undefined)) && !this.steps[i]) this.lift(i, swing, 0.05 + 0.035 * Math.min(1, speed / 4) + 0.1 * THREE.MathUtils.clamp((speed - 2.3) / 2.6, 0, 1));
      }
    } else {
      // Standing: shuffle a foot back under the hip only when it has been left behind or the body has turned.
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        if (this.steps[i] || this.steps[1 - i]) continue;
        this.homeOf(i, root, yaw, home);
        const off = Math.hypot(home.x - f.position.x, home.z - f.position.z);
        if (off > 0.17 || Math.abs(wrap(yaw - f.yaw)) > 0.6 || Math.abs(home.y - f.position.y) > 0.12) {
          this.lift(i, 0.26, 0.04);
          break;
        }
      }
    }

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const s = this.steps[i];
      if (!s) {
        // A foot fallen through lost ground (a kicked-away prop) or left too far behind at a sudden stop is picked up at once.
        this.homeOf(i, root, yaw, home);
        if (Math.hypot(home.x - f.position.x, home.z - f.position.z) > travel * (1 - AHEAD) + 0.12) this.lift(i, Math.min(swing, 0.2), 0.05);
        f.lift = 0;
        f.pitch = 0;
        continue;
      }
      s.t += dt;
      const u = Math.min(1, s.t / s.duration);
      // Land ahead of where the hip will be, by the smaller share of the ground it will then pass over.
      this.homeOf(i, root, yaw, home);
      const remaining = (1 - u) * s.duration;
      const lead = moving ? remaining + cycle * duty * AHEAD : 0;
      v.set(home.x + velocity.x * lead, 0, home.z + velocity.z * lead);
      v.y = this.ground(v.x, v.z, root.y);
      const e = u * u * (3 - 2 * u);
      f.position.lerpVectors(s.from, v, e);
      f.yaw = s.fromYaw + wrap(yaw - s.fromYaw) * e;
      f.lift = Math.sin(Math.PI * u) * s.height + Math.max(0, v.y - s.from.y) * Math.sin(Math.PI * u) * 0.5;
      // Toes trail as the foot leaves and lead as it comes down heel first.
      f.pitch = moving ? Math.sin(Math.PI * 2 * u) * (0.25 + 0.3 * Math.min(1, speed / 4)) * (u < 0.5 ? 1 : 0.5) : 0;
      if (u >= 1) {
        this.steps[i] = null;
        f.planted = true;
        f.lift = 0;
        f.pitch = 0;
        this.onStep?.(i, f.position, speed);
      }
    }

    // The pelvis drops as the legs spread and rides towards the foot that carries it.
    const bob = moving ? -Math.abs(Math.sin(this.phase * Math.PI * 2)) * (0.012 + 0.018 * Math.min(1, speed / 4)) : 0;
    const carry = moving ? Math.sin(this.phase * Math.PI * 2) * 0.012 : 0;
    this.sway.set(carry, bob, 0);
  }
}
