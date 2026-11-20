// Armor shells. Torso + head use clamshells (front/back halves joined by pegs that pass
// through the frame). Limbs use slide-on sleeves with crush ribs. Feet take the ankle tongue.
import type { Manifold, Vec2, Vec3 } from 'manifold-3d';
import type { FigureSpec } from '../types.ts';
import {
  box, chamferedExtrude, circle, cylY, cylZ, extrude, hull, keepSide, octoLoft, poly, rect, sector, sphere, union, type Slice,
} from './geo.ts';
import type { Dims } from './kit.ts';
import type { FrameBuild, SocketFeature } from './frame.ts';

export type Shell = { front: Manifold; back: Manifold };

const rad = (deg: number) => (deg * Math.PI) / 180;

function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Volume the neighbouring stem sweeps through, kept clear of armor. */
function sweepCut(d: Dims, f: SocketFeature): Manifold {
  const [big, small] = f.sweep ?? [0, 0];
  const a = rad(f.mouth);
  const ax = Math.cos(a), ay = Math.sin(a);
  const px = -ay, py = ax;
  const L = 40 * d.s, r0 = 2.0 * d.s, zc = d.c;
  const tb = Math.tan(rad(Math.min(big, 75))) * L + r0;
  const ts = Math.tan(rad(Math.min(small, 75))) * L + r0;
  const pts: Vec3[] = [];
  for (const u of [-1, 1]) for (const w of [-1, 1]) {
    pts.push([f.x + u * r0 * px, f.y + u * r0 * py, zc + w * r0]);
    pts.push([f.x + L * ax + u * ts * px, f.y + L * ay + u * ts * py, zc + w * tb]);
  }
  return hull(pts);
}

export type ClamshellOpts = {
  hz: number;
  outer?: Manifold | null; // character skin: replaces the faceted shell
  cover?: number;          // skin: wall (mm) kept around the frame where the model is thinner

  emblem?: { kind: FigureSpec['style']['emblem']; x: number; y: number; size: number };
  port?: { x: number; y: number; half: number };
  groove?: { y: number; halfW: number; h: number };
};

export function clamshell(d: Dims, fb: FrameBuild, slices: Slice[], opts: ClamshellOpts): Shell {
  const clr = d.armor.clr, zc = d.c, s = d.s;
  const bb = fb.solid.boundingBox();
  const zMin = bb.min[2], zMax = bb.max[2];
  const skin = !!opts.outer;
  let body = opts.outer ?? octoLoft(slices, zc);
  // pocket = frame silhouette with its holes filled (pegs and ports pass through it)
  const outerContours = fb.solid.project().toPolygons().filter((pg) => signedArea(pg) > 0);
  const outline = poly(outerContours).offset(clr, 'Round', 2, 24);
  // a thin model still has to hide the frame: keep a wall around it
  // (clipped to the standard shell, whose outline is made to clear the neighbouring pieces)
  const coverM = skin && opts.cover ? extrude(outline.offset(opts.cover, 'Round', 2, 24), zMin - clr - opts.cover, zMax + clr + opts.cover).intersect(octoLoft(slices, zc)) : null;
  if (coverM) body = body.add(coverM);
  body = body.subtract(extrude(outline, zMin - clr, zMax + clr));
  for (const f of fb.features) {
    if (f.kind === 'ball') {
      body = body.subtract(sphere(d.armor.ringClear, f.x, f.y, zc));
      continue;
    }
    // the neighbour's ball pokes through the socket faces
    body = body.subtract(sphere(d.ball.r + 0.3 * s, f.x, f.y, zc));
    // skins trade some range of motion for keeping more of the character's shape
    if (f.sweep) body = body.subtract(sweepCut(d, skin ? { ...f, sweep: [f.sweep[0] * 0.55, f.sweep[1] * 0.55] } : f));
    // the cover wall is standard armor, so it gets the standard (full) swing clearance
    if (f.sweep && coverM) body = body.subtract(sweepCut(d, f).intersect(coverM));
    if (f.faceStem) body = body.subtract(cylZ(d.armor.faceStemR, -50, 50, f.x, f.y));
    if (f.cutPlane) {
      const a = rad(f.mouth), ax = Math.cos(a), ay = Math.sin(a);
      body = keepSide(body, [-ax, -ay, 0], [f.x + ax * d.armor.cutAt, f.y + ay * d.armor.cutAt, 0]);
    }
  }
  const front0 = opts.hz + zc;
  if (opts.groove && !skin) {
    const g = opts.groove;
    body = body.subtract(box(-g.halfW, g.halfW, g.y - g.h / 2, g.y + g.h / 2, front0 - 0.7 * s, front0 + 1));
  }
  if (!skin && opts.emblem && opts.emblem.kind !== 'none') body = body.subtract(emblemCut(opts.emblem, front0, s));
  let front = keepSide(body, [0, 0, 1], [0, 0, zc]);
  let back = keepSide(body, [0, 0, -1], [0, 0, zc]);
  if (opts.port) {
    const p = opts.port;
    back = back.subtract(box(p.x - p.half, p.x + p.half, p.y - p.half, p.y + p.half, -50, zc + 0.01));
  }
  const A = d.armor;
  for (const [px, py] of fb.pegs) {
    if (skin) {
      // skins print split-face down, so both halves get holes and separate dowels join them
      front = front.subtract(cylZ(A.pegHoleR, zMax + clr - 0.05, zMax + clr + A.pegDepth + 0.5 * s, px, py, 24));
      back = back.subtract(cylZ(A.pegHoleR, zMin - clr - A.pegDepth - 0.5 * s, zMin - clr + 0.05, px, py, 24));
    } else {
      back = back.add(cylZ(A.pegR, zMin - clr - 0.4 * s, zMax + clr + A.pegDepth - 0.25 * s, px, py, 24));
      front = front.subtract(cylZ(A.pegHoleR, zMax + clr - 0.05, zMax + clr + A.pegDepth, px, py, 24));
    }
  }
  return { front, back };
}

function emblemCut(e: NonNullable<ClamshellOpts['emblem']>, zFront: number, s: number): Manifold {
  const depth = 0.6 * s;
  const sz = e.size;
  let cs;
  if (e.kind === 'chevron') {
    const w = sz, h = sz * 0.55, t = sz * 0.22;
    cs = poly([[-w, h], [-w + t, h], [0, -h + t * 1.2], [w - t, h], [w, h], [0, -h]]);
  } else if (e.kind === 'circle') {
    cs = circle(sz * 0.62, 0, 0, 40).subtract(circle(sz * 0.62 - 0.55 * s, 0, 0, 40));
  } else {
    cs = rect(-sz, sz, -0.28 * sz, 0.28 * sz);
  }
  return extrude(cs.translate([e.x, e.y]), zFront - depth, zFront + 1);
}

// ---------- torso + head ----------

/** Skin wall kept around the frame where the model is too thin (0 = off). */
function cover(spec: FigureSpec, s: number): number {
  return spec.skin.cover ? 1.2 * s : 0;
}

function facetCh(spec: FigureSpec, base: number, s: number): number {
  return (base * (0.35 + 1.1 * spec.style.facet)) * s;
}

export function headShell(d: Dims, spec: FigureSpec, fb: FrameBuild, outer?: Manifold | null): Shell {
  const s = d.s, k = spec.style.headSize;
  const H = Math.max(15.5 * s * k, 13.8 * s);
  const hw = Math.max(6.5 * s * k, 5.4 * s);
  const hz = Math.max(5.7 * s * k, 5.75 * s);
  const yb = -1.2 * s;
  const shapes: Record<string, [number, number, number][]> = {
    egg: [[0, 0.62, 0.3], [0.18, 0.86, 0.32], [0.45, 0.98, 0.34], [0.72, 0.96, 0.34], [0.9, 0.78, 0.3], [1, 0.5, 0.25]],
    round: [[0, 0.55, 0.38], [0.15, 0.86, 0.4], [0.4, 1, 0.42], [0.68, 1, 0.42], [0.88, 0.82, 0.4], [1, 0.48, 0.36]],
    block: [[0, 0.84, 0.16], [0.1, 1, 0.16], [0.9, 1, 0.16], [1, 0.88, 0.16]],
    visor: [[0, 0.84, 0.16], [0.1, 1, 0.16], [0.9, 1, 0.16], [1, 0.88, 0.16]],
  };
  const f = 0.5 + spec.style.facet;
  const slices: Slice[] = shapes[spec.style.headShape].map(([t, w, c]) => ({
    y: yb + t * H, hx: w * hw, hz, ch: Math.min(w * hw, hz) * c * f,
  }));
  const groove = spec.style.headShape === 'visor' ? { y: yb + 0.56 * H, halfW: hw * 0.8, h: 1.5 * s } : undefined;
  return clamshell(d, fb, slices, { hz, groove, outer, cover: cover(spec, s) });
}

export function chestShell(d: Dims, spec: FigureSpec, fb: FrameBuild, outer?: Manifold | null): Shell {
  const s = d.s, P = spec.proportions, st = spec.style, w = st.chestWidth;
  const Lc = P.chestLen * s, Ys = P.shoulderY * s, Xs = P.shoulderHalf * s;
  const armLimit = Xs - 4.6 * s * st.bulk - 0.6 * s;
  const shLimit = Xs - 3.2 * s;
  const ch = facetCh(spec, 1.6, s);
  const hz = 5.8 * s;
  const slices: Slice[] = [
    { y: -1.2 * s, hx: Math.min(5.4 * s * w, armLimit), hz, ch },
    { y: Ys - 5.2 * s, hx: Math.min(6.0 * s * w, armLimit), hz, ch },
    { y: Ys + 0.6 * s, hx: Math.min(6.8 * s * w, shLimit), hz, ch },
    { y: Lc - 0.6 * s, hx: Math.min(5.6 * s * w, shLimit), hz, ch },
    { y: Lc + 1.6 * s, hx: 4.4 * s, hz, ch: ch * 0.8 },
  ];
  const emblem = { kind: st.emblem, x: 0, y: Math.max(Ys - 4.2 * s, 6.5 * s), size: 2.6 * s * Math.min(w, 1.15) };
  const port = st.backPort ? { x: 0, y: Ys, half: 1.6 * s + 0.15 } : undefined;
  return clamshell(d, fb, slices, { hz, emblem, port, outer, cover: cover(spec, s) });
}

export function abdomenShell(d: Dims, spec: FigureSpec, fb: FrameBuild, outer?: Manifold | null): Shell | null {
  const s = d.s, La = spec.proportions.abdomenLen * s;
  const w = 1 + (spec.style.chestWidth - 1) * 0.5;
  const top = La - 5.4 * s, bottom = -1.0 * s;
  if (top - bottom < 3 * s && !outer) return null;
  const hz = 5.4 * s, ch = facetCh(spec, 1.3, s);
  const slices: Slice[] = [
    { y: bottom, hx: 5.5 * s * w, hz, ch },
    { y: (top + bottom) / 2, hx: 5.1 * s * w, hz, ch },
    { y: top, hx: 4.7 * s * w, hz, ch },
  ];
  return clamshell(d, fb, slices, { hz, outer, cover: cover(spec, s) });
}

export function pelvisShell(d: Dims, spec: FigureSpec, fb: FrameBuild, outer?: Manifold | null): Shell | null {
  const s = d.s, P = spec.proportions;
  const Lw = P.waistLen * s;
  const top = Lw - 5.4 * s, bottom = -4.4 * s;
  const hz = Math.min(5.0 * s, P.hipHalf * s - 3.0 * s);
  const ch = facetCh(spec, 1.3, s);
  const slices: Slice[] = [
    { y: bottom, hx: 5.0 * s, hz, ch },
    { y: -1.0 * s, hx: 6.1 * s, hz, ch },
    { y: Math.max(top, 0), hx: 5.4 * s, hz, ch },
  ];
  return clamshell(d, fb, slices, { hz, outer, cover: cover(spec, s) });
}

// ---------- limb sleeves ----------

function ribs(d: Dims, y0: number, y1: number, halfX: number): Manifold[] {
  const s = d.s, c = d.c, clr = d.armor.clr;
  const prot = clr + 0.08, base = 0.35 * s;
  const out: Manifold[] = [];
  for (const sx of [-1, 1]) {
    const tri: Vec2[] = sx > 0
      ? [[halfX + 0.3, c - base], [halfX + 0.3, c + base], [halfX - prot, c]]
      : [[-halfX - 0.3, c + base], [-halfX - 0.3, c - base], [-halfX + prot, c]];
    // extrude along y: build in XY (x, z) then rotate so extrusion runs along +y
    const prism = extrude(poly(tri.map(([x, z]) => [x, -z] as Vec2)), 0, y1 - y0).rotate([-90, 0, 0]).translate([0, y0, 0]);
    out.push(prism);
  }
  return out;
}

/** Thigh / upper-arm sleeve. Slides on from the hinge end; the head block sits in the top pocket. */
export function upperSleeve(d: Dims, spec: FigureSpec, L: number, factor = 1, outer?: Manifold | null): Manifold | null {
  const s = d.s, clr = d.armor.clr, T = d.T, c = d.c, b = spec.style.bulk * factor;
  const top = L + d.swivel.headTop, pocketBot = L - 3.95 * s, bottom = 5.5 * s;
  if (top - bottom < 4 * s) return null;
  const ch = facetCh(spec, 1.4, s);
  const sl = (b: number): Slice[] => [
    { y: bottom, hx: Math.max(3.9 * s * b, 3.8 * s), hz: Math.max(3.9 * s * b, 3.8 * s), ch: ch * 0.8 },
    { y: Math.max(bottom + 1 * s, pocketBot - 0.5 * s), hx: Math.max(5.0 * s * b, 5.4 * s), hz: Math.max(4.4 * s * b, 4.3 * s), ch },
    { y: top, hx: Math.max(5.4 * s * b, 5.4 * s), hz: Math.max(4.5 * s * b, 4.4 * s), ch },
  ];
  const slices = sl(b);
  // thin limbs: the leanest standard sleeve fills in where the model can't hide the frame
  if (outer && spec.skin.cover) outer = outer.add(octoLoft(sl(0), c));
  const hw = d.hinge.barHW + clr;
  let m: Manifold;
  if (outer) {
    // skin: keep everything above the knee/elbow gap; above the bone top the piece becomes a
    // collar around the swivel and ball joint (bore + slot for the body rod, both open upward
    // so the sleeve still slides on from the hinge end)
    const ballY = L + d.swivel.drop;
    const big = 80 * s;
    m = outer.intersect(box(-big, big, bottom, big, -big, big));
    // side plates over the hinge: outside the pin's slab nothing rotates, so the armor can
    // reach down to the pin without touching the link or the lower bone
    const cheek = 2.6 * s + clr;
    m = m.add(outer.intersect(box(-big, big, 0, bottom + 0.01, -big, c - cheek)))
      .add(outer.intersect(box(-big, big, 0, bottom + 0.01, c + cheek, big)));
    m = m.subtract(cylY(5.4 * s + clr, top - 0.01, big, 0, c));
    const slot = extrude(sector(96, 90, big), 0, big).rotate([-90, 0, 0]).translate([0, ballY - 6 * s, c]);
    m = m.subtract(slot);
  } else {
    m = octoLoft(slices, c);
  }
  m = m.subtract(box(-hw, hw, bottom - 1, pocketBot + 0.01, -clr, T + clr));
  m = m.subtract(box(-(d.swivel.headHalfW + clr), d.swivel.headHalfW + clr, pocketBot, top + 1, -clr, T + 0.5 * s + clr));
  const span = pocketBot - bottom;
  if (span > 3 * s) m = union([m, ...ribs(d, bottom + 0.2 * span, bottom + 0.8 * span, hw)]);
  return m;
}

/** Shin / forearm sleeve. Slides on from the hinge end, rests on the collar above the ball. */
export function lowerSleeve(d: Dims, spec: FigureSpec, L: number, factor = 1, outer?: Manifold | null): Manifold | null {
  const s = d.s, clr = d.armor.clr, T = d.T, c = d.c, b = spec.style.bulk * factor;
  const top = -5.5 * s, bottom = -L + 5.25 * s;
  const len = top - bottom;
  // a skin cuff takes its shape from the model, so even a short forearm or shin gets one
  if (len < (outer ? 0.5 : 3) * s) return null;
  const ch = facetCh(spec, 1.3, s);
  const mn = 3.75 * s;
  const sl = (b: number): Slice[] => [
    { y: top, hx: Math.max(4.1 * s * b, mn), hz: Math.max(4.0 * s * b, mn), ch },
    { y: top - 0.35 * len, hx: Math.max(4.6 * s * b, mn), hz: Math.max(4.3 * s * b, mn), ch },
    { y: bottom, hx: Math.max(3.8 * s * b, mn), hz: Math.max(3.75 * s * b, mn), ch: ch * 0.85 },
  ];
  const slices = sl(b);
  if (outer && spec.skin.cover && len >= 3 * s) outer = outer.add(octoLoft(sl(0), c));
  const hw = d.hinge.barHW + clr;
  const big = 80 * s;
  let shell: Manifold;
  if (outer) {
    // skin: below the collar stop the piece continues as a cuff around the wrist/ankle ball,
    // with a bore so the hand or ankle socket keeps its swing (open downward)
    const cheek = 2.6 * s + clr;
    shell = outer.intersect(box(-big, big, -big, top, -big, big))
      .add(outer.intersect(box(-big, big, top - 0.01, 0, -big, c - cheek)))
      .add(outer.intersect(box(-big, big, top - 0.01, 0, c + cheek, big)))
      .subtract(cylY(5.4 * s + clr, -big, bottom + 0.01, 0, c));
  } else {
    shell = octoLoft(slices, c);
  }
  let m = shell.subtract(box(-hw, hw, bottom - 1, top + 1, -clr, T + clr));
  if (len > 3 * s) m = union([m, ...ribs(d, bottom + 0.2 * len, bottom + 0.8 * len, hw)]);
  return m;
}

// ---------- feet ----------

/** Foot in its own print frame: sole on z = 0, toe toward +y, mortise for the ankle tongue at the origin. */
export function foot(d: Dims, spec: FigureSpec, outer?: Manifold | null): Manifold {
  const s = d.s, f = spec.style.footSize, sl = spec.tolerances.slide;
  const ch = facetCh(spec, 1.4, s);
  const slices: Slice[] = [
    { y: -6 * s * f, hx: 3.5 * s * f, hz: 4.4 * s, ch },
    { y: 0, hx: Math.max(4.1 * s * f, 4.0 * s), hz: 5.0 * s, ch },
    { y: 5 * s * f, hx: 4.3 * s * f, hz: 3.6 * s, ch },
    { y: 10.5 * s * f, hx: 3.5 * s * f, hz: 2.3 * s, ch: ch * 0.8 },
  ];
  const stock = () => keepSide(octoLoft(slices, 0), [0, 0, 1], [0, 0, 0]);
  let m = outer ? (spec.skin.cover ? outer.add(stock()) : outer) : stock();
  if (outer) {
    // keep the ankle ball and the shin's swing clear
    const az = footDrop(d), r0 = 2.2 * s, L = 40 * s;
    m = m.subtract(sphere(d.armor.ringClear, 0, 0, az));
    const ty = Math.tan(rad(42)) * L + r0, tx = Math.tan(rad(22)) * L + r0;
    const pts: Vec3[] = [];
    for (const u of [-1, 1]) for (const w of [-1, 1]) {
      pts.push([u * r0, w * r0, az]);
      pts.push([u * tx, w * ty, az + L]);
    }
    m = m.subtract(hull(pts));
  }
  const mx = 3.0 * s + sl, my = d.c + sl;
  m = m.subtract(box(-mx, mx, -my, my, 0.9 * s, 20 * s));
  // crush ribs on the mortise side walls (vertical, print-friendly)
  const prot = d.armor.clr + 0.08;
  for (const sx of [-1, 1]) {
    const tri: Vec2[] = sx > 0 ? [[mx + 0.3, -0.35 * s], [mx + 0.3, 0.35 * s], [mx - prot, 0]] : [[-mx - 0.3, 0.35 * s], [-mx - 0.3, -0.35 * s], [-mx + prot, 0]];
    m = m.add(chamferedExtrude(poly(tri), 1.2 * s, 4.6 * s, 0));
  }
  return m;
}

/** World height of the sole below the ankle ball centre. */
export function footDrop(d: Dims): number {
  return 10.1 * d.s;
}

/** Dowel pin joining skin clamshell halves; lies flat for printing. */
export function dowel(d: Dims): Manifold {
  const s = d.s, A = d.armor;
  const len = 5.5 * s + 2 * A.clr + 2 * A.pegDepth - 0.3;
  const r = A.pegR;
  return cylY(r, 0, len, 0, r - 0.15).intersect(box(-r - 1, r + 1, -1, len + 1, 0, 2 * r));
}
