// Minimal SHP/DBF writer used to build tiny BUE-like fixtures in tests (PointZ, PolyLineZ, PolygonZ).
import fs from 'node:fs';
import path from 'node:path';

const TYPE = { point: 11, line: 13, poly: 15, text: 11 };

function shapeBody(type, parts) {
  if (type === 11) {
    const [x, y, z] = parts[0][0];
    const b = Buffer.alloc(4 + 32);
    b.writeInt32LE(11, 0);
    b.writeDoubleLE(x, 4); b.writeDoubleLE(y, 12); b.writeDoubleLE(z, 20); b.writeDoubleLE(0, 28);
    return b;
  }
  const pts = parts.flat();
  const n = pts.length;
  const b = Buffer.alloc(4 + 32 + 4 + 4 + 4 * parts.length + 16 * n + 16 + 8 * n + 16 + 8 * n);
  let o = 0;
  b.writeInt32LE(type, o); o += 4;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]); const zs = pts.map((p) => p[2]);
  for (const v of [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]) { b.writeDoubleLE(v, o); o += 8; }
  b.writeInt32LE(parts.length, o); o += 4;
  b.writeInt32LE(n, o); o += 4;
  let s = 0;
  for (const p of parts) { b.writeInt32LE(s, o); o += 4; s += p.length; }
  for (const p of pts) { b.writeDoubleLE(p[0], o); b.writeDoubleLE(p[1], o + 8); o += 16; }
  b.writeDoubleLE(Math.min(...zs), o); b.writeDoubleLE(Math.max(...zs), o + 8); o += 16;
  for (const p of pts) { b.writeDoubleLE(p[2], o); o += 8; }
  b.writeDoubleLE(0, o); b.writeDoubleLE(0, o + 8); o += 16;
  for (let i = 0; i < n; i++) { b.writeDoubleLE(0, o); o += 8; }
  return b;
}

export function writeLayer(dir, prefix, key, records) {
  const kind = { l: 'line', p: 'point', s: 'poly', t: 'text' }[key];
  const type = TYPE[kind];
  const bodies = records.map((r) => shapeBody(type, r.parts));
  const total = 100 + bodies.reduce((a, b) => a + 8 + b.length, 0);
  const shp = Buffer.alloc(total);
  shp.writeInt32BE(9994, 0);
  shp.writeInt32BE(total / 2, 24);
  shp.writeInt32LE(1000, 28);
  shp.writeInt32LE(type, 32);
  let o = 100;
  bodies.forEach((body, i) => {
    shp.writeInt32BE(i + 1, o);
    shp.writeInt32BE(body.length / 2, o + 4);
    body.copy(shp, o + 8);
    o += 8 + body.length;
  });
  const fields = [['CAS', 24], ['DESCRIPCIO', 60]];
  if (key === 'p' || key === 't') fields.push(['ANGLE', 12]);
  if (key === 'p') fields.push(['ALTITUD', 12]);
  if (key === 't') fields.push(['TEXT', 60]);
  const recLen = 1 + fields.reduce((a, f) => a + f[1], 0);
  const headLen = 32 + 32 * fields.length + 1;
  const dbf = Buffer.alloc(headLen + recLen * records.length + 1, 0x20);
  dbf[0] = 3;
  dbf.writeUInt32LE(records.length, 4);
  dbf.writeUInt16LE(headLen, 8);
  dbf.writeUInt16LE(recLen, 10);
  dbf.fill(0, 12, 32);
  fields.forEach(([name, len], i) => {
    const f = 32 + 32 * i;
    dbf.fill(0, f, f + 32);
    dbf.write(name, f, 'latin1');
    dbf[f + 11] = 'C'.charCodeAt(0);
    dbf[f + 16] = len;
  });
  dbf[headLen - 1] = 0x0d;
  records.forEach((r, i) => {
    let p = headLen + i * recLen;
    dbf[p++] = 0x20;
    for (const [name, len] of fields) {
      const v = Buffer.from(String(r[name] ?? ''), 'utf8');
      dbf.fill(0x20, p, p + len);
      v.copy(dbf, p, 0, Math.min(v.length, len));
      p += len;
    }
  });
  dbf[dbf.length - 1] = 0x1a;
  fs.writeFileSync(path.join(dir, prefix + key + '.shp'), shp);
  fs.writeFileSync(path.join(dir, prefix + key + '.dbf'), dbf);
}
