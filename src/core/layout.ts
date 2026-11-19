// Bed layout: shelf packing with 90-degree rotation, spilling onto extra plates.
import { Matrix4 } from 'three';
import type { MeshData } from './types.ts';

export type Prepared = {
  positions: Float32Array; // print orientation, min z = 0, centred in xy
  indices: Uint32Array;
  w: number;
  h: number;
  d: number;
};

/** Apply the print rotation, drop to z = 0 and centre on the xy origin. */
export function prepareForPrint(mesh: MeshData, printRot: Matrix4): Prepared {
  const e = printRot.elements;
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    const X = e[0] * x + e[4] * y + e[8] * z + e[12];
    const Y = e[1] * x + e[5] * y + e[9] * z + e[13];
    const Z = e[2] * x + e[6] * y + e[10] * z + e[14];
    out[i] = X; out[i + 1] = Y; out[i + 2] = Z;
    if (X < x0) x0 = X; if (X > x1) x1 = X;
    if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < out.length; i += 3) {
    out[i] -= cx; out[i + 1] -= cy; out[i + 2] -= z0;
  }
  return { positions: out, indices: mesh.indices, w: x1 - x0, h: y1 - y0, d: z1 - z0 };
}

export type PackItem = { id: string; key: string; w: number; h: number };
export type Placement = { id: string; key: string; x: number; y: number; rot: boolean };
export type Plate = { items: Placement[] };

export function packPlates(items: PackItem[], bedX: number, bedY: number, gap: number): { plates: Plate[]; oversize: string[] } {
  const oversize: string[] = [];
  const oriented = items.map((it) => {
    let w = it.w, h = it.h, rot = false;
    // prefer landscape; rotate if it only fits that way
    if (h > w) { [w, h] = [h, w]; rot = true; }
    if (w > bedX - 2 * gap && h <= bedX - 2 * gap && w <= bedY - 2 * gap) { [w, h] = [h, w]; rot = !rot; }
    if (w > bedX - 2 * gap || h > bedY - 2 * gap) oversize.push(it.id);
    return { ...it, w, h, rot };
  });
  oriented.sort((a, b) => b.h - a.h || b.w - a.w);
  const plates: Plate[] = [];
  let plate: Plate = { items: [] };
  let x = gap, y = gap, shelfH = 0;
  for (const it of oriented) {
    if (x + it.w > bedX - gap && plate.items.length) {
      x = gap; y += shelfH + gap; shelfH = 0;
    }
    if (y + it.h > bedY - gap && plate.items.length) {
      plates.push(plate);
      plate = { items: [] };
      x = gap; y = gap; shelfH = 0;
    }
    plate.items.push({ id: it.id, key: it.key, x: x + it.w / 2, y: y + it.h / 2, rot: it.rot });
    x += it.w + gap;
    shelfH = Math.max(shelfH, it.h);
  }
  if (plate.items.length) plates.push(plate);
  // centre each plate's group of parts on the bed
  const dims = new Map(oriented.map((o) => [o.id, o]));
  for (const pl of plates) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of pl.items) {
      const o = dims.get(it.id)!;
      x0 = Math.min(x0, it.x - o.w / 2); x1 = Math.max(x1, it.x + o.w / 2);
      y0 = Math.min(y0, it.y - o.h / 2); y1 = Math.max(y1, it.y + o.h / 2);
    }
    const dx = bedX / 2 - (x0 + x1) / 2, dy = bedY / 2 - (y0 + y1) / 2;
    for (const it of pl.items) { it.x += dx; it.y += dy; }
  }
  return { plates, oversize };
}

/** Placement -> matrix (bed coordinates, origin at the bed's front-left corner). */
export function placementMatrix(p: Placement): Matrix4 {
  const m = new Matrix4();
  if (p.rot) m.makeRotationZ(Math.PI / 2);
  m.setPosition(p.x, p.y, 0);
  return m;
}
