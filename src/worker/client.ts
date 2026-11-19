// Main-thread side of the geometry worker. Every request gets an id; a newer request
// supersedes older ones (the worker abandons them between part groups).
import type { FigureSpec, MeshData } from '../core/types.ts';
import type { WorkerIn, WorkerOut } from './protocol.ts';

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
  onError: (msg: string) => void = (m) => console.error(m);

  constructor() {
    this.worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => this.handle(e.data);
    this.worker.onerror = (e) => this.onError(e.message || 'geometry worker failed to start');
  }

  build(spec: FigureSpec, segments: number, opts: { keys?: string[]; calibration?: boolean; onPart?: Pending['onPart'] } = {}) {
    const id = this.nextId++;
    // older requests will never complete: settle them now
    for (const [pid, p] of this.pending) { p.reject(new Error('superseded')); this.pending.delete(pid); }
    return new Promise<Map<string, MeshData | null>>((resolve, reject) => {
      this.pending.set(id, { onPart: opts.onPart, resolve, reject, out: new Map() });
      const msg: WorkerIn = { type: 'build', id, spec, segments, keys: opts.keys, calibration: opts.calibration };
      this.worker.postMessage(msg);
    });
  }

  private handle(msg: WorkerOut) {
    const p = this.pending.get(msg.id);
    if (msg.type === 'error') { this.onError(msg.message); return; }
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
