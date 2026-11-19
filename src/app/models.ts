// Import character models (STL / OBJ / GLB / glTF / 3MF / PLY) and keep the last one in IndexedDB.
import { Box3, BufferAttribute, BufferGeometry, Matrix4, Mesh, Object3D, Vector3 } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { modelId, modelMatrix, type SkinModel } from '../core/skinctx.ts';
import type { SkinSettings } from '../core/types.ts';

export const MODEL_ACCEPT = '.stl,.obj,.glb,.gltf,.3mf,.ply';

export async function parseModel(file: File): Promise<SkinModel> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const buf = await file.arrayBuffer();
  const geos: BufferGeometry[] = [];
  const collect = (root: Object3D) => {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || !m.geometry?.attributes?.position) return;
      const g = new BufferGeometry();
      g.setAttribute('position', m.geometry.attributes.position.clone());
      if (m.geometry.index) g.setIndex(m.geometry.index.clone());
      g.applyMatrix4(m.matrixWorld);
      geos.push(g);
    });
  };
  if (ext === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    geos.push(new STLLoader().parse(buf));
  } else if (ext === 'ply') {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
    geos.push(new PLYLoader().parse(buf));
  } else if (ext === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    collect(new OBJLoader().parse(new TextDecoder().decode(buf)));
  } else if (ext === '3mf') {
    const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
    collect(new ThreeMFLoader().parse(buf));
  } else if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(ext === 'glb' ? buf : new TextDecoder().decode(buf), '');
    collect(gltf.scene);
  } else {
    throw new Error(`Unsupported file type .${ext}`);
  }
  if (!geos.length) throw new Error('No meshes found in that file');
  // one position-only, indexed geometry
  let total = 0;
  for (const g of geos) total += (g.index ? g.index.count : g.attributes.position.count);
  const pos = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    const n = g.index ? g.index.count : p.count;
    for (let i = 0; i < n; i++) {
      const v = g.index ? g.index.getX(i) : i;
      pos[o++] = p.getX(v); pos[o++] = p.getY(v); pos[o++] = p.getZ(v);
    }
  }
  const soup = new BufferGeometry();
  soup.setAttribute('position', new BufferAttribute(pos, 3));
  const merged = mergeVertices(soup, 1e-5);
  const positions = new Float32Array(merged.attributes.position.array as ArrayLike<number>);
  const indices = new Uint32Array(merged.index!.array as ArrayLike<number>);
  if (indices.length / 3 > 2_000_000) throw new Error('Model is too detailed (over 2 million triangles)');
  return { id: modelId(positions, indices), name: file.name, positions, indices };
}

/**
 * Initial placement: Z-up models are stood up, then the model is scaled to the figure's height,
 * centred, and set on the ground.
 */
export function autoFit(model: SkinModel, figureHeight: number, groundY: number, rot?: [number, number, number]): SkinSettings['transform'] {
  const box = new Box3();
  const p = model.positions, v = new Vector3();
  for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]));
  const size = box.getSize(new Vector3());
  const r: [number, number, number] = rot ?? (size.z > size.y * 1.25 ? [-90, 0, 0] : [0, 0, 0]);
  const rotOnly = modelMatrix({ scale: 1, rot: r, offset: [0, 0, 0] });
  const rb = new Box3();
  for (let i = 0; i < p.length; i += 3) rb.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(rotOnly));
  const rs = rb.getSize(new Vector3());
  const scale = rs.y > 0 ? figureHeight / rs.y : 1;
  const c = rb.getCenter(new Vector3()).multiplyScalar(scale);
  return { scale, rot: r, offset: [-c.x, groundY - rb.min.y * scale, -c.z] };
}

export function ghostMatrix(t: SkinSettings['transform']): Matrix4 {
  return modelMatrix(t);
}

// ---------- IndexedDB persistence ----------

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dummo', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function storeModel(m: SkinModel | null): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction('files', 'readwrite');
      if (m) tx.objectStore('files').put(m, 'model'); else tx.objectStore('files').delete('model');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage unavailable: the model just won't survive a reload */
  }
}

export async function restoreModel(): Promise<SkinModel | null> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const req = d.transaction('files').objectStore('files').get('model');
      req.onsuccess = () => resolve((req.result as SkinModel) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
