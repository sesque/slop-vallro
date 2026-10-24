// Downloads the OpenStreetMap highways inside the municipality's bounding box from the Overpass API (ODbL).
//   node tools/vallromanes/fetch-osm.mjs [--endpoint https://overpass-api.de/api/interpreter]
// Writes tools/data/vallromanes/raw/osm/vallromanes.json (the Overpass response); build-roads.mjs uses it when present.
// A few hundred kB for a village this size. Credit: © OpenStreetMap contributors, ODbL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');

export function boundingBoxOf(geojson, ine = '08296') {
  const f = geojson.features.find((x) => String(x.properties.CODIMUNI).startsWith(ine));
  if (!f) throw new Error(`INE ${ine} not found in the boundary file`);
  const pts = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.flat(2) : f.geometry.coordinates.flat(1));
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  const pad = 0.002; // about 200 m, like the terrain margin
  return { south: Math.min(...lats) - pad, west: Math.min(...lons) - pad, north: Math.max(...lats) + pad, east: Math.max(...lons) + pad };
}

export function overpassQuery(b) {
  return `[out:json][timeout:90];(way["highway"](${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}););out geom tags;`;
}

async function main() {
  const i = process.argv.indexOf('--endpoint');
  const endpoint = i >= 0 ? process.argv[i + 1] : 'https://overpass-api.de/api/interpreter';
  const src = path.join(RAW, 'boundary/dl/divisions-administratives-v2r2-municipis-5000-20260120.json');
  const bbox = boundingBoxOf(JSON.parse(fs.readFileSync(src, 'utf8')));
  const query = overpassQuery(bbox);
  console.log(`Overpass ${endpoint}\n${query}`);
  // Overpass refuses anonymous clients: it wants a User-Agent that says who is asking, and an Accept header
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'User-Agent': 'slop-vallro/0.1 (Vallromanes simulation; one-off road attribute download)', Accept: 'application/json' },
    body: new URLSearchParams({ data: query })
  });
  if (!res.ok) throw new Error(`Overpass answered HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.elements) || !json.elements.length) throw new Error('Overpass returned no ways');
  fs.mkdirSync(path.join(RAW, 'osm'), { recursive: true });
  const out = path.join(RAW, 'osm/vallromanes.json');
  fs.writeFileSync(out, JSON.stringify(json));
  console.log(`${json.elements.length} ways -> ${out} (${(fs.statSync(out).size / 1e3).toFixed(0)} kB)`);
}

if (import.meta.url === new URL(process.argv[1] || '', 'file://').href) {
  main().catch((err) => { console.error(`fetch-osm failed: ${err.message}`); process.exit(1); });
}
