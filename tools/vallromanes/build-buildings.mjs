// Bakes the building footprints (spec §5.3, phase 3 first pass).
//   node tools/vallromanes/build-buildings.mjs
// Reads the BUE polygons (buildings, sheds, porches, canopies ...), puts them on the baked terrain and writes
// data/buildings.json (one record per structure) and data/buildings.bin (rings as Int32 centimetres, x then z).
// Needs data/terrain.* and data/boundary.json (run build-terrain.mjs and build-boundary.mjs first).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0, H0, toLocal } from './frame.mjs';
import { readBue } from './read-bue.mjs';
import { loadTerrain } from '../../js/geo/load-geodata.js';
import { fsFetch } from './fs-fetch.mjs';
import { roofStats, loadDsm } from './lidar-roofs.mjs';
import { centroid, orientedBox, pointInRings, reverseRing, signedArea, simplifyRing } from '../../js/geo/polygon.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');

// CAS code -> structure kind (knowledge.md §3.3). `open` kinds are a roof slab without walls.
export const KINDS = [
  { name: 'building', re: /^CON_01pol_PL$/, open: false },
  { name: 'shed', re: /^CON_07pol_PL$/, open: false },
  { name: 'porch', re: /^CON_08pol_PL$/, open: true },
  { name: 'canopy', re: /^CON_09pol_PL$/, open: true },
  { name: 'construction', re: /^CON_18pol(ES|LN|LS)_PL$/, open: false },
  { name: 'tank', re: /^CON_21pol_PL$/, open: false },
  { name: 'ruins', re: /^CON_10pol_PL$/, open: false },
  { name: 'greenhouse', re: /^CON_11pol_PL$/, open: false },
  { name: 'wip', re: /^CON_06pol_PL$/, open: false },
  { name: 'monument', re: /^CON_22pol_PL$/, open: false },
  { name: 'cemetery', re: /^CON_31pol_PL$/, open: false },
  { name: 'tower', re: /^ENE_03pol_PL$/, open: false }
];
export const ROOF = { FLAT: 0, HIP: 1 };
export const FLAG = { TALL: 1, SHORT: 2, BURIED: 4, LOW_TOP: 8, LIDAR_TOP: 16 };
export const LIDAR_TOP_DIFF = 1.2; // m: a BUE top this far from the LiDAR roof level is replaced by it
export const LIDAR_FLAT_RELIEF = 0.9; // m between eave and ridge below which a roof counts as flat
export const MIN_HEIGHT = 2.2; // spec §5.3
const MIN_AREA = 0.2; // m², below this a polygon is a survey artefact
const FLOOR_HEIGHT = 3.0;
const SIMPLIFY_TOL = 0.1; // spec §5.3
const BOUNDARY_TOL = 5; // metres outside the municipal boundary that are still kept

export function kindOf(cas) {
  return KINDS.findIndex((k) => k.re.test(cas));
}

// FNV-1a over the CAS code and the centimetre-rounded ring, so overrides keyed by id survive re-runs (spec §4)
export function stableId(cas, ringCm) {
  let h = 0x811c9dc5;
  const feed = (n) => { h = Math.imul(h ^ (n & 0xff), 0x01000193); };
  for (let i = 0; i < cas.length; i++) feed(cas.charCodeAt(i));
  for (const v of ringCm) { feed(v); feed(v >> 8); feed(v >> 16); feed(v >> 24); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Splits a feature's parts into the outer ring and its holes, oriented per js/geo/polygon.js, simplified.
export function featureRings(parts) {
  const rings = parts.map((part) => {
    const flat = [];
    for (const [x, , z] of part) flat.push(x, z);
    return simplifyRing(flat, SIMPLIFY_TOL);
  });
  const outer = rings[0];
  const holes = rings.slice(1).filter((r) => r.length >= 6 && Math.abs(signedArea(r)) >= 1);
  return {
    outer: signedArea(outer) >= 0 ? outer : reverseRing(outer),
    holes: holes.map((h) => (signedArea(h) <= 0 ? h : reverseRing(h)))
  };
}

// Heights, floors, roof and flags for one footprint. `ground(x, z)` is the baked terrain height (local y).
export function describeStructure(outer, top, ground, open) {
  const n = outer.length / 2;
  let base = Infinity, baseMax = -Infinity, sum = 0;
  const [cx, cz] = centroid(outer);
  const samples = [ground(cx, cz)];
  for (let i = 0; i < n; i++) samples.push(ground(outer[i * 2], outer[i * 2 + 1]));
  for (const g of samples) {
    if (g < base) base = g;
    if (g > baseMax) baseMax = g;
    sum += g;
  }
  const baseMean = sum / samples.length;
  let flags = 0;
  const height = top - base;
  if (height > 30) flags |= FLAG.TALL;
  if (height < 2) flags |= FLAG.SHORT;
  if (top < baseMax + 0.3) flags |= FLAG.BURIED;
  if (height < MIN_HEIGHT) { top = base + MIN_HEIGHT; flags |= FLAG.LOW_TOP; }
  const floors = open ? 1 : Math.max(1, Math.min(10, Math.round((top - baseMean) / FLOOR_HEIGHT)));
  return { base, baseMax, baseMean, top, floors, flags };
}

// Hip roof when the footprint is nearly a rectangle (spec §5.3, phase 3): otherwise flat. `rise` is the height from
// the eave to the ridge; the baked `top` is the mean roof level (knowledge.md §3.5), so the eave sits below it.
export function chooseRoof(outer, holes, kindIndex) {
  const flat = { roof: ROOF.FLAT, rise: 0 };
  if (kindIndex !== 0 || holes.length || outer.length / 2 > 16) return flat;
  const box = orientedBox(outer);
  if (!box || box.hz * 2 < 3) return flat;
  const fill = Math.abs(signedArea(outer)) / box.area;
  if (fill < 0.8) return flat;
  return { roof: ROOF.HIP, rise: +Math.max(0.6, Math.min(2.2, box.hz * 0.35)).toFixed(2) };
}

/**
 * Corrects a baked building with its LiDAR roof statistics `st` ({ median, eave, ridge } in local y, or null): a BUE top buried in
 * the ground or more than LIDAR_TOP_DIFF from the roof level takes the roof level; a hip roof whose eave-to-ridge relief is under
 * LIDAR_FLAT_RELIEF becomes flat, and a hip roof takes its rise from the relief. Only buildings and sheds (kinds 0 and 1).
 * `d` = describeStructure's result and `roof` = chooseRoof's; returns the new { top, floors, flags, roof, rise, changed }.
 */
export function refineWithLidar(d, roof, st, kindIndex, open, baseMean) {
  const out = { top: d.top, floors: d.floors, flags: d.flags, roof: roof.roof, rise: roof.rise, changed: { top: false, roof: false } };
  if (!st || kindIndex > 1) return out;
  const bad = d.flags & (FLAG.BURIED | FLAG.SHORT | FLAG.LOW_TOP);
  if (bad || Math.abs(d.top - st.median) > LIDAR_TOP_DIFF) {
    const top = Math.max(st.median, d.baseMax + 0.3);
    if (top - d.base >= MIN_HEIGHT) {
      out.top = top;
      out.flags = (d.flags & ~(FLAG.BURIED | FLAG.SHORT | FLAG.LOW_TOP)) | FLAG.LIDAR_TOP;
      if (top - d.base > 30) out.flags |= FLAG.TALL;
      out.floors = open ? 1 : Math.max(1, Math.min(10, Math.round((top - baseMean) / FLOOR_HEIGHT)));
      out.changed.top = true;
    }
  }
  if (roof.roof === ROOF.HIP) {
    const relief = st.ridge - st.eave;
    if (relief < LIDAR_FLAT_RELIEF) { out.roof = ROOF.FLAT; out.rise = 0; out.changed.roof = true; }
    else { out.rise = +Math.max(0.6, Math.min(4, relief)).toFixed(2); out.changed.roof = Math.abs(out.rise - roof.rise) > 0.3; }
  }
  return out;
}

export function buildBuildings(features, ground, boundaryRings, lidar = null) {
  const records = [];
  const rings = [];
  let ringVerts = 0;
  const dropped = { degenerate: 0, outside: 0 };
  const lidarCount = { topReplaced: 0, flattened: 0, riseSet: 0, noPixels: 0 };
  const ids = new Set();
  const seen = { vertsBefore: 0, vertsAfter: 0 };

  for (const f of features) {
    if (f.kind !== 'poly') continue;
    const kindIndex = kindOf(f.cas);
    if (kindIndex < 0) continue;
    seen.vertsBefore += f.parts.reduce((s, p) => s + p.length - 1, 0);
    const { outer, holes } = featureRings(f.parts);
    seen.vertsAfter += outer.length / 2 + holes.reduce((s, h) => s + h.length / 2, 0);
    if (outer.length < 6 || signedArea(outer) < MIN_AREA) { dropped.degenerate++; continue; }
    const [cx, cz] = centroid(outer);
    if (!pointInRings(cx, cz, boundaryRings)) {
      // allow a small tolerance for structures straddling the line
      const near = [[BOUNDARY_TOL, 0], [-BOUNDARY_TOL, 0], [0, BOUNDARY_TOL], [0, -BOUNDARY_TOL]].some(([dx, dz]) => pointInRings(cx + dx, cz + dz, boundaryRings));
      if (!near) { dropped.outside++; continue; }
    }
    const top = f.coords[0][1];
    let d = describeStructure(outer, top, ground, KINDS[kindIndex].open);
    let roof = chooseRoof(outer, holes, kindIndex);
    if (lidar) {
      const st = kindIndex <= 1 ? roofStats([outer, ...holes], lidar) : null;
      if (kindIndex <= 1 && !st) lidarCount.noPixels++;
      const r = refineWithLidar(d, roof, st, kindIndex, KINDS[kindIndex].open, d.baseMean);
      if (r.changed.top) lidarCount.topReplaced++;
      if (r.changed.roof && r.roof === ROOF.FLAT) lidarCount.flattened++;
      else if (r.changed.roof) lidarCount.riseSet++;
      d = { ...d, top: r.top, floors: r.floors, flags: r.flags };
      roof = { roof: r.roof, rise: r.rise };
    }
    const allRings = [outer, ...holes];
    const cm = allRings.map((r) => r.map((v) => Math.round(v * 100)));
    let id = stableId(f.cas, cm.flat());
    while (ids.has(id)) id = stableId(id, [ids.size]); // vanishingly rare; keep ids unique
    ids.add(id);
    records.push({
      id, kind: kindIndex,
      base: +d.base.toFixed(2), baseMax: +d.baseMax.toFixed(2), top: +d.top.toFixed(2),
      floors: d.floors, roof: roof.roof, rise: roof.rise, flags: d.flags,
      rings: allRings.map((r, i) => [ringVerts + allRings.slice(0, i).reduce((s, q) => s + q.length / 2, 0), r.length / 2])
    });
    ringVerts += allRings.reduce((s, r) => s + r.length / 2, 0);
    for (const r of cm) rings.push(Int32Array.from(r));
  }
  const bin = new Int32Array(ringVerts * 2);
  let o = 0;
  for (const r of rings) { bin.set(r, o); o += r.length; }
  return { records, bin, dropped, seen, lidarCount };
}

async function main() {
  const { sampler, meta } = await loadTerrain('./data/', fsFetch());
  if (meta.frame.H0 !== H0 || meta.frame.E0 !== E0 || meta.frame.N0 !== N0) throw new Error('data/terrain.json was baked with a different frame; rerun build-terrain.mjs');
  const boundary = JSON.parse(fs.readFileSync(path.join(root, 'data/boundary.json'), 'utf8'));
  const features = readBue(path.join(RAW, 'bue'), { transform: toLocal });

  const ground = (x, z) => sampler.heightAt(x, z);
  const lidar = loadDsm(path.join(RAW, 'icgc/dtm'));
  console.log(lidar ? 'LiDAR DSM found: roofs and tops are checked against it' : 'No LiDAR DSM (fetch-icgc-dtm.mjs --product dsm --level 0): BUE tops only');
  const { records, bin, dropped, seen, lidarCount } = buildBuildings(features, ground, boundary.rings, lidar);
  if (lidar) console.log(`LiDAR: ${lidarCount.topReplaced} tops replaced by the roof level, ${lidarCount.flattened} hip roofs made flat, ${lidarCount.riseSet} hip rises set from the relief, ${lidarCount.noPixels} buildings without enough pixels`);
  if (!records.length) throw new Error('No structures baked');
  for (const r of records) {
    if (![r.base, r.baseMax, r.top].every(Number.isFinite)) throw new Error(`Non-finite height in ${r.id}`);
  }
  for (const v of bin) if (!Number.isInteger(v)) throw new Error('Non-integer ring coordinate');

  const count = (fn) => records.filter(fn).length;
  const buildings = records.filter((r) => r.kind === 0);
  const heights = buildings.map((r) => r.top - r.base).sort((a, b) => a - b);
  const q = (p) => heights[Math.min(heights.length - 1, Math.floor(p * heights.length))];
  console.log(`Structures baked: ${records.length} (dropped: ${dropped.degenerate} degenerate, ${dropped.outside} outside the boundary)`);
  for (let k = 0; k < KINDS.length; k++) console.log(`  ${KINDS[k].name.padEnd(13)} ${String(count((r) => r.kind === k)).padStart(5)}`);
  console.log(`Vertices: ${seen.vertsBefore} -> ${seen.vertsAfter} after ${SIMPLIFY_TOL} m simplification (${bin.length / 2} baked incl. holes)`);
  console.log(`Building height (top - lowest ground): P10 ${q(0.1).toFixed(1)} P50 ${q(0.5).toFixed(1)} P90 ${q(0.9).toFixed(1)} m`);
  const floorHist = {};
  for (const r of buildings) floorHist[r.floors] = (floorHist[r.floors] || 0) + 1;
  console.log(`Floors: ${Object.entries(floorHist).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`Roofs: ${count((r) => r.roof === ROOF.HIP)} hip, ${count((r) => r.roof === ROOF.FLAT)} flat (of ${buildings.length} buildings, ${count((r) => r.roof === ROOF.HIP)} hips overall)`);
  const flagged = (bit) => count((r) => r.flags & bit);
  const review = FLAG.TALL | FLAG.SHORT | FLAG.BURIED;
  const flaggedBuildings = buildings.filter((r) => r.flags & review).length;
  console.log(`Flags (all kinds): tall ${flagged(FLAG.TALL)}, short ${flagged(FLAG.SHORT)}, buried ${flagged(FLAG.BURIED)}, raised to ${MIN_HEIGHT} m ${flagged(FLAG.LOW_TOP)}`);
  console.log(`Buildings flagged for review: ${flaggedBuildings} of ${buildings.length} (${(100 * flaggedBuildings / buildings.length).toFixed(2)}%)`);
  if (flaggedBuildings / buildings.length > 0.01) {
    console.warn('WARNING: more than 1% of buildings flagged (spec §8 gate). Mostly "buried": the BUE top is within 0.3 m of the highest ground at the footprint (knowledge.md §3.5).');
  }

  const out = {
    frame: meta.frame, source: 'Diputació de Barcelona BUE 1:1000 (CON_* polygons)', kinds: KINDS.map((k) => ({ name: k.name, open: k.open })),
    flags: FLAG, roofs: ROOF, ringEncoding: 'int32-cm-xz', count: records.length, buildings: records
  };
  fs.writeFileSync(path.join(root, 'data/buildings.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(root, 'data/buildings.bin'), Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength));
  const size = fs.statSync(path.join(root, 'data/buildings.json')).size + bin.byteLength;
  console.log(`written data/buildings.json + buildings.bin (${(size / 1e6).toFixed(2)} MB raw)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(`build-buildings failed: ${err.message}`); process.exit(1); });
}
