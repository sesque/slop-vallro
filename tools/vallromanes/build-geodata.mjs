// Runs every bake stage in order (boundary, roads, terrain with the roads burned in, buildings) and writes
// data/manifest.json (spec §5.8): frame, counts, file sizes and hashes.
//   npm run geodata
// Stages needing raw downloads (tools/data/vallromanes/raw) fail loudly if a source is missing. The DTM/DSM windows
// are fetched separately with fetch-icgc-dtm.mjs (network) and are not part of this run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CRS, E0, H0, N0 } from './frame.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stages = ['build-boundary.mjs', 'build-roads.mjs', 'build-terrain.mjs', 'build-buildings.mjs'];

for (const stage of stages) {
  console.log(`\n=== ${stage} ===`);
  const r = spawnSync(process.execPath, [path.join(root, 'tools/vallromanes', stage)], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) {
    console.error(`\ngeodata failed in ${stage}`);
    process.exit(r.status || 1);
  }
}

const files = ['boundary.json', 'roads.json', 'terrain.json', 'terrain.bin', 'buildings.json', 'buildings.bin'];
const manifestFiles = {};
for (const f of files) {
  const buf = fs.readFileSync(path.join(root, 'data', f));
  manifestFiles[f] = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
const terrain = JSON.parse(fs.readFileSync(path.join(root, 'data/terrain.json'), 'utf8'));
const buildings = JSON.parse(fs.readFileSync(path.join(root, 'data/buildings.json'), 'utf8'));
const boundary = JSON.parse(fs.readFileSync(path.join(root, 'data/boundary.json'), 'utf8'));
const roads = JSON.parse(fs.readFileSync(path.join(root, 'data/roads.json'), 'utf8'));
const manifest = {
  version: 1,
  frame: { E0, N0, H0, crs: CRS },
  municipality: { ine: boundary.ine, name: boundary.name, areaKm2: boundary.areaKm2 },
  terrainBounds: terrain.bounds,
  counts: { structures: buildings.count, roadEdges: roads.edges.length, terrainTiers: terrain.tiers.length },
  files: manifestFiles,
  attribution: [
    'Cartografia topogràfica urbana 1:1000 © Diputació de Barcelona',
    '© Institut Cartogràfic i Geològic de Catalunya (ICGC), CC BY 4.0'
  ]
};
fs.writeFileSync(path.join(root, 'data/manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nwritten data/manifest.json (${Object.values(manifestFiles).reduce((s, f) => s + f.bytes, 0) / 1e6} MB of data)`);
