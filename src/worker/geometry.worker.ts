// Geometry worker: owns the manifold WASM instance and builds part meshes on request.
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { Manifold } from 'manifold-3d';
import { buildersFor, CALIBRATION, skinActive, type BuildCtx } from '../core/catalog.ts';
import { createSkinContext, type SkinModel } from '../core/skinctx.ts';
import { collect, initGeo, setSegments } from '../core/geometry/geo.ts';
import { jointDims } from '../core/geometry/kit.ts';
import { meshOf } from '../core/geometry/mesh.ts';
import type { FigureSpec, MeshData } from '../core/types.ts';
import type { WorkerIn, WorkerOut } from './protocol.ts';

const port = self as unknown as {
  postMessage(msg: WorkerOut, transfer?: Transferable[]): void;
};

const ready = Module({ locateFile: () => wasmUrl }).then((w) => {
  w.setup();
  initGeo(w);
  return w;
});

let latest = 0;
let model: SkinModel | null = null;
const cache = new Map<string, MeshData | null>();
const MAX_CACHE = 600;

const toMesh = (m: Manifold): MeshData => meshOf(m);

function post(msg: WorkerOut): void {
  if (msg.type === 'part' && msg.mesh) port.postMessage(msg, [msg.mesh.positions.buffer, msg.mesh.indices.buffer]);
  else port.postMessage(msg);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function build(id: number, spec: FigureSpec, segments: number, skinEdge: number, keys: string[] | undefined, calibration: boolean) {
  const wasm = await ready;
  const t0 = performance.now();
  setSegments(segments);
  const d = jointDims(spec);
  const groups = calibration ? [CALIBRATION] : buildersFor(spec).filter((g) => !keys || g.keys.some((k) => keys.includes(k)));
  const specKey = `${JSON.stringify(spec)}|${skinEdge}|${model?.id ?? ''}`;
  let ctx: BuildCtx = {};
  const wantSkin = !calibration && skinActive(spec);
  const needSkin = () => wantSkin && groups.some((g) => g.keys.some((k) => !cache.has(`${segments}|${k}|${specKey}`)));
  if (wantSkin && !model) {
    post({ type: 'skin', id, state: 'missing' });
  } else if (needSkin() && model && model.id === spec.skin.modelId) {
    post({ type: 'skin', id, state: 'building' });
    await tick();
    try {
      const sc = createSkinContext(wasm, spec, d, model, skinEdge);
      ctx = sc;
      post({ type: 'skin', id, state: 'ready', ms: sc.info.ms });
    } catch (err) {
      post({ type: 'error', id, message: `skin: ${(err as Error).message ?? err}` });
    } finally {
      collect();
    }
  }
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
        const res = g.build(d, spec, ctx);
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

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'model') {
    model = msg.model;
    return;
  }
  if (msg.type === 'build') {
    latest = msg.id;
    build(msg.id, msg.spec, msg.segments, msg.skinEdge, msg.keys, !!msg.calibration).catch((err) =>
      post({ type: 'error', id: msg.id, message: String(err?.message ?? err) }));
  }
};
