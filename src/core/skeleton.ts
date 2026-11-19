// Kinematic rig: rigid nodes connected by joints, with pivots in rest-pose world space.
// World axes: +x = figure's left, +y = up, +z = forward. Origin = pelvis ball.
import type { FigureSpec, Pose, Vec3 } from './types.ts';

export type JointType = 'root' | 'ball' | 'hinge' | 'swivel';
export type Limits = [[number, number], [number, number], [number, number]];

export type RigNode = {
  id: string;
  parent: string | null;
  pivot: Vec3;
  label: string;
  group: string;
  joint: JointType;
  limits: Limits;
};

export type RigPoints = {
  pelvis: Vec3; hipL: Vec3; hipR: Vec3; waistBall: Vec3; chestPivot: Vec3; neckSock: Vec3; headPivot: Vec3;
  shoulderL: Vec3; shoulderR: Vec3;
  legDiscL: Vec3; legDiscR: Vec3; kneeAL: Vec3; kneeAR: Vec3; kneeBL: Vec3; kneeBR: Vec3; ankleL: Vec3; ankleR: Vec3;
  armDiscL: Vec3; armDiscR: Vec3; elbowAL: Vec3; elbowAR: Vec3; elbowBL: Vec3; elbowBR: Vec3; wristL: Vec3; wristR: Vec3;
};

export type Rig = { nodes: RigNode[]; byId: Record<string, RigNode>; points: RigPoints };

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const Z: [number, number] = [0, 0];
const L3 = (x: [number, number], y: [number, number], z: [number, number]): Limits => [x, y, z];

export function rigPoints(spec: FigureSpec): RigPoints {
  const s = spec.scale, P = spec.proportions;
  const drop = 8.75 * s, pitch = 6 * s;
  const pelvis: Vec3 = [0, 0, 0];
  const hipL: Vec3 = [P.hipHalf * s, 0, 0];
  const hipR: Vec3 = [-P.hipHalf * s, 0, 0];
  const waistBall: Vec3 = [0, P.waistLen * s, 0];
  const chestPivot: Vec3 = [0, (P.waistLen + P.abdomenLen) * s, 0];
  const neckSock = add(chestPivot, [0, P.chestLen * s, 0]);
  const headPivot = add(neckSock, [0, P.neckLen * s, 0]);
  const shoulderL = add(chestPivot, [P.shoulderHalf * s, P.shoulderY * s, 0]);
  const shoulderR = add(chestPivot, [-P.shoulderHalf * s, P.shoulderY * s, 0]);
  const leg = (hip: Vec3) => {
    const disc = add(hip, [0, -drop, 0]);
    const a = add(disc, [0, -P.thighLen * s, 0]);
    const b = add(a, [0, -pitch, 0]);
    return { disc, a, b, end: add(b, [0, -P.shinLen * s, 0]) };
  };
  const arm = (sh: Vec3) => {
    const disc = add(sh, [0, -drop, 0]);
    const a = add(disc, [0, -P.upperArmLen * s, 0]);
    const b = add(a, [0, -pitch, 0]);
    return { disc, a, b, end: add(b, [0, -P.forearmLen * s, 0]) };
  };
  const lL = leg(hipL), lR = leg(hipR), aL = arm(shoulderL), aR = arm(shoulderR);
  return {
    pelvis, hipL, hipR, waistBall, chestPivot, neckSock, headPivot, shoulderL, shoulderR,
    legDiscL: lL.disc, legDiscR: lR.disc, kneeAL: lL.a, kneeAR: lR.a, kneeBL: lL.b, kneeBR: lR.b, ankleL: lL.end, ankleR: lR.end,
    armDiscL: aL.disc, armDiscR: aR.disc, elbowAL: aL.a, elbowAR: aR.a, elbowBL: aL.b, elbowBR: aR.b, wristL: aL.end, wristR: aR.end,
  };
}

export function buildRig(spec: FigureSpec): Rig {
  const p = rigPoints(spec);
  const nodes: RigNode[] = [
    { id: 'pelvis', parent: null, pivot: p.pelvis, label: 'Whole body', group: 'Body', joint: 'root', limits: L3([-90, 90], [-180, 180], [-90, 90]) },
    { id: 'waist', parent: 'pelvis', pivot: p.pelvis, label: 'Waist', group: 'Spine', joint: 'ball', limits: L3([-35, 40], [-15, 15], [-15, 15]) },
    { id: 'abdomen', parent: 'waist', pivot: p.waistBall, label: 'Abdomen', group: 'Spine', joint: 'ball', limits: L3([-30, 45], [-45, 45], [-30, 30]) },
    { id: 'chest', parent: 'abdomen', pivot: p.chestPivot, label: 'Chest', group: 'Spine', joint: 'ball', limits: L3([-30, 45], [-45, 45], [-30, 30]) },
    { id: 'neck', parent: 'chest', pivot: p.neckSock, label: 'Neck', group: 'Head', joint: 'ball', limits: L3([-40, 40], [-60, 60], [-30, 30]) },
    { id: 'head', parent: 'neck', pivot: p.headPivot, label: 'Head', group: 'Head', joint: 'ball', limits: L3([-40, 40], [-60, 60], [-30, 30]) },
  ];
  for (const side of ['L', 'R'] as const) {
    const m = side === 'L' ? 1 : -1;
    const sideName = side === 'L' ? 'Left' : 'Right';
    const z = (lo: number, hi: number): [number, number] => (m > 0 ? [lo, hi] : [-hi, -lo]);
    const g = (part: string) => `${sideName} ${part}`;
    const P = (k: string) => (p as Record<string, Vec3>)[k + side];
    nodes.push(
      { id: `hip${side}`, parent: 'pelvis', pivot: P('hip'), label: 'Hip', group: g('leg'), joint: 'ball', limits: L3([-120, 60], [-20, 20], z(-15, 85)) },
      { id: `thigh${side}`, parent: `hip${side}`, pivot: P('legDisc'), label: 'Thigh twist', group: g('leg'), joint: 'swivel', limits: L3(Z, [-180, 180], Z) },
      { id: `kneeClip${side}`, parent: `thigh${side}`, pivot: P('kneeA'), label: 'Knee (upper)', group: g('leg'), joint: 'hinge', limits: L3([-5, 95], Z, Z) },
      { id: `shin${side}`, parent: `kneeClip${side}`, pivot: P('kneeB'), label: 'Knee (lower)', group: g('leg'), joint: 'hinge', limits: L3([-5, 95], Z, Z) },
      { id: `foot${side}`, parent: `shin${side}`, pivot: P('ankle'), label: 'Ankle', group: g('leg'), joint: 'ball', limits: L3([-40, 40], [-20, 20], [-20, 20]) },
      { id: `shoulder${side}`, parent: 'chest', pivot: P('shoulder'), label: 'Shoulder', group: g('arm'), joint: 'ball', limits: L3([-180, 60], [-20, 20], z(-15, 105)) },
      { id: `upperArm${side}`, parent: `shoulder${side}`, pivot: P('armDisc'), label: 'Arm twist', group: g('arm'), joint: 'swivel', limits: L3(Z, [-180, 180], Z) },
      { id: `elbowClip${side}`, parent: `upperArm${side}`, pivot: P('elbowA'), label: 'Elbow (upper)', group: g('arm'), joint: 'hinge', limits: L3([-95, 5], Z, Z) },
      { id: `forearm${side}`, parent: `elbowClip${side}`, pivot: P('elbowB'), label: 'Elbow (lower)', group: g('arm'), joint: 'hinge', limits: L3([-95, 5], Z, Z) },
      { id: `hand${side}`, parent: `forearm${side}`, pivot: P('wrist'), label: 'Wrist', group: g('arm'), joint: 'ball', limits: L3([-45, 45], [-60, 60], [-45, 45]) },
    );
  }
  const byId: Record<string, RigNode> = {};
  for (const n of nodes) byId[n.id] = n;
  return { nodes, byId, points: p };
}

export function clampPose(rig: Rig, pose: Pose): Pose {
  const out: Pose = {};
  for (const n of rig.nodes) {
    const v = pose[n.id];
    if (!v) continue;
    out[n.id] = [0, 1, 2].map((i) => Math.min(n.limits[i][1], Math.max(n.limits[i][0], v[i] || 0))) as Vec3;
  }
  return out;
}

/** Mirror a pose left <-> right (y and z rotations flip sign). */
export function mirrorPose(pose: Pose, from: 'L' | 'R' | 'swap'): Pose {
  const out: Pose = { ...pose };
  const flip = (v: Vec3 | undefined): Vec3 | undefined => (v ? [v[0], -v[1], -v[2]] : undefined);
  const ids = Object.keys(pose).concat(Object.keys(pose).map((k) => k.replace(/[LR]$/, (c) => (c === 'L' ? 'R' : 'L'))));
  const bases = new Set(ids.filter((k) => /[LR]$/.test(k)).map((k) => k.slice(0, -1)));
  for (const b of bases) {
    const l = pose[b + 'L'], r = pose[b + 'R'];
    if (from === 'L') { const v = flip(l); if (v) out[b + 'R'] = v; else delete out[b + 'R']; }
    else if (from === 'R') { const v = flip(r); if (v) out[b + 'L'] = v; else delete out[b + 'L']; }
    else {
      const vl = flip(r), vr = flip(l);
      if (vl) out[b + 'L'] = vl; else delete out[b + 'L'];
      if (vr) out[b + 'R'] = vr; else delete out[b + 'R'];
    }
  }
  if (from === 'swap') for (const k of Object.keys(out)) if (!/[LR]$/.test(k)) { const v = flip(out[k]); if (v) out[k] = v; }
  return out;
}
