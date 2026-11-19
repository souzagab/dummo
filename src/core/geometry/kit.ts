// Snap-joint primitives. Every solid is built in PRINT FRAME: bed at z = 0, joint centre at
// z = c (= T / 2), long axis of the part along y. Nothing needs support material.
import type { Manifold, Vec2 } from 'manifold-3d';
import type { FigureSpec } from '../types.ts';
import {
  box, chamferedExtrude, circle, cylX, cylY, cylZ, extrude, poly, rect, revolveZ, sector, slab, sphere, union, unionCS,
} from './geo.ts';

export type Dims = ReturnType<typeof jointDims>;

/** All joint dimensions for a spec: geometry scales, fits (interference/clearance) stay absolute. */
export function jointDims(spec: FigureSpec) {
  const s = spec.scale;
  const t = spec.tolerances;
  const T = 5 * s;
  const c = T / 2;
  const ballD = 6 * s;
  return {
    s, T, c,
    edge: 0.5 * s,
    ball: { r: ballD / 2, stemR: 1.5 * s, bedTrim: 0.5 * s, stemFlat: 0.2 * s },
    socket: {
      ro: 4.5 * s, h: T, ch: 0.5 * s, mouth: 112,
      exitZ: 1.85 * s, faceR: 2.4 * s,
      rSpine: (ballD - t.socketSpine) / 2,
      rLimb: (ballD - t.socketLimb) / 2,
    },
    hinge: {
      barHW: 2.5 * s, spoolR: 2.5 * s, rootR: 1.5 * s,
      slotBelow: 1.5 * s, slotAbove: 1.5 * s + 0.1, slotDepth: 5 * s,
      coreR: 0.5 * s, endCh: 0.5 * s,
    },
    clip: {
      pitch: 6 * s, t: 2.8 * s, outerR: 4.5 * s,
      holeR: 2.4 * s, tipR: 1.5 * s + 0.04, flank: 1.5 * s - t.hinge,
      mouth: 106, tilt: 5, ch: 0.4 * s,
      boss: { x: 3 * s, y: 3.6 * s, r: 1.5 * s, holeR: 0.66 * s, slotW: 0.8 * s },
    },
    swivel: {
      drop: 8.75 * s,
      discR: 3 * s, discLen: 2.3 * s, neckR: 1.5 * s, bedTrim: 0.5 * s, neckFlat: 0.2 * s,
      chamberHalfW: 3 * s + t.slide, channelHalfW: 1.5 * s + t.slide,
      chamberHi: 1.15 * s, bumpH: 0.45 * s,
      chamberLo: -1.15 * s + t.swivel - 0.45 * s,
      floorZ: 0.8 * s, floorHoleHalfW: 2.5 * s,
      leafT: 0.5 * s, bumpHalfW: 1.3 * s, leafHalfW: 2.55 * s, reliefDepth: 0.87 * s,
      headTop: 3.55 * s, headHalfW: 4 * s,
    },
    armor: {
      clr: t.armor, pegR: 0.95 * s, pegHoleR: 0.95 * s - t.peg / 2, frameHoleR: 0.95 * s + 0.15,
      pegDepth: 1.5 * s, ringClear: 5.2 * s, faceStemR: 3.0 * s, cutAt: 4.2 * s,
    },
  };
}

/** Ball on a stem. Stem leaves the ball centre in direction dirDeg (in the XY plane). */
export function ball(d: Dims, x: number, y: number, dirDeg: number, stemLen: number, topTrim = 0): Manifold {
  const { r, stemR, bedTrim, stemFlat } = d.ball;
  const c = d.c;
  const sph = sphere(r, 0, 0, c).intersect(slab(c - r + bedTrim, c + r - topTrim));
  const stem = cylY(stemR, 0, stemLen, 0, c).intersect(slab(c - stemR + stemFlat, c + stemR));
  return sph.add(stem).rotate([0, 0, dirDeg - 90]).translate([x, y, 0]);
}

/** Straight rod between two points in the XY plane with a flat (bridgeable) underside. */
export function rodX(d: Dims, x0: number, x1: number, y: number): Manifold {
  const { stemR, stemFlat } = d.ball;
  return cylX(stemR, x0, x1, y, d.c).intersect(slab(d.c - stemR + stemFlat, d.c + stemR));
}
export function rodY(d: Dims, y0: number, y1: number, x = 0): Manifold {
  const { stemR, stemFlat } = d.ball;
  return cylY(stemR, y0, y1, x, d.c).intersect(slab(d.c - stemR + stemFlat, d.c + stemR));
}

/**
 * C-socket: chamfered ring + undersized spherical cavity + conical face openings + wedge mouth.
 * Returns the ring and the cutter separately so bodies can be unioned before cutting.
 */
export function socket(d: Dims, kind: 'spine' | 'limb', x: number, y: number, mouthDeg: number) {
  const S = d.socket;
  const R = kind === 'spine' ? S.rSpine : S.rLimb;
  const c = d.c, h = S.h, ch = S.ch, ro = S.ro;
  const ring = revolveZ([[0, 0], [ro - ch, 0], [ro, ch], [ro, h - ch], [ro - ch, h], [0, h]]).translate([x, y, c - h / 2]);
  const rs = Math.sqrt(Math.max(0.01, R * R - S.exitZ * S.exitZ));
  const e = 0.05;
  const slope = (S.faceR - rs) / (h / 2 - S.exitZ);
  const rTop = S.faceR + slope * e;
  const coneTop = revolveZ([[0, c + S.exitZ], [rs, c + S.exitZ], [rTop, c + h / 2 + e], [0, c + h / 2 + e]]);
  const coneBot = revolveZ([[0, c - h / 2 - e], [rTop, c - h / 2 - e], [rs, c - S.exitZ], [0, c - S.exitZ]]);
  const mouth = extrude(sector(S.mouth, mouthDeg, ro + 3 * d.s), c - h / 2 - 1, c + h / 2 + 1);
  const cut = union([sphere(R, 0, 0, c), coneTop, coneBot, mouth]).translate([x, y, 0]);
  return { ring, cut };
}

/** Hinge end: bar toward +y, clevis slot bridged by a V-grooved spool at the origin. */
export function hingeEnd(d: Dims, length: number): Manifold {
  const H = d.hinge, T = d.T, c = d.c, r = H.barHW, ch = H.endCh;
  const endDisc = revolveZ([[0, 0], [r - ch, 0], [r, ch], [r, T - ch], [r - ch, T], [0, T]]);
  let body = endDisc.add(box(-r, r, 0, length, 0, T));
  const zlo = c - H.slotBelow, zhi = c + H.slotAbove;
  body = body.subtract(box(-r - 1, r + 1, -r - 1, H.slotDepth, zlo, zhi));
  const g = H.spoolR - H.rootR;
  const spool = revolveZ([
    [0, zlo - 0.01], [H.spoolR, zlo - 0.01], [H.spoolR, c - g], [H.rootR, c],
    [H.spoolR, c + g], [H.spoolR, zhi + 0.01], [0, zhi + 0.01],
  ]);
  body = body.add(spool);
  // countersink: 0.45 (not 0.5) so its rim is not exactly half the end-disc radius,
  // which lines its vertices up on the disc's chords and leaves zero-area triangles
  const hr = H.coreR, cs = 0.45 * d.s;
  const core = revolveZ([[0, -0.01], [hr + cs + 0.01, -0.01], [hr, cs], [hr, T - cs], [hr + cs + 0.01, T + 0.01], [0, T + 0.01]]);
  return body.subtract(core);
}

/** Double C-clip linking two hinge ends (double-jointed knee / elbow). Holes at (0,0) and (pitch,0). */
export function doubleClip(d: Dims, flankOverride?: number): Manifold {
  const C = d.clip;
  const { pitch, t, outerR } = C;
  const mid = pitch / 2, b = C.boss;
  let outline = unionCS([circle(outerR, 0, 0), circle(outerR, pitch, 0), rect(0, pitch, -outerR, 0)])
    .subtract(poly([[mid - 1.5 * d.s, -outerR - 0.01], [mid + 1.5 * d.s, -outerR - 0.01], [mid, -3.0 * d.s]]));
  outline = outline
    .subtract(sector(C.mouth, 90 + C.tilt, outerR + 1))
    .subtract(sector(C.mouth, 90 - C.tilt, outerR + 1).translate([pitch, 0]));
  outline = unionCS([outline, rect(b.x - 0.7 * d.s, b.x + 0.7 * d.s, 0, b.y), circle(b.r, b.x, b.y)]);
  let body = chamferedExtrude(outline, 0, t, C.ch);
  const tc = t / 2;
  const flank = flankOverride ?? C.flank;
  const tip = Math.max(0.02, C.tipR - flank);
  const flat = C.holeR - flank;
  const hole = revolveZ([
    [0, -0.01], [C.holeR, -0.01], [C.holeR, tc - flat], [C.tipR, tc - tip],
    [C.tipR, tc + tip], [C.holeR, tc + flat], [C.holeR, t + 0.01], [0, t + 0.01],
  ]);
  body = body.subtract(hole).subtract(hole.translate([pitch, 0, 0]));
  const key = unionCS([circle(b.holeR, b.x, b.y), rect(b.x - b.slotW / 2, b.x + b.slotW / 2, 1.6 * d.s, b.y)]);
  return body.subtract(extrude(key, -1, t + 1));
}

/** Swivel peg: disc centred at (0, y) with axis y, neck runs toward +y for neckLen. */
export function swivelPeg(d: Dims, y: number, neckLen: number): Manifold {
  const S = d.swivel, c = d.c;
  const disc = cylY(S.discR, y - S.discLen / 2, y + S.discLen / 2, 0, c).intersect(slab(c - S.discR + S.bedTrim, c + S.discR));
  const neck = cylY(S.neckR, y + S.discLen / 2 - 0.01, y + S.discLen / 2 + neckLen, 0, c)
    .intersect(slab(c - S.neckR + S.neckFlat, c + S.neckR));
  return disc.add(neck);
}

/** Cut tool for the swivel T-slot with its printed leaf spring. Disc centre at (0, y). Channel opens toward +y. */
export function swivelSlotCut(d: Dims, y: number): Manifold {
  const S = d.swivel, T = d.T;
  const lo = S.chamberLo, hi = S.chamberHi;
  let cut = union([
    box(-S.chamberHalfW, S.chamberHalfW, lo, hi, S.floorZ, T + 1),
    box(-S.floorHoleHalfW, S.floorHoleHalfW, lo, hi, -1, S.floorZ + 0.01),
    box(-S.channelHalfW, S.channelHalfW, hi - 0.01, hi + S.headTop + 2, S.floorZ, T + 1),
  ]);
  const Rb = (S.bumpHalfW ** 2 + S.bumpH ** 2) / (2 * S.bumpH);
  const bump2d = circle(Rb, 0, lo + S.bumpH - Rb).intersect(rect(-S.bumpHalfW, S.bumpHalfW, lo - 0.001, lo + S.bumpH + 0.01));
  const top = lo - S.leafT;
  const sag = S.reliefDepth - 0.1 * d.s;
  const Rr = (S.leafHalfW ** 2 + sag ** 2) / (2 * sag);
  const lens = circle(Rr, 0, top - S.reliefDepth + Rr).intersect(rect(-S.leafHalfW, S.leafHalfW, top - S.reliefDepth, top));
  const relief = unionCS([lens, bump2d.translate([0, -S.leafT])]);
  cut = cut.add(extrude(relief, -1, T + 1)).subtract(extrude(bump2d, -1, T + 1));
  return cut.translate([0, y, 0]);
}

/** Through-hole along z. */
export function holeZ(r: number, x: number, y: number, z0 = -1, z1 = 50): Manifold {
  return cylZ(r, z0, z1, x, y);
}

/** Teardrop hole along x (prints without support when x lies in the bed plane). */
export function teardropX(r: number, x0: number, x1: number, y: number, z: number): Manifold {
  // profile in (u = y, v = z); the pointed top keeps the roof at 45 degrees
  const pts: Vec2[] = [];
  for (let i = 0; i <= 32; i++) {
    const a = ((135 + (i / 32) * 270) * Math.PI) / 180;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  pts.push([0, r * Math.SQRT2]);
  // extrusion axis -> x, u -> y, v -> z
  return extrude(poly(pts), 0, x1 - x0).rotate([90, 0, 90]).translate([x0, y, z]);
}
