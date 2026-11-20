// Headless geometry check: builds every part for each preset, verifies the solids are valid
// and that nothing collides in the rest pose except intended joint interference.
// Run: node scripts/check.ts [--fast]
import Module from 'manifold-3d';
import type { Manifold, Mat4 } from 'manifold-3d';
import { BUILDERS, buildersFor, CALIBRATION, partList, type BuildCtx } from '../src/core/catalog.ts';
import { createSkinContext, modelId } from '../src/core/skinctx.ts';
import { fitRig } from '../src/core/rigfit.ts';
import { mannequin } from './mannequin.ts';
import { isWatertight, meshOf } from '../src/core/geometry/mesh.ts';
import { applyPreset, defaultSpec, PRESETS, sanitizeSpec } from '../src/core/defaults.ts';
import { collect, initGeo, setSegments } from '../src/core/geometry/geo.ts';
import { jointDims } from '../src/core/geometry/kit.ts';
import { POSES, restToPosed } from '../src/core/pose.ts';
import { buildRig } from '../src/core/skeleton.ts';
import type { FigureSpec } from '../src/core/types.ts';

const wasm = await Module();
wasm.setup();
initGeo(wasm);
setSegments(process.argv.includes('--fast') ? 24 : 40);

// Pairs whose overlap is intended: joint interference, crush ribs, pegs.
const EXPECTED = (a: string, b: string) => {
  const k = [a, b].sort().join('|');
  const pairs = [
    'pelvis|waist', 'abdomen|waist', 'abdomen|chest', 'chest|neck', 'head-frame|neck',
    'hip-swivel-L|pelvis', 'hip-swivel-R|pelvis', 'hip-swivel-L|thigh-L', 'hip-swivel-R|thigh-R',
    'knee-L|thigh-L', 'knee-R|thigh-R', 'knee-L|shin-L', 'knee-R|shin-R', 'ankle-L|shin-L', 'ankle-R|shin-R',
    'chest|shoulder-swivel-L', 'chest|shoulder-swivel-R', 'shoulder-swivel-L|upper-arm-L', 'shoulder-swivel-R|upper-arm-R',
    'elbow-L|upper-arm-L', 'elbow-R|upper-arm-R', 'elbow-L|forearm-L', 'elbow-R|forearm-R', 'forearm-L|hand-L', 'forearm-R|hand-R',
    'thigh-L|thigh-sleeve-L', 'thigh-R|thigh-sleeve-R', 'shin-L|shin-sleeve-L', 'shin-R|shin-sleeve-R',
    'upper-arm-L|upper-arm-sleeve-L', 'upper-arm-R|upper-arm-sleeve-R', 'forearm-L|forearm-sleeve-L', 'forearm-R|forearm-sleeve-R',
    'ankle-L|foot-L', 'ankle-R|foot-R',
  ];
  const halves = ['head', 'chest', 'abdomen', 'pelvis'].map((x) => `${x}-back|${x}-front`);
  return pairs.includes(k) || halves.includes(k);
};

let failures = 0;
const fail = (msg: string) => { failures++; console.log('  FAIL ' + msg); };

function checkSpec(name: string, spec: FigureSpec, ctx: BuildCtx = {}) {
  const t0 = performance.now();
  const d = jointDims(spec);
  const solids = new Map<string, Manifold>();
  for (const g of buildersFor(spec)) {
    const res = g.build(d, spec, ctx);
    for (const k of g.keys) {
      const m = res[k];
      if (!m) continue;
      if (m.status() !== 'NoError') fail(`${name}: ${k} status ${m.status()}`);
      if (m.isEmpty() || m.volume() < 1) fail(`${name}: ${k} empty (vol ${m.volume().toFixed(2)})`);
      const bb = m.boundingBox();
      if (!k.startsWith('stand') && !k.startsWith('foot') && !k.includes('sleeve') && !k.endsWith('-front') && !k.endsWith('-back') && bb.min[2] < -1e-3)
        fail(`${name}: ${k} below the bed (z ${bb.min[2].toFixed(3)})`);
      if (!isWatertight(meshOf(m))) fail(`${name}: ${k} exports a mesh that is not watertight`);
      const parts = m.decompose();
      if (parts.length > 1 && !k.endsWith('-back')) fail(`${name}: ${k} has ${parts.length} disconnected pieces`);
      solids.set(k, m);
    }
  }
  const defs = partList(spec).filter((p) => (p.group !== 'accessory' || p.key === 'weapon') && p.node !== 'world' && solids.has(p.key));
  const posed = restToPosed(buildRig(spec), spec.skin.enabled ? spec.skin.bindPose : POSES.Rest);
  const world = defs.map((p) => ({
    id: p.id, group: p.group,
    m: solids.get(p.key)!.transform(posed[p.node].clone().multiply(p.mount).elements as unknown as Mat4),
  }));
  const boxes = world.map((w) => w.m.boundingBox());
  const hits: string[] = [];
  for (let i = 0; i < world.length; i++) for (let j = i + 1; j < world.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.max[0] < b.min[0] || b.max[0] < a.min[0] || a.max[1] < b.min[1] || b.max[1] < a.min[1] || a.max[2] < b.min[2] || b.max[2] < a.min[2]) continue;
    const v = world[i].m.intersect(world[j].m).volume();
    if (v < 0.05) continue;
    const exp = EXPECTED(world[i].id, world[j].id);
    const tag = `${world[i].id} x ${world[j].id}: ${v.toFixed(2)} mm3`;
    if (exp) { if (v > 12 * d.s ** 3) fail(`${name}: too much joint overlap ${tag}`); else hits.push(tag); }
    else fail(`${name}: collision ${tag}`);
  }
  const vol = [...solids.entries()].filter(([k]) => !k.startsWith('stand')).reduce((a, [, m]) => a + m.volume(), 0);
  console.log(`${name.padEnd(10)} parts=${defs.length} unique=${solids.size} solid-volume=${(vol / 1000).toFixed(2)}cm3  ${(performance.now() - t0).toFixed(0)}ms`);
  if (process.argv.includes('--verbose')) for (const h of hits) console.log('    ok overlap ' + h);
  collect();
}

for (const preset of Object.keys(PRESETS)) checkSpec(preset, sanitizeSpec(applyPreset(defaultSpec(), preset)));
for (const scale of [0.7, 1.6]) {
  const s = defaultSpec();
  s.scale = scale;
  checkSpec(`scale ${scale}`, sanitizeSpec(s));
}
{
  const s = defaultSpec();
  for (const hp of ['open', 'grip'] as const) { s.style.handPose = hp; checkSpec(`hand ${hp}`, sanitizeSpec(s)); }
  s.style.weapon = 'staff'; checkSpec('staff', sanitizeSpec(s));
  s.style.weapon = 'sword'; s.style.handSize = 1.3; checkSpec('big hands', sanitizeSpec(s)); s.style.handSize = 1;
  for (const hs of ['round', 'block', 'visor'] as const) { s.style.headShape = hs; checkSpec(`head ${hs}`, sanitizeSpec(s)); }
}
{
  // character skin: re-skin the default figure with its own assembled armor as the "model"
  const base = defaultSpec();
  const d = jointDims(base);
  const solids = new Map<string, Manifold>();
  for (const g of BUILDERS) { const r = g.build(d, base); for (const k of g.keys) if (r[k]) solids.set(k, r[k]!); }
  const pos: number[] = [], idx: number[] = [];
  const restPosed = restToPosed(buildRig(base), POSES.Rest);
  for (const p of partList(base)) {
    if (p.group !== 'armor' || !solids.has(p.key)) continue;
    const mesh = solids.get(p.key)!.transform(restPosed[p.node].clone().multiply(p.mount).elements as unknown as Mat4).getMesh();
    const off = pos.length / 3, n = mesh.numProp;
    for (let i = 0; i < mesh.vertProperties.length; i += n) pos.push(mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]);
    for (const t of mesh.triVerts) idx.push(t + off);
  }
  collect();
  const positions = new Float32Array(pos), indices = new Uint32Array(idx);
  const spec = sanitizeSpec({ ...base, skin: { ...base.skin, enabled: true, modelId: modelId(positions, indices), detail: 0.6, bindPose: structuredClone(POSES.Rest) } });
  const ctx = createSkinContext(wasm, spec, jointDims(spec), { id: spec.skin.modelId, name: 'self', positions, indices }, 0.8);
  collect();
  checkSpec('skin', spec, ctx);
}
{
  // generic models end to end, as the app does it: fit the skeleton, then skin and build
  const cases: [string, string, number][] = [['Standard', 'A-pose', 1.05], ['Heroic', 'T-pose', 1.2], ['Slim', 'Rest', 1]];
  for (const [preset, poseName, girth] of process.argv.includes('--fast') ? cases.slice(0, 1) : cases) {
    const truth = sanitizeSpec(applyPreset(defaultSpec(), preset));
    const body = mannequin(truth, POSES[poseName], girth, 1.1);
    const fit = fitRig(sanitizeSpec(defaultSpec()), body.positions, body.indices);
    if (!fit.ok) { fail(`auto-fit ${preset} ${poseName}: ${fit.notes.join('; ')}`); continue; }
    // the app moves the model so its pelvis lands on the rig's origin
    const positions = body.positions.slice();
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) positions[i + k] -= fit.pelvis[k];
    const base = sanitizeSpec(defaultSpec());
    const spec = sanitizeSpec({ ...base, proportions: fit.proportions, skin: { ...base.skin, enabled: true, modelId: modelId(positions, body.indices), detail: 0.6, bindPose: fit.pose } });
    const ctx = createSkinContext(wasm, spec, jointDims(spec), { id: spec.skin.modelId, name: 'mannequin', positions, indices: body.indices }, 0.8);
    collect();
    checkSpec(`fit ${preset.slice(0, 4)} ${poseName}`, spec, ctx);
  }
}
{
  const d = jointDims(defaultSpec());
  const res = CALIBRATION.build(d, defaultSpec());
  for (const [k, m] of Object.entries(res)) if (!m || m.status() !== 'NoError' || m.volume() < 1) fail(`calibration ${k}`);
  console.log('calibration ok');
  collect();
}
console.log(failures ? `\n${failures} problem(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
