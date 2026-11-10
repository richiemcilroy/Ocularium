import type { Builder } from './builder';

/**
 * Timber buildings inside the ward, assembled from the pieces a carpenter
 * would use: stone plinth, sill beam, posts, rails, wall plate, wattle-and-daub
 * panels, rafters and thatch.
 */

export interface Opening {
  /** Extent along the wall. */
  a: number;
  b: number;
  /** Height range of the hole above the building's floor datum. */
  y0: number;
  y1: number;
}

export interface FrameWall {
  /** World axis the wall runs along. */
  axis: 'x' | 'z';
  /** Position of the wall's centre line on the other axis. */
  at: number;
  from: number;
  to: number;
  /** Top of the wall plate. */
  top: number;
  /** Height of the stone plinth; 0 for an internal partition. */
  plinth?: number;
  /** Material key of the panels between the posts. */
  infill?: string;
  infillThick?: number;
  openings?: Opening[];
  /** Largest gap between posts. */
  spacing?: number;
  /** Emit the end posts (corner posts are shared, so only one wall of each pair should). */
  ends?: [boolean, boolean];
}

const POST = 0.2;

export function frameWall(b: Builder, w: FrameWall): void {
  const plinth = w.plinth ?? 0.45;
  const infill = w.infill ?? 'daub';
  const thick = w.infillThick ?? 0.12;
  // Plank scans run along U, so boards stand upright when V follows the wall.
  const infillGrain: 'x' | 'y' | 'z' = infill === 'boards' ? w.axis : 'y';
  const openings = [...(w.openings ?? [])].sort((p, q) => p.a - q.a);
  const P = (along: number, y: number): [number, number, number] => (w.axis === 'x' ? [along, y, w.at] : [w.at, y, along]);
  const S = (len: number, h: number, t: number): [number, number, number] => (w.axis === 'x' ? [len, h, t] : [t, h, len]);
  const span = (material: string, a: number, c: number, y0: number, y1: number, t: number, grain: 'x' | 'y' | 'z', collide = true) => {
    if (c - a < 0.02 || y1 - y0 < 0.02) return;
    b.box(material, P((a + c) / 2, (y0 + y1) / 2), S(c - a, y1 - y0, t), { grain, collide });
  };

  // Runs of wall between doorways (anything that reaches the floor).
  const doors = openings.filter((o) => o.y0 <= plinth + 0.01);
  const runs: Array<[number, number]> = [];
  let cursor = w.from;
  for (const d of doors) {
    runs.push([cursor, d.a - POST]);
    cursor = d.b + POST;
  }
  runs.push([cursor, w.to]);

  const sillTop = plinth + POST;
  const plateBottom = w.top - POST;
  const ends = w.ends ?? [false, false];
  // At a corner the wall that owns the post runs through; the other butts against it.
  const reach = (atEnd: boolean, owner: boolean, by: number) => (atEnd ? (owner ? by : -by) : 0);
  for (const [a, c] of runs) {
    const s0 = a === w.from, s1 = c === w.to;
    if (plinth > 0) span('plinth', a - reach(s0, ends[0], 0.17), c + reach(s1, ends[1], 0.17), -0.3, plinth, 0.34, 'y');
    span('beam', a - reach(s0, ends[0], POST / 2), c + reach(s1, ends[1], POST / 2), plinth, sillTop, POST, w.axis);
  }
  span('beam', w.from - reach(true, ends[0], POST / 2), w.to + reach(true, ends[1], POST / 2), plateBottom, w.top, POST, w.axis);

  // Post positions: ends, either side of every opening, then filled in to the spacing.
  const fixed: number[] = [w.from, w.to];
  for (const o of openings) fixed.push(o.a - POST / 2, o.b + POST / 2);
  fixed.sort((p, q) => p - q);
  const posts: number[] = [];
  for (let i = 0; i + 1 < fixed.length; i++) {
    const a = fixed[i], c = fixed[i + 1];
    posts.push(a);
    const within = openings.some((o) => a >= o.a - POST && c <= o.b + POST);
    if (within) continue;
    const n = Math.ceil((c - a) / (w.spacing ?? 1.3));
    for (let k = 1; k < n; k++) posts.push(a + ((c - a) * k) / n);
  }
  posts.push(w.to);

  posts.forEach((p, i) => {
    if ((i === 0 && !ends[0]) || (i === posts.length - 1 && !ends[1])) return;
    const door = doors.some((o) => Math.abs(p - (o.a - POST / 2)) < 0.01 || Math.abs(p - (o.b + POST / 2)) < 0.01);
    // Door posts stand on the ground, not the sill.
    b.box('beam', P(p, ((door ? 0 : sillTop) + plateBottom) / 2), S(POST, plateBottom - (door ? 0 : sillTop), POST), { grain: 'y' });
  });

  // Panels and rails between each pair of posts.
  const rail = 2.12;
  for (let i = 0; i + 1 < posts.length; i++) {
    const a = posts[i] + POST / 2, c = posts[i + 1] - POST / 2;
    const o = openings.find((q) => a >= q.a - 0.02 && c <= q.b + 0.02);
    if (!o) {
      span(infill, a, c, sillTop, plateBottom, thick, infillGrain);
      span('beam', a, c, rail - 0.07, rail + 0.07, POST - 0.04, w.axis, false);
      continue;
    }
    const head = Math.max(o.y1, sillTop);
    span('beam', a, c, head, head + 0.14, POST - 0.02, w.axis);
    span(infill, a, c, head + 0.14, plateBottom, thick, infillGrain);
    if (o.y0 > sillTop) {
      span('beam', a, c, o.y0 - 0.12, o.y0, POST - 0.02, w.axis);
      span(infill, a, c, sillTop, o.y0 - 0.12, thick, infillGrain);
      // Unglazed window: square bars set on the diagonal.
      const bars = Math.max(2, Math.round((c - a) / 0.2) - 1);
      for (let k = 1; k <= bars; k++) {
        b.box('beam', P(a + ((c - a) * k) / (bars + 1), (o.y0 + head) / 2), [0.045, head - o.y0, 0.045], { rot: [0, Math.PI / 4, 0], grain: 'y', collide: false });
      }
    }
  }
}

export interface RoofSpec {
  /** Building footprint (wall centre lines). */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Top of the wall plates. */
  plate: number;
  /** Rise of the ridge above the plates. */
  rise: number;
  eaves: number;
  verge: number;
  thick: number;
}

/** A gabled roof with its ridge along Z: tie beams, king posts, rafters and a thatch coat. */
export function gableRoof(b: Builder, r: RoofSpec): void {
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const half = (r.x1 - r.x0) / 2;
  const pitch = Math.atan2(r.rise, half);
  const cos = Math.cos(pitch), sin = Math.sin(pitch);
  const ridgeY = r.plate + r.rise;
  const length = r.z1 - r.z0 + r.verge * 2;
  const run = half + r.eaves;
  const slope = run / cos;

  for (const side of [-1, 1]) {
    // Midpoint of the slope, lifted so the underside rests on the rafters.
    const mx = cx + (side * run) / 2, my = ridgeY - (run / 2) * (sin / cos);
    // The coat runs a little past the ridge so the two sides lock together.
    const over = 0.3;
    const ox = mx - side * cos * (over / 2) + side * sin * (r.thick / 2 + 0.12);
    const oy = my + sin * (over / 2) + cos * (r.thick / 2 + 0.12);
    b.box('thatch', [ox, oy, cz], [slope + over, r.thick, length], { rot: [0, 0, -side * pitch], grain: 'x', surface: 'thatch' });
    const rafterLen = (half + 0.25) / cos;
    const rx = cx + (side * (half + 0.25)) / 2, ry = ridgeY - ((half + 0.25) / 2) * (sin / cos);
    for (let z = r.z0; z <= r.z1 + 0.01; z += (r.z1 - r.z0) / Math.round((r.z1 - r.z0) / 1.4)) {
      b.box('beam', [rx + side * sin * 0.06, ry + cos * 0.06, z], [rafterLen, 0.12, 0.1], { rot: [0, 0, -side * pitch], grain: 'x', collide: false });
    }
    // Purlin halfway up.
    b.box('beam', [cx + side * half * 0.5, ridgeY - half * 0.5 * (sin / cos) - 0.07, cz], [0.14, 0.14, r.z1 - r.z0], { rot: [0, 0, -side * pitch], grain: 'z', collide: false });
  }
  // Ridge: a capping roll of thatch outside, the ridge piece inside.
  b.box('thatch', [cx, ridgeY + r.thick + 0.12, cz], [0.9, 0.36, length], { grain: 'x', surface: 'thatch' });
  b.box('beam', [cx, ridgeY - 0.09, cz], [0.14, 0.18, r.z1 - r.z0], { grain: 'z', collide: false });

  const bays = Math.round((r.z1 - r.z0) / 3.5);
  for (let i = 1; i < bays; i++) {
    const z = r.z0 + ((r.z1 - r.z0) * i) / bays;
    b.box('beam', [cx, r.plate + 0.11, z], [r.x1 - r.x0, 0.22, 0.2], { grain: 'x', collide: false });
    b.box('beam', [cx, r.plate + 0.22 + (r.rise - 0.4) / 2, z], [0.18, r.rise - 0.4, 0.18], { grain: 'y', collide: false });
    for (const side of [-1, 1]) {
      // Struts from the foot of the king post up to the rafters.
      const ax = 0, ay = r.plate + 0.4;
      const bx = side * half * 0.5, by = ridgeY - half * 0.5 * (sin / cos) - 0.1;
      const len = Math.hypot(bx - ax, by - ay);
      b.box('beam', [cx + (ax + bx) / 2, (ay + by) / 2, z], [0.1, len, 0.1], { rot: [0, 0, Math.atan2(-(bx - ax), by - ay)], grain: 'y', collide: false });
    }
  }
}

/** A trestle table with its long side along Z. */
export function trestleTable(b: Builder, x: number, y: number, z: number, length: number, ry = 0): void {
  const c = Math.cos(ry), s = Math.sin(ry);
  const at = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
  b.box('boards', at(0, 0.745, 0), [0.82, 0.05, length], { rot: [0, ry, 0], grain: 'x', surface: 'wood' });
  for (const end of [-1, 1]) {
    const lz = end * (length / 2 - 0.35);
    for (const side of [-1, 1]) {
      b.box('beam', at(side * 0.21, 0.36, lz), [0.07, 0.76, 0.09], { rot: [0, ry, side * 0.3], grain: 'y', collide: false });
    }
    b.box('beam', at(0, 0.3, lz), [0.5, 0.06, 0.05], { rot: [0, ry, 0], grain: 'x', collide: false });
  }
  b.box('beam', at(0, 0.3, 0), [0.05, 0.07, length - 0.7], { rot: [0, ry, 0], grain: 'z', collide: false });
}

/** A plank bench with its long side along Z. */
export function bench(b: Builder, x: number, y: number, z: number, length: number, ry = 0): void {
  const c = Math.cos(ry), s = Math.sin(ry);
  const at = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
  b.box('boards', at(0, 0.45, 0), [0.29, 0.045, length], { rot: [0, ry, 0], grain: 'x', surface: 'wood' });
  for (const end of [-1, 1]) {
    b.box('boards', at(0, 0.215, end * (length / 2 - 0.22)), [0.25, 0.43, 0.04], { rot: [0, ry, 0], grain: 'y', collide: false });
  }
  b.box('beam', at(0, 0.36, 0), [0.04, 0.09, length - 0.44], { rot: [0, ry, 0], grain: 'z', collide: false });
}
