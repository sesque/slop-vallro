// Experiment: dump the building footprints and a ground-height function sample for registering aerial screenshots (see aerial-colours.py)
import fs from 'node:fs';
import { loadBuildings } from '../../../js/geo/load-geodata.js';
import { fsFetch } from '../fs-fetch.mjs';
const out = process.argv[2];
const { structures } = await loadBuildings('./data/', fsFetch());
const b = structures.filter((s) => s.kind <= 1).map((s) => ({ id: s.id, kind: s.kind, base: s.base, baseMax: s.baseMax, top: s.top, floors: s.floors, roof: s.roof, rise: s.rise, pal: s.pal, look: s.look, ring: Array.from(s.rings[0]) }));
fs.writeFileSync(out, JSON.stringify({ buildings: b }));
console.log(b.length, 'structures');
