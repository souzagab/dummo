// Skeleton auto-fit check: build models around known skeletons, fit, compare joint positions.
//   node scripts/fitcheck.ts                  all cases (exit 1 if a joint is off by more than FIT_LIMIT mm)
//   FIT_ONLY="mannequin|Slim|thin|Rest" ...   one case; RIGFIT_DEBUG=1 and FIT_PNG=<dir> for diagnostics
// Two kinds of model:
//   statue    - dummo's own frame + armor (separate pieces with gaps, like kit-built statues)
//   mannequin - one fused body of capsules and blobs (like a sculpt or a game model), thin to chubby
import Module from 'manifold-3d';
import type { Manifold, Mat4 } from 'manifold-3d';
import { writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { buildersFor, partList } from '../src/core/catalog.ts';
import { applyPreset, defaultSpec, sanitizeSpec } from '../src/core/defaults.ts';
import { collect, initGeo, setSegments } from '../src/core/geometry/geo.ts';
import { mannequin, meshArrays } from './mannequin.ts';
import { jointDims } from '../src/core/geometry/kit.ts';
import { POSES, restToPosed } from '../src/core/pose.ts';
import { fitRig, type RigFit } from '../src/core/rigfit.ts';
import { buildRig, rigPoints } from '../src/core/skeleton.ts';
import type { FigureSpec, Pose, Vec3 } from '../src/core/types.ts';

const wasm = await Module();
wasm.setup();
initGeo(wasm);
setSegments(20);

function statue(spec: FigureSpec, pose: Pose) {
  const d = jointDims(spec);
  const solids = new Map<string, Manifold>();
  for (const g of buildersFor(spec)) { const r = g.build(d, spec); for (const k of g.keys) { const m = r[k]; if (m) solids.set(k, m); } }
  const posed = restToPosed(buildRig(spec), pose);
  const ms = partList(spec).filter((p) => p.node !== 'world' && solids.has(p.key) && p.group !== 'accessory')
    .map((p) => solids.get(p.key)!.transform(posed[p.node].clone().multiply(p.mount).elements as unknown as Mat4));
  const out = meshArrays(ms);
  collect();
  return out;
}

const NODE: Record<string, string> = { hip: 'hip', legDisc: 'thigh', kneeA: 'kneeClip', kneeB: 'shin', ankle: 'foot', shoulder: 'shoulder', armDisc: 'upperArm', elbowA: 'elbowClip', elbowB: 'forearm', wrist: 'hand' };
const TRUNK: Record<string, string> = { pelvis: 'pelvis', waistBall: 'abdomen', chestPivot: 'chest', neckSock: 'neck', headPivot: 'head' };
function joints(sp: FigureSpec, ps: Pose, shift: Vec3): Record<string, Vec3> {
  const posed = restToPosed(buildRig(sp), ps), rp = rigPoints(sp) as Record<string, Vec3>;
  const out: Record<string, Vec3> = {};
  for (const [k, v] of Object.entries(rp)) {
    const m = k.match(/^(.*)([LR])$/);
    const node = m && NODE[m[1]] ? NODE[m[1]] + m[2] : TRUNK[k] ?? 'pelvis';
    const w = new Vector3(...v).applyMatrix4(posed[node]);
    out[k] = [w.x + shift[0], w.y + shift[1], w.z + shift[2]];
  }
  return out;
}

/** Front view: solid (grey), traced paths (blue), fitted joints (red), true joints (green). */
function render(file: string, r: RigFit, spec: FigureSpec, pose: Pose) {
  const dbg = r.debug;
  if (!dbg) return;
  const f = dbg.field, S = 4, W = f.nx * S, Hh = f.ny * S;
  const img = new Uint8Array(W * Hh * 3).fill(255);
  const put = (wx: number, wy: number, c: number[], rad = 1) => {
    const px = Math.round(((wx - f.o[0]) / f.h) * S), py = Hh - 1 - Math.round(((wy - f.o[1]) / f.h) * S);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) { const x = px + dx, y = py + dy; if (x >= 0 && y >= 0 && x < W && y < Hh) img.set(c, (y * W + x) * 3); }
  };
  for (let y = 0; y < f.ny; y++) for (let x = 0; x < f.nx; x++) {
    let n = 0;
    for (let z = 0; z < f.nz; z++) n += dbg.mask[x + f.nx * (y + f.ny * z)];
    const c = 215 - Math.min(80, n * 4);
    if (n) for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) img.set([c, c, c], ((Hh - 1 - (y * S + dy)) * W + x * S + dx) * 3);
  }
  for (const p of dbg.paths) for (const q of p) put(q[0], q[1], [40, 90, 230], 1);
  for (const v of Object.values(joints(spec, pose, [0, 0, 0]))) put(v[0], v[1], [30, 170, 60], 2);
  for (const v of Object.values(joints({ ...spec, proportions: r.proportions }, r.pose, r.pelvis))) put(v[0], v[1], [230, 40, 40], 2);
  writeFileSync(file, Buffer.concat([Buffer.from(`P6 ${W} ${Hh} 255\n`), Buffer.from(img)]));
}

const KEY = ['hipL', 'hipR', 'kneeAL', 'kneeAR', 'ankleL', 'ankleR', 'shoulderL', 'shoulderR', 'elbowAL', 'elbowAR', 'wristL', 'wristR', 'chestPivot', 'neckSock', 'headPivot'];
function jointError(spec: FigureSpec, pose: Pose, r: RigFit): { worst: number; at: string } {
  const a = joints(spec, pose, [0, 0, 0]), b = joints({ ...spec, proportions: r.proportions }, r.pose, r.pelvis);
  let worst = 0, at = '';
  for (const k of KEY) {
    const d = Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1], a[k][2] - b[k][2]);
    if (d > worst) { worst = d; at = k; }
  }
  return { worst, at };
}

type Case = { kind: 'statue' | 'mannequin'; preset: string; body: string; pose: string; girth: number; head: number };
const cases: Case[] = [];
const bodies: [string, number, number][] = [['thin', 0.8, 1], ['average', 1.05, 1.15], ['chubby', 1.45, 1], ['bighead', 1, 1.6]];
const presets = (process.env.FIT_PRESETS ?? 'Standard,Heroic,Slim,Chibi,Brute').split(',');
for (const preset of presets) for (const pose of ['Rest', 'A-pose', 'T-pose']) {
  cases.push({ kind: 'statue', preset, body: '-', pose, girth: 1, head: 1 });
  // arms sunk into a chubby body in rest pose leave no trace of the arm to find: not tested
  for (const [body, girth, head] of bodies) if (!(body === 'chubby' && pose === 'Rest')) cases.push({ kind: 'mannequin', preset, body, pose, girth, head });
}
const LIMIT = Number(process.env.FIT_LIMIT ?? 6);
let worst = 0, failed = 0, n = 0;
const t0 = performance.now();
for (const c of cases) {
  const id = `${c.kind}|${c.preset}|${c.body}|${c.pose}`;
  if (process.env.FIT_ONLY && process.env.FIT_ONLY !== id) continue;
  n++;
  const spec = sanitizeSpec(applyPreset(defaultSpec(), c.preset));
  const pose = POSES[c.pose];
  const model = c.kind === 'statue' ? statue(spec, pose) : mannequin(spec, pose, c.girth, c.head);
  const r = fitRig(sanitizeSpec(defaultSpec()), model.positions, model.indices, !!process.env.FIT_PNG,
    process.env.FIT_ONLY ? { P: spec.proportions, pose, pelvis: [0, 0, 0] } : undefined);
  if (process.env.FIT_PNG) render(`${process.env.FIT_PNG}/${id.replace(/\|/g, '-')}.ppm`, r, spec, pose);
  const e = jointError(spec, pose, r);
  const bad = !r.ok || e.worst > LIMIT * spec.scale;
  if (bad) failed++;
  worst = Math.max(worst, e.worst);
  console.log(`${bad ? 'FAIL' : 'ok  '} ${id.padEnd(34)} worst joint ${e.worst.toFixed(1).padStart(5)} mm (${e.at})${r.ok ? '' : '  ' + r.notes.at(-1)}`);
}
console.log(`\n${failed} of ${n} off by more than ${LIMIT} mm; worst ${worst.toFixed(1)} mm; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
process.exit(failed ? 1 : 0);
