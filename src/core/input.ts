/** Keyboard and mouse state with pointer lock. Mouse deltas accumulate until consumed. */
export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  locked = false;
  /** Mouse sensitivity in radians per pixel. */
  sensitivity = 0.0016;

  constructor(private element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (this.locked && ['Tab', 'Space', 'AltLeft', 'KeyQ', 'KeyE'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());
    element.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      const code = `Mouse${e.button}`;
      this.keys.add(code);
      this.pressed.add(code);
    });
    window.addEventListener('mouseup', (e) => {
      const code = `Mouse${e.button}`;
      this.keys.delete(code);
      this.released.add(code);
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (this.locked) this.wheel += Math.sign(e.deltaY);
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
      if (!this.locked) this.keys.clear();
      this.onLockChange?.(this.locked);
    });
  }

  onLockChange: ((locked: boolean) => void) | null = null;

  requestLock(): void {
    // Raw input bypasses OS acceleration where the browser supports it.
    const p = (this.element as any).requestPointerLock({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') p.catch(() => this.element.requestPointerLock());
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** True only on the frame the key or button went down. */
  hit(code: string): boolean {
    return this.pressed.has(code);
  }

  up(code: string): boolean {
    return this.released.has(code);
  }

  /** -1, 0 or 1 from a pair of keys. */
  axis(negative: string, positive: string): number {
    return (this.down(positive) ? 1 : 0) - (this.down(negative) ? 1 : 0);
  }

  /** Returns accumulated mouse movement in radians (yaw, pitch) and clears it. */
  consumeLook(): { x: number; y: number } {
    const out = { x: this.dx * this.sensitivity, y: this.dy * this.sensitivity };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Call at the end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
  }

  /** Test hook: feed synthetic input without pointer lock. */
  inject(opts: { keysDown?: string[]; keysUp?: string[]; look?: [number, number] }): void {
    for (const k of opts.keysDown ?? []) {
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
    }
    for (const k of opts.keysUp ?? []) {
      this.keys.delete(k);
      this.released.add(k);
    }
    if (opts.look) {
      this.dx += opts.look[0];
      this.dy += opts.look[1];
    }
  }
}
