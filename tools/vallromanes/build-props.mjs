// Bakes the point props (spec §5.6, phase 5): trees, street lamps, poles, pillars, manholes, gullies, tree pits and
// fountains -> data/props.json + data/props.bin (Float32 x, z, angle in radians, three per prop).
//   node tools/vallromanes/build-props.mjs
// Heights are not baked: the runtime puts every prop on the ground (and on the road surface where it stands on one).
// Needs data/boundary.json and data/buildings.* (trees standing inside a building footprint are survey noise).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0, H0, toLocal } from './frame.mjs';
import { readBue } from './read-bue.mjs';
import { fsFetch } from './fs-fetch.mjs';
import { loadBoundary, loadBuildings } from '../../js/geo/load-geodata.js';
import { pointInRings } from '../../js/geo/polygon.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');
const BOUNDARY_TOL = 5;
const DUPLICATE = 0.4; // m: two props of one type this close are one

export const PROP_TYPES = [
  { name: 'tree', re: /^VEG_03_PT$/ },
  { name: 'lamp', re: /^ENE_06_PT$/ },
  { name: 'pole', re: /^ENE_05_PT$/ },
  { name: 'pillar', re: /^ENE_04_PT$/ },
  { name: 'manhole', re: /^REG_01_PT$/ },
  { name: 'gully', re: /^HID_14_PT$/ },
  { name: 'treePit', re: /^VEG_10_PT$/ },
  { name: 'fountain', re: /^HID_15_PT$/ }
];
export const propTypeOf = (cas) => PROP_TYPES.findIndex((t) => t.re.test(cas));

// Spatial hash of building outlines, to ask "is this point inside a building?" quickly
export function buildingLookup(structures) {
  const CELL = 16;
  const cells = new Map();
  for (const s of structures) {
    if (s.open) continue;
    const [outer] = s.rings;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < outer.length; i += 2) { minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i]); minZ = Math.min(minZ, outer[i + 1]); maxZ = Math.max(maxZ, outer[i + 1]); }
    for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++) for (let j = Math.floor(minZ / CELL); j <= Math.floor(maxZ / CELL); j++) {
      const k = `${i},${j}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(s);
    }
  }
  return (x, z) => (cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []).some((s) => pointInRings(x, z, s.rings));
}

export function bakeProps(features, { boundaryRings, insideBuilding }) {
  const out = PROP_TYPES.map(() => []);
  const dropped = { outside: 0, inBuilding: 0, duplicate: 0 };
  const seen = PROP_TYPES.map(() => new Map());
  for (const f of features) {
    if (f.kind !== 'point') continue;
    const t = propTypeOf(f.cas);
    if (t < 0) continue;
    const [x, , z] = f.coords[0];
    if (!pointInRings(x, z, boundaryRings) && ![[BOUNDARY_TOL, 0], [-BOUNDARY_TOL, 0], [0, BOUNDARY_TOL], [0, -BOUNDARY_TOL]].some(([dx, dz]) => pointInRings(x + dx, z + dz, boundaryRings))) { dropped.outside++; continue; }
    if ((PROP_TYPES[t].name === 'tree' || PROP_TYPES[t].name === 'treePit') && insideBuilding(x, z)) { dropped.inBuilding++; continue; }
    const key = `${Math.round(x / DUPLICATE)},${Math.round(z / DUPLICATE)}`;
    if (seen[t].has(key)) { dropped.duplicate++; continue; }
    seen[t].set(key, true);
    // ANGLE is degrees counter-clockwise from east in UTM; x east, z = -north, so the heading about +y is the same angle negated
    const angle = f.angle ? (-f.angle * Math.PI) / 180 : 0;
    out[t].push(x, z, angle);
  }
  return { out, dropped };
}

async function main() {
  const [boundary, { structures }] = await Promise.all([loadBoundary('./data/', fsFetch()), loadBuildings('./data/', fsFetch())]);
  const features = readBue(path.join(RAW, 'bue'), { transform: toLocal });
  const { out, dropped } = bakeProps(features, { boundaryRings: boundary.rings, insideBuilding: buildingLookup(structures) });
  const total = out.reduce((s, a) => s + a.length / 3, 0);
  if (!total) throw new Error('No props baked');
  const all = new Float32Array(out.reduce((s, a) => s + a.length, 0));
  const types = [];
  let off = 0;
  PROP_TYPES.forEach((t, i) => { all.set(out[i], off); types.push({ name: t.name, count: out[i].length / 3, offset: off / 3 }); off += out[i].length; });
  for (const v of all) if (!Number.isFinite(v)) throw new Error('Non-finite prop coordinate');
  console.log(`Props baked: ${total} (dropped ${dropped.outside} outside the boundary, ${dropped.inBuilding} trees inside buildings, ${dropped.duplicate} duplicates)`);
  for (const t of types) console.log(`  ${t.name.padEnd(9)} ${String(t.count).padStart(6)}`);
  fs.writeFileSync(path.join(root, 'data/props.json'), JSON.stringify({ frame: { E0, N0, H0, crs: 'EPSG:25831' }, source: 'Diputació de Barcelona BUE 1:1000 (VEG_03, ENE_04/05/06, REG_01, HID_14/15, VEG_10)', encoding: 'float32-x-z-angle', types }));
  fs.writeFileSync(path.join(root, 'data/props.bin'), Buffer.from(all.buffer, all.byteOffset, all.byteLength));
  console.log(`written data/props.json + props.bin (${(all.byteLength / 1e3).toFixed(0)} kB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(`build-props failed: ${err.message}`); process.exit(1); });
}
