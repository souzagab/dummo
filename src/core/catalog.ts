// Part catalog: which solids exist (builder groups, run in the worker) and where every
// instance sits on the rig (mounts, used by the viewer and exporters).
import { Matrix4, Vector3 } from 'three';
import type { Manifold } from 'manifold-3d';
import type { FigureSpec, PartGroup, Vec3 } from './types.ts';
import { rigPoints } from './skeleton.ts';
import { jointDims, type Dims } from './geometry/kit.ts';
import * as F from './geometry/frame.ts';
import * as A from './geometry/armor.ts';
import { calibration, handleZ, standBase, standLayout, standPost, staff, sword } from './geometry/accessories.ts';

/** Extra inputs for builders. skinOuter(piece) returns a character-skin region in the piece's design frame. */
export type BuildCtx = { skinOuter?: (piece: string) => Manifold | null };

export type BuilderGroup = {
  keys: string[];
  build: (d: Dims, spec: FigureSpec, ctx?: BuildCtx) => Record<string, Manifold | null>;
};

type Fn<T> = (d: Dims, spec: FigureSpec, ctx: BuildCtx) => T;
const one = (key: string, fn: Fn<Manifold | null>): BuilderGroup => ({
  keys: [key], build: (d, spec, ctx = {}) => ({ [key]: fn(d, spec, ctx) }),
});
const shell = (prefix: string, fn: Fn<A.Shell | null>): BuilderGroup => ({
  keys: [`${prefix}-front`, `${prefix}-back`],
  build: (d, spec, ctx = {}) => {
    const sh = fn(d, spec, ctx);
    return { [`${prefix}-front`]: sh?.front ?? null, [`${prefix}-back`]: sh?.back ?? null };
  },
});
const so = (ctx: BuildCtx, piece: string) => ctx.skinOuter?.(piece) ?? null;

/** Drop small islands that joint cut-outs can leave behind on organic skin pieces. */
function clean(m: Manifold | null): Manifold | null {
  if (!m) return m;
  // simplify removes the odd zero-area sliver left where flat cuts meet the level-set surface
  const parts = m.asOriginal().simplify(1e-3).decompose();
  if (parts.length < 2) return parts[0] ?? null;
  const big = Math.max(...parts.map((p) => p.volume()));
  const keep = parts.filter((p) => p.volume() >= Math.max(4, big * 0.1));
  return keep.length === 1 ? keep[0] : keep.reduce((a, b) => a.add(b));
}
const cleanShell = (sh: A.Shell | null): A.Shell | null => (sh ? { front: clean(sh.front)!, back: clean(sh.back)! } : null);

export function skinActive(spec: FigureSpec): boolean {
  return spec.skin.enabled && !!spec.skin.modelId;
}

/** Builder groups for a spec. In skin mode left and right limb armor differ, and dowels appear. */
export function buildersFor(spec: FigureSpec): BuilderGroup[] {
  if (!skinActive(spec)) return BUILDERS;
  const base = BUILDERS.filter((g) => !['thigh-sleeve', 'shin-sleeve', 'upper-arm-sleeve', 'forearm-sleeve', 'foot'].includes(g.keys[0])
    && !g.keys[0].match(/^(head|chest|abdomen|pelvis)-front$/));
  const out: BuilderGroup[] = [...base,
    shell('head', (d, s, c) => (s.style.armor.head ? cleanShell(A.headShell(d, s, F.headFrame(d), so(c, 'head'))) : null)),
    shell('chest', (d, s, c) => (s.style.armor.chest ? cleanShell(A.chestShell(d, s, F.chest(d, s), so(c, 'chest'))) : null)),
    shell('abdomen', (d, s, c) => (s.style.armor.abdomen ? cleanShell(A.abdomenShell(d, s, F.spineLink(d, s.proportions.abdomenLen * d.s, 'abdomen'), so(c, 'abdomen'))) : null)),
    shell('pelvis', (d, s, c) => (s.style.armor.pelvis ? cleanShell(A.pelvisShell(d, s, F.spineLink(d, s.proportions.waistLen * d.s, 'waist'), so(c, 'pelvis'))) : null)),
    one('dowel', (d) => A.dowel(d)),
  ];
  for (const side of ['L', 'R']) {
    out.push(
      one(`thigh-sleeve-${side}`, (d, s, c) => (s.style.armor.legs ? clean(A.upperSleeve(d, s, s.proportions.thighLen * d.s, 1, so(c, `thigh-sleeve-${side}`))) : null)),
      one(`shin-sleeve-${side}`, (d, s, c) => (s.style.armor.legs ? clean(A.lowerSleeve(d, s, s.proportions.shinLen * d.s, 1, so(c, `shin-sleeve-${side}`))) : null)),
      one(`upper-arm-sleeve-${side}`, (d, s, c) => (s.style.armor.arms ? clean(A.upperSleeve(d, s, s.proportions.upperArmLen * d.s, 0.9, so(c, `upper-arm-sleeve-${side}`))) : null)),
      one(`forearm-sleeve-${side}`, (d, s, c) => (s.style.armor.arms ? clean(A.lowerSleeve(d, s, s.proportions.forearmLen * d.s, 0.9, so(c, `forearm-sleeve-${side}`))) : null)),
      one(`foot-${side}`, (d, s, c) => (s.style.armor.feet ? clean(A.foot(d, s, so(c, `foot-${side}`))) : null)),
    );
  }
  return out;
}

export const BUILDERS: BuilderGroup[] = [
  one('pelvis', (d, s) => F.pelvis(d, s).solid),
  one('waist', (d, s) => F.spineLink(d, s.proportions.waistLen * d.s, 'waist').solid),
  one('abdomen', (d, s) => F.spineLink(d, s.proportions.abdomenLen * d.s, 'abdomen').solid),
  one('chest', (d, s) => F.chest(d, s).solid),
  one('neck', (d, s) => F.neck(d, s).solid),
  one('head-frame', (d) => F.headFrame(d).solid),
  one('swivel', (d) => F.swivel(d).solid),
  one('thigh', (d, s) => F.upperBone(d, s.proportions.thighLen * d.s).solid),
  one('upper-arm', (d, s) => F.upperBone(d, s.proportions.upperArmLen * d.s).solid),
  one('shin', (d, s) => F.lowerBone(d, s.proportions.shinLen * d.s).solid),
  one('forearm', (d, s) => F.lowerBone(d, s.proportions.forearmLen * d.s).solid),
  one('clip', (d) => F.clip(d).solid),
  one('ankle', (d, s) => F.ankle(d, s).solid),
  one('hand-L', (d, s) => F.hand(d, s, s.style.handPose, 'L').solid),
  one('hand-R', (d, s) => F.hand(d, s, s.style.handPose, 'R').solid),
  shell('head', (d, s) => (s.style.armor.head ? A.headShell(d, s, F.headFrame(d)) : null)),
  shell('chest', (d, s) => (s.style.armor.chest ? A.chestShell(d, s, F.chest(d, s)) : null)),
  shell('abdomen', (d, s) => (s.style.armor.abdomen ? A.abdomenShell(d, s, F.spineLink(d, s.proportions.abdomenLen * d.s, 'abdomen')) : null)),
  shell('pelvis', (d, s) => (s.style.armor.pelvis ? A.pelvisShell(d, s, F.spineLink(d, s.proportions.waistLen * d.s, 'waist')) : null)),
  one('thigh-sleeve', (d, s) => (s.style.armor.legs ? A.upperSleeve(d, s, s.proportions.thighLen * d.s) : null)),
  one('shin-sleeve', (d, s) => (s.style.armor.legs ? A.lowerSleeve(d, s, s.proportions.shinLen * d.s) : null)),
  one('upper-arm-sleeve', (d, s) => (s.style.armor.arms ? A.upperSleeve(d, s, s.proportions.upperArmLen * d.s, 0.9) : null)),
  one('forearm-sleeve', (d, s) => (s.style.armor.arms ? A.lowerSleeve(d, s, s.proportions.forearmLen * d.s, 0.9) : null)),
  one('foot', (d, s) => (s.style.armor.feet ? A.foot(d, s) : null)),
  one('stand-base', (d, s) => standBase(d, s)),
  one('stand-post', (d, s) => standPost(d, s)),
  one('weapon', (d, s) => (s.style.handPose !== 'grip' ? null : s.style.weapon === 'sword' ? sword(d, s) : s.style.weapon === 'staff' ? staff(d, s) : null)),
];

export const CALIBRATION: BuilderGroup = {
  keys: ['cal-sockets', 'cal-balls', 'cal-clips', 'cal-spools'],
  build: (d) => calibration(d),
};

// ---------- instances ----------

export type PartDef = {
  id: string;
  key: string;
  label: string;
  group: PartGroup;
  node: string; // rig node, or 'world' for the stand
  mount: Matrix4; // design frame -> rest-pose world
  printRot: Matrix4; // design frame -> print orientation (before bed placement)
  explode: Vec3 | null; // rest-pose world direction for exploded view
};

const basis = (x: Vec3, y: Vec3, z: Vec3) =>
  new Matrix4().makeBasis(new Vector3(...x), new Vector3(...y), new Vector3(...z));

export const R = {
  I: new Matrix4(),
  SAG_L: basis([0, 0, -1], [0, 1, 0], [1, 0, 0]),
  SAG_R: basis([0, 0, 1], [0, 1, 0], [-1, 0, 0]),
  CLIP_L: basis([0, -1, 0], [0, 0, -1], [1, 0, 0]),
  CLIP_R: basis([0, -1, 0], [0, 0, 1], [-1, 0, 0]),
  ROT_Y180: basis([-1, 0, 0], [0, 1, 0], [0, 0, -1]),
  FOOT: basis([-1, 0, 0], [0, 0, 1], [0, 1, 0]),
  POST: basis([0, 0, 1], [0, 1, 0], [-1, 0, 0]),
  BASE: basis([1, 0, 0], [0, 0, -1], [0, 1, 0]),
  FLIP_X: basis([1, 0, 0], [0, -1, 0], [0, 0, -1]),
  STAND_UP: basis([1, 0, 0], [0, 0, 1], [0, -1, 0]),
};

/** Mount that maps a local point onto a world point with rotation rot. */
function mountAt(rot: Matrix4, local: Vec3, world: Vec3): Matrix4 {
  const l = new Vector3(...local).applyMatrix4(rot);
  return new Matrix4().makeTranslation(world[0] - l.x, world[1] - l.y, world[2] - l.z).multiply(rot);
}

const dirOf = (rot: Matrix4, v: Vec3): Vec3 => {
  const d = new Vector3(...v).applyMatrix4(new Matrix4().extractRotation(rot));
  return [d.x, d.y, d.z];
};

export function partList(spec: FigureSpec): PartDef[] {
  const d = jointDims(spec);
  const s = d.s, c = d.c, p = rigPoints(spec);
  const skin = skinActive(spec);
  const perSide = (key: string, side: string) => (skin ? `${key}-${side}` : key);
  const out: PartDef[] = [];
  const add = (id: string, key: string, label: string, group: PartGroup, node: string, mount: Matrix4,
    printRot: Matrix4 = R.I, explode: Vec3 | null = null) => out.push({ id, key, label, group, node, mount, printRot, explode });

  // spine + head
  add('pelvis', 'pelvis', 'Pelvis', 'frame', 'pelvis', mountAt(R.I, [0, 0, c], p.pelvis));
  const waistM = mountAt(R.SAG_L, [0, 0, c], p.pelvis);
  add('waist', 'waist', 'Waist', 'frame', 'waist', waistM);
  const abdM = mountAt(R.I, [0, 0, c], p.waistBall);
  add('abdomen', 'abdomen', 'Abdomen', 'frame', 'abdomen', abdM);
  const chestM = mountAt(R.I, [0, 0, c], p.chestPivot);
  add('chest', 'chest', 'Chest', 'frame', 'chest', chestM);
  add('neck', 'neck', 'Neck', 'frame', 'neck', mountAt(R.I, [0, 0, c], p.neckSock));
  const headM = mountAt(R.I, [0, 0, c], p.headPivot);
  add('head-frame', 'head-frame', 'Head core', 'frame', 'head', headM);

  // faceted shells print outer face down; skins print split face down
  const shellPair = (prefix: string, label: string, node: string, m: Matrix4) => {
    add(`${prefix}-front`, `${prefix}-front`, `${label} (front)`, 'armor', node, m, skin ? R.I : R.FLIP_X, dirOf(m, [0, 0, 1]));
    add(`${prefix}-back`, `${prefix}-back`, `${label} (back)`, 'armor', node, m, skin ? R.FLIP_X : R.I, dirOf(m, [0, 0, -1]));
  };
  shellPair('head', 'Head', 'head', headM);
  shellPair('chest', 'Chest', 'chest', chestM);
  shellPair('abdomen', 'Abdomen', 'abdomen', abdM);
  shellPair('pelvis', 'Pelvis', 'waist', waistM);

  for (const side of ['L', 'R'] as const) {
    const S = side === 'L' ? 'left' : 'right';
    const sag = side === 'L' ? R.SAG_L : R.SAG_R;
    const clipR = side === 'L' ? R.CLIP_L : R.CLIP_R;
    const P = (k: string) => (p as Record<string, Vec3>)[k + side];
    // leg
    add(`hip-swivel-${side}`, 'swivel', `Hip swivel (${S})`, 'frame', `hip${side}`, mountAt(sag, [0, 0, c], P('hip')));
    const thighM = mountAt(sag, [0, spec.proportions.thighLen * s, c], P('legDisc'));
    add(`thigh-${side}`, 'thigh', `Thigh (${S})`, 'frame', `thigh${side}`, thighM);
    add(`thigh-sleeve-${side}`, perSide('thigh-sleeve', side), `Thigh armor (${S})`, 'armor', `thigh${side}`, thighM, R.STAND_UP, [0, -1, 0]);
    add(`knee-${side}`, 'clip', `Knee link (${S})`, 'frame', `kneeClip${side}`, mountAt(clipR, [0, 0, d.clip.t / 2], P('kneeA')));
    const shinM = mountAt(sag, [0, 0, c], P('kneeB'));
    add(`shin-${side}`, 'shin', `Shin (${S})`, 'frame', `shin${side}`, shinM);
    add(`shin-sleeve-${side}`, perSide('shin-sleeve', side), `Shin armor (${S})`, 'armor', `shin${side}`, shinM, R.STAND_UP, [0, 1, 0]);
    const ankleRot = side === 'L' ? R.I : R.ROT_Y180;
    add(`ankle-${side}`, 'ankle', `Ankle (${S})`, 'frame', `foot${side}`, mountAt(ankleRot, [0, 0, c], P('ankle')));
    add(`foot-${side}`, perSide('foot', side), `Foot (${S})`, 'armor', `foot${side}`, mountAt(R.FOOT, [0, 0, A.footDrop(d)], P('ankle')), R.I, [0, -1, 0]);
    // arm
    add(`shoulder-swivel-${side}`, 'swivel', `Shoulder swivel (${S})`, 'frame', `shoulder${side}`, mountAt(sag, [0, 0, c], P('shoulder')));
    const uaM = mountAt(sag, [0, spec.proportions.upperArmLen * s, c], P('armDisc'));
    add(`upper-arm-${side}`, 'upper-arm', `Upper arm (${S})`, 'frame', `upperArm${side}`, uaM);
    add(`upper-arm-sleeve-${side}`, perSide('upper-arm-sleeve', side), `Upper arm armor (${S})`, 'armor', `upperArm${side}`, uaM, R.STAND_UP, [0, -1, 0]);
    add(`elbow-${side}`, 'clip', `Elbow link (${S})`, 'frame', `elbowClip${side}`, mountAt(clipR, [0, 0, d.clip.t / 2], P('elbowA')));
    const faM = mountAt(sag, [0, 0, c], P('elbowB'));
    add(`forearm-${side}`, 'forearm', `Forearm (${S})`, 'frame', `forearm${side}`, faM);
    add(`forearm-sleeve-${side}`, perSide('forearm-sleeve', side), `Forearm armor (${S})`, 'armor', `forearm${side}`, faM, R.STAND_UP, [0, 1, 0]);
    const handM = mountAt(sag, [0, 0, c], P('wrist'));
    add(`hand-${side}`, `hand-${side}`, `Hand (${S})`, 'frame', `hand${side}`, handM);
    if (side === 'R') {
      // weapon: handle axis = grip hole axis (hand x); blade toward the thumb side
      const g = F.gripCentre(d, spec);
      const inHand = new Matrix4().makeTranslation(g[0], g[1], g[2])
        .multiply(basis([1, 0, 0], [0, 1, 0], [0, 0, 1]))
        .multiply(new Matrix4().makeTranslation(0, 0, -handleZ(d)));
      add('weapon', 'weapon', spec.style.weapon === 'staff' ? 'Staff' : 'Sword', 'accessory', 'handR', handM.clone().multiply(inHand));
    }
  }

  if (skin) {
    const st = spec.style.armor;
    const n = (st.head ? 2 : 0) + (st.chest ? 2 : 0) + (st.abdomen ? 1 : 0) + (st.pelvis ? 1 : 0);
    for (let i = 0; i < n; i++) add(`dowel-${i}`, 'dowel', 'Armor dowel', 'armor', 'world', new Matrix4(), R.I, null);
  }

  // stand
  const L = standLayout(d, spec);
  add('stand-post', 'stand-post', 'Stand post', 'accessory', 'world', new Matrix4().makeTranslation(L.tx, 0, 0).multiply(R.POST));
  add('stand-base', 'stand-base', 'Stand base', 'accessory', 'world',
    new Matrix4().makeTranslation(0, L.groundY - L.baseT, L.zBase).multiply(R.BASE));
  return out;
}

/** Height of the sole below the pelvis at rest (positive number). */
export function restGround(spec: FigureSpec): number {
  const d = jointDims(spec), p = rigPoints(spec);
  return -(Math.min(p.ankleL[1], p.ankleR[1]) - A.footDrop(d));
}
