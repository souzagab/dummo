// Geometry worker: owns the manifold WASM instance and builds part meshes on request.
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { Manifold } from 'manifold-3d';
import { BUILDERS, CALIBRATION } from '../core/catalog.ts';
import { collect, initGeo, setSegments } from '../core/geometry/geo.ts';
import { jointDims } from '../core/geometry/kit.ts';
import type { FigureSpec, MeshData } from '../core/types.ts';
import type { WorkerIn, WorkerOut } from './protocol.ts';

const ctx = self as unknown as {
  postMessage(msg: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

const ready = Module({ locateFile: () => wasmUrl }).then((w) => {
  w.setup();
  initGeo(w);
  return w;
});

let latest = 0;
const cache = new Map<string, MeshData | null>();
const MAX_CACHE = 600;

function toMesh(m: Manifold): MeshData {
  const mesh = m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties;
  const n = vp.length / np;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[3 * i] = vp[i * np];
    positions[3 * i + 1] = vp[i * np + 1];
    positions[3 * i + 2] = vp[i * np + 2];
  }
  return { positions, indices: new Uint32Array(mesh.triVerts), volume: m.volume() };
}

function post(msg: WorkerOut): void {
  if (msg.type === 'part' && msg.mesh) ctx.postMessage(msg, [msg.mesh.positions.buffer, msg.mesh.indices.buffer]);
  else ctx.postMessage(msg);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function build(id: number, spec: FigureSpec, segments: number, keys: string[] | undefined, calibration: boolean) {
  await ready;
  const t0 = performance.now();
  setSegments(segments);
  const d = jointDims(spec);
  const groups = calibration ? [CALIBRATION] : BUILDERS.filter((g) => !keys || g.keys.some((k) => keys.includes(k)));
  const specKey = JSON.stringify(spec);
  let done = 0;
  const total = groups.reduce((a, g) => a + g.keys.length, 0);
  for (const g of groups) {
    if (id !== latest) return; // superseded
    const cacheKeys = g.keys.map((k) => `${segments}|${k}|${specKey}`);
    let results: (MeshData | null)[];
    if (cacheKeys.every((k) => cache.has(k))) {
      results = cacheKeys.map((k) => cache.get(k)!);
    } else {
      try {
        const res = g.build(d, spec);
        results = g.keys.map((k) => (res[k] ? toMesh(res[k]!) : null));
      } catch (err) {
        post({ type: 'error', id, message: `${g.keys.join(', ')}: ${(err as Error).message ?? err}` });
        results = g.keys.map(() => null);
      } finally {
        collect();
      }
      if (cache.size > MAX_CACHE) cache.clear();
      cacheKeys.forEach((k, i) => cache.set(k, results[i]));
    }
    g.keys.forEach((k, i) => {
      const r = results[i];
      // copy so the cached buffers survive the transfer
      const mesh = r ? { positions: r.positions.slice(), indices: r.indices.slice(), volume: r.volume } : null;
      done++;
      post({ type: 'part', id, key: k, mesh, done, total });
    });
    await tick();
  }
  post({ type: 'done', id, ms: performance.now() - t0 });
}

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'build') {
    latest = msg.id;
    build(msg.id, msg.spec, msg.segments, msg.keys, !!msg.calibration).catch((err) =>
      post({ type: 'error', id: msg.id, message: String(err?.message ?? err) }));
  }
};
