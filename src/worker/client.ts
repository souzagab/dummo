// Main-thread side of the geometry worker. Every request gets an id; a newer request
// supersedes older ones (the worker abandons them between part groups).
import type { FigureSpec, MeshData } from '../core/types.ts';
import type { FitResult, WorkerIn, WorkerOut } from './protocol.ts';
import type { SkinModel } from '../core/skinctx.ts';

type Pending = {
  onPart?: (key: string, mesh: MeshData | null, done: number, total: number) => void;
  resolve: (r: Map<string, MeshData | null>) => void;
  reject: (e: Error) => void;
  out: Map<string, MeshData | null>;
};

export class GeometryClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private fits = new Map<number, (r: { fit: FitResult | null; error?: string }) => void>();
  onError: (msg: string) => void = (m) => console.error(m);
  onSkin: (state: 'building' | 'ready' | 'missing', ms?: number) => void = () => {};

  constructor() {
    this.worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => this.handle(e.data);
    this.worker.onerror = (e) => this.onError(e.message || 'geometry worker failed to start');
  }

  setModel(model: SkinModel | null): void {
    // copy so the caller keeps its arrays
    const m = model ? { ...model, positions: model.positions.slice(), indices: model.indices.slice() } : null;
    const msg: WorkerIn = { type: 'model', model: m };
    this.worker.postMessage(msg, m ? [m.positions.buffer, m.indices.buffer] : []);
  }

  /** Fit the skeleton to the loaded model (placed by spec.skin.transform). */
  fit(spec: FigureSpec): Promise<{ fit: FitResult | null; error?: string }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.fits.set(id, resolve);
      const msg: WorkerIn = { type: 'fit', id, spec };
      this.worker.postMessage(msg);
    });
  }

  build(spec: FigureSpec, segments: number, opts: { keys?: string[]; calibration?: boolean; skinEdge?: number; onPart?: Pending['onPart'] } = {}) {
    const id = this.nextId++;
    // older requests will never complete: settle them now
    for (const [pid, p] of this.pending) { p.reject(new Error('superseded')); this.pending.delete(pid); }
    return new Promise<Map<string, MeshData | null>>((resolve, reject) => {
      this.pending.set(id, { onPart: opts.onPart, resolve, reject, out: new Map() });
      const msg: WorkerIn = { type: 'build', id, spec, segments, skinEdge: opts.skinEdge ?? 1, keys: opts.keys, calibration: opts.calibration };
      this.worker.postMessage(msg);
    });
  }

  private handle(msg: WorkerOut) {
    if (msg.type === 'fit') { this.fits.get(msg.id)?.({ fit: msg.fit, error: msg.error }); this.fits.delete(msg.id); return; }
    const p = this.pending.get(msg.id);
    if (msg.type === 'error') { this.onError(msg.message); return; }
    if (msg.type === 'skin') { if (this.pending.has(msg.id)) this.onSkin(msg.state, msg.ms); return; }
    if (!p) return;
    if (msg.type === 'part') {
      p.out.set(msg.key, msg.mesh);
      p.onPart?.(msg.key, msg.mesh, msg.done, msg.total);
    } else if (msg.type === 'done') {
      this.pending.delete(msg.id);
      p.resolve(p.out);
    }
  }
}
