// Test bodies for the skeleton fit and the skin pipeline: one fused mesh of capsules and blobs
// around a known skeleton, like a sculpt or a game model.
import type { Manifold } from 'manifold-3d';
import { Vector3 } from 'three';
import { collect, M, sphere, union } from '../src/core/geometry/geo.ts';
import { restToPosed } from '../src/core/pose.ts';
import { buildRig, rigPoints } from '../src/core/skeleton.ts';
import type { FigureSpec, Pose, Vec3 } from '../src/core/types.ts';

export function meshArrays(ms: Manifold[]) {
  const pos: number[] = [], idx: number[] = [];
  for (const m of ms) {
    const mesh = m.getMesh(), base = pos.length / 3;
    for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) pos.push(mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]);
    for (const t of mesh.triVerts) idx.push(base + t);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** One fused body around the skeleton; `g` scales the girth of torso and limbs, `hk` the head. */
export function mannequin(spec: FigureSpec, pose: Pose, g: number, hk: number) {
  const s = spec.scale, posed = restToPosed(buildRig(spec), pose), p = rigPoints(spec) as Record<string, Vec3>;
  const W = (node: string, q: Vec3): Vec3 => { const v = new Vector3(...q).applyMatrix4(posed[node]); return [v.x, v.y, v.z]; };
  const off = (q: Vec3, d: Vec3): Vec3 => [q[0] + d[0], q[1] + d[1], q[2] + d[2]];
  const ball = (r: number, c: Vec3) => sphere(r, c[0], c[1], c[2]);
  const hullOf = (ms: Manifold[]) => M().hull(ms);
  const cap = (a: Vec3, b: Vec3, ra: number, rb = ra) => hullOf([ball(ra, a), ball(rb, b)]);
  const parts: Manifold[] = [];
  parts.push(hullOf([ball(5.5 * g * s, W('pelvis', off(p.hipL, [-1 * s, 1 * s, 0]))), ball(5.5 * g * s, W('pelvis', off(p.hipR, [1 * s, 1 * s, 0]))), ball(6.5 * g * s, W('waist', p.waistBall))]));
  parts.push(cap(W('abdomen', p.waistBall), W('abdomen', p.chestPivot), 6.5 * g * s, 7 * g * s));
  parts.push(hullOf([ball(7.5 * g * s, W('chest', p.chestPivot)), ball(5 * g * s, W('chest', off(p.shoulderL, [-2 * s, -1 * s, 0]))),
    ball(5 * g * s, W('chest', off(p.shoulderR, [2 * s, -1 * s, 0]))), ball(4 * g * s, W('chest', p.neckSock))]));
  parts.push(cap(W('neck', p.neckSock), W('neck', p.headPivot), 3.6 * Math.max(1, g * 0.9) * s));
  parts.push(sphere(1).scale([7.5 * hk * s, 9 * hk * s, 8 * hk * s]).translate(W('head', off(p.headPivot, [0, 6 * hk * s, 0.5 * s]))));
  for (const S of ['L', 'R'] as const) {
    const q = (k: string) => p[k + S];
    parts.push(cap(W(`shoulder${S}`, q('shoulder')), W(`upperArm${S}`, q('elbowA')), 4.6 * g * s, 3.8 * g * s));
    parts.push(cap(W(`upperArm${S}`, q('elbowA')), W(`forearm${S}`, q('elbowB')), 3.6 * g * s));
    parts.push(cap(W(`forearm${S}`, q('elbowB')), W(`forearm${S}`, q('wrist')), 3.6 * g * s, 2.9 * g * s));
    parts.push(cap(W(`hand${S}`, q('wrist')), W(`hand${S}`, off(q('wrist'), [0, -8 * s, 0])), 3.2 * s, 2.6 * s));
    parts.push(cap(W(`hip${S}`, q('hip')), W(`thigh${S}`, q('kneeA')), 6 * g * s, 4.6 * g * s));
    parts.push(cap(W(`thigh${S}`, q('kneeA')), W(`shin${S}`, q('kneeB')), 4.5 * g * s));
    parts.push(cap(W(`shin${S}`, q('kneeB')), W(`shin${S}`, q('ankle')), 4.4 * g * s, 3.2 * g * s));
    parts.push(hullOf([ball(3.4 * s, W(`foot${S}`, off(q('ankle'), [0, -1 * s, -1 * s]))), ball(2.8 * s, W(`foot${S}`, off(q('ankle'), [0, -7.3 * s, -2 * s]))),
      ball(2.6 * s, W(`foot${S}`, off(q('ankle'), [0, -7.5 * s, 9 * s])))]));
  }
  const out = meshArrays([union(parts)]);
  collect();
  return out;
}

