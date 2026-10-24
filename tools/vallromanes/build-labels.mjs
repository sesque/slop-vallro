// Bakes the text labels (spec §5.7, phase 6): places, street names, house numbers and the teleport destinations.
//   node tools/vallromanes/build-labels.mjs
// Reads the BUE text points (TOP_*), data/roads.json (street names), data/buildings.* (to attach house numbers) and
// data/boundary.json. Writes data/labels.json: { places, streets, numbers, teleports } in the local frame.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0, H0, toLocal } from './frame.mjs';
import { readBue } from './read-bue.mjs';
import { fsFetch } from './fs-fetch.mjs';
import { stableId } from './build-buildings.mjs';
import { loadBoundary, loadBuildings, loadRoads } from '../../js/geo/load-geodata.js';
import { nearestOnRings, pointInRings } from '../../js/geo/polygon.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');

export const PLACE_KINDS = [
  { kind: 'settlement', re: /^TOP_08(AL|MU)_TX$/ },
  { kind: 'masia', re: /^TOP_06_TX$/ },
  { kind: 'terrain', re: /^TOP_11(OP|PD|SD)_TX$/ },
  { kind: 'water', re: /^TOP_12(FD|HP)_TX$/ },
  { kind: 'facility', re: /^TOP_09EQ_TX$/ },
  { kind: 'business', re: /^TOP_10EM_TX$/ },
  { kind: 'road', re: /^TOP_01CL_TX$/ }
];
const SAME_NAME = 80; // m: labels with one name this close are one place
const NUMBER_REACH = 14; // m from a house number to the building it belongs to
const STREET_MIN_EDGE = 40; // m: shorter edges carry no street label
const STREET_GAP = 250; // m between two labels of one street

// The survey writes some names in capitals ("VALLROMANES"): "Vallromanes"
export function titleCase(s) {
  if (s !== s.toUpperCase() || s.length < 2) return s;
  return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

// A terrain name is a hill, a pass or a wood by its first word
export function terrainKind(name) {
  // (JavaScript's \b does not see accented letters as word characters, hence the explicit lookahead)
  const word = (w) => new RegExp(`(^|\\s)${w}(?=[\\s']|$)`, 'iu');
  if (word('bosc').test(name)) return 'wood';
  if (word('(turó|pedró|roca)').test(name)) return 'hill';
  if (word('coll').test(name)) return 'pass';
  if (word('(plana|clot)').test(name)) return 'plain';
  return 'place';
}

export function dedupePlaces(places, gap = SAME_NAME) {
  const out = [];
  for (const p of places) {
    if (!out.some((q) => q.kind === p.kind && q.name.toLowerCase() === p.name.toLowerCase() && Math.hypot(q.x - p.x, q.z - p.z) < gap)) out.push(p);
  }
  return out;
}

export function bakePlaces(texts) {
  const places = [];
  for (const t of texts) {
    const k = PLACE_KINDS.find((p) => p.re.test(t.cas));
    if (!k || !t.text) continue;
    const [x, , z] = t.coords[0];
    let kind = k.kind, name = titleCase(t.text.trim());
    if (kind === 'terrain') kind = terrainKind(name);
    places.push({ id: stableId(`${kind}:${name}`, [Math.round(x * 100), Math.round(z * 100)]), kind, name, x: +x.toFixed(1), z: +z.toFixed(1) });
  }
  return dedupePlaces(places);
}

/** One label per named street at most every `gap` metres, on the middle of edges at least `minEdge` long. */
export function streetLabels(edges, { minEdge = STREET_MIN_EDGE, gap = STREET_GAP } = {}) {
  const byName = new Map();
  for (const e of edges) {
    if (!e.name || (e.cls !== 'urban' && e.cls !== 'road' && e.cls !== 'urbanUnpaved')) continue;
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push(e);
  }
  const labels = [];
  for (const [name, list] of byName) {
    const total = list.reduce((s, e) => s + e.length, 0);
    const placed = [];
    for (const e of [...list].sort((a, b) => b.length - a.length)) {
      if (e.length < minEdge && placed.length) continue;
      // the point at half the arc length
      let acc = 0;
      const half = e.length / 2;
      let x = e.pts[0][0], z = e.pts[0][1], tx = 1, tz = 0;
      for (let i = 0; i + 1 < e.pts.length; i++) {
        const len = Math.hypot(e.pts[i + 1][0] - e.pts[i][0], e.pts[i + 1][1] - e.pts[i][1]);
        if (acc + len >= half || i + 2 === e.pts.length) {
          const t = len > 0 ? Math.min(1, Math.max(0, (half - acc) / len)) : 0;
          x = e.pts[i][0] + t * (e.pts[i + 1][0] - e.pts[i][0]);
          z = e.pts[i][1] + t * (e.pts[i + 1][1] - e.pts[i][1]);
          tx = (e.pts[i + 1][0] - e.pts[i][0]) / (len || 1);
          tz = (e.pts[i + 1][1] - e.pts[i][1]) / (len || 1);
          break;
        }
        acc += len;
      }
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < gap)) continue;
      // text reads left to right: keep the angle within (-90, 90]
      let angle = Math.atan2(tz, tx);
      if (angle > Math.PI / 2) angle -= Math.PI;
      else if (angle <= -Math.PI / 2) angle += Math.PI;
      placed.push({ name, x: +x.toFixed(1), z: +z.toFixed(1), angle: +angle.toFixed(3), length: +e.length.toFixed(0) });
    }
    for (const p of placed) labels.push({ ...p, major: total >= 400 });
  }
  return labels;
}

// A house number belongs to the building its point is inside of, or the nearest one within NUMBER_REACH
export function attachNumbers(texts, structures) {
  const CELL = 24;
  const cells = new Map();
  for (const s of structures) {
    if (s.kindName !== 'building') continue;
    const o = s.rings[0];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
    for (let i = Math.floor((x0 - NUMBER_REACH) / CELL); i <= Math.floor((x1 + NUMBER_REACH) / CELL); i++) for (let j = Math.floor((z0 - NUMBER_REACH) / CELL); j <= Math.floor((z1 + NUMBER_REACH) / CELL); j++) {
      const k = `${i},${j}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(s);
    }
  }
  return texts.map((t) => {
    const [x, , z] = t.coords[0];
    let best = null;
    for (const s of cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
      const d = pointInRings(x, z, [s.rings[0]]) ? 0 : Math.sqrt(nearestOnRings(x, z, [s.rings[0]]).d2);
      if (d <= NUMBER_REACH && (!best || d < best.d)) best = { d, id: s.id };
    }
    return { text: t.text.trim(), x: +x.toFixed(1), z: +z.toFixed(1), building: best ? best.id : null };
  });
}

// The curated destinations: [category, display name, kind of place, name as written in the survey (regex), optional
// pick: 'first' | 'nearest to the centroid of its namesakes' is the default for repeated names]
export const TELEPORTS = [
  ['village', 'Ajuntament', 'facility', /^Ajuntament$/],
  ['village', 'Sant Vicenç', 'masia', /^Sant Vicenç$/],
  ['village', 'Escola Tres Pins', 'facility', /^C\.E\.I\.P Tres Pins$/],
  ['village', 'CAP Vallromanes', 'facility', /^CAP Vallromanes$/],
  ['village', 'Escola Bressol', 'facility', /^Escola Bressol$/],
  ['village', 'Casal', 'facility', /^Casal$/],
  ['village', 'Casal de la Gent Gran', 'facility', /^Casal de la Gent Gran/],
  ['village', 'Cooperativa Agrària', 'facility', /^Cooperativa$/],
  ['leisure', 'Club de Golf Vallromanes', 'facility', /^Club de Golf Vallromanes$/],
  ['leisure', 'Zona Esportiva', 'facility', /^Zona Esportiva$/],
  ['leisure', 'Càmping el Vedado', 'facility', /^Càmping el Vedado$/],
  ['stay', 'Hotel Can Galvany', 'facility', /^Hotel Can Galvany$/],
  ['stay', 'Hotel Mas Salagros', 'facility', /^Hotel Mas Salagros$/],
  ['stay', 'Restaurant Mont-Bell', 'facility', /^Restaurant Mont-Bell$/],
  ['stay', 'Restaurant la Noguera', 'facility', /^Restaurant la Noguera$/],
  ['stay', 'Restaurant Sauló', 'facility', /^Restaurant Sauló$/],
  ['masia', 'Can Corbera', 'masia', /^Can Corbera$/],
  ['masia', 'Can Colomer', 'masia', /^Can Colomer$/],
  ['masia', 'Can Rabassa', 'settlement', /^Can Rabassa$/],
  ['masia', 'Can Tàvec', 'settlement', /^Can Tàvec$/],
  ['masia', 'Can Palau', 'settlement', /^Can Palau$/],
  ['masia', 'Torre Tavernera', 'settlement', /^Torre Tavernera$/],
  ['hill', 'Turó de Can Colomer', 'hill', /^Turó de Can Colomer$/],
  ['hill', 'Turó de Can Rabassa', 'hill', /^Turó de Can Rabassa$/],
  ['hill', 'Turó de Can Tàvec', 'hill', /^Turó de Can Tàvec$/],
  ['hill', "Turó d'en Moreu", 'hill', /^Turó d'en Moreu$/],
  ['hill', 'la Roca Foradada', 'hill', /^la Roca Foradada$/],
  ['hill', 'el Pedró', 'hill', /^el Pedró$/],
  ['hill', 'Coll de Forns', 'pass', /^Coll de Forns$/]
];
export const CATEGORY_LABEL = { village: 'Village', leisure: 'Leisure', stay: 'Stay & eat', masia: 'Farmhouse', hill: 'Hill' };

/**
 * Teleport destinations from the baked places. Names written more than once ("Zona Esportiva") take the first
 * occurrence; `streetNear(x, z)` supplies a nearby street name for the sub-title; `inside(x, z)` keeps them in the municipality.
 */
export function pickTeleports(places, { streetNear = () => null, inside = () => true } = {}) {
  const out = [];
  for (const [category, name, kind, re] of TELEPORTS) {
    const p = places.find((q) => q.kind === kind && re.test(q.name) && inside(q.x, q.z));
    if (!p) continue;
    const street = streetNear(p.x, p.z);
    out.push({ id: stableId(`tp:${name}`, [Math.round(p.x * 100), Math.round(p.z * 100)]), name, category, sub: street ? `near ${street}` : CATEGORY_LABEL[category], x: p.x, z: p.z, heading: Math.PI });
  }
  return out;
}

function nearestStreet(edges) {
  return (x, z, reach = 60) => {
    let best = null;
    for (const e of edges) {
      if (!e.name) continue;
      for (let i = 0; i + 1 < e.pts.length; i++) {
        const ax = e.pts[i][0], az = e.pts[i][1], bx = e.pts[i + 1][0], bz = e.pts[i + 1][1];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
        const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
        if (d <= reach && (!best || d < best.d)) best = { d, name: e.name };
      }
    }
    return best ? best.name : null;
  };
}

async function main() {
  const [boundary, { structures }, roads] = await Promise.all([loadBoundary('./data/', fsFetch()), loadBuildings('./data/', fsFetch()), loadRoads('./data/', fsFetch())]);
  const features = readBue(path.join(RAW, 'bue'), { transform: toLocal });
  const texts = features.filter((f) => f.kind === 'text');
  const inside = (x, z) => pointInRings(x, z, boundary.rings) || [[8, 0], [-8, 0], [0, 8], [0, -8]].some(([dx, dz]) => pointInRings(x + dx, z + dz, boundary.rings));

  const places = bakePlaces(texts).filter((p) => inside(p.x, p.z));
  const streets = streetLabels(roads.edges);
  const numbers = attachNumbers(texts.filter((t) => t.cas === 'TOP_07_TX' && t.text), structures).filter((n) => inside(n.x, n.z));
  const teleports = pickTeleports(places, { streetNear: nearestStreet(roads.edges), inside });
  if (!places.length || !streets.length || !numbers.length || !teleports.length) throw new Error('A label layer is empty');
  for (const l of [...places, ...streets, ...numbers, ...teleports]) if (![l.x, l.z].every(Number.isFinite)) throw new Error('Non-finite label position');
  if (new Set(places.map((p) => p.id)).size !== places.length) throw new Error('Place ids are not unique');
  if (!teleports.some((t) => t.name === 'Ajuntament')) throw new Error('The Ajuntament teleport is missing');

  const count = (k) => places.filter((p) => p.kind === k).length;
  console.log(`Places: ${places.length} (${['settlement', 'masia', 'hill', 'pass', 'wood', 'plain', 'place', 'water', 'facility', 'business', 'road'].map((k) => `${k} ${count(k)}`).join(', ')})`);
  console.log(`Street labels: ${streets.length} for ${new Set(streets.map((s) => s.name)).size} streets (${new Set(streets.filter((s) => s.major).map((s) => s.name)).size} major)`);
  console.log(`House numbers: ${numbers.length}, ${numbers.filter((n) => n.building).length} attached to a building`);
  console.log(`Teleports: ${teleports.length} (${Object.keys(CATEGORY_LABEL).map((c) => `${c} ${teleports.filter((t) => t.category === c).length}`).join(', ')})`);
  const missing = TELEPORTS.filter(([, name]) => !teleports.some((t) => t.name === name)).map(([, name]) => name);
  if (missing.length) console.warn(`WARNING: no teleport for ${missing.join(', ')}`);

  fs.writeFileSync(path.join(root, 'data/labels.json'), JSON.stringify({
    frame: { E0, N0, H0, crs: 'EPSG:25831' }, source: 'Diputació de Barcelona BUE 1:1000 (TOP_* texts), data/roads.json names',
    categories: CATEGORY_LABEL, places, streets, numbers, teleports
  }));
  console.log(`written data/labels.json (${(fs.statSync(path.join(root, 'data/labels.json')).size / 1e3).toFixed(0)} kB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(`build-labels failed: ${err.message}`); process.exit(1); });
}
