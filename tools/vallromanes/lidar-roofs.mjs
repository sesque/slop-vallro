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
