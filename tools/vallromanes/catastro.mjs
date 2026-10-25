// Reads the Catastro INSPIRE building files of one municipality (phase 8): `building` (use, year of construction) and
// `buildingpart` (floors above ground, footprint). The GML is plain regular text, so it is read with patterns; there is no need
// for an XML library. Coordinates are EPSG:25831 and become the local frame (x = E - E0, z = N0 - N).
import fs from 'node:fs';
import path from 'node:path';
import { E0, N0 } from './frame.mjs';
import { pointInRings } from '../../js/geo/polygon.js';

export const USE = { UNKNOWN: 0, RESIDENTIAL: 1, AGRICULTURE: 2, INDUSTRIAL: 3, RETAIL: 4, PUBLIC: 5, OTHER: 6 };

/** Catastro `currentUse` ("1_residential", "4_3_publicServices", ...) -> USE. */
export function useOf(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('residential')) return USE.RESIDENTIAL;
  if (t.includes('agriculture')) return USE.AGRICULTURE;
  if (t.includes('industrial')) return USE.INDUSTRIAL;
  if (t.includes('retail')) return USE.RETAIL;
  if (t.includes('publicservices')) return USE.PUBLIC;
  return t ? USE.OTHER : USE.UNKNOWN;
}

const tag = (body, name) => (body.match(new RegExp(`<${name}[^>]*>([^<]*)<`)) || [])[1];

/** Buildings: Map from the cadastral reference to { use, year (0 when unknown or the placeholder 1900), dwellings }. */
export function parseBuildings(gml) {
  const out = new Map();
  for (const m of gml.matchAll(/<bu-ext2d:Building gml:id="ES\.SDGC\.BU\.([^"]*)">([\s\S]*?)<\/bu-ext2d:Building>/g)) {
    const year = parseInt((tag(m[2], 'bu-core2d:beginning') || '').slice(0, 4), 10);
    out.set(m[1], {
      use: useOf(tag(m[2], 'bu-ext2d:currentUse')),
      year: Number.isFinite(year) && year > 1500 && year !== 1900 ? year : 0,
      dwellings: parseInt(tag(m[2], 'bu-ext2d:numberOfDwellings') || '0', 10) || 0
    });
  }
  return out;
}

/** Building parts: [{ ref, floors, x, z (centroid of the footprint, local frame) }]. */
export function parseParts(gml) {
  const out = [];
  for (const m of gml.matchAll(/<bu-ext2d:BuildingPart gml:id="ES\.SDGC\.BU\.([^"_]*)_part\d+">([\s\S]*?)<\/bu-ext2d:BuildingPart>/g)) {
    const pos = tag(m[2], 'gml:posList');
    const floors = parseInt(tag(m[2], 'bu-ext2d:numberOfFloorsAboveGround') || '', 10);
    if (!pos || !Number.isFinite(floors)) continue;
    const v = pos.trim().split(/\s+/).map(Number);
    let sx = 0, sz = 0, n = 0;
    for (let i = 0; i + 1 < v.length; i += 2) { sx += v[i] - E0; sz += N0 - v[i + 1]; n++; }
    if (n) out.push({ ref: m[1], floors, x: sx / n, z: sz / n });
  }
  return out;
}

/** Reads the three files of `dir` (A.ES.SDGC.BU.<code>.building.gml and .buildingpart.gml), or returns null when they are missing. */
export function loadCatastro(dir, code = '08297') {
  const b = path.join(dir, `A.ES.SDGC.BU.${code}.building.gml`), p = path.join(dir, `A.ES.SDGC.BU.${code}.buildingpart.gml`);
  if (!fs.existsSync(b) || !fs.existsSync(p)) return null;
  return makeIndex(parseBuildings(fs.readFileSync(b, 'latin1')), parseParts(fs.readFileSync(p, 'latin1')));
}

const CELL = 16;

/**
 * An index over parts and buildings. `lookup(rings)` takes a footprint ([outer, ...holes] flat [x, z, ...]) and returns
 * { floors (the most floors of its parts), use, year } from the parts whose centroid lies inside it, or null.
 */
export function makeIndex(buildings, parts) {
  const cells = new Map();
  for (const p of parts) {
    const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  function lookup(rings) {
    const outer = rings[0];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < outer.length; i += 2) { minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i]); minZ = Math.min(minZ, outer[i + 1]); maxZ = Math.max(maxZ, outer[i + 1]); }
    let floors = -1, owner = null, count = 0;
    for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++) {
      for (let j = Math.floor(minZ / CELL); j <= Math.floor(maxZ / CELL); j++) {
        for (const p of cells.get(`${i},${j}`) || []) {
          if (!pointInRings(p.x, p.z, rings)) continue;
          count++;
          if (p.floors > floors) { floors = p.floors; owner = p.ref; }
        }
      }
    }
    if (!count) return null;
    const b = buildings.get(owner) || { use: USE.UNKNOWN, year: 0 };
    return { floors, use: b.use, year: b.year, parts: count };
  }
  return { lookup, buildings: buildings.size, parts: parts.length };
}
