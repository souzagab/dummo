// Mesh extraction shared by the worker, CLI tools and checks.
import type { Manifold } from 'manifold-3d';
import type { MeshData } from '../types.ts';

/**
 * Positions + indices of a solid, cleaned for slicers: vertices closer than ~0.1 µm are welded,
 * triangles that collapse are dropped, and opposite duplicate triangles (zero-thickness fins)
 * cancel out. Booleans and level sets can leave such near-coincident vertices; they are valid
 * for manifold but turn into holes or non-manifold edges once a slicer merges vertices.
 */
export function meshOf(m: Manifold): MeshData {
  const mesh = m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const n = vp.length / np;
  const q = 1e4; // weld grid: 0.1 µm
  const weld = new Map<string, number>();
  const remap = new Uint32Array(n);
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = vp[i * np], y = vp[i * np + 1], z = vp[i * np + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let v = weld.get(key);
    if (v === undefined) { v = pos.length / 3; weld.set(key, v); pos.push(x, y, z); }
    remap[i] = v;
  }
  const tris = new Map<string, number[]>();
  const order: string[] = [];
  for (let t = 0; t < tv.length; t += 3) {
    const a = remap[tv[t]], b = remap[tv[t + 1]], c = remap[tv[t + 2]];
    if (a === b || b === c || a === c) continue;
    // canonical rotation; a reversed duplicate has the same sorted set but opposite winding
    const key = [a, b, c].sort((u, v) => u - v).join(',');
    const prev = tris.get(key);
    if (prev) {
      const same = (prev[0] === a && prev[1] === b && prev[2] === c) || (prev[0] === b && prev[1] === c && prev[2] === a) || (prev[0] === c && prev[1] === a && prev[2] === b);
      if (!same) { tris.delete(key); continue; } // opposite pair: zero-thickness fin
    }
    if (!prev) order.push(key);
    tris.set(key, [a, b, c]);
  }
  const indices: number[] = [];
  for (const k of order) { const t = tris.get(k); if (t) indices.push(t[0], t[1], t[2]); }
  return { positions: new Float32Array(pos), indices: new Uint32Array(indices), volume: m.volume() };
}

/**
 * Closed-surface check after merging vertices by position: every edge is used equally often in
 * both directions (2 uses normally, 4 where the surface touches itself along an edge).
 */
export function isWatertight(d: MeshData): boolean {
  const id = new Map<string, number>();
  const vid = (i: number) => {
    const k = `${d.positions[3 * i]},${d.positions[3 * i + 1]},${d.positions[3 * i + 2]}`;
    let v = id.get(k);
    if (v === undefined) { v = id.size; id.set(k, v); }
    return v;
  };
  const fwd = new Map<string, number>(), back = new Map<string, number>();
  for (let t = 0; t < d.indices.length; t += 3) {
    const v = [vid(d.indices[t]), vid(d.indices[t + 1]), vid(d.indices[t + 2])];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (a === b) return false;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const m = a < b ? fwd : back;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  for (const [k, n] of fwd) if (back.get(k) !== n) return false;
  for (const [k, n] of back) if (fwd.get(k) !== n) return false;
  return true;
}
