// Headless geometry check: builds every part for each preset, verifies the solids are valid
// and that nothing collides in the rest pose except intended joint interference.
// Run: node scripts/check.ts [--fast]
import Module from 'manifold-3d';
import type { Manifold, Mat4 } from 'manifold-3d';
import { BUILDERS, CALIBRATION, partList } from '../src/core/catalog.ts';
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

function degenerate(m: Manifold): number {
  const mesh = m.getMesh();
  const v = mesh.vertProperties, t = mesh.triVerts, n = mesh.numProp;
  let bad = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * n, b = t[i + 1] * n, c = t[i + 2] * n;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (Math.hypot(cx, cy, cz) < 1e-9) bad++;
  }
  return bad;
}

let failures = 0;
const fail = (msg: string) => { failures++; console.log('  FAIL ' + msg); };

function checkSpec(name: string, spec: FigureSpec) {
  const t0 = performance.now();
  const d = jointDims(spec);
  const solids = new Map<string, Manifold>();
  for (const g of BUILDERS) {
    const res = g.build(d, spec);
    for (const k of g.keys) {
      const m = res[k];
      if (!m) continue;
      if (m.status() !== 'NoError') fail(`${name}: ${k} status ${m.status()}`);
      if (m.isEmpty() || m.volume() < 1) fail(`${name}: ${k} empty (vol ${m.volume().toFixed(2)})`);
      const bb = m.boundingBox();
      if (!k.startsWith('stand') && k !== 'foot' && !k.includes('sleeve') && !k.endsWith('-front') && !k.endsWith('-back') && bb.min[2] < -1e-3)
        fail(`${name}: ${k} below the bed (z ${bb.min[2].toFixed(3)})`);
      const deg = degenerate(m);
      if (deg) fail(`${name}: ${k} has ${deg} zero-area triangles`);
      const parts = m.decompose();
      if (parts.length > 1 && !k.endsWith('-back')) fail(`${name}: ${k} has ${parts.length} disconnected pieces`);
      solids.set(k, m);
    }
  }
  const defs = partList(spec).filter((p) => (p.group !== 'accessory' || p.key === 'weapon') && solids.has(p.key));
  const posed = restToPosed(buildRig(spec), POSES.Rest);
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
  const d = jointDims(defaultSpec());
  const res = CALIBRATION.build(d, defaultSpec());
  for (const [k, m] of Object.entries(res)) if (!m || m.status() !== 'NoError' || m.volume() < 1) fail(`calibration ${k}`);
  console.log('calibration ok');
  collect();
}
console.log(failures ? `\n${failures} problem(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
