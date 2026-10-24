// Bakes the terrain height grids from the ICGC 1 m DTM window (spec §5.2).
//   node tools/vallromanes/build-terrain.mjs [--fine 2] [--coarse 4] [--core-margin 100]
// Two tiers: `fine` over the BUE core (bbox + margin) and `coarse` over the whole download window. Each vertex is
// the box average of the 1 m source pixels centred on that vertex. Heights are quantised to 5 cm above H0 and stored
// as int16 residuals of a planar predictor (left + up - upLeft), which gzip compresses well (about 3 MB in all).
// The road profiles of data/roads.json (build-roads.mjs) are burned into both tiers before they are quantised.
// Writes data/terrain.bin (int16 residuals per tier, little-endian) and data/terrain.json; throws if the BUE spot-height quality gate fails.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0, H0 } from './frame.mjs';
import { readBue } from './read-bue.mjs';
import { createTerrainSampler, decodeHeights, decodePlanar } from '../../js/geo/terrain-sampler.js';
import { burnRoads } from './burn-roads.mjs';
import { ROAD_DEPTH } from '../../js/world/street-geometry.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');
export const SCALE = 0.05; // metres per quantised step (max rounding error 2.5 cm)
export const GATE = { median: 0.3, p95: 1.0 };

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

export function loadDem(dir, name = 'dtm-1m') {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, `${name}.f32`));
  const heights = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  if (heights.length !== meta.width * meta.height) throw new Error(`${name}: ${heights.length} samples, expected ${meta.width * meta.height}`);
  return { meta, heights };
}

// Box-average resample. The source has 1 m pixels whose corners fall on integer metres from (originE, originN).
// Vertex (i, j) of the output sits at source corner (cx0 + i * step, cy0 + j * step) and averages the step × step
// pixels around it (clamped at the raster edge). cx0/cy0 are in source pixels; x0/y0 are the sample counts.
export function resampleBox(src, width, height, step, cx0, cy0, w, h, nodata = -9999) {
  const out = new Float32Array(w * h);
  const half = step / 2;
  for (let j = 0; j < h; j++) {
    const cy = cy0 + j * step;
    const ya = Math.max(0, Math.ceil(cy - half));
    const yb = Math.min(height, Math.ceil(cy + half));
    for (let i = 0; i < w; i++) {
      const cx = cx0 + i * step;
      const xa = Math.max(0, Math.ceil(cx - half));
      const xb = Math.min(width, Math.ceil(cx + half));
      let sum = 0, n = 0;
      for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) {
          const v = src[y * width + x];
          if (v === nodata || !Number.isFinite(v)) continue;
          sum += v;
          n++;
        }
      }
      if (!n) throw new Error(`No valid source pixels for vertex (${i}, ${j})`);
      out[j * w + i] = sum / n;
    }
  }
  return out;
}

// Planar predictor: residual = value - (left + up - upLeft); edges fall back to left or up. See decodePlanar().
export function encodePlanar(q, width, height) {
  const out = new Int16Array(q.length);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      const left = i ? q[k - 1] : (j ? q[k - width] : 0);
      const up = j ? q[k - width] : left;
      const upLeft = i && j ? q[k - width - 1] : left;
      const r = q[k] - (left + up - upLeft);
      if (r < -32768 || r > 32767) throw new Error(`Terrain residual ${r} does not fit in int16`);
      out[k] = r;
    }
  }
  return out;
}

export function encodeHeights(hAbs) {
  const out = new Uint16Array(hAbs.length);
  for (let i = 0; i < hAbs.length; i++) {
    const v = Math.round((hAbs[i] - H0) / SCALE);
    if (!Number.isFinite(v) || v < 0 || v > 65535) throw new Error(`Height ${hAbs[i]} outside the uint16 range above H0 = ${H0}`);
    out[i] = v;
  }
  return out;
}

// Builds a tier covering the local-frame rectangle [minX, maxX] × [minZ, maxZ] (snapped to the tier's cell grid).
export function buildTier(dem, name, cell, rect, roads = null) {
  const { meta, heights } = dem;
  // local x = E - E0, local z = N0 - N; source pixel column = E - originE, row = originN - N.
  const colOfX = (x) => x + E0 - meta.originE;
  const rowOfZ = (z) => z + meta.originN - N0;
  const c0 = Math.ceil(Math.max(colOfX(rect.minX), 0) / cell) * cell;
  const c1 = Math.floor(Math.min(colOfX(rect.maxX), meta.width) / cell) * cell;
  const r0 = Math.ceil(Math.max(rowOfZ(rect.minZ), 0) / cell) * cell;
  const r1 = Math.floor(Math.min(rowOfZ(rect.maxZ), meta.height) / cell) * cell;
  const w = (c1 - c0) / cell + 1;
  const h = (r1 - r0) / cell + 1;
  const abs = resampleBox(heights, meta.width, meta.height, cell, c0, r0, w, h, meta.nodata);
  const minX = c0 + meta.originE - E0, minZ = r0 + N0 - meta.originN;
  // roads are in local y (H - H0); the grid holds absolute H here, hence base = H0
  const burned = roads ? burnRoads(abs, { minX, minZ, cell, w, h }, roads, { base: H0, depth: ROAD_DEPTH }) : 0;
  return {
    burned,
    name, cell, width: w, height: h,
    minX: c0 + meta.originE - E0,
    minZ: r0 + N0 - meta.originN,
    u16: encodeHeights(abs)
  };
}

// Compares the sampler with BUE spot heights (ORO_03), skipping points within ~5 m of buildings.
export function validateAgainstSpots(sampler, features) {
  const cell = 5;
  const near = new Set();
  for (const f of features) {
    if (f.kind === 'poly' && /^CON_(01|07|08|09)pol_PL$/.test(f.cas)) {
      for (const [e, n] of f.coords) near.add(`${Math.floor(e / cell)},${Math.floor(n / cell)}`);
    }
  }
  const close = (e, n) => {
    const cx = Math.floor(e / cell), cy = Math.floor(n / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (near.has(`${cx + i},${cy + j}`)) return true;
    return false;
  };
  const diffs = [];
  for (const f of features) {
    if (f.kind !== 'point' || f.cas !== 'ORO_03_PT') continue;
    const [e, n, h] = f.coords[0];
    if (close(e, n)) continue;
    const x = e - E0, z = N0 - n;
    if (x < sampler.bounds.minX || x > sampler.bounds.maxX || z < sampler.bounds.minZ || z > sampler.bounds.maxZ) continue;
    diffs.push(sampler.heightAt(x, z) - (h - H0));
  }
  if (!diffs.length) throw new Error('No spot heights available for validation');
  const abs = diffs.map(Math.abs).sort((a, b) => a - b);
  const q = (p) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
  return { n: diffs.length, median: q(0.5), p95: q(0.95), max: abs[abs.length - 1], mean: diffs.reduce((s, v) => s + v, 0) / diffs.length };
}

function main() {
  const fineCell = arg('--fine', 2);
  const coarseCell = arg('--coarse', 4);
  const coreMargin = arg('--core-margin', 100);
  const dem = loadDem(path.join(RAW, 'icgc/dtm'));
  const { meta } = dem;

  // Whole download window in local coordinates.
  const full = {
    minX: meta.originE - E0, maxX: meta.originE + meta.width - E0,
    minZ: N0 - meta.originN, maxZ: N0 - meta.originN + meta.height
  };
  // BUE core: bbox of the delivered shapefiles plus a margin.
  const features = readBue(path.join(RAW, 'bue'));
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const f of features) for (const part of f.parts) for (const [e, n] of part) {
    if (e < minE) minE = e; if (e > maxE) maxE = e; if (n < minN) minN = n; if (n > maxN) maxN = n;
  }
  const core = { minX: minE - coreMargin - E0, maxX: maxE + coreMargin - E0, minZ: N0 - (maxN + coreMargin), maxZ: N0 - (minN - coreMargin) };

  const roadsFile = path.join(root, 'data/roads.json');
  const roads = fs.existsSync(roadsFile) ? JSON.parse(fs.readFileSync(roadsFile, 'utf8')).edges : null;
  if (!roads) console.warn('WARNING: data/roads.json not found, terrain is not flattened under roads (run build-roads.mjs first)');
  const tiers = [buildTier(dem, 'fine', fineCell, core, roads), buildTier(dem, 'coarse', coarseCell, full, roads)];
  if (roads) console.log(`Road profiles burned into the terrain: ${tiers.map((t) => `${t.name} ${t.burned} vertices`).join(', ')}`);
  const sampler = createTerrainSampler(tiers.map((t) => ({ ...t, heights: decodeHeights(t.u16, SCALE) })));

  const report = {};
  for (const t of tiers) {
    const single = createTerrainSampler([{ ...t, heights: decodeHeights(t.u16, SCALE) }]);
    report[t.name] = validateAgainstSpots(single, features);
  }
  console.log('Spot-height check against BUE ORO_03 (away from buildings):');
  for (const [name, r] of Object.entries(report)) {
    console.log(`  ${name.padEnd(6)} n ${r.n}  median |Δ| ${r.median.toFixed(3)} m  P95 ${r.p95.toFixed(3)} m  max ${r.max.toFixed(2)} m  mean ${r.mean.toFixed(3)} m`);
  }
  const fine = report.fine;
  if (fine.median > GATE.median || fine.p95 > GATE.p95) throw new Error(`Quality gate failed: median ${fine.median.toFixed(3)} (max ${GATE.median}), P95 ${fine.p95.toFixed(3)} (max ${GATE.p95})`);

  let offset = 0;
  const parts = [];
  const desc = tiers.map((t) => {
    const res = encodePlanar(t.u16, t.width, t.height);
    const bytes = Buffer.from(res.buffer, res.byteOffset, res.byteLength);
    const d = { name: t.name, cell: t.cell, width: t.width, height: t.height, minX: t.minX, minZ: t.minZ, offset, bytes: bytes.length };
    parts.push(bytes);
    offset += bytes.length;
    return d;
  });
  const bin = Buffer.concat(parts);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/terrain.bin'), bin);
  const maxY = Math.max(...tiers.map((t) => t.u16.reduce((m, v) => (v > m ? v : m), 0))) * SCALE;
  // Round-trip check: the decoded file must reproduce the quantised grids exactly.
  for (const t of tiers) {
    const back = decodePlanar(encodePlanar(t.u16, t.width, t.height), t.width, t.height, SCALE);
    const want = decodeHeights(t.u16, SCALE);
    for (let k = 0; k < back.length; k++) if (back[k] !== want[k]) throw new Error(`Planar round trip failed in tier ${t.name} at ${k}`);
  }
  fs.writeFileSync(path.join(root, 'data/terrain.json'), JSON.stringify({
    frame: { E0, N0, H0, crs: 'EPSG:25831' }, encoding: 'int16-planar-le', scale: SCALE, tiers: desc,
    bounds: sampler.bounds, maxY, source: meta.source, quality: report
  }, null, 2));
  const gz = zlib.gzipSync(bin).length;
  for (const d of desc) console.log(`tier ${d.name}: ${d.width} × ${d.height} @ ${d.cell} m, x ${d.minX}..${d.minX + (d.width - 1) * d.cell}, z ${d.minZ}..${d.minZ + (d.height - 1) * d.cell}`);
  console.log(`terrain.bin ${(bin.length / 1e6).toFixed(2)} MB raw, ${(gz / 1e6).toFixed(2)} MB gzipped; max y ${maxY.toFixed(2)} m`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (err) { console.error(`build-terrain failed: ${err.message}`); process.exit(1); }
}
