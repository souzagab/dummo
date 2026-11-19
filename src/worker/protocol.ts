import type { FigureSpec, MeshData } from '../core/types.ts';

export type WorkerIn = {
  type: 'build';
  id: number;
  spec: FigureSpec;
  segments: number;
  keys?: string[];
  calibration?: boolean;
};

export type WorkerOut =
  | { type: 'part'; id: number; key: string; mesh: MeshData | null; done: number; total: number }
  | { type: 'done'; id: number; ms: number }
  | { type: 'error'; id: number; message: string };
