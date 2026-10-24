// Bakes the vegetation height (spec §5.6, phase 8): the ICGC LiDAR surface model minus the terrain model, with the building
// footprints taken out, as a 4 m grid over the municipality -> data/canopy.json + data/canopy.bin (uint8, 0.5 m steps).
//   node tools/vallromanes/build-canopy.mjs
// Needs the 1 m DSM and DTM windows (fetch-icgc-dtm.mjs --product dsm|dtm) and data/boundary.json, data/buildings.*.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0 } from './frame.mjs';
import { fsFetch } from './fs-fetch.mjs';
import { loadBoundary, loadBuildings } from '../../js/geo/load-geodata.js';
import { pointInRings } from '../../js/geo/polygon.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw/icgc/dtm');
export const CELL = 4; // m
export const STEP = 0.5; // m per unit of the uint8 height
export const NODATA = -9999;

const readF32 = (file) => {
  const b = fs.readFileSync(file);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};

/** 1 where a 1 m pixel of the window lies inside a building footprint; `meta` is the window's .json (originE, originN, width, height). */
export function buildingMask(structures, meta) {
  const { width: W, height: H, originE, originN } = meta;
  const mask = new Uint8Array(W * H);
  for (const s of structures) {
    const r = s.rings[0];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < r.length; i += 2) { minX = Math.min(minX, r[i]); maxX = Math.max(maxX, r[i]); minZ = Math.min(minZ, r[i + 1]); maxZ = Math.max(maxZ, r[i + 1]); }
    const i0 = Math.max(0, Math.floor(minX + E0 - originE) - 1), i1 = Math.min(W - 1, Math.ceil(maxX + E0 - originE) + 1);
    const j0 = Math.max(0, Math.floor(originN - (N0 - minZ)) - 1), j1 = Math.min(H - 1, Math.ceil(originN - (N0 - maxZ)) + 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (pointInRings(originE + i + 0.5 - E0, N0 - (originN - j - 0.5), s.rings)) mask[j * W + i] = 1;
    }
  }
  return mask;
}

/**
 * The canopy grid: per CELL x CELL cell the mean of (DSM - DTM) over its valid, non-building pixels, clamped to [0, 127.5] m and
 * quantised to STEP. `area` = { minX, maxX, minZ, maxZ } in the local frame. Returns { width, height, originX, originZ, data }.
 */
export function canopyGrid({ dsm, dtm, mask, meta, area }) {
  const { width: W, height: H, originE, originN } = meta;
  const originX = Math.floor(area.minX / CELL) * CELL, originZ = Math.floor(area.minZ / CELL) * CELL;
  const width = Math.ceil((area.maxX - originX) / CELL), height = Math.ceil((area.maxZ - originZ) / CELL);
  const data = new Uint8Array(width * height);
  for (let cj = 0; cj < height; cj++) {
    for (let ci = 0; ci < width; ci++) {
      let sum = 0, n = 0;
      for (let dj = 0; dj < CELL; dj++) for (let di = 0; di < CELL; di++) {
        const i = Math.floor(originX + ci * CELL + di + E0 - originE), j = Math.floor(originN - (N0 - (originZ + cj * CELL + dj)));
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const k = j * W + i;
        if (mask[k] || dsm[k] === NODATA || dtm[k] === NODATA) continue;
        sum += dsm[k] - dtm[k];
        n++;
      }
      data[cj * width + ci] = n ? Math.min(255, Math.max(0, Math.round(sum / n / STEP))) : 0;
    }
  }
  return { width, height, originX, originZ, data };
}

async function main() {
  const meta = JSON.parse(fs.readFileSync(path.join(RAW, 'dsm-1m.json'), 'utf8'));
  const dtmMeta = JSON.parse(fs.readFileSync(path.join(RAW, 'dtm-1m.json'), 'utf8'));
  for (const k of ['width', 'height', 'originE', 'originN', 'res']) if (meta[k] !== dtmMeta[k]) throw new Error(`DSM and DTM windows differ in ${k}`);
  const dsm = readF32(path.join(RAW, 'dsm-1m.f32')), dtm = readF32(path.join(RAW, 'dtm-1m.f32'));
  const f = fsFetch();
  const [{ structures }, boundary] = await Promise.all([loadBuildings('./data/', f), loadBoundary('./data/', f)]);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const ring of boundary.rings) for (let i = 0; i < ring.length; i += 2) { minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]); minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1]); }
  const area = { minX: minX - 20, maxX: maxX + 20, minZ: minZ - 20, maxZ: maxZ + 20 };
  const t0 = Date.now();
  const grid = canopyGrid({ dsm, dtm, mask: buildingMask(structures, meta), meta, area });

  // report: the share of the municipality by vegetation height
  const classes = [['<0.5 m', 0, 0.5], ['0.5-2 m', 0.5, 2], ['2-5 m', 2, 5], ['5-10 m', 5, 10], ['10-20 m', 10, 20], ['>20 m', 20, 1e9]].map(([name, lo, hi]) => ({ name, lo, hi, n: 0 }));
  let inside = 0;
  for (let cj = 0; cj < grid.height; cj++) for (let ci = 0; ci < grid.width; ci++) {
    if (!pointInRings(grid.originX + (ci + 0.5) * CELL, grid.originZ + (cj + 0.5) * CELL, boundary.rings)) continue;
    inside++;
    const v = grid.data[cj * grid.width + ci] * STEP;
    classes.find((c) => v >= c.lo && v < c.hi).n++;
  }
  if (!inside) throw new Error('No canopy cell inside the boundary');
  const share = Object.fromEntries(classes.map((c) => [c.name, Number((100 * c.n / inside).toFixed(1))]));
  const tall = classes.filter((c) => c.lo >= 5).reduce((s, c) => s + c.n, 0) / inside;
  if (tall < 0.3 || tall > 0.95) throw new Error(`Implausible share of cells above 5 m: ${(100 * tall).toFixed(0)} %`);
  console.log(`canopy ${grid.width} x ${grid.height} cells of ${CELL} m in ${((Date.now() - t0) / 1000).toFixed(1)} s; share of the municipality by height:`, share);

  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/canopy.bin'), grid.data);
  fs.writeFileSync(path.join(root, 'data/canopy.json'), JSON.stringify({
    source: 'ICGC LiDAR surface model (1 m, 2021-2023) minus terrain model, buildings removed (CC BY 4.0)',
    frame: { E0, N0 }, cell: CELL, step: STEP, width: grid.width, height: grid.height, originX: grid.originX, originZ: grid.originZ, share
  }));
  console.log(`written data/canopy.bin (${(grid.data.length / 1e6).toFixed(1)} MB) and canopy.json`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(`build-canopy failed: ${err.message}`); process.exit(1); });
}
