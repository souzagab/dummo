// Thin helpers over manifold-3d plus a tiny garbage collector for WASM objects.
import type { CrossSection, Manifold, ManifoldToplevel, SimplePolygon, Vec2, Vec3 } from 'manifold-3d';

let W: ManifoldToplevel;
let SEG = 48;
const registry: { delete(): void }[] = [];

export function initGeo(wasm: ManifoldToplevel): void {
  W = wasm;
  installGC(wasm);
}

export function setSegments(n: number): void {
  SEG = Math.max(12, Math.round(n / 4) * 4);
}
export function segments(): number {
  return SEG;
}

function track<T>(r: T): T {
  if (r && typeof (r as { delete?: unknown }).delete === 'function') registry.push(r as unknown as { delete(): void });
  return r;
}

function installGC(wasm: ManifoldToplevel): void {
  const marker = '__dummoGC';
  const M = wasm.Manifold as unknown as Record<string, unknown>;
  if (M[marker]) return;
  M[marker] = true;
  const wrap = (obj: Record<string, unknown>, skip: Set<string>) => {
    for (const name of Object.getOwnPropertyNames(obj)) {
      if (skip.has(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(obj, name);
      if (!desc || typeof desc.value !== 'function' || !desc.writable) continue;
      const orig = desc.value as (...a: unknown[]) => unknown;
      obj[name] = function (this: unknown, ...args: unknown[]) {
        return track(orig.apply(this, args));
      };
    }
  };
  const skipStatic = new Set(['prototype', 'length', 'name', 'arguments', 'caller']);
  const skipProto = new Set(['constructor', 'delete', 'isDeleted', 'deleteLater', 'isAliasOf', 'clone']);
  wrap(wasm.Manifold as unknown as Record<string, unknown>, skipStatic);
  wrap(wasm.Manifold.prototype as unknown as Record<string, unknown>, skipProto);
  wrap(wasm.CrossSection as unknown as Record<string, unknown>, skipStatic);
  wrap(wasm.CrossSection.prototype as unknown as Record<string, unknown>, skipProto);
}

/** Free every WASM object created since the last collect(). */
export function collect(): void {
  for (const o of registry) {
    try {
      o.delete();
    } catch {
      /* already freed */
    }
  }
  registry.length = 0;
}

export const BIG = 2000;

export const M = () => W.Manifold;
export const CS = () => W.CrossSection;

/** Polygon from points. A single contour is re-oriented counter-clockwise so it always fills. */
export function poly(pts: Vec2[] | SimplePolygon[]): CrossSection {
  const single = pts.length > 0 && typeof (pts[0] as number[])[0] === 'number';
  if (single) {
    const p = pts as Vec2[];
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
      a += x0 * y1 - x1 * y0;
    }
    return track(new W.CrossSection([a < 0 ? [...p].reverse() : p]));
  }
  return track(new W.CrossSection(pts as SimplePolygon[]));
}
export function rect(x0: number, x1: number, y0: number, y1: number): CrossSection {
  return W.CrossSection.square([x1 - x0, y1 - y0]).translate([x0, y0]);
}
export function circle(r: number, x = 0, y = 0, seg = SEG): CrossSection {
  return W.CrossSection.circle(r, seg).translate([x, y]);
}
export function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Manifold {
  return W.Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);
}
export function slab(z0: number, z1: number): Manifold {
  return box(-BIG, BIG, -BIG, BIG, z0, z1);
}
/** Keep the part of m on the side of the plane (point p, normal n) that n points to. */
export function keepSide(m: Manifold, n: Vec3, p: Vec3): Manifold {
  const l = Math.hypot(n[0], n[1], n[2]);
  const nn: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
  return m.trimByPlane(nn, nn[0] * p[0] + nn[1] * p[1] + nn[2] * p[2]);
}
export function sphere(r: number, x = 0, y = 0, z = 0): Manifold {
  return W.Manifold.sphere(r, SEG).translate([x, y, z]);
}
/** Cylinder along +z from z0 to z1. */
export function cylZ(r: number, z0: number, z1: number, x = 0, y = 0, seg = SEG): Manifold {
  return W.Manifold.cylinder(z1 - z0, r, r, seg).translate([x, y, z0]);
}
/** Cylinder along +y from y0 to y1, centred on (x, z). */
export function cylY(r: number, y0: number, y1: number, x = 0, z = 0): Manifold {
  return W.Manifold.cylinder(y1 - y0, r, r, SEG).rotate([-90, 0, 0]).translate([x, y0, z]);
}
/** Cylinder along +x from x0 to x1, centred on (y, z). */
export function cylX(r: number, x0: number, x1: number, y = 0, z = 0): Manifold {
  return W.Manifold.cylinder(x1 - x0, r, r, SEG).rotate([0, 90, 0]).translate([x0, y, z]);
}
/** Solid of revolution about z from an [r, z] profile. */
export function revolveZ(profile: Vec2[]): Manifold {
  return W.Manifold.revolve([profile], SEG);
}
export function extrude(cs: CrossSection, z0: number, z1: number): Manifold {
  return W.Manifold.extrude(cs, z1 - z0).translate([0, 0, z0]);
}
export function union(parts: Manifold[]): Manifold {
  const p = parts.filter(Boolean);
  if (p.length === 0) return W.Manifold.cube([0.001, 0.001, 0.001]).translate([BIG, BIG, BIG]);
  if (p.length === 1) return p[0];
  return W.Manifold.union(p);
}
export function unionCS(parts: CrossSection[]): CrossSection {
  return W.CrossSection.union(parts);
}
export function hull(points: Vec3[]): Manifold {
  return W.Manifold.hull(points);
}
/** Pie sector polygon with apex at origin, centred on dirDeg, total angle totalDeg. */
export function sector(totalDeg: number, dirDeg: number, r: number): CrossSection {
  const pts: Vec2[] = [[0, 0]];
  const n = 36;
  const a0 = dirDeg - totalDeg / 2;
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + (totalDeg * i) / n) * Math.PI) / 180;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return poly(pts);
}
/**
 * Extrude with 45-degree chamfers on both z edges, as stair steps about one layer tall
 * (identical to a true chamfer once sliced).
 */
export function chamferedExtrude(cs: CrossSection, z0: number, z1: number, ch: number, steps = 3): Manifold {
  const h = z1 - z0;
  if (ch <= 0.01 || h <= 2 * ch + 0.05) return extrude(cs, z0, z1);
  // Step boundaries are nudged off "round" heights so they never coincide exactly with
  // other features' vertices (exact coincidences leave zero-area slivers in the mesh).
  const j = 0.0137;
  const parts = [extrude(cs, z0 + ch - j, z1 - ch + j)];
  const dz = ch / steps;
  for (let i = 0; i < steps; i++) {
    const inset = ch - (i + 0.5) * dz;
    const layer = cs.offset(-inset, 'Miter');
    if (layer.isEmpty()) continue;
    const a = i === 0 ? 0 : i * dz - j, b = (i + 1) * dz + j * 0.5;
    parts.push(extrude(layer, z0 + a, z0 + b));
    parts.push(extrude(layer, z1 - b, z1 - a));
  }
  return union(parts);
}

export type Slice = { y: number; hx: number; hz: number; ch: number };

/** Faceted loft: hulls of consecutive octagonal slices (in XZ) stacked along y, centred at (0, *, zc). */
export function octoLoft(slices: Slice[], zc: number, xc = 0): Manifold {
  const pts = (s: Slice): Vec3[] => {
    const c = Math.max(0, Math.min(s.ch, s.hx * 0.9, s.hz * 0.9));
    return [
      [xc - s.hx + c, s.y, zc - s.hz], [xc + s.hx - c, s.y, zc - s.hz],
      [xc + s.hx, s.y, zc - s.hz + c], [xc + s.hx, s.y, zc + s.hz - c],
      [xc + s.hx - c, s.y, zc + s.hz], [xc - s.hx + c, s.y, zc + s.hz],
      [xc - s.hx, s.y, zc + s.hz - c], [xc - s.hx, s.y, zc - s.hz + c],
    ];
  };
  const sorted = [...slices].sort((a, b) => a.y - b.y);
  const parts: Manifold[] = [];
  for (let i = 0; i < sorted.length - 1; i++) parts.push(hull([...pts(sorted[i]), ...pts(sorted[i + 1])]));
  return union(parts);
}

export function polygonsOf(cs: CrossSection): SimplePolygon[] {
  return cs.toPolygons();
}
