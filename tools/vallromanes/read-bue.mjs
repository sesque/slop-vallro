// Reader for the Diputació BUE 1:1000 shapefile delivery (ETRS89 / UTM 31N, 3D geometries, UTF-8 DBF).
// Custom parser: the `shapefile` npm package drops the Z values that this data depends on.
import fs from 'node:fs';
import path from 'node:path';

export const LAYERS = { l: 'line', p: 'point', s: 'poly', t: 'text' };

const SHAPE = { POINT: 1, POLYLINE: 3, POLYGON: 5, POINTZ: 11, POLYLINEZ: 13, POLYGONZ: 15 };

export function readShp(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getInt32(0, false) !== 9994) throw new Error('Not a shapefile (bad magic)');
  const fileBytes = dv.getInt32(24, false) * 2;
  const shapes = [];
  let off = 100;
  while (off + 8 <= Math.min(fileBytes, buf.length)) {
    const len = dv.getInt32(off + 4, false) * 2;
    const start = off + 8;
    shapes.push(readShape(dv, start));
    off = start + len;
  }
  return shapes;
}

function readShape(dv, o) {
  const type = dv.getInt32(o, true);
  if (type === 0) return null;
  if (type === SHAPE.POINTZ || type === SHAPE.POINT) {
    const x = dv.getFloat64(o + 4, true);
    const y = dv.getFloat64(o + 12, true);
    const z = type === SHAPE.POINTZ ? dv.getFloat64(o + 20, true) : 0;
    return { type, parts: [[[x, y, z]]] };
  }
  if (type === SHAPE.POLYLINEZ || type === SHAPE.POLYGONZ || type === SHAPE.POLYLINE || type === SHAPE.POLYGON) {
    const nParts = dv.getInt32(o + 36, true);
    const nPts = dv.getInt32(o + 40, true);
    const partsOff = o + 44;
    const ptsOff = partsOff + 4 * nParts;
    const hasZ = type === SHAPE.POLYLINEZ || type === SHAPE.POLYGONZ;
    const zOff = ptsOff + 16 * nPts + 16; // skip Zmin, Zmax
    const starts = [];
    for (let i = 0; i < nParts; i++) starts.push(dv.getInt32(partsOff + 4 * i, true));
    starts.push(nPts);
    const parts = [];
    for (let p = 0; p < nParts; p++) {
      const ring = [];
      for (let i = starts[p]; i < starts[p + 1]; i++) {
        ring.push([
          dv.getFloat64(ptsOff + 16 * i, true),
          dv.getFloat64(ptsOff + 16 * i + 8, true),
          hasZ ? dv.getFloat64(zOff + 8 * i, true) : 0
        ]);
      }
      parts.push(ring);
    }
    return { type, parts };
  }
  throw new Error(`Unsupported shape type ${type}`);
}

export function readDbf(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(4, true);
  const headerLen = dv.getUint16(8, true);
  const recLen = dv.getUint16(10, true);
  const fields = [];
  for (let o = 32; buf[o] !== 0x0d && o < headerLen; o += 32) {
    const name = buf.toString('latin1', o, o + 11).replace(/\0.*$/, '');
    fields.push({ name, type: String.fromCharCode(buf[o + 11]), len: buf[o + 16] });
  }
  const rows = [];
  for (let i = 0; i < n; i++) {
    const base = headerLen + i * recLen;
    let p = base + 1;
    const row = {};
    for (const f of fields) {
      row[f.name] = buf.toString('utf8', p, p + f.len).trim();
      p += f.len;
    }
    rows.push(row);
  }
  return rows;
}

// "169,43" -> 169.43 (the DBF stores ALTITUD as text with a decimal comma)
export function parseDecimal(s) {
  if (s == null || s === '') return null;
  const v = Number(String(s).replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

// CAS looks like CON_01pol_PL, COM_17LS_LN, VEG_03_PT_C ... Strip the field-revision suffix and read the
// LTP / elevated markers (LS, LN, ES) that follow the numeric code. See knowledge.md §3.2 and §5.
export function parseCas(cas) {
  let base = cas;
  let fieldRevised = false;
  if (base.endsWith('_C')) {
    fieldRevised = true;
    base = base.slice(0, -2);
  }
  const m = /^[A-Z]{3}_\d+([A-Za-z]*)/.exec(base);
  const tag = m ? m[1] : '';
  return {
    base,
    fieldRevised,
    ltp: tag.endsWith('LS') ? true : tag.endsWith('LN') ? false : undefined,
    elevated: tag.endsWith('ES')
  };
}

const identity = (e, n, h) => [e, n, h];

// Reads the four layers from `dir` and returns normalised features.
// `transform(E, N, H) -> [x, y, z]` defaults to identity (raw UTM); pass frame.toLocal for the runtime frame.
export function readBue(dir, { transform = identity, prefix = 'BUE1M08296', layers = Object.keys(LAYERS) } = {}) {
  const features = [];
  for (const key of layers) {
    const kind = LAYERS[key];
    const base = path.join(dir, prefix + key);
    const shapes = readShp(fs.readFileSync(base + '.shp'));
    const rows = readDbf(fs.readFileSync(base + '.dbf'));
    if (shapes.length !== rows.length) throw new Error(`${base}: ${shapes.length} shapes vs ${rows.length} DBF rows`);
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i];
      const row = rows[i];
      if (!shape) continue;
      const parts = shape.parts.map((ring) => ring.map(([e, n, h]) => {
        const c = transform(e, n, h);
        if (!c.every(Number.isFinite)) throw new Error(`${base} record ${i}: non-finite coordinate`);
        return c;
      }));
      const cas = parseCas(row.CAS);
      const f = {
        cas: cas.base,
        desc: row.DESCRIPCIO,
        kind,
        coords: parts[0],
        parts,
        fieldRevised: cas.fieldRevised
      };
      if (cas.ltp !== undefined) f.ltp = cas.ltp;
      if (cas.elevated) f.elevated = true;
      if (row.ANGLE !== undefined) f.angle = parseDecimal(row.ANGLE);
      if (row.ALTITUD !== undefined) f.altitud = parseDecimal(row.ALTITUD);
      if (row.TEXT !== undefined) f.text = row.TEXT;
      features.push(f);
    }
  }
  return features;
}
