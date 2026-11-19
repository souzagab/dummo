// Frame (skeleton) parts. Each builder returns a solid in print frame plus the joint
// features armor needs to know about. Frame parts are 2.5D slabs that print flat.
import type { Manifold } from 'manifold-3d';
import type { FigureSpec, HandPose } from '../types.ts';
import { chamferedExtrude, poly, rect, union, unionCS } from './geo.ts';
import {
  ball, doubleClip, hingeEnd, holeZ, rodX, rodY, socket, swivelPeg, swivelSlotCut, teardropX, type Dims,
} from './kit.ts';

export type SocketFeature = {
  kind: 'socket';
  x: number;
  y: number;
  mouth: number;               // degrees, direction the mouth faces
  sweep?: [number, number];    // stem swing kept clear in armor: [toward faces, in plane]
  cutPlane?: boolean;          // trim armor beyond the ring along the mouth axis
  faceStem?: boolean;          // a rod passes through the face openings (pelvis)
};
export type BallFeature = { kind: 'ball'; x: number; y: number };
export type Feature = SocketFeature | BallFeature;
export type FrameBuild = { solid: Manifold; features: Feature[]; pegs: [number, number][] };

function withPegs(d: Dims, solid: Manifold, pegs: [number, number][]): Manifold {
  let out = solid;
  for (const [x, y] of pegs) out = out.subtract(holeZ(d.armor.frameHoleR, x, y));
  return out;
}

export function pelvis(d: Dims, spec: FigureSpec): FrameBuild {
  const H = spec.proportions.hipHalf * d.s;
  const solid = union([
    rodX(d, -H, H, 0),
    ball(d, -H, 0, 0, 0.01),
    ball(d, 0, 0, 90, 0.01),
    ball(d, H, 0, 180, 0.01),
  ]);
  return {
    solid,
    features: [{ kind: 'ball', x: -H, y: 0 }, { kind: 'ball', x: 0, y: 0 }, { kind: 'ball', x: H, y: 0 }],
    pegs: [],
  };
}

/** Spine link: socket at the bottom (mouth down), ball on top. */
export function spineLink(d: Dims, len: number, role: 'waist' | 'abdomen'): FrameBuild {
  const s = d.s;
  const sk = socket(d, 'spine', 0, 0, -90);
  const y0 = 3.0 * s, y1 = len - 3.4 * s;
  const parts = [sk.ring, ball(d, 0, len, -90, 3.8 * s, 0.5 * s)];
  if (y1 > y0 + 0.3 * s) parts.push(chamferedExtrude(rect(-3.2 * s, 3.2 * s, y0, y1), 0, d.T, d.edge));
  const pegs: [number, number][] = y1 - y0 >= 2.8 * s ? [[0, (y0 + y1) / 2]] : [];
  const solid = withPegs(d, union(parts).subtract(sk.cut), pegs);
  const sock: Feature = role === 'waist'
    ? { kind: 'socket', x: 0, y: 0, mouth: -90, faceStem: true }
    : { kind: 'socket', x: 0, y: 0, mouth: -90, sweep: [40, 30], cutPlane: true };
  return { solid, features: [sock, { kind: 'ball', x: 0, y: len }], pegs };
}

export function chest(d: Dims, spec: FigureSpec): FrameBuild {
  const s = d.s, P = spec.proportions;
  const Lc = P.chestLen * s, Ys = P.shoulderY * s, Xs = P.shoulderHalf * s;
  const lo = socket(d, 'spine', 0, 0, -90);
  const nk = socket(d, 'limb', 0, Lc, 90);
  const yokeHW = Math.max(4.6 * s, Xs - 3.6 * s);
  const outline = unionCS([rect(-4.6 * s, 4.6 * s, 3.0 * s, Lc - 3.0 * s), rect(-yokeHW, yokeHW, Ys - 2.6 * s, Ys + 2.6 * s)]);
  const body = chamferedExtrude(outline, 0, d.T, d.edge);
  const pegY = (4.8 * s + Ys - 2.6 * s) / 2;
  const pegs: [number, number][] = [[-2.6 * s, pegY], [2.6 * s, pegY]];
  let solid = union([lo.ring, nk.ring, body, rodX(d, -Xs, Xs, Ys), ball(d, Xs, Ys, 180, 0.01), ball(d, -Xs, Ys, 0, 0.01)])
    .subtract(lo.cut).subtract(nk.cut);
  solid = withPegs(d, solid, pegs);
  if (spec.style.backPort) {
    const h = 1.6 * s;
    solid = solid.subtract(chamferedExtrude(rect(-h, h, Ys - h, Ys + h), -1, d.T + 1, 0));
  }
  return {
    solid,
    pegs,
    features: [
      { kind: 'socket', x: 0, y: 0, mouth: -90, sweep: [45, 30], cutPlane: true },
      { kind: 'socket', x: 0, y: Lc, mouth: 90, sweep: [50, 30], cutPlane: true },
      { kind: 'ball', x: Xs, y: Ys },
      { kind: 'ball', x: -Xs, y: Ys },
    ],
  };
}

export function neck(d: Dims, spec: FigureSpec): FrameBuild {
  const s = d.s, L = spec.proportions.neckLen * s;
  const parts = [rodY(d, 0, L), ball(d, 0, 0, 90, 0.01), ball(d, 0, L, -90, 0.01)];
  if (L - 6.6 * s > 0.6 * s) parts.push(chamferedExtrude(rect(-1.8 * s, 1.8 * s, 3.3 * s, L - 3.3 * s), 0, d.T, 0.4 * s));
  return { solid: union(parts), features: [{ kind: 'ball', x: 0, y: 0 }, { kind: 'ball', x: 0, y: L }], pegs: [] };
}

export function headFrame(d: Dims): FrameBuild {
  const s = d.s;
  const sk = socket(d, 'limb', 0, 0, -90);
  const plate = chamferedExtrude(rect(-4.0 * s, 4.0 * s, 3.0 * s, 10.5 * s), 0, d.T, d.edge);
  const pegs: [number, number][] = [[-2.2 * s, 7.5 * s], [2.2 * s, 7.5 * s]];
  const solid = withPegs(d, union([sk.ring, plate]).subtract(sk.cut), pegs);
  return { solid, pegs, features: [{ kind: 'socket', x: 0, y: 0, mouth: -90, sweep: [45, 25] }] };
}

/** Hip / shoulder swivel: socket on top (mouth up), disc peg below. */
export function swivel(d: Dims): FrameBuild {
  const s = d.s, S = d.swivel;
  const sk = socket(d, 'limb', 0, 0, 90);
  const body = chamferedExtrude(poly([
    [-4.5 * s, 0], [4.5 * s, 0], [4.5 * s, -2.8 * s], [2.5 * s, -4.0 * s],
    [2.5 * s, -5.0 * s], [-2.5 * s, -5.0 * s], [-2.5 * s, -4.0 * s], [-4.5 * s, -2.8 * s],
  ]), 0, d.T, d.edge);
  const neckLen = S.drop - S.discLen / 2 - 5.0 * s + 0.3 * s;
  const solid = union([sk.ring, body, swivelPeg(d, -S.drop, neckLen)]).subtract(sk.cut);
  return { solid, features: [], pegs: [] };
}

/** Thigh / upper arm: swivel T-slot (with leaf spring) on top, hinge end at the origin. */
export function upperBone(d: Dims, L: number): FrameBuild {
  const s = d.s, S = d.swivel;
  const end = hingeEnd(d, L - 3.8 * s);
  const head = chamferedExtrude(poly([
    [-2.5 * s, L - 3.95 * s], [2.5 * s, L - 3.95 * s], [S.headHalfW, L - 2.45 * s],
    [S.headHalfW, L + S.headTop], [-S.headHalfW, L + S.headTop], [-S.headHalfW, L - 2.45 * s],
  ]), 0, d.T, 0);
  return { solid: end.add(head).subtract(swivelSlotCut(d, L)), features: [], pegs: [] };
}

/** Shin / forearm: hinge end at the origin, collar, ball at -L. */
export function lowerBone(d: Dims, L: number): FrameBuild {
  const s = d.s;
  const end = hingeEnd(d, L - 5.0 * s).rotate([0, 0, 180]);
  const collar = chamferedExtrude(rect(-3.0 * s, 3.0 * s, -L + 4.2 * s, -L + 5.2 * s), 0, d.T, 0.3 * s);
  return { solid: union([end, collar, ball(d, 0, -L, 90, 4.6 * s)]), features: [], pegs: [] };
}

export function clip(d: Dims): FrameBuild {
  return { solid: doubleClip(d), features: [], pegs: [] };
}

/** Ankle: socket (mouth up, tilted) with a tongue that presses into the foot. */
export function ankle(d: Dims, spec: FigureSpec): FrameBuild {
  const s = d.s;
  const sk = socket(d, 'limb', 0, 0, 90 - spec.style.ankleTilt);
  const tongue = chamferedExtrude(rect(-3.0 * s, 3.0 * s, -9.0 * s, -3.4 * s), 0, d.T, 0.3 * s);
  return { solid: union([sk.ring, tongue]).subtract(sk.cut), features: [], pegs: [] };
}

/** Centre of the grip hole (axis along x) in hand coordinates. */
export function gripCentre(d: Dims, spec: FigureSpec): [number, number, number] {
  const s = d.s, k = spec.style.handSize;
  return [0, -3.4 * s - 4.6 * s * k, Math.max(d.T, 6.2 * s) / 2];
}

/** Hands: socket on top (mouth up), hand hangs toward -y. Left hand thumb faces -x. */
export function hand(d: Dims, spec: FigureSpec, pose: HandPose, side: 'L' | 'R'): FrameBuild {
  const s = d.s, k = spec.style.handSize;
  const sk = socket(d, 'limb', 0, 0, 90);
  const top = -3.4 * s;
  const parts: Manifold[] = [sk.ring];
  const cuts: Manifold[] = [];
  if (pose === 'open') {
    const palmLen = 5.6 * s * k, palmHW = 3.9 * s * k;
    parts.push(chamferedExtrude(rect(-palmHW, palmHW, top - palmLen, top), 0, 3.6 * s, 0.4 * s));
    const fw = 1.5 * s * k, lens = [4.4, 5.4, 5.2, 4.2];
    lens.forEach((l, i) => {
      const cx = (-2.85 + i * 1.9) * s * k;
      parts.push(chamferedExtrude(rect(cx - fw / 2, cx + fw / 2, top - palmLen - l * s * k, top - palmLen + 0.5 * s), 0, 2.6 * s, 0.3 * s));
    });
    const thumb = chamferedExtrude(rect(-0.8 * s * k, 0.8 * s * k, -4.4 * s * k, 0.6 * s), 0, 2.8 * s, 0.3 * s)
      .rotate([0, 0, -40]).translate([-palmHW + 0.6 * s, top - 1.4 * s * k, 0]);
    parts.push(thumb);
  } else {
    const thick = Math.max(d.T, 6.2 * s);
    const len = 8.6 * s * k, hw = 4.2 * s * k;
    parts.push(chamferedExtrude(rect(-hw, hw, top - len, top), 0, thick, 0.8 * s));
    parts.push(chamferedExtrude(rect(-hw - 0.9 * s * k, -hw + 1.2 * s, top - 4.6 * s * k, top - 1.0 * s * k), 0, thick * 0.78, 0.5 * s));
    for (let i = 0; i < 3; i++) {
      const y = top - (3.2 + i * 1.9) * s * k;
      cuts.push(chamferedExtrude(rect(hw - 0.45 * s, hw + 1, y - 0.22 * s, y + 0.22 * s), 0.9 * s, thick + 1, 0));
    }
    if (pose === 'grip') cuts.push(teardropX(1.6 * s, -hw - 2 * s, hw + 2 * s, top - 4.6 * s * k, thick / 2));
  }
  let solid = union(parts).subtract(sk.cut);
  for (const c of cuts) solid = solid.subtract(c);
  if (side === 'R') solid = solid.mirror([1, 0, 0]);
  return { solid, features: [], pegs: [] };
}
