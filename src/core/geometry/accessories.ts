// Display stand (plugs into the back port) and the tolerance calibration coupon.
import type { Manifold } from 'manifold-3d';
import type { FigureSpec } from '../types.ts';
import { rigPoints } from '../skeleton.ts';
import { box, chamferedExtrude, circle, poly, rect, union, unionCS } from './geo.ts';
import { ball, doubleClip, hingeEnd, socket, type Dims } from './kit.ts';
import { cylX, slab } from './geo.ts';
import { footDrop } from './armor.ts';

export type StandLayout = {
  groundY: number; portY: number; backZ: number; zPost: number; zBase: number;
  tx: number; postCenterX: number; baseR: number; baseT: number;
};

export function standLayout(d: Dims, spec: FigureSpec): StandLayout {
  const s = d.s, p = rigPoints(spec), sl = spec.tolerances.slide;
  const groundY = Math.min(p.ankleL[1], p.ankleR[1]) - footDrop(d);
  const portY = p.chestPivot[1] + spec.proportions.shoulderY * s;
  const backZ = -5.8 * s;
  const zPost = backZ - 10 * s;
  const tx = 1.6 * s - sl;
  const baseR = Math.max(24 * s, Math.abs(zPost) * 0.5 + 18 * s);
  return { groundY, portY, backZ, zPost, zBase: zPost * 0.45, tx, postCenterX: -2.5 * s + tx, baseR, baseT: 3.4 * s };
}

/** L-shaped post, built in a frame where x = world z, y = world y, z = slab thickness. */
export function standPost(d: Dims, spec: FigureSpec): Manifold {
  const s = d.s, L = standLayout(d, spec), sl = spec.tolerances.slide;
  const outline = unionCS([
    rect(L.zPost - 2.5 * s, L.zPost + 2.5 * s, L.groundY - 2.6 * s, L.portY + 2.5 * s),
    rect(L.zPost, L.backZ + 0.01, L.portY - 2.5 * s, L.portY + 2.5 * s),
  ]);
  const body = chamferedExtrude(outline, 0, 5 * s, 0.6 * s);
  const pw = 1.6 * s - sl;
  const peg = box(L.backZ - 0.5 * s, -0.25 * s, L.portY - pw, L.portY + pw, 0, 2 * pw);
  return body.add(peg);
}

/** Octagonal base, print frame: x = world x, y = -world z, z = up. */
export function standBase(d: Dims, spec: FigureSpec): Manifold {
  const s = d.s, L = standLayout(d, spec), sl = spec.tolerances.slide;
  const plate = chamferedExtrude(circle(L.baseR, 0, 0, 8).rotate(22.5), 0, L.baseT, 0.8 * s);
  const h = 2.5 * s + sl;
  const mx = L.postCenterX, my = L.zBase - L.zPost;
  return plate.subtract(box(mx - h, mx + h, my - h, my + h, L.baseT - 2.6 * s, L.baseT + 1));
}

// ---------- calibration coupon ----------

const OFFSETS = [0.1, 0.2, 0.3, 0.4];
const HINGE = [0.05, 0.1, 0.15];

/** n small V-notches cut into an edge at y = edge (pointing toward +y), used as variant marks. */
function notches(n: number, x: number, edge: number, s: number): Manifold {
  const parts: Manifold[] = [];
  for (let i = 0; i < n; i++) {
    const cx = x + (i - (n - 1) / 2) * 1.3 * s;
    parts.push(chamferedExtrude(poly([[cx - 0.45 * s, edge - 0.4 * s], [cx + 0.45 * s, edge - 0.4 * s], [cx, edge + 0.65 * s]]), -1, 20, 0));
  }
  return union(parts);
}

export function calibration(d: Dims): Record<string, Manifold> {
  const s = d.s, step = 12 * s;
  // sockets with increasing interference
  const sockets: Manifold[] = [];
  const cuts: Manifold[] = [];
  OFFSETS.forEach((off, i) => {
    const dd: Dims = { ...d, socket: { ...d.socket, rLimb: (6 * s - off) / 2 } };
    const sk = socket(dd, 'limb', i * step, 0, 90);
    sockets.push(sk.ring);
    cuts.push(sk.cut);
  });
  sockets.push(chamferedExtrude(rect(0, 3 * step, -6.5 * s, -3.6 * s), 0, d.T, 0.4 * s));
  let sk = union(sockets);
  for (const c of cuts) sk = sk.subtract(c);
  OFFSETS.forEach((_, i) => { sk = sk.subtract(notches(i + 1, i * step, -6.5 * s, s)); });
  // balls on a bar
  const balls: Manifold[] = [chamferedExtrude(rect(-3 * s, 3 * step + 3 * s, -7.5 * s, -4.5 * s), 0, d.T, 0.4 * s)];
  OFFSETS.forEach((_, i) => balls.push(ball(d, i * step, 0, -90, 5 * s)));
  // clips with increasing ridge interference
  const clips: Manifold[] = [];
  HINGE.forEach((h, i) => {
    let c = doubleClip(d, 1.5 * s - h).translate([i * 13 * s, 0, 0]);
    c = c.subtract(notches(i + 1, i * 13 * s + 3 * s, -4.5 * s, s));
    clips.push(c);
  });
  // spools: three hinge ends on a common bar
  const spools: Manifold[] = [chamferedExtrude(rect(-2.5 * s, 2 * 9 * s + 2.5 * s, 9 * s, 12 * s), 0, d.T, 0.4 * s)];
  HINGE.forEach((_, i) => spools.push(hingeEnd(d, 9.5 * s).translate([i * 9 * s, 0, 0])));
  return { 'cal-sockets': sk, 'cal-balls': union(balls), 'cal-clips': union(clips), 'cal-spools': union(spools) };
}

export const CAL_INFO = {
  sockets: OFFSETS,
  hinge: HINGE,
};

// ---------- hand-held weapons ----------

/** Handle centre on the x axis at (0, 0, handleZ); handle runs along x; printed flat. */
export function handleZ(d: Dims): number {
  return 1.3 * d.s;
}

const GRIP_R = 1.6; // grip hole radius at scale 1 (see hand())

/** Handle: snug sliding fit in the grip hole, flat underside for printing. */
function handle(d: Dims, x0: number, x1: number): Manifold {
  const r = GRIP_R * d.s - 0.04, z = handleZ(d);
  return cylX(r, x0, x1, 0, z).intersect(slab(0, z + r));
}

/** Sword: blade toward +x. The guard stops it against the fist; the plain end slides in. */
export function sword(d: Dims, spec: FigureSpec): Manifold {
  const s = d.s, k = spec.style.handSize;
  const g0 = (5.1 * k + 0.4) * s; // just past the fist + thumb
  const len = 36 * s, bw = 2.4 * s;
  const blade = chamferedExtrude(poly([
    [g0 + 1.2 * s, -bw], [g0 + len - 5 * s, -bw * 0.85], [g0 + len, 0], [g0 + len - 5 * s, bw * 0.85], [g0 + 1.2 * s, bw],
  ]), 0, 2.2 * s, 0.7 * s);
  const guard = chamferedExtrude(rect(g0, g0 + 1.4 * s, -4.4 * s, 4.4 * s), 0, 2.8 * s, 0.4 * s);
  return union([blade, guard, handle(d, -(5.1 * k + 2.5) * s, g0 + 0.2 * s)]);
}

export function staff(d: Dims, _spec: FigureSpec): Manifold {
  const s = d.s;
  const half = 34 * s;
  const caps = [-1, 1].map((k) => chamferedExtrude(rect(k * half - 2 * s, k * half + 2 * s, -2.1 * s, 2.1 * s), 0, 2.8 * s, 0.6 * s));
  return union([handle(d, -half, half), ...caps]);
}
