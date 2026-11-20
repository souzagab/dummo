// Automatic skeleton fitting: measure an imported humanoid model and return the proportions,
// bind pose and placement that put every dummo joint inside it.
//
//   1. voxelise the model into a solid (skin.ts solidField) and erode it slightly so limbs
//      that touch the body stay apart,
//   2. geodesic distances from the belly; the five longest branches of the distance tree are
//      the head, hands and feet,
//   3. each limb's path through the solid is its curve skeleton: legs and arms are fitted as
//      straight lines, the shoulder is the corner where the arm path turns into the chest,
//   4. torso lengths come from the hips, shoulders and neck, split like the default figure.
import type { FigureSpec, Pose, Proportions, Vec3 } from './types.ts';
import { DEFAULT_PROPORTIONS, PROPORTION_LIMITS } from './defaults.ts';
import { solidField, type Field } from './geometry/skin.ts';
import { POSES } from './pose.ts';
import { refineRig, ridgePoints, type FitState, type Targets } from './rigopt.ts';

export type RigFit = {
  ok: boolean;
  proportions: Proportions;
  pose: Pose;
  /** world point that becomes the pelvis (subtract it from the model offset) */
  pelvis: Vec3;
  notes: string[];
  /** landmarks in the model's current world space, for debugging and overlays */
  marks: Record<string, Vec3>;
  /** with `debug`: the voxel solid and the traced limb paths */
  debug?: { field: Field; mask: Uint8Array; paths: Vec3[][] };
};

const R2D = 180 / Math.PI;
const DROP = 8.75, PITCH = 6, FOOT_DROP = 10.1;

type Grid = { f: Field; mask: Uint8Array; cost: Float32Array; nx: number; ny: number; nz: number; h: number };

/** Fit dummo's skeleton to a model given in world space (already scaled and stood up). */
export function fitRig(spec: FigureSpec, positions: Float32Array, indices: Uint32Array, debug = false, truth?: FitState): RigFit {
  const notes: string[] = [];
  const s = spec.scale;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 1; i < positions.length; i += 3) { y0 = Math.min(y0, positions[i]); y1 = Math.max(y1, positions[i]); }
  const H = y1 - y0;
  const h = Math.max(0.4, H / 120);
  const f = solidField(positions, indices, h, Math.max(spec.skin.close, 2 * h), true);
  const DBG = (globalThis as { process?: { env: Record<string, string> } }).process?.env.RIGFIT_DEBUG;
  const tl = (m: string) => { if (DBG) console.log(`[rigfit] ${m} ${(performance.now() - T0).toFixed(0)}ms`); };
  const T0 = performance.now();
  tl('field');
  const marks: Record<string, Vec3> = {};
  const fail = (why: string): RigFit => ({ ok: false, proportions: { ...spec.proportions }, pose: {}, pelvis: [0, 0, 0], notes: [...notes, why], marks });

  // ---- geodesic tree from the belly; head, hands and feet are its longest branches ----
  // Arms that touch the body let paths cut across; eroding harder (the skin layer becomes
  // expensive) separates them, so erosion grows until both arms read as long branches.
  type Trace = { g: Grid; seed: number; dist: Float64Array; pred: Int32Array; cx: number; head: Tip; F: { L: Tip; R: Tip }; Hd: { L: Tip; R: Tip }; score: number };
  type Tip = { t: number; p: Vec3; len: number };
  const trace = (erode: number): Trace | string => {
    const g = grid(f, erode * h, Math.max(2 * h, 0.035 * H));
    const seed = pickSeed(g, y0, H);
    if (seed < 0) return 'no solid body found';
    const { dist, pred } = dijkstra(g, seed);
    const tips = branches(g, dist, pred, seed, 12);
    tl(`erode ${erode}: ${tips.map((t) => pos(g, t.t).map((v) => v.toFixed(0)).join(',') + ':' + t.len.toFixed(0)).join(' | ')}`);
    if (tips.length < 5) return 'could not find head, hands and feet';
    const cx = pos(g, seed)[0];
    // feet: the two lowest tips; head: highest tip near the middle; hands: per side, the tip
    // farthest from the belly along the body (spikes and elbows end sooner)
    const pts: Tip[] = tips.map((t) => ({ t: t.t, p: pos(g, t.t), len: t.len }));
    const byY = [...pts].sort((a, b) => a.p[1] - b.p[1]);
    const feet = byY.slice(0, 2);
    const others = byY.slice(2);
    const central = others.filter((q) => Math.abs(q.p[0] - cx) < 0.15 * H);
    const head = (central.length ? central : others).reduce((a, b) => (b.p[1] > a.p[1] ? b : a));
    // hands: per side, the tip that reaches farthest out and down from the upper chest
    // (elbows, shoulder spikes and horns reach less)
    const chestY = y0 + 0.72 * H;
    const reach = (q: Tip) => Math.abs(q.p[0] - cx) + Math.max(0, chestY - q.p[1]);
    const handOf = (sgn: number) => others.filter((q) => q !== head && sgn * (q.p[0] - cx) > 0 && q.p[1] > y0 + 0.2 * H).reduce<Tip | null>((a, b) => (!a || reach(b) > reach(a) ? b : a), null);
    const L = handOf(1), R = handOf(-1);
    if (!L || !R) return 'could not find both hands';
    const side = (two: Tip[]) => (two[0].p[0] > two[1].p[0] ? { L: two[0], R: two[1] } : { L: two[1], R: two[0] });
    // geometric length of each arm branch (cost-weighted lengths are not comparable)
    const armLen = (t: Tip) => { let n = 0; for (let i = t.t; i >= 0 && n < 1e6; i = pred[i]) { n++; if (dist[i] <= dist[t.t] - t.len) break; } return n * h; };
    return { g, seed, dist, pred, cx, head, F: side(feet), Hd: { L, R }, score: Math.min(armLen(L), armLen(R)) / H };
  };
  let tr: Trace | null = null;
  let why = '';
  for (const e of [0.5, 1.5, 2.5, 3.5]) {
    const t = trace(e);
    if (typeof t === 'string') { why ||= t; continue; }
    if (!tr || t.score > tr.score) tr = t;
    if (t.score >= 0.2) break;
  }
  if (!tr) return fail(why);
  tl(`using score ${tr.score.toFixed(2)}`);
  const { g, seed, pred, cx, head, F, Hd } = tr;
  if (F.L.p[0] <= cx || F.R.p[0] >= cx) notes.push('feet are not on both sides of the body');
  for (const [k, v] of Object.entries({ head: head.p, footL: F.L.p, footR: F.R.p, handL: Hd.L.p, handR: Hd.R.p })) marks[k] = v;
  if (Math.max(F.L.p[1], F.R.p[1]) > y0 + 0.2 * H) return fail('feet are not at the bottom (is the model upright?)');

  const path = (t: number) => { const out: number[] = []; for (let i = t; i >= 0; i = pred[i]) out.push(i); return out; };
  const heuristic = (): FitState | string => {
    const ground = y0;
    const seedY = pos(g, seed)[1];

    // ---- arms ----
    const trunk = path(head.t);
    const trunkPts = trunk.map((i) => ({ p: pos(g, i), r: f.sdf[i] }));
    const arm = (t: number, sgn: 1 | -1) => {
      const p = path(t);
      // cut the path where it joins the trunk (head -> belly)
      let j = p.length;
      for (let k = 0; k < p.length; k++) {
        const q = pos(g, p[k]);
        if (trunkPts.some((u) => dist3(u.p, q) < Math.max(u.r, h) + h)) { j = k; break; }
      }
      const pts = p.slice(0, j).map((i) => pos(g, i));
      const radii = p.slice(0, j).map((i) => Math.max(h, f.sdf[i]));
      if (pts.length < 6) return null;
      const tip = pts[0];
      // which way the arm leaves the hand: up (hanging arm) or sideways (T- or A-pose)
      let acc = 0, k0 = 0;
      while (k0 < pts.length - 1 && acc < 0.12 * H) { acc += dist3(pts[k0], pts[k0 + 1]); k0++; }
      const up = norm(sub(pts[k0], tip));
      let c: Vec3, dir: Vec3, rArm: number, sh: Vec3;
      const cents = up[1] > Math.cos(40 / R2D) ? walkUp(g, tip, sgn, cx, Math.max(2 * h, 0.035 * H)) : [];
      if (cents.length >= 8) {
        // hanging arm: climb it by cross-section centroids (robust to arms touching the body),
        // the pivot is one arm radius below the top of the shoulder
        const n = cents.length;
        const run = cents.slice(Math.floor(n * 0.3), Math.max(Math.floor(n * 0.85), Math.floor(n * 0.3) + 3)).map((u) => u.c);
        c = centroid(run);
        dir = principal(run);
        if (dot(dir, sub(tip, c)) < 0) dir = [-dir[0], -dir[1], -dir[2]];
        rArm = median(cents.slice(Math.floor(n * 0.3), Math.floor(n * 0.7)).map((u) => u.r));
        const topT = dot(sub(cents[n - 1].c, c), dir);
        sh = [c[0] + dir[0] * (topT + rArm), c[1] + dir[1] * (topT + rArm), c[2] + dir[2] * (topT + rArm)];
      } else {
        // raised arm: the path runs straight up the arm into the chest; the pivot is where the
        // axis meets the side of the chest (measured below the armpit, clear of the arms)
        const corner = twoSegment(pts);
        const kc = corner && corner.angle > 30 ? corner.k : pts.length - 1;
        const run = pts.slice(Math.floor(kc * 0.2), kc + 1);
        c = centroid(run);
        dir = principal(run);
        if (dot(dir, sub(tip, c)) < 0) dir = [-dir[0], -dir[1], -dir[2]];
        rArm = median(radii.slice(Math.floor(kc * 0.2), kc + 1));
        const half = torsoHalfWidth(g, cx, pos(g, seed)[1], pts[kc][1] - rArm);
        const tS = (sgn * half - (c[0] - cx)) / (dir[0] || 1e-6);
        sh = [c[0] + dir[0] * tS, c[1] + dir[1] * tS, c[2] + dir[2] * tS];
      }
      // wrist: back from the tip by the hand's length
      const reach = dot(sub(tip, sh), dir);
      const handLen = Math.max(8 * s, 0.22 * reach);
      const L = reach - handLen;
      const wr: Vec3 = [sh[0] + dir[0] * L, sh[1] + dir[1] * L, sh[2] + dir[2] * L];
      return { tip, sh, wr };
    };
    const aL = arm(Hd.L.t, 1), aR = arm(Hd.R.t, -1);
    if (!aL || !aR) return ('arms are joined to the body');
    marks.shoulderL = aL.sh; marks.shoulderR = aR.sh; marks.wristL = aL.wr; marks.wristR = aR.wr;

    // ---- legs ----
    const ankleY = ground + FOOT_DROP * s;
    const S0 = (aL.sh[1] + aR.sh[1]) / 2;
    // hips sit at ~65% of the shoulder height in dummo, in action figures and in people alike;
    // a measured crotch overrides that when it is plausible (a skirt or loincloth hides it)
    const hipPrior = ground + 0.651 * (S0 - ground);
    const crotch = crotchY(g, path(F.L.t), path(F.R.t), ground + 0.15 * H, seedY);
    let hipY = hipPrior;
    if (crotch !== null) {
      const fromCrotch = crotch + 0.05 * (S0 - ground);
      if (Math.abs(fromCrotch - hipPrior) < 0.08 * (S0 - ground)) hipY = fromCrotch;
      else notes.push('crotch hidden (skirt, loincloth or touching legs): hip height from proportions');
    }
    // leg axes: centre of each side's cross-section, below the hands
    const handLow = Math.min(Hd.L.p[1], Hd.R.p[1]);
    const yHi = Math.min(hipY - 0.15 * (hipY - ankleY), handLow > hipY - 0.6 * (hipY - ankleY) ? handLow - 0.03 * H : Infinity);
    const yLo = ankleY + 0.1 * (hipY - ankleY);
    const lL = sideLine(g, cx, 1, yLo, yHi), lR = sideLine(g, cx, -1, yLo, yHi);
    if (!lL || !lR) return ('could not trace the legs');
    const hipL = lL(hipY), hipR = lR(hipY);
    const hipHalf = (hipL[0] - hipR[0]) / 2;
    const pelvis: Vec3 = [(hipL[0] + hipR[0]) / 2, hipY, (hipL[2] + hipR[2]) / 2];
    const ankL = lL(ankleY), ankR = lR(ankleY);
    marks.hipL = hipL; marks.hipR = hipR; marks.ankleL = ankL; marks.ankleR = ankR;
    if (crotch !== null) marks.crotch = [cx, crotch, pelvis[2]];

    // ---- torso and head ----
    const S = S0;
    const top = head.p[1];
    let neck = -Infinity, rMin = Infinity;
    const rShoulder = maxR(trunkPts, S - 0.05 * H, S + 0.02 * H);
    for (const u of trunkPts) if (u.p[1] > S && u.p[1] < S + 0.5 * (top - S) && u.r < rMin) { rMin = u.r; neck = u.p[1]; }
    const hasNeck = isFinite(neck) && rMin < 0.65 * rShoulder;
    const P: Proportions = { ...spec.proportions };
    const lim = (k: keyof Proportions, v: number) => {
      const [lo, hi] = PROPORTION_LIMITS[k];
      if (v < lo - 0.5 || v > hi + 0.5) notes.push(`${k} ${v.toFixed(1)} is outside ${lo}–${hi}`);
      P[k] = round(Math.min(hi, Math.max(lo, v)));
    };
    // neck socket: just below the narrowest point of the neck, else a little above the shoulders
    const neckSock = hasNeck ? neck - 0.35 * (top - neck) * 0.5 : S + 3.5 * s;
    const neckLen = hasNeck ? (neck + 0.3 * (top - neck)) - neckSock : Math.min(14 * s, Math.max(7 * s, 0.32 * (top - S)));
    const span = (neckSock - hipY) / s;
    const D = DEFAULT_PROPORTIONS, dsum = D.waistLen + D.abdomenLen + D.chestLen;
    lim('waistLen', span * D.waistLen / dsum);
    lim('abdomenLen', span * D.abdomenLen / dsum);
    lim('chestLen', span - P.waistLen - P.abdomenLen);
    lim('neckLen', neckLen / s);
    const chestPivot = hipY + (P.waistLen + P.abdomenLen) * s;
    lim('shoulderY', (S - chestPivot) / s);
    P.shoulderY = Math.min(P.shoulderY, P.chestLen - 3.5);
    lim('shoulderHalf', ((aL.sh[0] - pelvis[0]) - (aR.sh[0] - pelvis[0])) / 2 / s);
    lim('hipHalf', hipHalf / s);
    const legLen = (dist3(hipL, ankL) + dist3(hipR, ankR)) / 2 / s - DROP - PITCH;
    lim('thighLen', legLen * D.thighLen / (D.thighLen + D.shinLen));
    lim('shinLen', legLen - P.thighLen);
    const armLen = (dist3(aL.sh, aL.wr) + dist3(aR.sh, aR.wr)) / 2 / s - DROP - PITCH;
    lim('upperArmLen', armLen * D.upperArmLen / (D.upperArmLen + D.forearmLen));
    lim('forearmLen', armLen - P.upperArmLen);

    // ---- bind pose: limb directions as joint angles (Euler ZXY, rest = straight down) ----
    const pose: Pose = {};
    const aim = (from: Vec3, to: Vec3): Vec3 => {
      const d = norm([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
      return [round(-Math.asin(d[2]) * R2D), 0, round(Math.atan2(d[0], -d[1]) * R2D)];
    };
    pose.hipL = aim(hipL, ankL); pose.hipR = aim(hipR, ankR);
    pose.shoulderL = aim(aL.sh, aL.wr); pose.shoulderR = aim(aR.sh, aR.wr);
    for (const k of Object.keys(pose)) if (pose[k].every((v) => Math.abs(v) < 0.5)) delete pose[k];
    return { P, pose, pelvis };
  };
  const ground = y0;
  const hs = heuristic();
  if (typeof hs === 'string') notes.push(`first guess failed (${hs}), fitting from proportions`);
  tl('heuristic');
  // ---- refine: bones inside the model, reaching its hands and feet, along its middle ----
  const targets: Targets = { handL: Hd.L.p, handR: Hd.R.p, footL: F.L.p, footR: F.R.p, head: head.p, ground };
  const kH = (head.p[1] - ground) / (140 * s);
  const starts: FitState[] = typeof hs === 'string' ? [] : [hs];
  for (const name of ['Rest', 'A-pose', 'T-pose']) {
    const P = { ...DEFAULT_PROPORTIONS };
    for (const k of Object.keys(P) as (keyof Proportions)[]) P[k] *= kH;
    starts.push({ P, pose: structuredClone(POSES[name]), pelvis: [cx, ground + 70.85 * kH * s, pos(g, seed)[2]] });
  }
  const ridge = ridgePoints(f);
  const best = refineRig(spec, f, ridge, targets, starts, H, truth ? [truth] : undefined);
  tl(`refined (${ridge.length / 3} ridge points, energy ${best.energy.toFixed(1)})`);
  const P: Proportions = { ...spec.proportions };
  for (const k of Object.keys(P) as (keyof Proportions)[]) {
    const [lo, hi] = PROPORTION_LIMITS[k];
    P[k] = round(Math.min(hi, Math.max(lo, best.state.P[k])));
  }
  P.shoulderY = Math.min(P.shoulderY, P.chestLen - 3.5);
  const pose: Pose = {};
  for (const [k, v] of Object.entries(best.state.pose)) if (v.some((x) => Math.abs(x) >= 0.5)) pose[k] = v.map(round) as Vec3;
  const pelvis = best.state.pelvis;
  const out: RigFit = { ok: true, proportions: P, pose, pelvis, notes, marks };
  if (debug) out.debug = { field: f, mask: g.mask, paths: [head.t, F.L.t, F.R.t, Hd.L.t, Hd.R.t].map((t) => path(t).map((i) => pos(g, i))) };
  return out;
}

// ---------------------------------------------------------------------------------------------

/**
 * Walkable voxels and their cost: the eroded core is cheapest, the skin layer costs more (so
 * limbs touching the body stay apart) and thin air gaps between separate pieces of a model
 * can be crossed at a high price.
 */
function grid(f: Field, erode: number, gap: number): Grid {
  const N = f.nx * f.ny * f.nz;
  const mask = new Uint8Array(N), cost = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = f.sdf[i];
    mask[i] = v > 0 ? 1 : 0;
    // 1/depth keeps shortest paths on the limbs' centre lines instead of hugging their edges
    cost[i] = v > erode ? 1 + (6 * f.h) / v : v > 0 ? 25 : v > -gap ? 60 : 0;
  }
  return { f, mask, cost, nx: f.nx, ny: f.ny, nz: f.nz, h: f.h };
}


function pos(g: Grid, i: number): Vec3 {
  const { nx, ny, h, f } = g;
  const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
  return [f.o[0] + x * h, f.o[1] + y * h, f.o[2] + z * h];
}

/** Deepest voxel of the belly: middle height band, near the vertical axis of the body. */
function pickSeed(g: Grid, y0: number, H: number): number {
  const { nx, ny, nz, mask, f } = g;
  let sx = 0, n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { sx += i % nx; n++; }
  if (!n) return -1;
  const cxi = sx / n;
  let best = -1, br = -Infinity;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    const wy = f.o[1] + y * g.h;
    if (wy < y0 + 0.45 * H || wy > y0 + 0.62 * H) continue;
    for (let x = 0; x < nx; x++) {
      const i = x + nx * (y + ny * z);
      if (!mask[i] || Math.abs(x - cxi) * g.h > 0.12 * H) continue;
      if (f.sdf[i] > br) { br = f.sdf[i]; best = i; }
    }
  }
  return best;
}

function dijkstra(g: Grid, seed: number): { dist: Float64Array; pred: Int32Array } {
  const { nx, ny, nz, cost, h } = g;
  const N = cost.length;
  const dist = new Float64Array(N).fill(Infinity);
  const pred = new Int32Array(N).fill(-1);
  const offs: [number, number, number, number][] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy && !dz) continue;
    offs.push([dx, dy, dz, h * Math.hypot(dx, dy, dz)]);
  }
  const heap = new MinHeap();
  dist[seed] = 0;
  heap.push(seed, 0);
  while (heap.size) {
    const [i, d] = heap.pop();
    if (d > dist[i]) continue;
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
    for (const [dx, dy, dz, w] of offs) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
      const j = X + nx * (Y + ny * Z);
      if (!cost[j]) continue;
      const nd = d + w * 0.5 * (cost[i] + cost[j]);
      if (nd < dist[j]) { dist[j] = nd; pred[j] = i; heap.push(j, nd); }
    }
  }
  return { dist, pred };
}

/**
 * Greedy longest branches of the shortest-path tree: each new tip is the voxel whose path to the
 * seed runs longest before reaching a branch already taken. Short spikes (horns, pauldron
 * points) lose to whole limbs.
 */
function branches(g: Grid, dist: Float64Array, pred: Int32Array, seed: number, n: number): { t: number; len: number }[] {
  const { nx, ny, nz, mask, f, h } = g;
  const N = mask.length;
  // candidate tips: local maxima of the distance
  const cand: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!mask[i] || !isFinite(dist[i])) continue;
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
    let top = true;
    for (let dz = -1; dz <= 1 && top; dz++) for (let dy = -1; dy <= 1 && top; dy++) for (let dx = -1; dx <= 1 && top; dx++) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
      const j = X + nx * (Y + ny * Z);
      if (mask[j] && dist[j] > dist[i]) top = false;
    }
    if (top) cand.push(i);
  }
  const taken = new Uint8Array(N);
  const mark = (i: number) => {
    const r = Math.max(1, Math.ceil(Math.max(f.sdf[i], h) / h));
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
    for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy + dz * dz > r * r) continue;
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
      taken[X + nx * (Y + ny * Z)] = 1;
    }
  };
  mark(seed);
  // voxels by increasing distance: a voxel's predecessor always comes first
  const order: number[] = [];
  for (let i = 0; i < N; i++) if (isFinite(dist[i])) order.push(i);
  order.sort((a, b) => dist[a] - dist[b]);
  const base = new Float64Array(N);
  const tips: { t: number; len: number }[] = [];
  for (let k = 0; k < n; k++) {
    // distance at which each voxel's path reaches the branches taken so far
    for (const i of order) base[i] = taken[i] || pred[i] < 0 ? dist[i] : base[pred[i]];
    let best = -1, bl = 0;
    for (const c of cand) {
      const len = dist[c] - base[c];
      if (len > bl) { bl = len; best = c; }
    }
    if (best < 0) break;
    tips.push({ t: best, len: bl });
    const run: number[] = [];
    for (let i = best; i >= 0 && !taken[i]; i = pred[i]) run.push(i);
    for (const i of run) mark(i);
  }
  return tips;
}

/**
 * Height where the legs join: scanning down from the belly, the first level at which the two
 * leg paths fall in separate pieces of the horizontal cross-section. Legs that touch lower down
 * (knees, boots) do not matter.
 */
function crotchY(g: Grid, pathL: number[], pathR: number[], lowest: number, from: number): number | null {
  const { nx, ny, nz, f, h } = g;
  // eroded by a voxel, so legs that merely touch count as apart
  const mask = g.f.sdf.map((v) => (v > 0.6 * h ? 1 : 0));
  const at = (path: number[], yi: number) => {
    let best = -1, bd = Infinity;
    for (const i of path) { const d = Math.abs((((i / nx) | 0) % ny) - yi); if (d < bd) { bd = d; best = i; } }
    return bd <= 1 ? best : -1;
  };
  const seen = new Int32Array(nx * nz).fill(-1);
  const q = new Int32Array(nx * nz);
  const yTop = Math.round((from - f.o[1]) / h), yLow = Math.round((lowest - f.o[1]) / h);
  for (let y = yTop; y >= yLow; y--) {
    const a = at(pathL, y), b = at(pathR, y);
    if (a < 0 || b < 0) continue;
    const ax = a % nx, az = (a / (nx * ny)) | 0, bx = b % nx, bz = (b / (nx * ny)) | 0;
    if (!mask[ax + nx * (y + ny * az)] || !mask[bx + nx * (y + ny * bz)]) continue;
    // flood the slice from the left leg
    let qh = 0, qt = 0, joined = false;
    q[qt++] = ax + nx * az; seen[ax + nx * az] = y;
    while (qh < qt && !joined) {
      const c = q[qh++], x = c % nx, z = (c / nx) | 0;
      if (x === bx && z === bz) joined = true;
      for (const [X, Z] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
        if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
        const k = X + nx * Z;
        if (seen[k] === y || !mask[X + nx * (y + ny * Z)]) continue;
        seen[k] = y; q[qt++] = k;
      }
    }
    if (!joined) return f.o[1] + (y + 0.5) * h;
  }
  return null;
}

/**
 * Climb a hanging arm from the hand: centroid of the solid inside a small window around the
 * arm's axis, one voxel row at a time, until the solid ends above the shoulder. The window
 * follows the arm slowly, so a body touching the arm cannot pull it away.
 */
function walkUp(g: Grid, tip: Vec3, sgn: 1 | -1, cx: number, gap: number): { c: Vec3; r: number }[] {
  const { nx, ny, nz, mask, f, h } = g;
  const out: { c: Vec3; r: number }[] = [];
  let px = tip[0], pz = tip[2], r = 3 * h, miss = 0;
  // only solid that rests on the previous row counts, so the walk cannot jump to a head or
  // a shoulder pad that merely sits next to the arm
  let prev: Uint8Array | null = null;
  for (let y = Math.max(0, Math.round((tip[1] - f.o[1]) / h)); y < ny; y++) {
    const W = Math.max(2.5 * h, 1.5 * r);
    const x0 = Math.max(0, Math.floor((px - W - f.o[0]) / h)), x1 = Math.min(nx - 1, Math.ceil((px + W - f.o[0]) / h));
    const z0 = Math.max(0, Math.floor((pz - W - f.o[2]) / h)), z1 = Math.min(nz - 1, Math.ceil((pz + W - f.o[2]) / h));
    const cur = new Uint8Array(nx * nz);
    let sx = 0, sz = 0, n = 0;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (!mask[x + nx * (y + ny * z)]) continue;
      const wx = f.o[0] + x * h, wz = f.o[2] + z * h;
      if ((wx - px) ** 2 + (wz - pz) ** 2 > W * W) continue;
      if (prev) {
        const k = x + nx * z;
        if (!prev[k] && !(x > 0 && prev[k - 1]) && !(x < nx - 1 && prev[k + 1]) && !(z > 0 && prev[k - nx]) && !(z < nz - 1 && prev[k + nx])) continue;
      }
      cur[x + nx * z] = 1;
      sx += wx; sz += wz; n++;
    }
    if (n) prev = cur;
    if (!n) { if (++miss * h > gap) break; continue; }
    miss = 0;
    const mx = sx / n, mz = sz / n, rr = Math.sqrt((n * h * h) / Math.PI);
    out.push({ c: [mx, f.o[1] + y * h, mz], r: rr });
    // follow slowly; never towards the body's middle line
    const step = 0.4 * h;
    const nxp = px + Math.max(-step, Math.min(step, mx - px));
    if (sgn * (nxp - cx) > 0.5 * r) px = nxp;
    pz += Math.max(-step, Math.min(step, mz - pz));
    if (out.length < 6 || rr < 1.3 * r) r = 0.8 * r + 0.2 * rr;
    if (out.length > 400) break;
  }
  return out;
}

/** Half width of the body's middle piece (arms excluded) between the crotch and the armpits. */
function torsoHalfWidth(g: Grid, cx: number, crotch: number, top: number): number {
  const { nx, ny, nz, mask, f, h } = g;
  const xi = Math.round((cx - f.o[0]) / h);
  const ys = [0.55, 0.7, 0.85].map((t) => Math.round((crotch + t * (top - crotch) - f.o[1]) / h));
  let w = 0;
  for (const y of ys) {
    if (y < 0 || y >= ny) continue;
    // walk out from the middle until a column with no solid
    const run = (dir: 1 | -1) => {
      let x = xi;
      for (; x >= 0 && x < nx; x += dir) {
        let any = false;
        for (let z = 0; z < nz && !any; z++) any = mask[x + nx * (y + ny * z)] === 1;
        if (!any) break;
      }
      return Math.abs(x - xi) * h;
    };
    w = Math.max(w, (run(1) + run(-1)) / 2);
  }
  return w;
}

/** Axis of one leg: centroids of that side's cross-sections between two heights. */
function sideLine(g: Grid, cx: number, sgn: 1 | -1, yLo: number, yHi: number): ((y: number) => Vec3) | null {
  const { nx, ny, nz, mask, f, h } = g;
  const pts: Vec3[] = [];
  const a = Math.max(0, Math.ceil((yLo - f.o[1]) / h)), b = Math.min(ny - 1, Math.floor((yHi - f.o[1]) / h));
  for (let y = a; y <= b; y++) {
    let sx = 0, sz = 0, n = 0;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const wx = f.o[0] + x * h;
      if (sgn * (wx - cx) <= 0 || !mask[x + nx * (y + ny * z)]) continue;
      sx += wx; sz += f.o[2] + z * h; n++;
    }
    if (n) pts.push([sx / n, f.o[1] + y * h, sz / n]);
  }
  return pts.length >= 4 ? lineOnY(pts) : null;
}

/** Fit x(y), z(y) lines to roughly vertical points. */
function lineOnY(p: Vec3[]): (y: number) => Vec3 {
  let my = 0, mx = 0, mz = 0;
  for (const q of p) { my += q[1]; mx += q[0]; mz += q[2]; }
  my /= p.length; mx /= p.length; mz /= p.length;
  let syy = 0, sxy = 0, szy = 0;
  for (const q of p) { const dy = q[1] - my; syy += dy * dy; sxy += dy * (q[0] - mx); szy += dy * (q[2] - mz); }
  const bx = syy > 1e-9 ? sxy / syy : 0, bz = syy > 1e-9 ? szy / syy : 0;
  return (y) => [mx + bx * (y - my), y, mz + bz * (y - my)];
}

/** Best split of a polyline into two straight runs; angle between them in degrees. */
function twoSegment(p: Vec3[]): { k: number; angle: number } | null {
  const n = p.length;
  if (n < 8) return null;
  let best = -1, be = Infinity;
  // both runs at least a quarter of the path: a bent hand or a kink near the end is no corner
  for (let k = Math.max(3, Math.floor(n / 4)); k < Math.min(n - 3, Math.ceil((3 * n) / 4)); k++) {
    const e = lineErr(p, 0, k) + lineErr(p, k, n - 1);
    if (e < be) { be = e; best = k; }
  }
  if (best < 0) return null;
  const a = norm(sub(p[best], p[0])), b = norm(sub(p[n - 1], p[best]));
  return { k: best, angle: Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * R2D };
}

function lineErr(p: Vec3[], i: number, j: number): number {
  const a = p[i], d = norm(sub(p[j], a));
  let e = 0;
  for (let k = i; k <= j; k++) {
    const v = sub(p[k], a), t = dot(v, d);
    e += dot(v, v) - t * t;
  }
  return e;
}

function maxR(pts: { p: Vec3; r: number }[], lo: number, hi: number): number {
  let r = 0;
  for (const u of pts) if (u.p[1] >= lo && u.p[1] <= hi) r = Math.max(r, u.r);
  return r || 1;
}

function centroid(p: Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const q of p) { c[0] += q[0] / p.length; c[1] += q[1] / p.length; c[2] += q[2] / p.length; }
  return c;
}

/** Main direction of a point cloud (power iteration on the covariance). */
function principal(p: Vec3[]): Vec3 {
  const c = centroid(p);
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const q of p) {
    const d = sub(q, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[3 * i + j] += d[i] * d[j];
  }
  let v: Vec3 = norm(sub(p[p.length - 1], p[0]));
  for (let k = 0; k < 30; k++) v = norm([C[0] * v[0] + C[1] * v[1] + C[2] * v[2], C[3] * v[0] + C[4] * v[1] + C[5] * v[2], C[6] * v[0] + C[7] * v[1] + C[8] * v[2]]);
  return v;
}

function median(a: number[]): number {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[b.length >> 1] : 0;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const round = (v: number) => Math.round(v * 10) / 10;

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number { return this.ids.length; }
  push(id: number, key: number): void {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p]; i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop(): [number, number] {
    const ids = this.ids, keys = this.keys;
    const top: [number, number] = [ids[0], keys[0]];
    const lid = ids.pop()!, lk = keys.pop()!;
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < n && keys[l] < mk) { m = l; mk = keys[l]; }
        if (r < n && keys[r] < mk) { m = r; mk = keys[r]; }
        if (m === i) break;
        ids[i] = ids[m]; keys[i] = keys[m]; i = m;
      }
      ids[i] = lid; keys[i] = lk;
    }
    return top;
  }
}
