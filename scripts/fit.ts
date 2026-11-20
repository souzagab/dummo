// Fit dummo's skeleton to a model (STL, already in dummo world space or auto-placed).
//   node scripts/fit.ts <model.stl> [spec.json]
import { readFileSync } from 'node:fs';
import { defaultSpec, sanitizeSpec } from '../src/core/defaults.ts';
import { fitRig } from '../src/core/rigfit.ts';
import { readStl } from './stl.ts';

const [modelPath, specPath] = process.argv.slice(2);
const { positions, indices } = readStl(readFileSync(modelPath));
let spec = defaultSpec();
if (specPath) Object.assign(spec, JSON.parse(readFileSync(specPath, 'utf8')).spec ?? {});
spec = sanitizeSpec(spec);
const t0 = performance.now();
const r = fitRig(spec, positions, indices, false, specPath ? { P: spec.proportions, pose: {}, pelvis: [0, 0, 0] } : undefined);
console.log(`fit ${r.ok ? 'ok' : 'FAILED'} in ${(performance.now() - t0).toFixed(0)} ms`, r.notes);
console.log('pelvis', r.pelvis.map((v) => v.toFixed(1)).join(' '));
const ref = spec.proportions;
for (const k of Object.keys(r.proportions) as (keyof typeof ref)[]) console.log(`  ${k.padEnd(13)} ${String(r.proportions[k]).padStart(6)}   (spec ${ref[k]})`);
console.log('pose', JSON.stringify(r.pose));
for (const [k, v] of Object.entries(r.marks)) console.log(`  ${k.padEnd(10)} ${v.map((x) => x.toFixed(1).padStart(6)).join(' ')}`);
