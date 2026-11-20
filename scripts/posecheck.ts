// How freely does an auto-fitted skin move? Fit a mannequin, skin it, then measure armor-on-armor
// overlap in the pose presets (overlap = the pieces would block each other before that pose).
//   node scripts/posecheck.ts [preset] [bindPose] [girth]
//   node scripts/posecheck.ts model.stl          (a model already standing on the ground, in mm)
import Module from 'manifold-3d';
import type { Manifold, Mat4 } from 'manifold-3d';
import { buildersFor, partList } from '../src/core/catalog.ts';
import { applyPreset, defaultSpec, sanitizeSpec } from '../src/core/defaults.ts';
import { collect, initGeo, setSegments } from '../src/core/geometry/geo.ts';
import { jointDims } from '../src/core/geometry/kit.ts';
import { POSES, restToPosed } from '../src/core/pose.ts';
import { fitRig } from '../src/core/rigfit.ts';
import { buildRig } from '../src/core/skeleton.ts';
import { createSkinContext, modelId } from '../src/core/skinctx.ts';
import { readFileSync } from 'node:fs';
import { mannequin } from './mannequin.ts';
import { readStl } from './stl.ts';

const [preset = 'Standard', bind = 'A-pose', girth = '1.05'] = process.argv.slice(2);
const wasm = await Module(); wasm.setup(); initGeo(wasm); setSegments(24);
const truth = sanitizeSpec(applyPreset(defaultSpec(), preset.endsWith('.stl') ? 'Standard' : preset));
const body = preset.endsWith('.stl') ? readStl(readFileSync(preset)) : mannequin(truth, POSES[bind], Number(girth), 1.1);
const fit = fitRig(sanitizeSpec(defaultSpec()), body.positions, body.indices);
console.log('fit', fit.ok, JSON.stringify(fit.proportions), JSON.stringify(fit.pose), fit.notes.join('; '));
const positions = body.positions.slice();
for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) positions[i + k] -= fit.pelvis[k];
const base = sanitizeSpec(defaultSpec());
const spec = sanitizeSpec({ ...base, proportions: fit.proportions, skin: { ...base.skin, enabled: true, modelId: modelId(positions, body.indices), detail: 0.6, bindPose: fit.pose, motion: process.env.MOTION !== '0' } });
const d = jointDims(spec);
const tc = performance.now();
const ctx = createSkinContext(wasm, spec, d, { id: spec.skin.modelId, name: 'm', positions, indices: body.indices }, 0.8);
const solids = new Map<string, Manifold>();
for (const g of buildersFor(spec)) { const r = g.build(d, spec, ctx); for (const k of g.keys) { const m = r[k]; if (m) solids.set(k, m); } }
const tb = performance.now();
console.log(`skin build ${((tb - tc) / 1000).toFixed(1)} s`);
console.log('missing parts:', partList(spec).filter((p) => !solids.has(p.key)).map((p) => p.id).join(', ') || 'none');
const defs = partList(spec).filter((p) => p.group === 'armor' && p.node !== 'world' && solids.has(p.key));
const rig = buildRig(spec);
for (const name of Object.keys(POSES)) {
  const posed = restToPosed(rig, POSES[name]);
  const w = defs.map((p) => ({ id: p.id, node: p.node, m: solids.get(p.key)!.transform(posed[p.node].clone().multiply(p.mount).elements as unknown as Mat4) }));
  const bb = w.map((x) => x.m.boundingBox());
  const hits: string[] = [];
  for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) {
    if (w[i].node === w[j].node) continue;
    const a = bb[i], b = bb[j];
    if (a.max[0] < b.min[0] || b.max[0] < a.min[0] || a.max[1] < b.min[1] || b.max[1] < a.min[1] || a.max[2] < b.min[2] || b.max[2] < a.min[2]) continue;
    const v = w[i].m.intersect(w[j].m).volume();
    if (v > 5) hits.push(`${w[i].id}x${w[j].id} ${v.toFixed(0)}`);
  }
  console.log(`${name.padEnd(8)} ${hits.length ? hits.join(', ') : 'free'}`);
  collect();
}
