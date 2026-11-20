// Model-based refinement of a fitted skeleton: adjust proportions, limb angles and placement so
// that dummo's bones (a) lie inside the model, (b) reach its hands and feet and (c) run along
// its medial axis (every "ridge" voxel of the solid is near some bone). Coordinate descent from
// a few starting guesses; the best end state wins.
import { Vector3 } from 'three';
import type { FigureSpec, Pose, Proportions, Vec3 } from './types.ts';
import { DEFAULT_PROPORTIONS, PROPORTION_LIMITS } from './defaults.ts';
import { buildRig, clampPose, type Rig } from './skeleton.ts';
import { restToPosed } from './pose.ts';
import type { Field } from './geometry/skin.ts';

export type FitState = { P: Proportions; pose: Pose; pelvis: Vec3 };
export type Targets = { handL: Vec3; handR: Vec3; footL: Vec3; footR: Vec3; head: Vec3; ground: number };

const FOOT_DROP = 10.1;
const HAND = 0.22; // hand length as a share of shoulder -> fingertip

type Params = Float64Array;
// parameter layout
const PX = 0, PY = 1, PZ = 2, HIP = 3, SPINE = 4, CHEST = 5, SHY = 6, SHX = 7, NECK = 8, THIGH = 9, SHIN = 10, UARM = 11, FARM = 12,
  SLX = 13, SLZ = 14, SRX = 15, SRZ = 16, ELL = 17, ELR = 18, HLX = 19, HLZ = 20, HRX = 21, HRZ = 22, KNL = 23, KNR = 24, NP = 25;

const D = DEFAULT_PROPORTIONS;
const SPINE_SPLIT = D.waistLen / (D.waistLen + D.abdomenLen);

function toParams(st: FitState): Params {
  const p = new Float64Array(NP), P = st.P, q = st.pose;
  p[PX] = st.pelvis[0]; p[PY] = st.pelvis[1]; p[PZ] = st.pelvis[2];
  p[HIP] = P.hipHalf; p[SPINE] = P.waistLen + P.abdomenLen; p[CHEST] = P.chestLen; p[SHY] = P.shoulderY; p[SHX] = P.shoulderHalf;
  p[NECK] = P.neckLen; p[THIGH] = P.thighLen; p[SHIN] = P.shinLen; p[UARM] = P.upperArmLen; p[FARM] = P.forearmLen;
  p[SLX] = q.shoulderL?.[0] ?? 0; p[SLZ] = q.shoulderL?.[2] ?? 0; p[SRX] = q.shoulderR?.[0] ?? 0; p[SRZ] = q.shoulderR?.[2] ?? 0;
  p[ELL] = (q.elbowClipL?.[0] ?? 0) + (q.forearmL?.[0] ?? 0); p[ELR] = (q.elbowClipR?.[0] ?? 0) + (q.forearmR?.[0] ?? 0);
  p[HLX] = q.hipL?.[0] ?? 0; p[HLZ] = q.hipL?.[2] ?? 0; p[HRX] = q.hipR?.[0] ?? 0; p[HRZ] = q.hipR?.[2] ?? 0;
  p[KNL] = (q.kneeClipL?.[0] ?? 0) + (q.shinL?.[0] ?? 0); p[KNR] = (q.kneeClipR?.[0] ?? 0) + (q.shinR?.[0] ?? 0);
  return p;
}

function toState(p: Params): FitState {
  const P: Proportions = {
    hipHalf: p[HIP], waistLen: p[SPINE] * SPINE_SPLIT, abdomenLen: p[SPINE] * (1 - SPINE_SPLIT), chestLen: p[CHEST], shoulderY: p[SHY],
    shoulderHalf: p[SHX], neckLen: p[NECK], thighLen: p[THIGH], shinLen: p[SHIN], upperArmLen: p[UARM], forearmLen: p[FARM],
  };
  const pose: Pose = {
    shoulderL: [p[SLX], 0, p[SLZ]], shoulderR: [p[SRX], 0, p[SRZ]],
    elbowClipL: [p[ELL] / 2, 0, 0], forearmL: [p[ELL] / 2, 0, 0], elbowClipR: [p[ELR] / 2, 0, 0], forearmR: [p[ELR] / 2, 0, 0],
    hipL: [p[HLX], 0, p[HLZ]], hipR: [p[HRX], 0, p[HRZ]],
    kneeClipL: [p[KNL] / 2, 0, 0], shinL: [p[KNL] / 2, 0, 0], kneeClipR: [p[KNR] / 2, 0, 0], shinR: [p[KNR] / 2, 0, 0],
  };
  return { P, pose, pelvis: [p[PX], p[PY], p[PZ]] };
}

/** Keep parameters inside dummo's limits. */
function clampParams(p: Params, rig: Rig): void {
  const lim = (i: number, lo: number, hi: number) => { p[i] = Math.min(hi, Math.max(lo, p[i])); };
  const L = PROPORTION_LIMITS;
  lim(HIP, L.hipHalf[0], L.hipHalf[1]);
  lim(SPINE, L.waistLen[0] + L.abdomenLen[0], L.waistLen[1] + L.abdomenLen[1]);
  lim(CHEST, L.chestLen[0], L.chestLen[1]);
  lim(SHY, L.shoulderY[0], Math.min(L.shoulderY[1], p[CHEST] - 3.5));
  lim(SHX, L.shoulderHalf[0], L.shoulderHalf[1]);
  lim(NECK, L.neckLen[0], L.neckLen[1]);
  lim(THIGH, L.thighLen[0], L.thighLen[1]); lim(SHIN, L.shinLen[0], L.shinLen[1]);
  lim(UARM, L.upperArmLen[0], L.upperArmLen[1]); lim(FARM, L.forearmLen[0], L.forearmLen[1]);
  const jl = (i: number, node: string, axis: number, k = 1) => lim(i, rig.byId[node].limits[axis][0] * k, rig.byId[node].limits[axis][1] * k);
  jl(SLX, 'shoulderL', 0); jl(SLZ, 'shoulderL', 2); jl(SRX, 'shoulderR', 0); jl(SRZ, 'shoulderR', 2);
  jl(ELL, 'elbowClipL', 0, 2); jl(ELR, 'elbowClipR', 0, 2);
  jl(HLX, 'hipL', 0); jl(HLZ, 'hipL', 2); jl(HRX, 'hipR', 0); jl(HRZ, 'hipR', 2);
  jl(KNL, 'kneeClipL', 0, 2); jl(KNR, 'kneeClipR', 0, 2);
}

type Seg = { a: Vec3; b: Vec3; inside: boolean };

/** Bone segments of a state, in world space. */
function segments(spec: FigureSpec, st: FitState, t: Targets): { segs: Seg[]; handL: Vec3; handR: Vec3; toeL: Vec3; toeR: Vec3 } {
  const sp = { ...spec, proportions: st.P };
  const rig = buildRig(sp);
  const posed = restToPosed(rig, st.pose);
  const s = spec.scale, p = rig.points as Record<string, Vec3>;
  const v = new Vector3();
  const W = (node: string, q: Vec3): Vec3 => { v.set(q[0], q[1], q[2]).applyMatrix4(posed[node]); return [v.x + st.pelvis[0], v.y + st.pelvis[1], v.z + st.pelvis[2]]; };
  const segs: Seg[] = [];
  const add = (a: Vec3, b: Vec3, inside = true) => segs.push({ a, b, inside });
  add(W('waist', p.pelvis), W('waist', p.waistBall));
  add(W('abdomen', p.waistBall), W('abdomen', p.chestPivot));
  add(W('chest', p.chestPivot), W('chest', p.neckSock));
  add(W('chest', p.shoulderL), W('chest', p.shoulderR));
  add(W('neck', p.neckSock), W('neck', p.headPivot));
  // the head core (frame plate up to 10.5 mm) must sit inside the head; the tip only steers coverage
  add(W('head', p.headPivot), W('head', [p.headPivot[0], p.headPivot[1] + 10.5 * s, p.headPivot[2]]));
  add(W('head', p.headPivot), t.head, false);
  add(W('pelvis', p.hipL), W('pelvis', p.hipR));
  const ends: Record<string, Vec3> = {};
  for (const S of ['L', 'R'] as const) {
    const q = (k: string) => p[k + S];
    add(W(`shoulder${S}`, q('shoulder')), W(`upperArm${S}`, q('elbowA')));
    add(W(`elbowClip${S}`, q('elbowA')), W(`forearm${S}`, q('elbowB')));
    const wrist = W(`forearm${S}`, q('wrist'));
    add(W(`forearm${S}`, q('elbowB')), wrist);
    // hand: continues the forearm by a share of the whole arm's length
    const armLen = (8.75 + 6 + st.P.upperArmLen + st.P.forearmLen) * s;
    const hl = (HAND / (1 - HAND)) * armLen;
    const hand = W(`forearm${S}`, [q('wrist')[0], q('wrist')[1] - hl, q('wrist')[2]]);
    add(wrist, hand, false);
    ends[`hand${S}`] = hand;
    add(W(`hip${S}`, q('hip')), W(`thigh${S}`, q('kneeA')));
    add(W(`kneeClip${S}`, q('kneeA')), W(`shin${S}`, q('kneeB')));
    const ankle = W(`shin${S}`, q('ankle'));
    add(W(`shin${S}`, q('kneeB')), ankle);
    const toe = W(`foot${S}`, [q('ankle')[0], q('ankle')[1] - FOOT_DROP * s, q('ankle')[2] + 9 * s]);
    add(ankle, toe, false);
    ends[`toe${S}`] = toe;
  }
  return { segs, handL: ends.handL, handR: ends.handR, toeL: ends.toeL, toeR: ends.toeR };
}

function segDist2(px: number, py: number, pz: number, a: Vec3, b: Vec3): number {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const l2 = ux * ux + uy * uy + uz * uz;
  let t = l2 > 0 ? ((px - a[0]) * ux + (py - a[1]) * uy + (pz - a[2]) * uz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - a[0] - t * ux, dy = py - a[1] - t * uy, dz = pz - a[2] - t * uz;
  return dx * dx + dy * dy + dz * dz;
}

/** Voxels on the solid's medial ridge (local maxima of depth), at most `max` of them. */
export function ridgePoints(f: Field, max = 1800): Float32Array {
  const { nx, ny, nz, h, o, sdf } = f;
  const out: number[] = [];
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const i = x + nx * (y + ny * z), v = sdf[i];
    if (v < 0.9 * h) continue;
    let ridge = 0;
    // a ridge in at least two of the three axis directions (tube centre lines and sheet middles)
    if (v >= sdf[i - 1] && v >= sdf[i + 1]) ridge++;
    if (v >= sdf[i - nx] && v >= sdf[i + nx]) ridge++;
    if (v >= sdf[i - nx * ny] && v >= sdf[i + nx * ny]) ridge++;
    if (ridge >= 2) out.push(o[0] + x * h, o[1] + y * h, o[2] + z * h);
  }
  const n = out.length / 3, step = Math.max(1, n / max);
  const res: number[] = [];
  for (let k = 0; k < n; k += step) { const j = Math.floor(k) * 3; res.push(out[j], out[j + 1], out[j + 2]); }
  return new Float32Array(res);
}

export function refineRig(spec: FigureSpec, f: Field, ridge: Float32Array, t: Targets, starts: FitState[], H: number, explain?: FitState[]): { state: FitState; energy: number } {
  const rig = buildRig(spec);
  const h = f.h;
  const sample = (x: number, y: number, z: number) => {
    const i = Math.round((x - f.o[0]) / h), j = Math.round((y - f.o[1]) / h), k = Math.round((z - f.o[2]) / h);
    if (i < 0 || j < 0 || k < 0 || i >= f.nx || j >= f.ny || k >= f.nz) return -h * 4;
    return f.sdf[i + f.nx * (j + f.ny * k)];
  };
  const T2 = (0.12 * H) ** 2;
  // bones want some flesh around them: frame parts are ~3 mm thick on each side of the axis
  const margin = Math.max(0.5 * h, 2 * spec.scale);
  const nR = ridge.length / 3;
  const s = spec.scale;
  // proportions prior: the default figure scaled to the model's height
  const kH = (t.head[1] - t.ground) / (140 * s);
  const prior = toParams({ P: { ...D }, pose: {}, pelvis: [0, 0, 0] });
  const energy = (p: Params, parts?: Record<string, number>): number => {
    const st = toState(p);
    const { segs, handL, handR, toeL, toeR } = segments(spec, st, t);
    // (c) coverage of the medial ridge
    let cov = 0;
    for (let r = 0; r < nR; r++) {
      const x = ridge[3 * r], y = ridge[3 * r + 1], z = ridge[3 * r + 2];
      let m = T2;
      for (const sg of segs) { const d = segDist2(x, y, z, sg.a, sg.b); if (d < m) m = d; }
      cov += m;
    }
    cov /= nR;
    // (b) reach the extremities
    const d2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    // feet: the detected tip may be a toe or a heel, so only the ground contact counts
    const ext = d2(handL, t.handL) + d2(handR, t.handR);
    // (a) bones inside the solid
    let out = 0, n = 0;
    for (const sg of segs) {
      if (!sg.inside) continue;
      const L = Math.sqrt(segDist2(sg.b[0], sg.b[1], sg.b[2], sg.a, sg.a));
      const k = Math.max(2, Math.ceil(L / h));
      for (let i = 0; i <= k; i++) {
        const u = i / k;
        const v = sample(sg.a[0] + (sg.b[0] - sg.a[0]) * u, sg.a[1] + (sg.b[1] - sg.a[1]) * u, sg.a[2] + (sg.b[2] - sg.a[2]) * u);
        if (v < margin) out += (margin - v) ** 2;
        n++;
      }
    }
    out /= Math.max(1, n);
    // feet on the ground
    const ground = ((toeL[1] + toeR[1]) / 2 - t.ground) ** 2;
    // proportions prior (weak)
    let pr = 0;
    // widths vary far more between characters than lengths do
    for (let i = HIP; i <= FARM; i++) { const q = prior[i] * kH, sd = i === HIP || i === SHX ? 0.8 : 0.4; pr += ((p[i] - q) / (sd * q)) ** 2; }
    if (parts) Object.assign(parts, { cov, ext: 0.15 * ext, out: 3 * out, ground: 0.5 * ground, prior: pr });
    return cov + 0.15 * ext + 3 * out + 0.5 * ground + pr;
  };
  if (explain) { const sg = segments(spec, explain[0], t); console.log('[rigopt] truth ends', JSON.stringify({ handL: sg.handL, handR: sg.handR, toeL: sg.toeL, toeR: sg.toeR }), 'targets', JSON.stringify(t)); }
  if (explain) for (const st0 of [...explain, ...starts]) { const parts: Record<string, number> = {}; const e = energy(toParams(st0), parts); console.log('[rigopt] energy', e.toFixed(1), JSON.stringify(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, +v.toFixed(1)])))); }
  const steps = new Float64Array(NP);
  for (let i = 0; i < NP; i++) steps[i] = i <= PZ ? 3 * s : i <= FARM ? 2 : 10;
  let best: { state: FitState; energy: number } | null = null;
  for (const st0 of starts) {
    const p = toParams(st0);
    clampParams(p, rig);
    let e = energy(p);
    const st = Float64Array.from(steps);
    for (let round = 0; round < 7; round++) {
      let improved = true, passes = 0;
      while (improved && passes++ < 6) {
        improved = false;
        for (let i = 0; i < NP; i++) {
          for (const dirn of [1, -1]) {
            const old = p[i];
            p[i] = old + dirn * st[i];
            clampParams(p, rig);
            const e2 = energy(p);
            if (e2 < e - 1e-9) { e = e2; improved = true; break; }
            p[i] = old;
          }
        }
      }
      for (let i = 0; i < NP; i++) st[i] *= 0.5;
    }
    if (explain) { const parts: Record<string, number> = {}; energy(p, parts); console.log('[rigopt] end', e.toFixed(1), JSON.stringify(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, +v.toFixed(1)]))), JSON.stringify(toState(p).pose.shoulderL)); }
    // the first start (the measured guess) wins near-ties
    if (!best || e < best.energy * 0.97) best = { state: toState(p), energy: e };
  }
  const out = best!;
  out.state.pose = clampPose(rig, out.state.pose);
  return out;
}
