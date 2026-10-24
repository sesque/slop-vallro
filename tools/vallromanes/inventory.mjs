// Inventory and validation of the raw BUE 1:1000 shapefiles (plan phase 1).
//   npm run inventory [-- --dir <bue dir>] [--svg <file>] [--strict]
// Prints counts per CAS code, compares them with knowledge.md §3.3, checks the bbox, and writes an SVG preview.
// Throws on NaN coordinates, empty layers or a bbox outside the expected area. Count differences from §3.3
// are reported as DIFF lines; --strict turns them into a non-zero exit code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0, H0, toLocal } from './frame.mjs';
import { readBue } from './read-bue.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_DIR = path.join(root, 'tools/data/vallromanes/raw/bue');
export const DEFAULT_SVG = path.join(root, 'tools/data/vallromanes/raw/inventory-preview.svg');

// knowledge.md §3.1: E 439 509 → 443 384, N 4 596 673 → 4 599 326.
export const EXPECTED_BBOX = { minE: 439509, maxE: 443384, minN: 4596673, maxN: 4599326 };
const BBOX_TOL = 5; // metres

export const LAYER_TOTALS = { poly: 4512, line: 70412, point: 34657, text: 2760 };

// [label, kind, CAS regex, expected count] — knowledge.md §3.3.
export const EXPECTED = [
  ['building', 'poly', /^CON_01pol_PL$/, 2908],
  ['shed', 'poly', /^CON_07pol_PL$/, 836],
  ['porch', 'poly', /^CON_08pol_PL$/, 316],
  ['canopy', 'poly', /^CON_09pol_PL$/, 81],
  ['construction (ES/LS/LN)', 'poly', /^CON_18pol..?_PL$/, 98],
  ['covered tank', 'poly', /^CON_21pol_PL$/, 31],
  ['ruins', 'poly', /^CON_10pol_PL$/, 14],
  ['greenhouse', 'poly', /^CON_11pol_PL$/, 15],
  ['under construction', 'poly', /^CON_06pol_PL$/, 7],
  ['monument', 'poly', /^CON_22pol_PL$/, 5],
  ['cemetery', 'poly', /^CON_31pol_PL$/, 3],
  ['tower', 'poly', /^ENE_03pol_PL$/, 1],
  ['urban block', 'poly', /^CON_13_PL$/, 127],
  ['sand', 'poly', /^VEG_08_PL$/, 69],

  ['contour', 'line', /^ORO_01_LN$/, 18291],
  ['index contour', 'line', /^ORO_02_LN$/, 5146],
  ['form line', 'line', /^MED_06LF_LN$/, 6115],
  ['non-representable contour', 'line', /^MED_03_LN$/, 641],
  ['slope breaks', 'line', /^MED_05/, 29],
  ['paved urban centreline', 'line', /^COM_18_LN$/, 125],
  ['unpaved urban centreline', 'line', /^COM_19_LN$/, 28],
  ['other paved road centreline', 'line', /^COM_23_LN$/, 39],
  ['track centreline', 'line', /^COM_24_LN$/, 363],
  ['kerb', 'line', /^COM_17/, 1402],
  ['pavement limit', 'line', /^COM_03/, 1472],
  ['road edge', 'line', /^COM_02/, 92],
  ['track edge', 'line', /^COM_04/, 1411],
  ['footpath', 'line', /^COM_05/, 118],
  ['hard shoulder (voral)', 'line', /^COM_20/, 38],
  ['bridge', 'line', /^COM_13ES_LN$/, 12],
  ['crash barrier', 'line', /^COM_16_LN$/, 34],
  ['drains and ditches (COM_11 + COM_12)', 'line', /^COM_1[12]/, 57],
  ['facade', 'line', /^CON_01_LN$/, 1245],
  ['party wall', 'line', /^CON_03_LN$/, 54],
  ['volumetric line', 'line', /^CON_04_LN$/, 1831],
  ['overhang', 'line', /^CON_05_LN$/, 51],
  ['roof ridge', 'line', /^CON_29_LN$/, 953],
  ['protruding bay', 'line', /^CON_27_LN$/, 26],
  ['retaining wall', 'line', /^CON_14/, 4295],
  ['wall', 'line', /^CON_15_LN$/, 3551],
  ['garden wall', 'line', /^CON_16_LN$/, 76],
  ['fence', 'line', /^CON_17_LN$/, 74],
  ['wire fence', 'line', /^CON_19_LN$/, 531],
  ['railing', 'line', /^CON_20_LN$/, 110],
  ['stairs', 'line', /^CON_23_LN$/, 11243],
  ['stream', 'line', /^HID_03_LN$/, 75],
  ['flood channel', 'line', /^HID_04_LN$/, 8],
  ['irrigation ditch', 'line', /^HID_08_LN$/, 6],
  ['pond (HID_09 + HID_10)', 'line', /^HID_(09|10)/, 182],
  ['pool outer', 'line', /^HID_11EX_LN$/, 616],
  ['pool inner', 'line', /^HID_11IN_LN$/, 612],
  ['well', 'line', /^HID_12_LN$/, 24],
  ['grate', 'line', /^HID_13_LN$/, 166],
  ['field limit', 'line', /^VEG_01_LN$/, 1134],
  ['woodland', 'line', /^VEG_02_LN$/, 280],
  ['hedge', 'line', /^VEG_04_LN$/, 1555],
  ['scrub', 'line', /^VEG_05_LN$/, 22],
  ['garden', 'line', /^VEG_06_LN$/, 1320],
  ['flowerbed', 'line', /^VEG_07/, 356],
  ['firebreak', 'line', /^VEG_09_LN$/, 38],
  ['power line', 'line', /^ENE_07_LN$/, 32],
  ['tower (line)', 'line', /^ENE_03_LN$/, 1],

  ['isolated tree', 'point', /^VEG_03_PT$/, 11852],
  ['spot height', 'point', /^ORO_03_PT$/, 8402],
  ['building top height', 'point', /^ORO_05_PT$/, 2908],
  ['ridge slope symbol', 'point', /^CON_29_PT$/, 2966],
  ['street lamp', 'point', /^ENE_06_PT/, 1555],
  ['pole', 'point', /^ENE_05_PT/, 664],
  ['pylon', 'point', /^ENE_04_PT/, 415],
  ['gully', 'point', /^HID_14_PT$/, 553],
  ['manhole', 'point', /^REG_01_PT$/, 802],
  ['tree pit', 'point', /^VEG_10_PT$/, 208],
  ['fountain', 'point', /^HID_15_PT$/, 6],
  ['geodetic vertex', 'point', /^CON_26_PT$/, 1],

  ['street names', 'text', /^TOP_05(AV|CR)_TX$/, 139],
  ['house numbers', 'text', /^TOP_07_TX$/, 846],
  ['buildings/farmhouses', 'text', /^TOP_06_TX$/, 86],
  ['facilities', 'text', /^TOP_09EQ_TX$/, 44],
  ['settlements', 'text', /^TOP_08(AL|MU)_TX$/, 12],
  ['places/orography', 'text', /^TOP_11(OP|PD|SD)_TX$/, 19],
  ['hydrography', 'text', /^TOP_12(FD|HP)_TX$/, 10],
  ['index contour labels', 'text', /^ORO_02_TX$/, 331]
];

export function inventory(features) {
  const byCas = new Map();
  for (const f of features) {
    const k = `${f.kind} ${f.cas}`;
    const e = byCas.get(k) || { kind: f.kind, cas: f.cas, desc: f.desc, count: 0 };
    e.count++;
    byCas.set(k, e);
  }
  const byKind = {};
  for (const f of features) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const checks = EXPECTED.map(([label, kind, re, expected]) => {
    let actual = 0;
    for (const e of byCas.values()) if (e.kind === kind && re.test(e.cas)) actual += e.count;
    return { label, kind, expected, actual, ok: actual === expected };
  });
  for (const [kind, expected] of Object.entries(LAYER_TOTALS)) {
    const actual = byKind[kind] || 0;
    checks.push({ label: `TOTAL ${kind}`, kind, expected, actual, ok: actual === expected });
  }
  const names = new Set(features.filter((f) => /^TOP_05(AV|CR)_TX$/.test(f.cas)).map((f) => f.text));
  checks.push({ label: 'distinct street names', kind: 'text', expected: 104, actual: names.size, ok: names.size === 104 });
  const urban = (byCas.get('line COM_18_LN')?.count || 0) + (byCas.get('line COM_19_LN')?.count || 0);
  checks.push({ label: 'urban centrelines (paved + unpaved)', kind: 'line', expected: 153, actual: urban, ok: urban === 153 });
  return { byCas: [...byCas.values()], byKind, checks };
}

// Bounding box in raw UTM plus the Z range, throwing on anything non-finite. Text points carry Z = 0 and are
// excluded from the Z statistics.
export function bounds(features) {
  const b = { minE: Infinity, maxE: -Infinity, minN: Infinity, maxN: -Infinity, minH: Infinity, maxH: -Infinity, zeroZ: 0 };
  for (const f of features) {
    for (const part of f.parts) {
      for (const [e, n, h] of part) {
        if (!Number.isFinite(e) || !Number.isFinite(n) || !Number.isFinite(h)) throw new Error(`Non-finite coordinate in ${f.cas}`);
        if (e < b.minE) b.minE = e;
        if (e > b.maxE) b.maxE = e;
        if (n < b.minN) b.minN = n;
        if (n > b.maxN) b.maxN = n;
        if (f.kind === 'text') continue;
        if (h === 0) { b.zeroZ++; continue; }
        if (h < b.minH) b.minH = h;
        if (h > b.maxH) b.maxH = h;
      }
    }
  }
  return b;
}

export function validate(features, b) {
  if (!features.length) throw new Error('No features read');
  const kinds = new Set(features.map((f) => f.kind));
  for (const k of Object.keys(LAYER_TOTALS)) if (!kinds.has(k)) throw new Error(`Layer "${k}" is empty`);
  const x = EXPECTED_BBOX;
  if (b.minE < x.minE - BBOX_TOL || b.maxE > x.maxE + BBOX_TOL || b.minN < x.minN - BBOX_TOL || b.maxN > x.maxN + BBOX_TOL) {
    throw new Error(`Bbox out of bounds: E ${b.minE.toFixed(1)}..${b.maxE.toFixed(1)}, N ${b.minN.toFixed(1)}..${b.maxN.toFixed(1)}`);
  }
  if (b.minH - H0 < 0) throw new Error(`Height ${b.minH.toFixed(2)} m is below H0 = ${H0} m (local y would be negative)`);
}

export function previewSvg(features, b) {
  const w = b.maxE - b.minE;
  const h = b.maxN - b.minN;
  const px = (e) => (e - b.minE).toFixed(1);
  const py = (n) => (b.maxN - n).toFixed(1);
  const path = (part, close) => 'M' + part.map(([e, n]) => `${px(e)} ${py(n)}`).join('L') + (close ? 'Z' : '');
  const layer = (re, kind, attrs, close) => {
    const d = features.filter((f) => f.kind === kind && re.test(f.cas)).map((f) => f.parts.map((p) => path(p, close)).join('')).join('');
    return `<path d="${d}" ${attrs}/>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" width="${(w / 2).toFixed(0)}" height="${(h / 2).toFixed(0)}">
<rect width="100%" height="100%" fill="#f4f1ea"/>
${layer(/^ORO_02_LN$/, 'line', 'fill="none" stroke="#c9a77c" stroke-width="0.6"')}
${layer(/^HID_03_LN$/, 'line', 'fill="none" stroke="#3b82c4" stroke-width="1.2"')}
${layer(/^COM_17/, 'line', 'fill="none" stroke="#888" stroke-width="0.4"')}
${layer(/^CON_01pol_PL$/, 'poly', 'fill="#b5543f" stroke="none"', true)}
${layer(/^COM_(18|19|23)_LN$/, 'line', 'fill="none" stroke="#222" stroke-width="1"')}
</svg>
`;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dir = path.resolve(arg('--dir') || DEFAULT_DIR);
  const svgPath = path.resolve(arg('--svg') || DEFAULT_SVG);
  const strict = process.argv.includes('--strict');
  if (!fs.existsSync(dir)) throw new Error(`BUE directory not found: ${dir}`);

  const features = readBue(dir);
  const b = bounds(features);
  validate(features, b);
  const inv = inventory(features);

  console.log(`BUE inventory: ${dir}`);
  console.log(`features: ${features.length} (${Object.entries(inv.byKind).map(([k, v]) => `${k} ${v}`).join(', ')})\n`);
  console.log('Per CAS code:');
  for (const e of inv.byCas.sort((a, c) => a.kind.localeCompare(c.kind) || a.cas.localeCompare(c.cas))) {
    console.log(`  ${e.kind.padEnd(5)} ${e.cas.padEnd(16)} ${String(e.count).padStart(6)}  ${e.desc}`);
  }
  console.log(`\nBbox (EPSG:25831): E ${b.minE.toFixed(1)} → ${b.maxE.toFixed(1)}, N ${b.minN.toFixed(1)} → ${b.maxN.toFixed(1)} ` +
    `(${(b.maxE - b.minE).toFixed(0)} × ${(b.maxN - b.minN).toFixed(0)} m)`);
  const [x0, , z0] = toLocal(b.minE, b.maxN);
  const [x1, , z1] = toLocal(b.maxE, b.minN);
  console.log(`Local frame (E0 ${E0}, N0 ${N0}, H0 ${H0}): x ${x0.toFixed(1)} → ${x1.toFixed(1)}, z ${z0.toFixed(1)} → ${z1.toFixed(1)}`);
  console.log(`Height range: ${b.minH.toFixed(2)} → ${b.maxH.toFixed(2)} m (${b.zeroZ} non-text vertices with Z = 0)\n`);

  const bad = inv.checks.filter((c) => !c.ok);
  console.log(`Comparison with knowledge.md §3.3: ${inv.checks.length - bad.length}/${inv.checks.length} match`);
  for (const c of bad) console.log(`  DIFF ${c.kind} ${c.label}: expected ${c.expected}, found ${c.actual}`);

  fs.mkdirSync(path.dirname(svgPath), { recursive: true });
  fs.writeFileSync(svgPath, previewSvg(features, b));
  console.log(`\nPreview written to ${svgPath}`);
  if (strict && bad.length) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`inventory failed: ${err.message}`);
    process.exit(1);
  });
}
