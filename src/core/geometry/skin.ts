// Character skins: turn an arbitrary humanoid mesh (triangle soup, open shells and all)
// into solid armor regions, one per armor piece, by
//   1. voxelising the surface and "closing" small openings (solidify),
//   2. building a signed distance field,
//   3. giving every point of the solid to the nearest bone (Voronoi over bone segments),
//   4. meshing each region with a level set.
// Mechanical cuts (frame pockets, joint clearances, slide-on channels) are added later by
// the regular armor builders, which take these regions as their outer shape.
import type { Manifold } from 'manifold-3d';
import type { Vec3 } from '../types.ts';
import { M } from './geo.ts';

export type Field = {
  nx: number; ny: number; nz: number;
  h: number;
  o: Vec3;            // world position of voxel (0,0,0)
  sdf: Float32Array;  // mm, positive inside
};

const INF = 1e20;

function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Euclidean distance (in voxels) from every voxel to the nearest voxel where mask[i] === value. */
function edt(mask: Uint8Array, value: number, nx: number, ny: number, nz: number): Float32Array {
  const N = nx * ny * nz;
  const g = new Float32Array(N);
  for (let i = 0; i < N; i++) g[i] = mask[i] === value ? 0 : INF;
  const n = Math.max(nx, ny, nz);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len: number, stride: number, starts: () => Iterable<number>) => {
    for (const s0 of starts()) {
      for (let i = 0; i < len; i++) f[i] = g[s0 + i * stride];
      dt1d(f, len, d, v, z);
      for (let i = 0; i < len; i++) g[s0 + i * stride] = d[i];
    }
  };
  pass(nx, 1, function* () { for (let zz = 0; zz < nz; zz++) for (let y = 0; y < ny; y++) yield nx * (y + ny * zz); });
  pass(ny, nx, function* () { for (let zz = 0; zz < nz; zz++) for (let x = 0; x < nx; x++) yield x + nx * ny * zz; });
  pass(nz, nx * ny, function* () { for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) yield x + nx * y; });
  for (let i = 0; i < N; i++) g[i] = Math.sqrt(g[i]);
  return g;
}

/**
 * For every voxel, on how many of 14 directions (6 axes, 8 cube diagonals) a surface voxel lies
 * ahead of it. Inside a hollow shell or a tube nearly every direction hits a wall; in the open
 * crooks between limbs at most about half do.
 */
export function enclosed(surf: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const N = nx * ny * nz, sy = nx, sz = nx * ny;
  const cnt = new Uint8Array(N), seen = new Uint8Array(N);
  const dirs: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const a of [1, -1]) for (const b of [1, -1]) for (const c of [1, -1]) dirs.push([a, b, c]);
  for (const [dx, dy, dz] of dirs) {
    // visit voxels so that the one behind (i - d) is always done first
    const xs = dx >= 0 ? [0, nx, 1] : [nx - 1, -1, -1];
    const ys = dy >= 0 ? [0, ny, 1] : [ny - 1, -1, -1];
    const zs = dz >= 0 ? [0, nz, 1] : [nz - 1, -1, -1];
    const back = -(dx + dy * sy + dz * sz);
    for (let z = zs[0]; z !== zs[1]; z += zs[2]) {
      const zb = z - dz >= 0 && z - dz < nz;
      for (let y = ys[0]; y !== ys[1]; y += ys[2]) {
        const yb = zb && y - dy >= 0 && y - dy < ny;
        for (let x = xs[0]; x !== xs[1]; x += xs[2]) {
          const i = x + sy * y + sz * z;
          let v = 0;
          if (yb && x - dx >= 0 && x - dx < nx) { const j = i + back; v = surf[j] | seen[j]; }
          seen[i] = v;
          cnt[i] += v;
        }
      }
    }
  }
  return cnt;
}

/**
 * Solid signed distance field of a (possibly open, overlapping, self-intersecting) mesh.
 * Openings narrower than about 2 * close are sealed. `coarse` skips the smoothing and the exact
 * distances near the surface (voxel-accurate, much faster).
 */
export function solidField(pos: Float32Array, idx: Uint32Array, h: number, close: number, coarse = false): Field {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const pad = close + 4 * h;
  const o: Vec3 = [x0 - pad, y0 - pad, z0 - pad];
  const nx = Math.ceil((x1 - x0 + 2 * pad) / h) + 1;
  const ny = Math.ceil((y1 - y0 + 2 * pad) / h) + 1;
  const nz = Math.ceil((z1 - z0 + 2 * pad) / h) + 1;
  const N = nx * ny * nz;
  if (N > 40e6) throw new Error('model too large for this detail level');
  const id = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  // 1. surface voxels: sample every triangle densely
  const surf = new Uint8Array(N);
  const step = 0.45 * h;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const ux = pos[b] - ax, uy = pos[b + 1] - ay, uz = pos[b + 2] - az;
    const vx = pos[c] - ax, vy = pos[c + 1] - ay, vz = pos[c + 2] - az;
    const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz), lw = Math.hypot(ux - vx, uy - vy, uz - vz);
    const n = Math.max(1, Math.ceil(Math.max(lu, lv, lw) / step));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const s = i / n, r = j / n;
        const ix = Math.round((ax + s * ux + r * vx - o[0]) / h);
        const iy = Math.round((ay + s * uy + r * vy - o[1]) / h);
        const iz = Math.round((az + s * uz + r * vz - o[2]) / h);
        surf[id(ix, iy, iz)] = 1;
      }
    }
  }

  // 2. closing: flood the outside through voxels farther than `close` from the surface,
  //    then grow the flooded region back by `close`
  const rad = close / h;
  const dSurf = rad > 0 ? edt(surf, 1, nx, ny, nz) : null;
  const blocked = (i: number) => (dSurf ? dSurf[i] <= rad : surf[i] === 1);
  const outside = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  const seed = (i: number) => { if (!outside[i] && !blocked(i)) { outside[i] = 1; queue[qt++] = i; } };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { seed(id(0, y, z)); seed(id(nx - 1, y, z)); }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { seed(id(x, 0, z)); seed(id(x, ny - 1, z)); }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { seed(id(x, y, 0)); seed(id(x, y, nz - 1)); }
  const sx = 1, sy = nx, sz = nx * ny;
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / sz) | 0;
    if (x > 0) seed(i - sx); if (x < nx - 1) seed(i + sx);
    if (y > 0) seed(i - sy); if (y < ny - 1) seed(i + sy);
    if (z > 0) seed(i - sz); if (z < nz - 1) seed(i + sz);
  }
  // regrow the outside through empty (non-surface) voxels for ~close mm. Unlike a plain
  // morphological closing this restores inner corners, slits and recesses, while openings
  // deeper than `close` stay sealed.
  if (rad > 0) {
    const depth = Math.ceil(1.6 * rad) + 1;
    let front = queue.slice(0, qt);
    for (let k = 0; k < depth && front.length; k++) {
      const next: number[] = [];
      for (const i of front) {
        const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / sz) | 0;
        const nb = [x > 0 ? i - sx : -1, x < nx - 1 ? i + sx : -1, y > 0 ? i - sy : -1, y < ny - 1 ? i + sy : -1, z > 0 ? i - sz : -1, z < nz - 1 ? i + sz : -1];
        for (const j of nb) if (j >= 0 && !outside[j] && !surf[j]) { outside[j] = 1; next.push(j); }
      }
      front = Int32Array.from(next);
    }
  }
  // hollow shells and tubes (armor-style models) with openings wider than `close`: anything
  // walled in on 12 of 14 directions counts as inside
  const walled = enclosed(surf, nx, ny, nz);
  const solid = new Uint8Array(N);
  for (let i = 0; i < N; i++) solid[i] = !outside[i] || walled[i] >= 12 ? 1 : 0;

  // 3. coarse signed distance from the voxel classification...
  const dIn = edt(solid, 0, nx, ny, nz);
  const dOutS = edt(solid, 1, nx, ny, nz);
  let sdf: Float32Array = new Float32Array(N);
  for (let i = 0; i < N; i++) sdf[i] = solid[i] ? (dIn[i] - 0.5) * h : -(dOutS[i] - 0.5) * h;
  if (coarse) return { nx, ny, nz, h, o, sdf };
  sdf = blur(sdf, nx, ny, nz); // softens voxel steps on sealed openings (no real surface there)
  // ...refined near the real surface with exact point-to-triangle distances
  refineBand(sdf, solid, surf, dSurf ?? edt(surf, 1, nx, ny, nz), pos, idx, { nx, ny, nz, h, o });
  return { nx, ny, nz, h, o, sdf };
}

/**
 * Within ~2 voxels of the surface, replace the voxel-quantised distance with the exact distance
 * to the nearest triangle. On the solid's boundary the sign comes from that triangle's normal,
 * so the zero level lands on the true surface instead of on voxel steps.
 */
function refineBand(sdf: Float32Array, solid: Uint8Array, surf: Uint8Array, dSurf: Float32Array,
  pos: Float32Array, idx: Uint32Array, g: { nx: number; ny: number; nz: number; h: number; o: Vec3 }): void {
  const { nx, ny, nz, h, o } = g;
  const band = 2.2;
  // orientation: flip the normal test if the mesh is wound inside-out
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  const flip = vol < 0 ? -1 : 1;
  const nV = pos.length / 3, nT0 = idx.length / 3;
  const fN = new Float32Array(nT0 * 3), vN = new Float32Array(nV * 3);
  const eN = new Map<number, [number, number, number]>();
  const ekey = (u: number, v: number) => (u < v ? u * 4194304 + v : v * 4194304 + u);
  for (let t = 0; t < nT0; t++) {
    const ia = idx[3 * t], ib = idx[3 * t + 1], ic = idx[3 * t + 2];
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx0 = uy * vz - uz * vy, ny0 = uz * vx - ux * vz, nz0 = ux * vy - uy * vx;
    const l = Math.hypot(nx0, ny0, nz0) || 1;
    nx0 = (nx0 / l) * flip; ny0 = (ny0 / l) * flip; nz0 = (nz0 / l) * flip;
    fN[3 * t] = nx0; fN[3 * t + 1] = ny0; fN[3 * t + 2] = nz0;
    const corners = [ia, ib, ic];
    for (let k = 0; k < 3; k++) {
      const p0 = corners[k] * 3, p1 = corners[(k + 1) % 3] * 3, p2 = corners[(k + 2) % 3] * 3;
      const e1x = pos[p1] - pos[p0], e1y = pos[p1 + 1] - pos[p0 + 1], e1z = pos[p1 + 2] - pos[p0 + 2];
      const e2x = pos[p2] - pos[p0], e2y = pos[p2 + 1] - pos[p0 + 1], e2z = pos[p2 + 2] - pos[p0 + 2];
      const cosA = (e1x * e2x + e1y * e2y + e1z * e2z) / ((Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z)) || 1);
      const ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
      vN[p0] += ang * nx0; vN[p0 + 1] += ang * ny0; vN[p0 + 2] += ang * nz0;
      const key = ekey(corners[k], corners[(k + 1) % 3]);
      const e = eN.get(key);
      if (e) { e[0] += nx0; e[1] += ny0; e[2] += nz0; } else eN.set(key, [nx0, ny0, nz0]);
    }
  }
  const pseudo = (t: number, region: number): [number, number, number] => {
    if (region === 1) return [fN[3 * t], fN[3 * t + 1], fN[3 * t + 2]];
    const ia = idx[3 * t], ib = idx[3 * t + 1], ic = idx[3 * t + 2];
    const vert = region === 2 ? ia : region === 3 ? ib : region === 4 ? ic : -1;
    if (vert >= 0) return [vN[3 * vert], vN[3 * vert + 1], vN[3 * vert + 2]];
    const e = eN.get(region === 5 ? ekey(ia, ib) : region === 6 ? ekey(ib, ic) : ekey(ic, ia));
    return e ?? [fN[3 * t], fN[3 * t + 1], fN[3 * t + 2]];
  };
  // bucket triangles into coarse cells (CSR layout)
  const cs = 2 * h, cx = Math.ceil(nx / 2) + 1, cy = Math.ceil(ny / 2) + 1, cz = Math.ceil(nz / 2) + 1;
  const nT = idx.length / 3, margin = band * h + 0.01;
  const cellRange = (t: number) => {
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    const lo = [0, 1, 2].map((k) => Math.min(pos[a + k], pos[b + k], pos[c + k]) - margin - o[k]);
    const hi = [0, 1, 2].map((k) => Math.max(pos[a + k], pos[b + k], pos[c + k]) + margin - o[k]);
    return [
      Math.max(0, Math.floor(lo[0] / cs)), Math.min(cx - 1, Math.floor(hi[0] / cs)),
      Math.max(0, Math.floor(lo[1] / cs)), Math.min(cy - 1, Math.floor(hi[1] / cs)),
      Math.max(0, Math.floor(lo[2] / cs)), Math.min(cz - 1, Math.floor(hi[2] / cs)),
    ];
  };
  const counts = new Int32Array(cx * cy * cz + 1);
  for (let t = 0; t < nT; t++) {
    const [x0, x1, y0, y1, z0, z1] = cellRange(t);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) counts[x + cx * (y + cy * z) + 1]++;
  }
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const list = new Int32Array(counts[counts.length - 1]);
  const fill = counts.slice(0, -1);
  for (let t = 0; t < nT; t++) {
    const [x0, x1, y0, y1, z0, z1] = cellRange(t);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) list[fill[x + cx * (y + cy * z)]++] = t;
  }
  const q = [0, 0, 0, 0];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (y + ny * z);
    // only near the solid's boundary: walls buried inside (hollow shells that were filled,
    // overlapping pieces) must not carve the interior
    if (dSurf[i] > band || Math.abs(sdf[i]) > (band + 1) * h) continue;
    const px = o[0] + x * h, py = o[1] + y * h, pz = o[2] + z * h;
    const cell = ((x * h) / cs | 0) + cx * (((y * h) / cs | 0) + cy * ((z * h) / cs | 0));
    let best = Infinity, bt = -1, bqx = 0, bqy = 0, bqz = 0, bRegion = 0;
    for (let k = counts[cell]; k < counts[cell + 1]; k++) {
      const t = list[k];
      const d2 = closestOnTri(pos, idx, t, px, py, pz, q);
      if (d2 < best) { best = d2; bt = t; bqx = q[0]; bqy = q[1]; bqz = q[2]; bRegion = q[3]; }
    }
    if (bt < 0) continue;
    const dist = Math.sqrt(best);
    const coarse = sdf[i];
    if (dist > Math.abs(coarse) + h) continue; // near a sealed opening: no real surface here
    let sign = solid[i] ? 1 : -1;
    const boundary = surf[i] && solid[i] && (
      (x > 0 && !solid[i - 1]) || (x < nx - 1 && !solid[i + 1]) ||
      (y > 0 && !solid[i - nx]) || (y < ny - 1 && !solid[i + nx]) ||
      (z > 0 && !solid[i - nx * ny]) || (z < nz - 1 && !solid[i + nx * ny]));
    if (boundary) {
      // sign from the angle-weighted pseudo-normal of the closest feature (face, edge or vertex),
      // but only if the voxel beyond that surface really is outside (faces buried inside
      // overlapping shells must not punch holes)
      const [nxv, nyv, nzv] = pseudo(bt, bRegion);
      const dot = (px - bqx) * nxv + (py - bqy) * nyv + (pz - bqz) * nzv;
      if (dot > 1e-12) {
        const ax = Math.abs(nxv), ay = Math.abs(nyv), az = Math.abs(nzv);
        let j = i;
        if (ax >= ay && ax >= az) j += nxv > 0 ? (x < nx - 1 ? 1 : 0) : (x > 0 ? -1 : 0);
        else if (ay >= az) j += nyv > 0 ? (y < ny - 1 ? nx : 0) : (y > 0 ? -nx : 0);
        else j += nzv > 0 ? (z < nz - 1 ? nx * ny : 0) : (z > 0 ? -nx * ny : 0);
        if (!solid[j]) sign = -1;
      }
    }
    sdf[i] = sign * dist;
  }
}

/** Squared distance from p to triangle t; closest point written to q (Ericson, RTCD 5.1.5). */
function closestOnTri(pos: Float32Array, idx: Uint32Array, t: number, px: number, py: number, pz: number, q: number[]): number {
  const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
  const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
  const abx = pos[b] - ax, aby = pos[b + 1] - ay, abz = pos[b + 2] - az;
  const acx = pos[c] - ax, acy = pos[c + 1] - ay, acz = pos[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let rx: number, ry: number, rz: number;
  q[3] = 0;
  if (d1 <= 0 && d2 <= 0) { rx = ax; ry = ay; rz = az; q[3] = 2; }
  else {
    const bpx = px - pos[b], bpy = py - pos[b + 1], bpz = pz - pos[b + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { rx = pos[b]; ry = pos[b + 1]; rz = pos[b + 2]; q[3] = 3; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); rx = ax + v * abx; ry = ay + v * aby; rz = az + v * abz; q[3] = 5; }
      else {
        const cpx = px - pos[c], cpy = py - pos[c + 1], cpz = pz - pos[c + 2];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { rx = pos[c]; ry = pos[c + 1]; rz = pos[c + 2]; q[3] = 4; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); rx = ax + w * acx; ry = ay + w * acy; rz = az + w * acz; q[3] = 7; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              rx = pos[b] + w * (pos[c] - pos[b]); ry = pos[b + 1] + w * (pos[c + 1] - pos[b + 1]); rz = pos[b + 2] + w * (pos[c + 2] - pos[b + 2]);
              q[3] = 6;
            } else {
              const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
              rx = ax + abx * v + acx * w; ry = ay + aby * v + acy * w; rz = az + abz * v + acz * w;
              q[3] = 1;
            }
          }
        }
      }
    }
  }
  q[0] = rx; q[1] = ry; q[2] = rz;
  const dx = px - rx, dy = py - ry, dz = pz - rz;
  return dx * dx + dy * dy + dz * dz;
}

function blur(a: Float32Array, nx: number, ny: number, nz: number): Float32Array {
  let src: Float32Array = a, dst: Float32Array = new Float32Array(a.length);
  const strides = [1, nx, nx * ny], dims = [nx, ny, nz];
  for (let ax = 0; ax < 3; ax++) {
    const st = strides[ax], n = dims[ax];
    for (let i = 0; i < src.length; i++) {
      const c = ax === 0 ? i % nx : ax === 1 ? ((i / nx) | 0) % ny : (i / (nx * ny)) | 0;
      const l = c > 0 ? src[i - st] : src[i], r = c < n - 1 ? src[i + st] : src[i];
      dst[i] = 0.25 * l + 0.5 * src[i] + 0.25 * r;
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/** Trilinear sample; far outside the grid counts as outside. */
export function sample(f: Field, x: number, y: number, z: number): number {
  const gx = (x - f.o[0]) / f.h, gy = (y - f.o[1]) / f.h, gz = (z - f.o[2]) / f.h;
  if (gx < 0 || gy < 0 || gz < 0 || gx >= f.nx - 1 || gy >= f.ny - 1 || gz >= f.nz - 1) return -10 * f.h;
  const ix = gx | 0, iy = gy | 0, iz = gz | 0;
  const tx = gx - ix, ty = gy - iy, tz = gz - iz;
  const nx = f.nx, sxy = f.nx * f.ny, s = f.sdf;
  const i = ix + nx * iy + sxy * iz;
  const c00 = s[i] + (s[i + 1] - s[i]) * tx;
  const c10 = s[i + nx] + (s[i + nx + 1] - s[i + nx]) * tx;
  const c01 = s[i + sxy] + (s[i + sxy + 1] - s[i + sxy]) * tx;
  const c11 = s[i + sxy + nx] + (s[i + sxy + nx + 1] - s[i + sxy + nx]) * tx;
  const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
  return c0 + (c1 - c0) * tz;
}

// ---------- regions ----------

export type Owner = { piece: string | null; segs: [Vec3, Vec3][] };

function segDist(px: number, py: number, pz: number, a: Vec3, b: Vec3): number {
  const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
  const wx = px - a[0], wy = py - a[1], wz = pz - a[2];
  const l2 = vx * vx + vy * vy + vz * vz;
  let t = l2 > 0 ? (wx * vx + wy * vy + wz * vz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - t * vx, dy = wy - t * vy, dz = wz - t * vz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function ownerDist(o: Owner, x: number, y: number, z: number): number {
  let m = Infinity;
  for (const [a, b] of o.segs) { const d = segDist(x, y, z, a, b); if (d < m) m = d; }
  return m;
}

export type Box = { min: Vec3; max: Vec3 };

/** Bounding box of each owner's share of the solid. */
export function regionBoxes(f: Field, owners: Owner[]): (Box | null)[] {
  const boxes: (Box | null)[] = owners.map(() => null);
  const step = Math.max(1, Math.round(1.0 / f.h)); // ~1 mm sampling is plenty for bounds
  for (let z = 0; z < f.nz; z += step) for (let y = 0; y < f.ny; y += step) for (let x = 0; x < f.nx; x += step) {
    const i = x + f.nx * (y + f.ny * z);
    if (f.sdf[i] <= 0) continue;
    const px = f.o[0] + x * f.h, py = f.o[1] + y * f.h, pz = f.o[2] + z * f.h;
    let best = -1, bd = Infinity;
    for (let k = 0; k < owners.length; k++) { const d = ownerDist(owners[k], px, py, pz); if (d < bd) { bd = d; best = k; } }
    let b = boxes[best];
    if (!b) b = boxes[best] = { min: [px, py, pz], max: [px, py, pz] };
    b.min = [Math.min(b.min[0], px), Math.min(b.min[1], py), Math.min(b.min[2], pz)];
    b.max = [Math.max(b.max[0], px), Math.max(b.max[1], py), Math.max(b.max[2], pz)];
  }
  return boxes;
}

/** Mesh one owner's share of the solid, shrunk by `gap` at the borders with other owners. */
export function regionSolid(f: Field, owners: Owner[], k: number, box: Box, gap: number, edge: number): Manifold | null {
  const me = owners[k];
  const sdf = (p: [number, number, number]) => {
    const s = sample(f, p[0], p[1], p[2]);
    if (s < -2 * edge) return s;
    const dMe = ownerDist(me, p[0], p[1], p[2]);
    let g = Infinity;
    for (let j = 0; j < owners.length; j++) {
      if (j === k) continue;
      const d = ownerDist(owners[j], p[0], p[1], p[2]) - dMe;
      if (d < g) g = d;
    }
    return Math.min(s, 0.5 * g - gap / 2);
  };
  const pad = 2 * edge + f.h;
  const bounds = {
    min: [box.min[0] - pad, box.min[1] - pad, box.min[2] - pad] as [number, number, number],
    max: [box.max[0] + pad, box.max[1] + pad, box.max[2] + pad] as [number, number, number],
  };
  // a tiny level offset keeps grid samples from sitting exactly on the surface
  // (exact zeros produce zero-area triangles)
  const m = M().levelSet(sdf, bounds, edge, 1e-4);
  if (m.isEmpty()) return null;
  const parts = m.decompose().filter((p) => p.volume() > 1.0);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : M().union(parts);
}
