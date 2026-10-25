// What the ICGC LiDAR surface model (DSM) says about a footprint's roof (phase 8): the pixels well inside the walls give the roof
// level (median), the eave (10th percentile) and the ridge (95th). build-buildings.mjs uses them to replace the BUE tops that are
// buried in the ground and to turn hip roofs that are really terraces into flat ones.
import fs from 'node:fs';
import path from 'node:path';
import { E0, N0, H0 } from './frame.mjs';
import { pointInRings } from '../../js/geo/polygon.js';

export const NODATA = -9999;
const INSET = 0.6; // m: pixels nearer the wall than this mix roof and ground
const MIN_PIXELS = 8;

const readF32 = (file) => {
  const b = fs.readFileSync(file);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};

/** The 1 m DSM window written by fetch-icgc-dtm.mjs, or null when it has not been fetched. */
export function loadDsm(dir) {
  const metaFile = path.join(dir, 'dsm-1m.json'), binFile = path.join(dir, 'dsm-1m.f32');
  if (!fs.existsSync(metaFile) || !fs.existsSync(binFile)) return null;
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  return { meta, dsm: readF32(binFile) };
}

function distanceToRing(ring, x, z) {
  let best = Infinity;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2], az = ring[i * 2 + 1], dx = ring[j * 2] - ax, dz = ring[j * 2 + 1] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

/**
 * Roof statistics of the footprint `rings` (flat [x, z, ...] in the local frame, outer first) from the DSM, heights as local y:
 * { n, median, eave, ridge } or null when fewer than MIN_PIXELS valid pixels lie well inside the walls.
 */
export function roofStats(rings, { meta, dsm }) {
  const { width: W, height: H, originE, originN } = meta;
  const outer = rings[0];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < outer.length; i += 2) { minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i]); minZ = Math.min(minZ, outer[i + 1]); maxZ = Math.max(maxZ, outer[i + 1]); }
  const i0 = Math.max(0, Math.floor(minX + E0 - originE)), i1 = Math.min(W - 1, Math.ceil(maxX + E0 - originE));
  const j0 = Math.max(0, Math.floor(originN - (N0 - minZ))), j1 = Math.min(H - 1, Math.ceil(originN - (N0 - maxZ)));
  const values = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const v = dsm[j * W + i];
      if (v === NODATA) continue;
      const x = originE + i + 0.5 - E0, z = N0 - (originN - j - 0.5);
      if (!pointInRings(x, z, rings)) continue;
      if (rings.some((r) => distanceToRing(r, x, z) < INSET)) continue;
      values.push(v - H0);
    }
  }
  if (values.length < MIN_PIXELS) return null;
  values.sort((a, b) => a - b);
  const q = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  return { n: values.length, median: q(0.5), eave: q(0.1), ridge: q(0.95) };
}

/**
 * The shape of a pitched roof over a near-rectangular footprint from the DSM: `box` = polygon.js orientedBox of the outer ring.
 * Heights are compared in zones of the box (A along the long axis, B across, both in -1..1): the ridge middle (|A| and |B| under 0.4),
 * the ridge ends (|A| > 0.65, |B| < 0.4) and the eave middle (|B| > 0.6, |A| < 0.4). A gable has the same height at the ridge ends as in the
 * middle; a hip falls away there. Returns 'gable' (ridge along the long axis), 'gableShort' (ridge along the short axis)
 * or 'hip'; null when a zone has too few pixels to tell.
 */
export function roofShape(rings, box, { meta, dsm }) {
  const { width: W, height: H, originE, originN } = meta;
  const zones = { mid: [], end: [], side: [] };
  const outer = rings[0];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < outer.length; i += 2) { minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i]); minZ = Math.min(minZ, outer[i + 1]); maxZ = Math.max(maxZ, outer[i + 1]); }
  const i0 = Math.max(0, Math.floor(minX + E0 - originE)), i1 = Math.min(W - 1, Math.ceil(maxX + E0 - originE));
  const j0 = Math.max(0, Math.floor(originN - (N0 - minZ))), j1 = Math.min(H - 1, Math.ceil(originN - (N0 - maxZ)));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const v = dsm[j * W + i];
      if (v === NODATA) continue;
      const x = originE + i + 0.5 - E0, z = N0 - (originN - j - 0.5);
      if (!pointInRings(x, z, rings) || rings.some((r) => distanceToRing(r, x, z) < INSET)) continue;
      const A = Math.abs(((x - box.cx) * box.ux + (z - box.cz) * box.uz) / box.hx);
      const B = Math.abs((-(x - box.cx) * box.uz + (z - box.cz) * box.ux) / box.hz);
      if (A < 0.4 && B < 0.4) zones.mid.push(v);
      else if (A > 0.65 && B < 0.4) zones.end.push(v);
      else if (B > 0.6 && A < 0.4) zones.side.push(v);
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  if (zones.mid.length < 2 || zones.end.length < 2 || zones.side.length < 2) return null;
  const mid = mean(zones.mid), end = mean(zones.end), side = mean(zones.side);
  const drop = (lo) => mid - lo; // how far a zone lies below the middle
  // ridge along the long axis: the ends keep the ridge height, the sides fall
  if (drop(side) >= 0.7 && drop(end) <= 0.3 * drop(side)) return 'gable';
  // ridge along the short axis: the sides keep it, the ends fall
  if (drop(end) >= 0.7 && drop(side) <= 0.3 * drop(end)) return 'gableShort';
  return 'hip';
}

/**
 * A tower or spire standing out of a roof: the pixels inside the footprint grown by `reach` metres that are more than `minRise`
 * above the roof's median level. Returns { x, z, size, top } (local frame; `top` is the local y of the highest pixel, `size` the
 * side of a square that covers the tall pixels, between 3 and 6 m) or null when nothing rises that far.
 */
export function findSpike(rings, { meta, dsm }, { minRise = 4, reach = 3 } = {}) {
  const stats = roofStats(rings, { meta, dsm });
  if (!stats) return null;
  const { width: W, height: H, originE, originN } = meta;
  const outer = rings[0];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < outer.length; i += 2) { minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i]); minZ = Math.min(minZ, outer[i + 1]); maxZ = Math.max(maxZ, outer[i + 1]); }
  const i0 = Math.max(0, Math.floor(minX - reach + E0 - originE)), i1 = Math.min(W - 1, Math.ceil(maxX + reach + E0 - originE));
  const j0 = Math.max(0, Math.floor(originN - (N0 - (minZ - reach)))), j1 = Math.min(H - 1, Math.ceil(originN - (N0 - (maxZ + reach))));
  const tall = [];
  let top = -Infinity;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const v = dsm[j * W + i];
      if (v === NODATA) continue;
      const y = v - H0;
      if (y < stats.median + minRise) continue;
      const x = originE + i + 0.5 - E0, z = N0 - (originN - j - 0.5);
      if (!pointInRings(x, z, rings) && distanceToRing(outer, x, z) > reach) continue;
      tall.push([x, z, y]);
      if (y > top) top = y;
    }
  }
  if (tall.length < 3) return null;
  // the tower is where the highest pixels are: keep those within the upper part of the rise and take their box
  const core = tall.filter((p) => p[2] > top - Math.max(2, (top - stats.median) * 0.5));
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const [x, z] of core) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); d = Math.max(d, z); }
  const size = Math.min(6, Math.max(3, Math.max(b - a, d - c) + 1));
  return { x: (a + b) / 2, z: (c + d) / 2, size: +size.toFixed(1), top: +top.toFixed(2) };
}
