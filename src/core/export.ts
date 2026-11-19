// File writers: binary STL, 3MF (with per-object colours) and zip.
import { strToU8, zipSync } from 'fflate';
import type { Matrix4 } from 'three';

export function stlBinary(positions: Float32Array, indices: Uint32Array): Uint8Array {
  const nTri = indices.length / 3;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const dv = new DataView(buf);
  const header = 'binary STL exported by dummo';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nTri, true);
  let o = 84;
  for (let t = 0; t < nTri; t++) {
    const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, positions[v], true); dv.setFloat32(o + 4, positions[v + 1], true); dv.setFloat32(o + 8, positions[v + 2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

export type TmfObject = { name: string; positions: Float32Array; indices: Uint32Array; color: number };
export type TmfItem = { object: number; transform: Matrix4 };

const num = (v: number) => {
  const s = v.toFixed(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

export function threeMF(title: string, colors: string[], objects: TmfObject[], items: TmfItem[]): Uint8Array {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  parts.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  parts.push(`<metadata name="Title">${escapeXml(title)}</metadata>\n<metadata name="Application">dummo</metadata>\n<resources>\n`);
  parts.push('<basematerials id="1">');
  colors.forEach((c, i) => parts.push(`<base name="color${i}" displaycolor="${c.toUpperCase()}FF"/>`));
  parts.push('</basematerials>\n');
  objects.forEach((ob, i) => {
    parts.push(`<object id="${i + 2}" name="${escapeXml(ob.name)}" type="model" pid="1" pindex="${ob.color}"><mesh><vertices>`);
    const p = ob.positions;
    const vs: string[] = [];
    for (let k = 0; k < p.length; k += 3) vs.push(`<vertex x="${num(p[k])}" y="${num(p[k + 1])}" z="${num(p[k + 2])}"/>`);
    parts.push(vs.join(''));
    parts.push('</vertices><triangles>');
    const t = ob.indices;
    const ts: string[] = [];
    for (let k = 0; k < t.length; k += 3) ts.push(`<triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"/>`);
    parts.push(ts.join(''));
    parts.push('</triangles></mesh></object>\n');
  });
  parts.push('</resources>\n<build>\n');
  for (const it of items) {
    const e = it.transform.elements;
    // 3MF uses a 3x4 row layout: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (column vectors, translation last)
    const tr = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]].map(num).join(' ');
    parts.push(`<item objectid="${it.object + 2}" transform="${tr}"/>\n`);
  }
  parts.push('</build>\n</model>\n');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(parts.join('')),
  };
  return zipSync(files, { level: 6 });
}

export function zip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6 });
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dummo';
}
