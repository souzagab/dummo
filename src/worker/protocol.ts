import type { FigureSpec, MeshData, Pose, Proportions, Vec3 } from '../core/types.ts';
import type { SkinModel } from '../core/skinctx.ts';

export type WorkerIn =
  | {
    type: 'build';
    id: number;
    spec: FigureSpec;
    segments: number;
    skinEdge: number;
    keys?: string[];
    calibration?: boolean;
  }
  | { type: 'model'; model: SkinModel | null }
  | { type: 'fit'; id: number; spec: FigureSpec };

/** Result of fitting the skeleton to the loaded model (see core/rigfit.ts). */
export type FitResult = { ok: boolean; proportions: Proportions; pose: Pose; pelvis: Vec3; notes: string[] };

export type WorkerOut =
  | { type: 'part'; id: number; key: string; mesh: MeshData | null; done: number; total: number }
  | { type: 'done'; id: number; ms: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'skin'; id: number; state: 'building' | 'ready' | 'missing'; ms?: number }
  | { type: 'fit'; id: number; fit: FitResult | null; error?: string };
