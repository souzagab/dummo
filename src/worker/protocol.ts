import type { FigureSpec, MeshData } from '../core/types.ts';
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
  | { type: 'model'; model: SkinModel | null };

export type WorkerOut =
  | { type: 'part'; id: number; key: string; mesh: MeshData | null; done: number; total: number }
  | { type: 'done'; id: number; ms: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'skin'; id: number; state: 'building' | 'ready' | 'missing'; ms?: number };
