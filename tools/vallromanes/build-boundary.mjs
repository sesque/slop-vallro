// Extracts the municipal boundary of Vallromanes (INE 08296) from the ICGC administrative divisions
// (CC BY 4.0, 1:5000 GeoJSON in lon/lat) and writes it in EPSG:25831 and in the local frame.
//   node tools/vallromanes/build-boundary.mjs [--src <municipis-5000.json>] [--out <file>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0, toLocal } from './frame.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw/boundary');
export const DEFAULT_SRC = path.join(RAW, 'dl/divisions-administratives-v2r2-municipis-5000-20260120.json');
export const DEFAULT_OUT = path.join(RAW, 'vallromanes-boundary.json');
export const INE = '08296';

// Transverse Mercator, GRS80, zone 31N (central meridian 3°E, k0 0.9996). ETRS89 and WGS84 differ by less than
// a metre in Catalonia, which is below the 1:5000 boundary accuracy, so no datum shift is applied.
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const LON0 = (3 * Math.PI) / 180;

export function lonLatToUtm31(lonDeg, latDeg) {
  const phi = (latDeg * Math.PI) / 180;
  const lam = (lonDeg * Math.PI) / 180;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const t = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * s * s);
  const T = t * t;
  const C = EP2 * c * c;
  const Aa = (lam - LON0) * c;
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  const M = A * ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
  const e = 500000 + K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120);
  const n = K0 * (M + N * t * ((Aa * Aa) / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720));
  return [e, n];
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

// Even-odd point-in-polygon over all rings (outer rings and holes) of a list of polygons.
export function pointInPolygons(e, n, polygons) {
  let inside = false;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > n) !== (yj > n) && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

export function extractBoundary(geojson, ine = INE) {
  // CODIMUNI is the 5-digit INE code plus a check digit.
  const hits = geojson.features.filter((f) => String(f.properties.CODIMUNI).startsWith(ine));
  if (hits.length !== 1) throw new Error(`Expected exactly one municipality for INE ${ine}, found ${hits.length}`);
  const f = hits[0];
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  const utm = polys.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => {
    const p = lonLatToUtm31(lon, lat);
    if (!p.every(Number.isFinite)) throw new Error('Non-finite boundary coordinate');
    return p;
  })));
  return { properties: f.properties, utm };
}

export function summarise(utm) {
  const pts = utm.flat(2);
  const es = pts.map((p) => p[0]);
  const ns = pts.map((p) => p[1]);
  const area = utm.reduce((a, poly) => a + Math.abs(ringArea(poly[0])) - poly.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0);
  return { minE: Math.min(...es), maxE: Math.max(...es), minN: Math.min(...ns), maxN: Math.max(...ns), areaKm2: area / 1e6, vertices: pts.length };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const src = path.resolve(arg('--src') || DEFAULT_SRC);
  const out = path.resolve(arg('--out') || DEFAULT_OUT);
  const { properties, utm } = extractBoundary(JSON.parse(fs.readFileSync(src, 'utf8')));
  const s = summarise(utm);
  const declared = properties.AREAM5000;
  if (Math.abs(s.areaKm2 - declared) / declared > 0.01) throw new Error(`Area ${s.areaKm2.toFixed(3)} km² differs from declared ${declared} km²`);
  const local = utm.map((poly) => poly.map((ring) => ring.map(([e, n]) => {
    const [x, , z] = toLocal(e, n, 0);
    return [x, z];
  })));
  fs.writeFileSync(out, JSON.stringify({
    source: 'ICGC Divisions administratives v2r2-20260120, 1:5000, CC BY 4.0',
    ine: INE, name: properties.NOMMUNI, crs: 'EPSG:25831', frame: { E0, N0 },
    bboxUtm: { minE: s.minE, maxE: s.maxE, minN: s.minN, maxN: s.maxN }, areaKm2: s.areaKm2,
    utm, local
  }));
  console.log(`${properties.NOMMUNI} (INE ${INE}): ${s.vertices} vertices, area ${s.areaKm2.toFixed(3)} km² (declared ${declared})`);
  console.log(`bbox E ${s.minE.toFixed(1)} → ${s.maxE.toFixed(1)}, N ${s.minN.toFixed(1)} → ${s.maxN.toFixed(1)} (${(s.maxE - s.minE).toFixed(0)} × ${(s.maxN - s.minN).toFixed(0)} m)`);
  console.log(`written ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (err) { console.error(`build-boundary failed: ${err.message}`); process.exit(1); }
}
