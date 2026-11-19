// Forward kinematics shared by the viewer and the headless checks.
import { Euler, Matrix4 } from 'three';
import type { Pose, Vec3 } from './types.ts';
import type { Rig } from './skeleton.ts';

const D2R = Math.PI / 180;

/**
 * For every node, the matrix that takes rest-pose world coordinates of that node's parts
 * to posed world coordinates.
 */
export function restToPosed(rig: Rig, pose: Pose): Record<string, Matrix4> {
  const world: Record<string, Matrix4> = {};
  const out: Record<string, Matrix4> = {};
  for (const n of rig.nodes) {
    const a = pose[n.id] ?? [0, 0, 0];
    const rot = new Matrix4().makeRotationFromEuler(new Euler(a[0] * D2R, a[1] * D2R, a[2] * D2R, 'ZXY'));
    let w: Matrix4;
    if (!n.parent) {
      w = new Matrix4().makeTranslation(n.pivot[0], n.pivot[1], n.pivot[2]).multiply(rot);
    } else {
      const p = rig.byId[n.parent];
      w = world[p.id].clone()
        .multiply(new Matrix4().makeTranslation(n.pivot[0] - p.pivot[0], n.pivot[1] - p.pivot[1], n.pivot[2] - p.pivot[2]))
        .multiply(rot);
    }
    world[n.id] = w;
    out[n.id] = w.clone().multiply(new Matrix4().makeTranslation(-n.pivot[0], -n.pivot[1], -n.pivot[2]));
  }
  out.world = new Matrix4();
  return out;
}

export const POSES: Record<string, Pose> = {
  Rest: { shoulderL: [0, 0, 8], shoulderR: [0, 0, -8] },
  'T-pose': { shoulderL: [0, 0, 90], shoulderR: [0, 0, -90] },
  'A-pose': { shoulderL: [0, 0, 40], shoulderR: [0, 0, -40], hipL: [0, 0, 6], hipR: [0, 0, -6] },
  Hero: {
    chest: [-6, 0, 0], head: [-10, 0, 0], hipL: [0, 0, 10], hipR: [0, 0, -10], footL: [0, 0, -10], footR: [0, 0, 10],
    shoulderL: [0, 0, 48], shoulderR: [0, 0, -48], upperArmL: [0, -90, 0], upperArmR: [0, 90, 0],
    elbowClipL: [-55, 0, 0], forearmL: [-60, 0, 0], elbowClipR: [-55, 0, 0], forearmR: [-60, 0, 0],
  },
  Flex: {
    chest: [-8, 0, 0], head: [-8, 0, 0], hipL: [0, 0, 12], hipR: [0, 0, -12], footL: [0, 0, -10], footR: [0, 0, 10],
    shoulderL: [12, 0, 38], shoulderR: [12, 0, -38], elbowClipL: [-50, 0, 0], forearmL: [-55, 0, 0],
    elbowClipR: [-50, 0, 0], forearmR: [-55, 0, 0], upperArmL: [0, 70, 0], upperArmR: [0, -70, 0],
  },
  Walk: {
    abdomen: [0, 6, 0], hipL: [-25, 0, 0], kneeClipL: [8, 0, 0], shinL: [8, 0, 0], footL: [10, 0, 0],
    hipR: [15, 0, 0], kneeClipR: [15, 0, 0], shinR: [15, 0, 0], footR: [-12, 0, 0],
    shoulderL: [20, 0, 8], shoulderR: [-22, 0, -8], elbowClipL: [-8, 0, 0], forearmL: [-8, 0, 0], elbowClipR: [-15, 0, 0], forearmR: [-15, 0, 0],
  },
  Run: {
    waist: [12, 0, 0], chest: [8, -10, 0], head: [-14, 8, 0],
    hipL: [-70, 0, 0], kneeClipL: [35, 0, 0], shinL: [40, 0, 0], footL: [10, 0, 0],
    hipR: [30, 0, 0], kneeClipR: [45, 0, 0], shinR: [45, 0, 0], footR: [-25, 0, 0],
    shoulderL: [45, 0, 10], shoulderR: [-55, 0, -10], elbowClipL: [-45, 0, 0], forearmL: [-45, 0, 0], elbowClipR: [-45, 0, 0], forearmR: [-45, 0, 0],
  },
  Sit: {
    hipL: [-90, 0, 4], hipR: [-90, 0, -4], kneeClipL: [45, 0, 0], shinL: [45, 0, 0], kneeClipR: [45, 0, 0], shinR: [45, 0, 0],
    shoulderL: [-20, 0, 8], shoulderR: [-20, 0, -8], elbowClipL: [-25, 0, 0], forearmL: [-30, 0, 0], elbowClipR: [-25, 0, 0], forearmR: [-30, 0, 0],
  },
  Wave: {
    head: [0, -15, 0], abdomen: [0, 0, 5],
    shoulderR: [-10, 0, -105], elbowClipR: [-40, 0, 0], forearmR: [-45, 0, 0], handR: [0, 0, -15], upperArmR: [0, -80, 0],
    shoulderL: [0, 0, 8],
  },
  Kick: {
    waist: [-10, 0, 0], chest: [-10, 0, 0],
    hipL: [-95, 0, 0], footL: [-25, 0, 0], hipR: [10, 0, -6], kneeClipR: [10, 0, 0], shinR: [10, 0, 0],
    shoulderL: [-30, 0, 45], shoulderR: [30, 0, -45], elbowClipL: [-40, 0, 0], forearmL: [-40, 0, 0], elbowClipR: [-40, 0, 0], forearmR: [-40, 0, 0],
  },
  Crouch: {
    waist: [25, 0, 0], abdomen: [10, 0, 0], head: [-25, 0, 0],
    hipL: [-80, 0, 18], hipR: [-30, 0, -18], kneeClipL: [55, 0, 0], shinL: [55, 0, 0], kneeClipR: [60, 0, 0], shinR: [60, 0, 0],
    footL: [-20, 0, 0], footR: [-35, 0, 0],
    shoulderL: [-20, 0, 25], shoulderR: [40, 0, -40], elbowClipL: [-30, 0, 0], forearmL: [-30, 0, 0],
  },
};

export function zeroPose(): Pose {
  return {};
}

export function cloneVec(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]];
}
