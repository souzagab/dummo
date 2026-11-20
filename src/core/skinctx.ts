// Glue between an imported character model and the armor builders.
import { Euler, Matrix4, Vector3 } from 'three';
import type { Manifold, Mat4, ManifoldToplevel, Mesh } from 'manifold-3d';
import type { FigureSpec, Pose, SkinSettings, Vec3 } from './types.ts';
import { buildRig, type Rig } from './skeleton.ts';
import { restToPosed } from './pose.ts';
import { BUILDERS, partList, type BuildCtx, type PartDef } from './catalog.ts';
import { poly, extrude } from './geometry/geo.ts';
import type { Dims } from './geometry/kit.ts';
import { regionBoxes, regionSolid, solidField, type Box, type Field, type Owner } from './geometry/skin.ts';

export type SkinModel = { id: string; name: string; positions: Float32Array; indices: Uint32Array };

const D2R = Math.PI / 180;

export function modelMatrix(t: SkinSettings['transform']): Matrix4 {
  const r = new Matrix4().makeRotationFromEuler(new Euler(t.rot[0] * D2R, t.rot[1] * D2R, t.rot[2] * D2R, 'XYZ'));
  return new Matrix4().makeTranslation(t.offset[0], t.offset[1], t.offset[2]).multiply(r).multiply(new Matrix4().makeScale(t.scale, t.scale, t.scale));
}

/** Cheap content hash for a model. */
export function modelId(positions: Float32Array, indices: Uint32Array): string {
  let h = 2166136261 >>> 0;
  const mix = (v: number) => { h ^= v; h = Math.imul(h, 16777619) >>> 0; };
  mix(positions.length); mix(indices.length);
  const stepP = Math.max(1, Math.floor(positions.length / 4096));
  for (let i = 0; i < positions.length; i += stepP) mix(Math.round(positions[i] * 1000) | 0);
  const stepI = Math.max(1, Math.floor(indices.length / 4096));
  for (let i = 0; i < indices.length; i += stepI) mix(indices[i]);
  return h.toString(36);
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Bone segments (rest pose) that claim the model's volume, and the armor piece each one feeds. */
function ownersRest(spec: FigureSpec, rig: Rig): (Owner & { node: string })[] {
  const s = spec.scale, P = spec.proportions, p = rig.points;
  const Ys = P.shoulderY * s, Xs = P.shoulderHalf * s;
  const o: (Owner & { node: string })[] = [
    { piece: 'head', node: 'head', segs: [[add(p.headPivot, [0, 3 * s, 0]), add(p.headPivot, [0, 9 * s, 0])]] },
    { piece: null, node: 'neck', segs: [[add(p.neckSock, [0, 2 * s, 0]), add(p.headPivot, [0, -1 * s, 0])]] },
    {
      piece: 'chest', node: 'chest', segs: [
        [add(p.chestPivot, [0, 3 * s, 0]), add(p.neckSock, [0, -3 * s, 0])],
        [add(p.chestPivot, [-0.45 * Xs, Ys, 0]), add(p.chestPivot, [0.45 * Xs, Ys, 0])],
      ],
    },
    { piece: 'abdomen', node: 'abdomen', segs: [[add(p.waistBall, [0, 2 * s, 0]), add(p.chestPivot, [0, -2 * s, 0])]] },
    {
      piece: 'pelvis', node: 'waist', segs: [
        [add(p.pelvis, [0, -3 * s, 0]), add(p.waistBall, [0, -2 * s, 0])],
        [[-0.4 * P.hipHalf * s, -1 * s, 0], [0.4 * P.hipHalf * s, -1 * s, 0]],
      ],
    },
  ];
  for (const S of ['L', 'R'] as const) {
    const q = (k: string) => (p as Record<string, Vec3>)[k + S];
    const fs = spec.style.footSize;
    o.push(
      { piece: `thigh-sleeve-${S}`, node: `thigh${S}`, segs: [[q('hip'), add(q('kneeA'), [0, 1 * s, 0])]] },
      { piece: null, node: `kneeClip${S}`, segs: [[add(q('kneeA'), [0, -1.5 * s, 0]), add(q('kneeB'), [0, 1.5 * s, 0])]] },
      { piece: `shin-sleeve-${S}`, node: `shin${S}`, segs: [[add(q('kneeB'), [0, -1 * s, 0]), add(q('ankle'), [0, 5 * s, 0])]] },
      { piece: `foot-${S}`, node: `foot${S}`, segs: [[add(q('ankle'), [0, -4 * s, -3 * s]), add(q('ankle'), [0, -7 * s, 8 * s * fs])]] },
      { piece: `upper-arm-sleeve-${S}`, node: `upperArm${S}`, segs: [[q('shoulder'), add(q('elbowA'), [0, 1 * s, 0])]] },
      { piece: null, node: `elbowClip${S}`, segs: [[add(q('elbowA'), [0, -1.5 * s, 0]), add(q('elbowB'), [0, 1.5 * s, 0])]] },
      { piece: `forearm-sleeve-${S}`, node: `forearm${S}`, segs: [[add(q('elbowB'), [0, -1 * s, 0]), add(q('wrist'), [0, 4 * s, 0])]] },
      { piece: null, node: `hand${S}`, segs: [[q('wrist'), add(q('wrist'), [0, -12 * s, 0])]] },
    );
  }
  return o;
}

const fieldCache = new Map<string, Field>();

type Pocket = { mesh: Mesh; box: Box; node: string };

export type SkinContextInfo = { field: Field; ms: number };

/**
 * Build the skin context for one build. Returns a BuildCtx whose skinOuter(piece) yields the
 * character region for that piece, already in the piece's design frame.
 */
export function createSkinContext(wasm: ManifoldToplevel, spec: FigureSpec, d: Dims, model: SkinModel, edge: number): BuildCtx & { info: SkinContextInfo } {
  const t0 = performance.now();
  const sk = spec.skin;
  const fkey = `${model.id}|${JSON.stringify(sk.transform)}|${sk.detail}|${sk.close}`;
  let field = fieldCache.get(fkey);
  if (!field) {
    const m = modelMatrix(sk.transform).elements;
    const src = model.positions, pos = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i], y = src[i + 1], z = src[i + 2];
      pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    field = solidField(pos, model.indices, sk.detail, sk.close);
    fieldCache.clear();
    fieldCache.set(fkey, field);
  }
  const rig = buildRig(spec);
  const posed = restToPosed(rig, sk.bindPose);
  const restOwners = ownersRest(spec, rig);
  const owners: Owner[] = restOwners.map((o) => ({
    piece: o.piece,
    segs: o.segs.map(([a, b]) => [xf(posed[o.node], a), xf(posed[o.node], b)] as [Vec3, Vec3]),
  }));
  const boxes = regionBoxes(field, owners);
  const parts = partList(spec);

  // frame pockets (bind pose, world) so skins never intrude into any frame part
  const pockets: Pocket[] = [];
  const frameKeys = new Set(parts.filter((p) => p.group === 'frame').map((p) => p.key));
  const localPockets = new Map<string, Mesh>();
  for (const g of BUILDERS) {
    if (!g.keys.some((k) => frameKeys.has(k))) continue;
    const res = g.build(d, spec);
    for (const k of g.keys) {
      const solid = res[k];
      if (!solid || !frameKeys.has(k)) continue;
      const bb = solid.boundingBox();
      const contours = solid.project().toPolygons().filter((c) => area(c) > 0);
      // with frame cover on, neighbours' frames carry a wall of standard armor: stay clear of it
      const keep = d.armor.clr + (sk.cover ? 1.2 * d.s + sk.gap : 0);
      const pocket = extrude(poly(contours).offset(keep, 'Round', 2, 16), bb.min[2] - keep, bb.max[2] + keep);
      localPockets.set(k, copyMesh(pocket.getMesh()));
    }
  }
  for (const p of parts) {
    if (p.group !== 'frame') continue;
    const lm = localPockets.get(p.key);
    if (!lm) continue;
    const w = posed[p.node].clone().multiply(p.mount);
    const world = wasm.Manifold.ofMesh(lm).transform(w.elements as unknown as Mat4);
    const bb = world.boundingBox();
    pockets.push({ mesh: copyMesh(world.getMesh()), box: { min: bb.min as Vec3, max: bb.max as Vec3 }, node: p.node });
  }
  const instance = (piece: string): PartDef | undefined => {
    const id = piece.match(/-(front|back)$/) ? piece : ({ head: 'head-front', chest: 'chest-front', abdomen: 'abdomen-front', pelvis: 'pelvis-front' } as Record<string, string>)[piece] ?? piece;
    return parts.find((p) => p.id === id);
  };
  // movement carving: the chest and pelvis lose whatever the upper arms and thighs sweep
  // through over the usual range of their joints (sampled), plus the gap
  const sweeps = new Map<string, Manifold | null>();
  type Sweep = { piece: string; node: string; poses: Pose[] };
  const grid = (joint: string, xs: number[], zs: number[]): Pose[] => {
    const sgn = joint.endsWith('L') ? 1 : -1;
    return xs.flatMap((x) => zs.map((z) => ({ [joint]: [x, 0, sgn * z] as Vec3 })));
  };
  const SWEEP: Record<string, Sweep[]> = {};
  for (const S of ['L', 'R'] as const) {
    // arm swings, plus twists of the upper arm (shoulder pads are rarely round)
    const twists = [-80, -40, 40, 80].flatMap((tw) => grid(`shoulder${S}`, [-30, 0, 20], [20, 45]).map((p) => ({ ...p, [`upperArm${S}`]: [0, tw, 0] as Vec3 })));
    const arm: Sweep = { piece: `upper-arm-sleeve-${S}`, node: `upperArm${S}`, poses: [...grid(`shoulder${S}`, [-90, -60, -30, 0, 20, 40], [0, 20, 40, 60, 90]), ...twists] };
    const thigh: Sweep = { piece: `thigh-sleeve-${S}`, node: `thigh${S}`, poses: grid(`hip${S}`, [-110, -75, -40, 0, 30], [0, 25]) };
    const shin: Sweep = { piece: `shin-sleeve-${S}`, node: `shin${S}`, poses: [30, 60, 90, 120, 160].map((a) => ({ [`kneeClip${S}`]: [a / 2, 0, 0] as Vec3, [`shin${S}`]: [a / 2, 0, 0] as Vec3 })) };
    const foot: Sweep = { piece: `foot-${S}`, node: `foot${S}`, poses: [-35, -15, 0, 15, 35].flatMap((x) => [-15, 0, 15].map((z) => ({ [`foot${S}`]: [x, 0, z] as Vec3 }))) };
    const fore: Sweep = { piece: `forearm-sleeve-${S}`, node: `forearm${S}`, poses: [30, 60, 90, 120, 160].map((a) => ({ [`elbowClip${S}`]: [-a / 2, 0, 0] as Vec3, [`forearm${S}`]: [-a / 2, 0, 0] as Vec3 })) };
    for (const [piece, sw] of [['chest', arm], ['abdomen', arm], ['pelvis', thigh], [`thigh-sleeve-${S}`, shin], [`shin-sleeve-${S}`, foot], [`upper-arm-sleeve-${S}`, fore]] as const) (SWEEP[piece] ??= []).push(sw);
  }
  const sweepOf = (sw: Sweep): Manifold | null => {
    if (sweeps.has(sw.piece)) return sweeps.get(sw.piece)!;
    const ts = performance.now();
    const k = owners.findIndex((o) => o.piece === sw.piece);
    const box = k >= 0 ? boxes[k] : null;
    // grown by the gap, so the carved piece keeps a gap's clearance from the moving one
    // (coarser than the pieces: a sweep only has to clear, not to look good)
    const region = box ? regionSolid(field!, owners, k, box, -sk.gap, Math.max(2.5 * edge, 1.6)) : null;
    let out: Manifold | null = null;
    if (region) {
      const back = posed[sw.node].clone().invert();
      const copies = sw.poses.map((p) => region.transform(restToPosed(rig, { ...sk.bindPose, ...p })[sw.node].clone().multiply(back).elements as unknown as Mat4));
      out = wasm.Manifold.union(copies).simplify(0.3);
    }
    sweeps.set(sw.piece, out);
    if ((globalThis as { process?: { env: Record<string, string> } }).process?.env.SKIN_DEBUG) console.log(`sweep ${sw.piece}: ${sw.poses.length} poses, ${(performance.now() - ts).toFixed(0)} ms, ${out?.numTri() ?? 0} tris`);
    return out;
  };
  const ms = performance.now() - t0;
  return {
    info: { field, ms },
    skinOuter(piece: string): Manifold | null {
      const k = owners.findIndex((o) => o.piece === piece);
      const box = k >= 0 ? boxes[k] : null;
      const inst = instance(piece);
      if (!box || !inst) return null;
      let region = regionSolid(field!, owners, k, box, sk.gap, edge);
      if (!region) return null;
      const rb = region.boundingBox();
      for (const pk of pockets) {
        // the piece's own frame part is cut by its builder; cutting it twice leaves slivers
        if (pk.node === inst.node) continue;
        if (pk.box.max[0] < rb.min[0] || pk.box.min[0] > rb.max[0] || pk.box.max[1] < rb.min[1] || pk.box.min[1] > rb.max[1] || pk.box.max[2] < rb.min[2] || pk.box.min[2] > rb.max[2]) continue;
        region = region.subtract(wasm.Manifold.ofMesh(pk.mesh));
      }
      if (sk.motion) for (const sw of SWEEP[piece] ?? []) {
        const cut = sweepOf(sw);
        if (cut) region = region.subtract(cut);
      }
      if (region.isEmpty()) return null;
      const toDesign = posed[inst.node].clone().multiply(inst.mount).invert();
      return region.transform(toDesign.elements as unknown as Mat4);
    },
  };
}

function xf(m: Matrix4, p: Vec3): Vec3 {
  const v = new Vector3(...p).applyMatrix4(m);
  return [v.x, v.y, v.z];
}

function area(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; a += x0 * y1 - x1 * y0; }
  return a / 2;
}

function copyMesh(m: Mesh): Mesh {
  return new (m.constructor as new (o: object) => Mesh)({
    numProp: m.numProp,
    vertProperties: new Float32Array(m.vertProperties),
    triVerts: new Uint32Array(m.triVerts),
  });
}

