// Downloads the named shops, restaurants, services and tourism places inside the municipality's bounding box from the Overpass API (ODbL).
//   node tools/vallromanes/fetch-osm-pois.mjs [--endpoint https://overpass-api.de/api/interpreter]
// Writes tools/data/vallromanes/raw/osm/pois.json (the Overpass response, with a centre for every way). A few tens of kB.
// Credit: © OpenStreetMap contributors, ODbL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundingBoxOf } from './fetch-osm.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');

export function poiQuery(b) {
  const box = `(${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)})`;
  return `[out:json][timeout:90];(nwr["name"]["shop"]${box};nwr["name"]["amenity"]${box};nwr["name"]["craft"]${box};nwr["name"]["office"]${box};nwr["name"]["tourism"]${box};nwr["name"]["leisure"]${box};);out center tags;`;
}

async function main() {
  const i = process.argv.indexOf('--endpoint');
  const endpoint = i >= 0 ? process.argv[i + 1] : 'https://overpass-api.de/api/interpreter';
  const src = path.join(RAW, 'boundary/dl/divisions-administratives-v2r2-municipis-5000-20260120.json');
  const query = poiQuery(boundingBoxOf(JSON.parse(fs.readFileSync(src, 'utf8'))));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'User-Agent': 'slop-vallro/0.1 (Vallromanes simulation; one-off shop names download)', Accept: 'application/json' },
    body: new URLSearchParams({ data: query })
  });
  if (!res.ok) throw new Error(`Overpass answered HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.elements)) throw new Error('Overpass returned no elements');
  fs.mkdirSync(path.join(RAW, 'osm'), { recursive: true });
  const out = path.join(RAW, 'osm/pois.json');
  fs.writeFileSync(out, JSON.stringify(json));
  console.log(`${json.elements.length} named places -> ${out} (${(fs.statSync(out).size / 1e3).toFixed(0)} kB)`);
}

if (import.meta.url === new URL(process.argv[1] || '', 'file://').href) {
  main().catch((err) => { console.error(`fetch-osm-pois failed: ${err.message}`); process.exit(1); });
}
