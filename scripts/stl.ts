// Minimal STL reader (binary and ASCII) with vertex welding.
export function readStl(buf: Buffer): { positions: Float32Array; indices: Uint32Array } {
  const tris: number[] = [];
  const isAscii = buf.subarray(0, 5).toString() === 'solid' && buf.includes(Buffer.from('facet'));
  if (isAscii) {
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    const txt = buf.toString();
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) tris.push(+m[1], +m[2], +m[3]);
  } else {
    const n = buf.readUInt32LE(80);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) tris.push(buf.readFloatLE(o + k * 4));
    }
  }
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx = new Uint32Array(tris.length / 3);
  for (let i = 0; i < tris.length; i += 3) {
    const key = `${Math.round(tris[i] * 1e4)},${Math.round(tris[i + 1] * 1e4)},${Math.round(tris[i + 2] * 1e4)}`;
    let v = map.get(key);
    if (v === undefined) { v = pos.length / 3; map.set(key, v); pos.push(tris[i], tris[i + 1], tris[i + 2]); }
    idx[i / 3] = v;
  }
  return { positions: new Float32Array(pos), indices: idx };
}
