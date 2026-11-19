// Headless character-skin builder.
//   node scripts/skin.ts <model.stl> <out-dir> [spec.json]
// spec.json may hold any FigureSpec fields (proportions, style, skin.transform, skin.bindPose...).
// Writes print-ready STLs per part, assembled previews (frame.stl / armor.stl) and a report.
import Module from 'manifold-3d';
import type { Manifold, Mat4 } from 'manifold-3d';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildersFor, partList } from '../src/core/catalog.ts';
import { defaultSpec, sanitizeSpec } from '../src/core/defaults.ts';
import { stlBinary } from '../src/core/export.ts';
import { collect, initGeo, setSegments } from '../src/core/geometry/geo.ts';
import { jointDims } from '../src/core/geometry/kit.ts';
import { prepareForPrint } from '../src/core/layout.ts';
import { meshOf } from '../src/core/geometry/mesh.ts';
import { restToPosed } from '../src/core/pose.ts';
import { buildRig } from '../src/core/skeleton.ts';
import { createSkinContext, modelId } from '../src/core/skinctx.ts';
import type { FigureSpec } from '../src/core/types.ts';

export function readStl(buf: Buffer): { positions: Float32Array; indices: Uint32Array } {
  const tris: number[] = [];
  const isAscii = buf.subarray(0, 5).toString() === 'solid' && buf.includes(Buffer.from('facet'));
  if (isAscii) {
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    const txt = buf.toString();
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) tris.push(+m[1], +m[2], +m[3]);
  } else {
    const n = buf.readUInt32LE(80);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) tris.push(buf.readFloatLE(o + k * 4));
    }
  }
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx = new Uint32Array(tris.length / 3);
  for (let i = 0; i < tris.length; i += 3) {
    const key = `${Math.round(tris[i] * 1e4)},${Math.round(tris[i + 1] * 1e4)},${Math.round(tris[i + 2] * 1e4)}`;
    let v = map.get(key);
    if (v === undefined) { v = pos.length / 3; map.set(key, v); pos.push(tris[i], tris[i + 1], tris[i + 2]); }
    idx[i / 3] = v;
  }
  return { positions: new Float32Array(pos), indices: idx };
}

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over as T) ?? base;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v) ? merge(cur, v) : v;
  }
  return out as T;
}

function asciiStl(ms: Manifold[]): string {
  const out = ['solid x'];
  for (const m of ms) {
    const mesh = m.getMesh(), v = mesh.vertProperties, t = mesh.triVerts, n = mesh.numProp;
    for (let i = 0; i < t.length; i += 3) {
      out.push('facet normal 0 0 0\nouter loop');
      for (let j = 0; j < 3; j++) { const o = t[i + j] * n; out.push(`vertex ${v[o]} ${v[o + 1]} ${v[o + 2]}`); }
      out.push('endloop\nendfacet');
    }
  }
  out.push('endsolid x');
  return out.join('\n');
}

const [modelPath, outDir, specPath] = process.argv.slice(2);
if (!modelPath || !outDir) {
  console.log('usage: node scripts/skin.ts <model.stl> <out-dir> [spec.json]');
  process.exit(1);
}
const wasm = await Module();
wasm.setup();
initGeo(wasm);
setSegments(48);
mkdirSync(`${outDir}/parts`, { recursive: true });

const t0 = performance.now();
const { positions, indices } = readStl(readFileSync(modelPath));
const model = { id: modelId(positions, indices), name: modelPath, positions, indices };
let spec: FigureSpec = defaultSpec();
if (specPath) spec = merge(spec, JSON.parse(readFileSync(specPath, 'utf8')));
spec.skin.enabled = true;
spec.skin.modelId = model.id;
spec = sanitizeSpec(spec);
console.log(`model: ${positions.length / 3} verts, ${indices.length / 3} tris  (${(performance.now() - t0).toFixed(0)} ms)`);

const d = jointDims(spec);
const t1 = performance.now();
const ctx = createSkinContext(wasm, spec, d, model, spec.skin.detail);
collect();
const f = ctx.info.field;
console.log(`field: ${f.nx}x${f.ny}x${f.nz} @ ${f.h} mm  (${(performance.now() - t1).toFixed(0)} ms)`);

const solids = new Map<string, Manifold>();
for (const g of buildersFor(spec)) {
  const tg = performance.now();
  const res = g.build(d, spec, ctx);
  for (const k of g.keys) {
    const m = res[k];
    if (!m || m.isEmpty()) continue;
    solids.set(k, m);
  }
  const dt = performance.now() - tg;
  if (dt > 300) console.log(`  ${g.keys.join(', ')}: ${dt.toFixed(0)} ms`);
}
console.log(`built ${solids.size} solids in ${((performance.now() - t1) / 1000).toFixed(1)} s`);

// print-ready parts
const parts = partList(spec).filter((p) => solids.has(p.key) && p.group !== 'accessory');
const counts = new Map<string, number>();
for (const p of parts) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
for (const [key, n] of counts) {
  const p = parts.find((q) => q.key === key)!;
  const prep = prepareForPrint(meshOf(solids.get(key)!), p.printRot);
  writeFileSync(`${outDir}/parts/${p.group}-${key}${n > 1 ? `_x${n}` : ''}.stl`, stlBinary(prep.positions, prep.indices));
}

// assembled preview in the bind pose + collision report
const posed = restToPosed(buildRig(spec), spec.skin.bindPose);
const world = parts.filter((p) => p.node !== 'world').map((p) => ({ p, m: solids.get(p.key)!.transform(posed[p.node].clone().multiply(p.mount).elements as unknown as Mat4) }));
writeFileSync(`${outDir}/frame.stl`, asciiStl(world.filter((w) => w.p.group === 'frame').map((w) => w.m)));
writeFileSync(`${outDir}/armor.stl`, asciiStl(world.filter((w) => w.p.group === 'armor').map((w) => w.m)));
const report: string[] = [];
const boxes = world.map((w) => w.m.boundingBox());
for (let i = 0; i < world.length; i++) for (let j = i + 1; j < world.length; j++) {
  const a = boxes[i], b = boxes[j];
  if (a.max[0] < b.min[0] || b.max[0] < a.min[0] || a.max[1] < b.min[1] || b.max[1] < a.min[1] || a.max[2] < b.min[2] || b.max[2] < a.min[2]) continue;
  if (world[i].p.group === 'frame' && world[j].p.group === 'frame') continue;
  const v = world[i].m.intersect(world[j].m).volume();
  if (v > 0.05) report.push(`${world[i].p.id} x ${world[j].p.id}: ${v.toFixed(2)} mm3`);
}
const vol = [...solids.entries()].filter(([k]) => !k.startsWith('stand') && k !== 'weapon').reduce((s, [, m]) => s + m.volume(), 0);
console.log(`armor/frame overlaps in bind pose (ribs and pegs expected):\n  ${report.join('\n  ') || 'none'}`);
console.log(`total volume ${(vol / 1000).toFixed(1)} cm3, ${parts.length} parts -> ${outDir}`);
