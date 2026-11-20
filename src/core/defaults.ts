import type { Colors, FigureSpec, PrintSettings, Proportions, SkinSettings, Style, Tolerances } from './types.ts';

export const MATERIALS: Record<string, Tolerances> = {
  'PETG': { socketSpine: 0.30, socketLimb: 0.20, hinge: 0.10, swivel: 0.15, armor: 0.10, peg: 0.15, slide: 0.10 },
  'ABS / ASA': { socketSpine: 0.30, socketLimb: 0.20, hinge: 0.10, swivel: 0.15, armor: 0.10, peg: 0.15, slide: 0.10 },
  'PLA': { socketSpine: 0.20, socketLimb: 0.12, hinge: 0.06, swivel: 0.10, armor: 0.12, peg: 0.10, slide: 0.12 },
  'Resin (SLA)': { socketSpine: 0.15, socketLimb: 0.10, hinge: 0.05, swivel: 0.08, armor: 0.08, peg: 0.08, slide: 0.08 },
};

export const MATERIAL_DENSITY: Record<string, number> = {
  'PETG': 1.27, 'ABS / ASA': 1.05, 'PLA': 1.24, 'Resin (SLA)': 1.15, 'Custom': 1.2,
};

export const DEFAULT_PROPORTIONS: Proportions = {
  hipHalf: 8,
  waistLen: 11,
  abdomenLen: 13,
  chestLen: 20,
  shoulderY: 14,
  shoulderHalf: 12,
  neckLen: 10,
  thighLen: 19,
  shinLen: 27,
  upperArmLen: 12,
  forearmLen: 17,
};

/** [min, max] at scale 1. Minimums keep neighbouring joints from colliding. */
export const PROPORTION_LIMITS: Record<keyof Proportions, [number, number]> = {
  hipHalf: [7.7, 16],
  waistLen: [9.5, 16],
  abdomenLen: [9.5, 18],
  chestLen: [14, 32],
  shoulderY: [10, 24],
  shoulderHalf: [10, 32],
  neckLen: [7, 14],
  thighLen: [14, 36],
  shinLen: [18, 40],
  upperArmLen: [9, 20],
  forearmLen: [13, 26],
};

export const PROPORTION_LABELS: Record<keyof Proportions, string> = {
  hipHalf: 'Hip width',
  waistLen: 'Waist',
  abdomenLen: 'Abdomen',
  chestLen: 'Chest height',
  shoulderY: 'Shoulder height',
  shoulderHalf: 'Shoulder width',
  neckLen: 'Neck',
  thighLen: 'Thigh',
  shinLen: 'Shin',
  upperArmLen: 'Upper arm',
  forearmLen: 'Forearm',
};

export const DEFAULT_STYLE: Style = {
  headShape: 'egg',
  headSize: 1,
  chestWidth: 1,
  bulk: 1,
  facet: 0.5,
  emblem: 'chevron',
  handPose: 'fist',
  weapon: 'sword',
  handSize: 1,
  footSize: 1,
  ankleTilt: 8,
  backPort: true,
  armor: { head: true, chest: true, abdomen: true, pelvis: true, arms: true, legs: true, feet: true },
};

export function defaultSkin(): SkinSettings {
  return {
    enabled: false, modelId: '', modelName: '',
    transform: { scale: 1, rot: [0, 0, 0], offset: [0, 0, 0] },
    bindPose: {}, detail: 0.45, close: 2.5, gap: 0.6, motion: true, cover: true,
  };
}

export function defaultSpec(): FigureSpec {
  return {
    version: 1,
    name: 'Dummo',
    scale: 1,
    material: 'PETG',
    proportions: { ...DEFAULT_PROPORTIONS },
    style: structuredClone(DEFAULT_STYLE),
    tolerances: { ...MATERIALS['PETG'] },
    skin: defaultSkin(),
  };
}

export const DEFAULT_PRINT: PrintSettings = { bedX: 220, bedY: 220, spacing: 4, stand: true };

export const DEFAULT_COLORS: Colors = { frame: '#3b3f46', armor: '#e8642c', background: '#f3efe8' };

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const PRESETS: Record<string, DeepPartial<FigureSpec>> = {
  Standard: {},
  Heroic: {
    proportions: { shoulderHalf: 12.5, chestLen: 21, thighLen: 20, shinLen: 28 },
    style: { chestWidth: 1.15, bulk: 1.1, headSize: 0.92, headShape: 'block', emblem: 'chevron' },
  },
  Slim: {
    proportions: { shoulderHalf: 10.2, hipHalf: 7.8, thighLen: 20.5, shinLen: 29, upperArmLen: 13, forearmLen: 18 },
    style: { chestWidth: 0.9, bulk: 0.9, headShape: 'egg', emblem: 'none' },
  },
  Chibi: {
    proportions: {
      thighLen: 14.5, shinLen: 19, upperArmLen: 9.5, forearmLen: 13.5, chestLen: 16,
      shoulderY: 10, abdomenLen: 10, waistLen: 10, neckLen: 7.5,
    },
    style: { headSize: 1.45, headShape: 'round', bulk: 1.05, emblem: 'circle' },
  },
  Brute: {
    proportions: { shoulderHalf: 13.5, hipHalf: 9.5, upperArmLen: 13, forearmLen: 18, shinLen: 26 },
    style: { bulk: 1.25, chestWidth: 1.3, headSize: 0.85, headShape: 'visor', emblem: 'bar' },
  },
};

export function applyPreset(base: FigureSpec, name: string): FigureSpec {
  const p = PRESETS[name] ?? {};
  const out = defaultSpec();
  out.name = base.name;
  out.scale = base.scale;
  out.material = base.material;
  out.tolerances = { ...base.tolerances };
  out.style.handPose = base.style.handPose;
  out.style.weapon = base.style.weapon;
  out.style.armor = { ...base.style.armor };
  out.skin = structuredClone(base.skin);
  Object.assign(out.proportions, p.proportions ?? {});
  const { armor, ...styleRest } = (p.style ?? {}) as DeepPartial<Style>;
  Object.assign(out.style, styleRest);
  if (armor) Object.assign(out.style.armor, armor);
  return out;
}

/** Clamp proportions to safe ranges (including dependent limits). */
export function sanitizeSpec(spec: FigureSpec): FigureSpec {
  const s = structuredClone(spec);
  s.scale = clamp(s.scale, 0.6, 2.5);
  const P = s.proportions;
  for (const k of Object.keys(PROPORTION_LIMITS) as (keyof Proportions)[]) {
    const [lo, hi] = PROPORTION_LIMITS[k];
    P[k] = clamp(Number(P[k]) || DEFAULT_PROPORTIONS[k], lo, hi);
  }
  P.shoulderY = clamp(P.shoulderY, 10, P.chestLen - 3.5);
  const st = s.style;
  st.headSize = clamp(st.headSize, 0.7, 1.6);
  st.chestWidth = clamp(st.chestWidth, 0.8, 1.35);
  st.bulk = clamp(st.bulk, 0.85, 1.35);
  st.facet = clamp(st.facet, 0, 1);
  st.handSize = clamp(st.handSize, 0.8, 1.3);
  st.footSize = clamp(st.footSize, 0.8, 1.3);
  st.ankleTilt = clamp(st.ankleTilt, 0, 15);
  const sk = s.skin ?? defaultSkin();
  s.skin = sk;
  sk.detail = clamp(Number(sk.detail) || 0.6, 0.3, 1.5);
  sk.close = clamp(Number(sk.close) || 0, 0, 8);
  sk.gap = clamp(Number(sk.gap) || 0.6, 0.2, 3);
  sk.motion = sk.motion !== false;
  sk.cover = sk.cover !== false;
  sk.transform.scale = clamp(Number(sk.transform.scale) || 1, 1e-4, 1e4);
  if (!sk.modelId) sk.enabled = false;
  const t = s.tolerances;
  for (const k of Object.keys(t) as (keyof Tolerances)[]) t[k] = clamp(Number(t[k]) || 0, 0, 0.6);
  return s;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
