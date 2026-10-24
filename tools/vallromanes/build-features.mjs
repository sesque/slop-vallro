// Bakes the linear and area features (spec §5.5, phase 5): walls, retaining walls, hedges, fences, railings, crash
// barriers, streams, bridges and the pools and ponds. Walls and the like become polylines with a base and a top height per
// vertex (the survey Z where it is plausible, a kind-specific default otherwise); water bodies become rings.
//   node tools/vallromanes/build-features.mjs
// Writes data/features.json and data/features.bin (Int32: x, z, base, top in centimetres, four per vertex).
// Needs the baked terrain (build-terrain.mjs) for the ground.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0, H0, toLocal } from './frame.mjs';
import { readBue } from './read-bue.mjs';
import { fsFetch } from './fs-fetch.mjs';
import { stableId } from './build-buildings.mjs';
import { simplify3D } from './build-roads.mjs';
import { loadTerrain } from '../../js/geo/load-geodata.js';
import { centroid, pointInRings, reverseRing, signedArea, simplifyRing } from '../../js/geo/polygon.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');

// mode 'top': the line's Z is the top (kept when it lies within [lo, hi] above the ground, else ground + def);
// 'retaining': Z is the crest, the base is the lower ground on either side; 'fixed': Z ignored, ground + def;
// 'ground': follows the ground; 'deck': Z is the deck top. `step` = vertex spacing after densifying (m).
export const LINE_KINDS = [
  { name: 'wall', re: /^CON_15_LN$/, mode: 'top', lo: 0.5, hi: 4.5, def: 1.8, thick: 0.25, step: 3 },
  { name: 'gardenWall', re: /^CON_16_LN$/, mode: 'top', lo: 0.8, hi: 4, def: 2.0, thick: 0.25, step: 3 },
  { name: 'retaining', re: /^CON_14L[NS]_LN$/, mode: 'retaining', lo: 0.4, hi: 7, def: 1.5, thick: 0.45, step: 3 },
  { name: 'hedge', re: /^VEG_04_LN$/, mode: 'top', lo: 0.5, hi: 2.8, def: 1.6, thick: 0.8, step: 3 },
  { name: 'fence', re: /^CON_17_LN$/, mode: 'top', lo: 0.5, hi: 2.5, def: 1.2, thick: 0.05, step: 4 },
  { name: 'wire', re: /^CON_19_LN$/, mode: 'fixed', def: 1.4, thick: 0.05, step: 4 },
  { name: 'railing', re: /^CON_20_LN$/, mode: 'top', lo: 0.5, hi: 1.6, def: 1.0, thick: 0.05, step: 3 },
  { name: 'barrier', re: /^COM_16_LN$/, mode: 'top', lo: 0.4, hi: 1.0, def: 0.75, thick: 0.1, step: 4 },
  { name: 'stream', re: /^HID_03_LN$/, mode: 'ground', width: 1.8, step: 4 },
  { name: 'ditch', re: /^HID_08_LN$/, mode: 'ground', width: 1.0, step: 4 },
  { name: 'bridge', re: /^COM_13ES_LN$/, mode: 'deck', width: 5, thick: 0.5, step: 3 }
];
const EMBED = 0.25; // walls start this far below the ground
const SIDE_PROBE = 1.5; // m, where a retaining wall's two ground levels are sampled
const MIN_LINE = 0.3; // m, shorter lines are survey artefacts
const SIMPLIFY = 0.08; // m, before densifying: the survey digitises curves every 1 m or less
const JOIN = 0.3; // m, outline pieces whose ends are this close belong to one ring

export const lineKindOf = (cas) => LINE_KINDS.findIndex((k) => k.re.test(cas));

// Kinds that stop where a flight of steps crosses them: a stair goes through the wall, hedge or fence beside it
const CLIPPED = new Set(['wall', 'gardenWall', 'retaining', 'hedge', 'fence', 'wire', 'railing']);
const CORRIDOR_MARGIN = { before: 2.0, after: 2.0, side: 0.25 }; // m beyond the first step, the last step and each side

/** Rectangles around the flights (data/stairs.json) with a point test; `flights` have steps [[ax, az, bx, bz, y]] and climb. */
export function stairCorridors(flights) {
  const rects = flights.map((f) => {
    const a = f.steps[0], b = f.steps[f.steps.length - 1];
    const c0 = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2], c1 = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const length = (c1[0] - c0[0]) * f.climb[0] + (c1[1] - c0[1]) * f.climb[1];
    return { c0, climb: f.climb, from: -CORRIDOR_MARGIN.before, to: length + CORRIDOR_MARGIN.after, half: f.width / 2 + CORRIDOR_MARGIN.side };
  });
  const CELL = 8;
  const grid = new Map();
  rects.forEach((r, i) => {
    const reach = Math.max(r.to, -r.from) + r.half;
    for (let ci = Math.floor((r.c0[0] - reach) / CELL); ci <= Math.floor((r.c0[0] + reach) / CELL); ci++) {
      for (let cj = Math.floor((r.c0[1] - reach) / CELL); cj <= Math.floor((r.c0[1] + reach) / CELL); cj++) {
        const k = `${ci},${cj}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  return {
    contains(x, z) {
      for (const i of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
        const r = rects[i];
        const dx = x - r.c0[0], dz = z - r.c0[1];
        const s = dx * r.climb[0] + dz * r.climb[1], t = -dx * r.climb[1] + dz * r.climb[0];
        if (s >= r.from && s <= r.to && Math.abs(t) <= r.half) return true;
      }
      return false;
    },
    count: rects.length
  };
}

// The runs of `pts` that lie outside the corridors: the line is cut into half-metre pieces and those whose middle is
// inside a corridor are dropped. Runs shorter than MIN_LINE are discarded.
export function clipLine(pts, corridors) {
  const fine = densify(pts, 0.5);
  const runs = [];
  let run = null;
  for (let i = 0; i + 1 < fine.length; i++) {
    const a = fine[i], b = fine[i + 1];
    if (corridors.contains((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) { run = null; continue; }
    if (!run) { run = [a]; runs.push(run); }
    run.push(b);
  }
  return runs.filter((r) => r.length >= 2 && lengthOf(r) >= MIN_LINE);
}

// Vertices every `step` metres at most; heights are interpolated linearly
export function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return out;
}

const lengthOf = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

// Base and top (local y) for each vertex of a line of `kind`; `pts` are [x, z, zSurvey(y)], `ground(x, z)` the terrain
export function verticalProfile(kind, pts, ground) {
  return pts.map((p, i) => {
    const g = ground(p[0], p[1]);
    if (kind.mode === 'ground') return [g, g];
    if (kind.mode === 'deck') return [p[2] - kind.thick, p[2]];
    if (kind.mode === 'fixed') return [g - EMBED, g + kind.def];
    if (kind.mode === 'retaining') {
      const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1;
      const nx = -(next[1] - prev[1]) / l, nz = (next[0] - prev[0]) / l;
      const low = Math.min(ground(p[0] + nx * SIDE_PROBE, p[1] + nz * SIDE_PROBE), ground(p[0] - nx * SIDE_PROBE, p[1] - nz * SIDE_PROBE), g);
      const top = p[2];
      return top - low >= kind.lo && top - low <= kind.hi ? [low - EMBED, top] : [low - EMBED, low + kind.def];
    }
    const top = p[2];
    return top - g >= kind.lo && top - g <= kind.hi ? [g - EMBED, top] : [g - EMBED, g + kind.def];
  });
}

// Pairs outer (EX) and inner (IN) rings: each inner ring goes with the smallest outer ring that contains its centroid
export function pairRings(outers, inners) {
  const used = new Set();
  return outers.map((o) => {
    let best = -1, bestArea = Infinity;
    inners.forEach((inner, i) => {
      if (used.has(i)) return;
      const [cx, cz] = centroid(inner.ring);
      if (pointInRings(cx, cz, [o.ring]) && Math.abs(signedArea(o.ring)) < bestArea) { best = i; bestArea = Math.abs(signedArea(o.ring)); }
    });
    if (best >= 0) used.add(best);
    return { outer: o, inner: best >= 0 ? inners[best] : null };
  });
}

// Chains open polylines whose ends meet (within JOIN) into longer ones; returns the chains, closed or not
export function joinChains(parts, tol = JOIN) {
  const chains = parts.map((p) => p.slice());
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) {
      const a = chains[i];
      if (a.length > 3 && near(a[0], a[a.length - 1])) continue; // already closed
      for (let j = i + 1; j < chains.length; j++) {
        const b = chains[j];
        let joined = null;
        if (near(a[a.length - 1], b[0])) joined = a.concat(b.slice(1));
        else if (near(a[a.length - 1], b[b.length - 1])) joined = a.concat(b.slice(0, -1).reverse());
        else if (near(a[0], b[b.length - 1])) joined = b.concat(a.slice(1));
        else if (near(a[0], b[0])) joined = b.slice().reverse().concat(a.slice(1));
        if (joined) {
          chains.splice(j, 1);
          chains[i] = joined;
          merged = true;
          break outer;
        }
      }
    }
  }
  return chains;
}

function closedRing(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  if (pts.length < 4 || Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.3) return null;
  const flat = simplifyRing(pts.slice(0, -1).flatMap((p) => [p[0], p[1]]), 0.1);
  if (flat.length < 6) return null;
  return signedArea(flat) >= 0 ? flat : reverseRing(flat);
}

export function bakeFeatures(features, ground, corridors = null) {
  const lines = [];
  const verts = [];
  const counts = {};
  const rings = { pool: { outer: [], inner: [] }, pond: { outer: [], inner: [] } };
  let skipped = 0;
  const waterParts = { 'pool.outer': [], 'pool.inner': [], 'pond.outer': [], 'pond.inner': [] };
  for (const f of features) {
    if (f.kind !== 'line') continue;
    const waterRole = /^HID_11EX_LN$/.test(f.cas) ? ['pool', 'outer'] : /^HID_11IN_LN$/.test(f.cas) ? ['pool', 'inner']
      : /^HID_09EX/.test(f.cas) ? ['pond', 'outer'] : /^HID_09IN/.test(f.cas) ? ['pond', 'inner']
      : /^HID_10_LN$/.test(f.cas) ? ['pond', 'outer'] : null;
    if (waterRole) {
      for (const part of f.parts) waterParts[waterRole.join('.')].push(part.map(([x, y, z]) => [x, z, y]));
      continue;
    }
    const ki = lineKindOf(f.cas);
    if (ki < 0) continue;
    const kind = LINE_KINDS[ki];
    for (const part of f.parts) {
      const raw = part.map(([x, y, z]) => [x, z, y]);
      if (raw.length < 2 || lengthOf(raw) < MIN_LINE) { skipped++; continue; }
      const simple = simplify3D(raw, SIMPLIFY);
      // Lines that cross a flight of steps are cut around it; the pieces keep their own ids
      const pieces = corridors && CLIPPED.has(kind.name) ? clipLine(simple, corridors).map((r) => simplify3D(r, SIMPLIFY)) : [simple];
      pieces.forEach((piece, pi) => {
        const pts = densify(piece, kind.step);
        const prof = verticalProfile(kind, pts, ground);
        const o = verts.length / 4;
        pts.forEach((p, i) => verts.push(Math.round(p[0] * 100), Math.round(p[1] * 100), Math.round(prof[i][0] * 100), Math.round(prof[i][1] * 100)));
        lines.push({ id: stableId(f.cas + (pi ? `#${pi}` : ''), [Math.round(raw[0][0] * 100), Math.round(raw[0][1] * 100), Math.round(lengthOf(raw) * 100)]), kind: ki, o, n: pts.length });
        counts[kind.name] = (counts[kind.name] || 0) + 1;
      });
    }
  }
  // Outlines arrive in pieces: chain them into rings
  for (const [key, parts] of Object.entries(waterParts)) {
    const [type, role] = key.split('.');
    for (const chain of joinChains(parts)) {
      const ring = closedRing(chain);
      if (!ring) { skipped++; continue; }
      rings[type][role].push({ ring, y: chain.reduce((s, p) => s + p[2], 0) / chain.length, cas: key });
    }
  }
  // Water bodies: pool and pond rings with their inner margin; the level is the survey height of the outer ring
  const water = [];
  for (const type of ['pool', 'pond']) {
    for (const { outer, inner } of pairRings(rings[type].outer, rings[type].inner)) {
      water.push({
        id: stableId(type, outer.ring.map((v) => Math.round(v * 100))), type, y: +(outer.y).toFixed(2),
        outer: outer.ring.map((v) => Math.round(v * 100)), inner: inner ? inner.ring.map((v) => Math.round(v * 100)) : null
      });
    }
  }
  return { lines, verts: Int32Array.from(verts), water, counts, skipped };
}

async function main() {
  const { sampler, meta } = await loadTerrain('./data/', fsFetch());
  if (meta.frame.H0 !== H0 || meta.frame.E0 !== E0 || meta.frame.N0 !== N0) throw new Error('data/terrain.json was baked with a different frame; rerun build-terrain.mjs');
  const features = readBue(path.join(RAW, 'bue'), { transform: toLocal });
  const stairsFile = path.join(root, 'data/stairs.json');
  const corridors = fs.existsSync(stairsFile) ? stairCorridors(JSON.parse(fs.readFileSync(stairsFile, 'utf8')).flights) : null;
  if (!corridors) console.warn('WARNING: data/stairs.json not found, walls are not cut where stairs cross them (run build-stairs.mjs first)');
  const { lines, verts, water, counts, skipped } = bakeFeatures(features, (x, z) => sampler.heightAt(x, z), corridors);
  if (!lines.length) throw new Error('No linear features baked');
  if (new Set(lines.map((l) => l.id)).size !== lines.length) {
    const seen = new Set();
    for (const l of lines) { let id = l.id; for (let n = 1; seen.has(id); n++) id = stableId(l.id, [n]); l.id = id; seen.add(id); }
  }
  if (new Set(water.map((w) => w.id)).size !== water.length) throw new Error('Water body ids are not unique');
  for (const v of verts) if (!Number.isInteger(v)) throw new Error('Non-integer feature vertex');
  if (corridors) console.log(`Cut around ${corridors.count} stair flights`);
  console.log(`Linear features: ${lines.length} lines, ${verts.length / 4} vertices (${skipped} slivers/open rings skipped)`);
  for (const k of LINE_KINDS) console.log(`  ${k.name.padEnd(11)} ${String(counts[k.name] || 0).padStart(5)}`);
  const pools = water.filter((w) => w.type === 'pool'), ponds = water.filter((w) => w.type === 'pond');
  console.log(`Water bodies: ${pools.length} pools (${pools.filter((p) => p.inner).length} with an inner margin), ${ponds.length} ponds (${ponds.filter((p) => p.inner).length} with an inner margin)`);
  const tall = []; for (const l of lines) { const k = LINE_KINDS[l.kind]; if (k.mode === 'retaining' || k.mode === 'top') for (let i = 0; i < l.n; i++) tall.push((verts[(l.o + i) * 4 + 3] - verts[(l.o + i) * 4 + 2]) / 100); }
  tall.sort((a, b) => a - b);
  console.log(`Wall height base->top over all vertices: P10 ${tall[Math.floor(tall.length * 0.1)].toFixed(1)}  P50 ${tall[Math.floor(tall.length * 0.5)].toFixed(1)}  P90 ${tall[Math.floor(tall.length * 0.9)].toFixed(1)}  max ${tall[tall.length - 1].toFixed(1)} m`);
  const out = {
    frame: { E0, N0, H0, crs: 'EPSG:25831' }, source: 'Diputació de Barcelona BUE 1:1000 (CON_14-17/19/20, VEG_04, HID_03/08/09/10/11, COM_13/16)',
    kinds: LINE_KINDS.map((k) => ({ name: k.name, thick: k.thick || 0, width: k.width || 0 })), vertexEncoding: 'int32-cm-x-z-base-top',
    count: lines.length, lines, water
  };
  fs.writeFileSync(path.join(root, 'data/features.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(root, 'data/features.bin'), Buffer.from(verts.buffer, verts.byteOffset, verts.byteLength));
  console.log(`written data/features.json + features.bin (${((fs.statSync(path.join(root, 'data/features.json')).size + verts.byteLength) / 1e6).toFixed(2)} MB raw)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(`build-features failed: ${err.message}`); process.exit(1); });
}
