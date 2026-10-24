// Bakes the stair flights (spec §5.5, phase 5): the survey's step lines grouped into flights -> data/stairs.json.
//   node tools/vallromanes/build-stairs.mjs
// Steps carry their own heights, so this stage needs no terrain; build-terrain.mjs lowers the ground under every flight.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0, H0, toLocal } from './frame.mjs';
import { readBue } from './read-bue.mjs';
import { groupStairs } from './stairs-group.mjs';
import { stableId } from './build-buildings.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');
const r2 = (v) => Math.round(v * 100) / 100;

export function stepLines(features) {
  const steps = [];
  for (const f of features) {
    if (f.kind !== 'line' || f.cas !== 'CON_23_LN') continue;
    for (const part of f.parts) {
      // A curved step edge is approximated by its chord
      const a = part[0], b = part[part.length - 1];
      steps.push({ ax: a[0], az: a[2], bx: b[0], bz: b[2], z: (a[1] + b[1]) / 2 });
    }
  }
  return steps;
}

export function bakeStairs(features) {
  const steps = stepLines(features);
  const flights = groupStairs(steps);
  const records = flights.map((f) => {
    const first = f.steps[0];
    return {
      id: stableId('stairs', [Math.round(first.ax * 100), Math.round(first.az * 100), Math.round(first.z * 100), f.steps.length]),
      climb: [r2(f.climb[0]), r2(f.climb[1])], width: r2(f.width), rise: r2(f.rise),
      steps: f.steps.map((s) => [r2(s.ax), r2(s.az), r2(s.bx), r2(s.bz), r2(s.z)])
    };
  });
  return { steps, records };
}

function main() {
  const features = readBue(path.join(RAW, 'bue'), { transform: toLocal });
  const { steps, records } = bakeStairs(features);
  if (!records.length) throw new Error('No stair flights found');
  const inFlights = records.reduce((s, r) => s + r.steps.length, 0);
  const sizes = records.map((r) => r.steps.length).sort((a, b) => a - b);
  console.log(`Stairs: ${steps.length} step lines -> ${records.length} flights holding ${inFlights} steps (${steps.length - inFlights} lone lines dropped)`);
  console.log(`  steps per flight P50 ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes[sizes.length - 1]}; rise P50 ${records.map((r) => r.rise).sort((a, b) => a - b)[Math.floor(records.length / 2)].toFixed(2)} m; width P50 ${records.map((r) => r.width).sort((a, b) => a - b)[Math.floor(records.length / 2)].toFixed(2)} m`);
  if (new Set(records.map((r) => r.id)).size !== records.length) throw new Error('Stair ids are not unique');
  for (const r of records) if (![r.width, r.rise, ...r.climb, ...r.steps.flat()].every(Number.isFinite)) throw new Error(`Non-finite stair data in ${r.id}`);
  const out = { frame: { E0, N0, H0, crs: 'EPSG:25831' }, source: 'Diputació de Barcelona BUE 1:1000 (CON_23 step lines)', count: records.length, flights: records };
  fs.writeFileSync(path.join(root, 'data/stairs.json'), JSON.stringify(out));
  console.log(`written data/stairs.json (${(fs.statSync(path.join(root, 'data/stairs.json')).size / 1e3).toFixed(0)} kB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (err) { console.error(`build-stairs failed: ${err.message}`); process.exit(1); }
}
