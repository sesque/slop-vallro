// Bakes the fascia signs of the town's shops (phase 11) -> data/shops.json.
//   node tools/vallromanes/build-shops.mjs
// Reads tools/data/vallromanes/overrides/shops.json (names, sectors and where each one is: a survey place, a point in degrees or a street
// and house number), finds the building of each, picks the wall that faces the street and puts the sign above the shopfront.
// Needs data/buildings.*, data/labels.json, data/roads.json and data/terrain.* (run the other stages first).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fsFetch } from './fs-fetch.mjs';
import { lonLatToLocal } from './utm.mjs';
import { loadBuildings, loadRoads, loadTerrain } from '../../js/geo/load-geodata.js';
import { createRoadIndex } from '../../js/geo/road-index.js';
import { pointInRings, signedArea } from '../../js/geo/polygon.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const SIGN_HEIGHT = 0.75;
export const SIGN_ABOVE_GROUND = 3.1; // m from the pavement to the bottom of the sign: over the shopfront door
const REACH = 20; // m: a point this near a footprint belongs to it

function distanceToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return { d: Math.hypot(px - ax - dx * t, pz - az - dz * t), t };
}

/** The building (kind 0) that contains (x, z), else the nearest one within REACH metres; null when there is none. */
export function findBuilding(structures, x, z) {
  let best = null;
  for (const s of structures) {
    if (s.kind !== 0) continue;
    if (pointInRings(x, z, s.rings)) return s;
    const r = s.rings[0];
    for (let i = 0; i < r.length; i += 2) {
      const j = (i + 2) % r.length;
      const { d } = distanceToSegment(x, z, r[i], r[i + 1], r[j], r[j + 1]);
      if (d < REACH && (!best || d < best.d)) best = { s, d };
    }
  }
  return best ? best.s : null;
}

/** The point an `at` entry names, in the local frame, or null. `ctx` = { places, numbers, streetAt(x, z) }. */
export function resolvePoint(at, ctx) {
  if (at.place) {
    const hits = ctx.places.filter((p) => p.name === at.place);
    const p = hits[at.index || 0];
    return p ? { x: p.x, z: p.z } : null;
  }
  if (Number.isFinite(at.lat) && Number.isFinite(at.lon)) return lonLatToLocal(at.lon, at.lat);
  if (at.street) {
    const wanted = String(at.number);
    const covers = (text) => String(text).split('-').map((t) => parseInt(t, 10)).filter(Number.isFinite).some((n) => String(n) === wanted) || text === wanted;
    const onStreet = ctx.numbers.filter((n) => ctx.streetAt(n.x, n.z) === at.street);
    const hit = onStreet.find((n) => covers(n.text));
    if (hit) return { x: hit.x, z: hit.z, building: hit.building || null };
    // the survey does not number every door: place the number between its neighbours on the same side of the street (same parity)
    const want = parseInt(wanted, 10);
    const same = onStreet.map((n) => ({ n: parseInt(n.text, 10), p: n })).filter((e) => Number.isFinite(e.n) && e.n % 2 === want % 2);
    const lo = same.filter((e) => e.n < want).sort((a, b) => b.n - a.n)[0], hi = same.filter((e) => e.n > want).sort((a, b) => a.n - b.n)[0];
    if (lo && hi && Math.hypot(lo.p.x - hi.p.x, lo.p.z - hi.p.z) < 160) {
      const t = (want - lo.n) / (hi.n - lo.n);
      return { x: lo.p.x + (hi.p.x - lo.p.x) * t, z: lo.p.z + (hi.p.z - lo.p.z) * t, estimated: true };
    }
    return null;
  }
  return null;
}

/**
 * The sign of `name` for `building` near `anchor`: on the footprint's wall nearest the anchor (the street side, since the anchor is the
 * door or the street number), centred on the anchor's projection, outward normal (nx, nz), width from the text length and the wall.
 * `ground(x, z)` is the terrain height; the sign is lowered when the building is too low for the usual height.
 */
export function placeSign(building, anchor, name, ground) {
  const r = building.rings[0];
  const n = r.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[i * 2], az = r[i * 2 + 1], bx = r[j * 2], bz = r[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 2.6) continue;
    const { d, t } = distanceToSegment(anchor.x, anchor.z, ax, az, bx, bz);
    // among near-equal distances prefer the longer wall
    const score = d - Math.min(len, 12) * 0.05;
    if (!best || score < best.score) best = { score, ax, az, bx, bz, len, t };
  }
  if (!best) return null;
  const dx = (best.bx - best.ax) / best.len, dz = (best.bz - best.az) / best.len;
  // outward normal of an outer ring: (dz, -dx) when its area is positive (see building-geometry.js)
  const sgn = signedArea(r) >= 0 ? 1 : -1;
  const nx = dz * sgn, nz = -dx * sgn;
  const width = Math.max(2.2, Math.min(best.len - 0.6, 6, name.length * 0.27 + 0.9));
  const along = Math.max(width / 2 + 0.3, Math.min(best.len - width / 2 - 0.3, best.t * best.len));
  const cx = best.ax + dx * along, cz = best.az + dz * along;
  const g = ground(cx + nx * 0.4, cz + nz * 0.4);
  const height = building.top - g;
  const y0 = height > SIGN_ABOVE_GROUND + SIGN_HEIGHT + 0.6 ? g + SIGN_ABOVE_GROUND : g + Math.max(2.2, height - SIGN_HEIGHT - 0.4);
  return { x: cx, z: cz, y: y0, nx, nz, dx, dz, width, height: SIGN_HEIGHT, wall: best, along };
}

/** Shops that land on the same wall are set side by side (centred as a group) so that their signs do not overlap. */
export function spreadSigns(signs) {
  const groups = new Map();
  for (const s of signs) {
    const k = `${s.building}:${s.wall.ax.toFixed(2)},${s.wall.az.toFixed(2)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const wall = list[0].wall;
    // too many names for the wall: shrink them all to fit (but not below 1.6 m)
    const room = wall.len - 0.6 - (list.length - 1) * 0.2;
    const sum = list.reduce((a, s) => a + s.width, 0);
    if (sum > room) for (const s of list) s.width = Math.max(1.6, (s.width * room) / sum);
    const total = list.reduce((a, s) => a + s.width, 0) + (list.length - 1) * 0.2;
    const dx = list[0].dx, dz = list[0].dz;
    let start = Math.max(0, Math.min(wall.len - total, list[0].along - total / 2));
    for (const s of list) {
      s.x = wall.ax + dx * (start + s.width / 2);
      s.z = wall.az + dz * (start + s.width / 2);
      start += s.width + 0.2;
    }
  }
}

export function bakeShops(shops, ctx, structures, ground) {
  const placed = [], skipped = [];
  for (const shop of shops) {
    const point = resolvePoint(shop.at, ctx);
    if (!point) { skipped.push([shop.name, 'no point found']); continue; }
    const building = (point.building && structures.find((s) => s.id === point.building)) || findBuilding(structures, point.x, point.z);
    if (!building) { skipped.push([shop.name, 'no building near the point']); continue; }
    const sign = placeSign(building, point, shop.name, ground);
    if (!sign) { skipped.push([shop.name, 'no wall long enough']); continue; }
    placed.push({ name: shop.name, sector: shop.sector, building: building.id, estimated: Boolean(point.estimated), ...sign });
  }
  spreadSigns(placed);
  return { placed, skipped };
}

async function main() {
  const f = fsFetch();
  const [{ structures }, roads, { sampler }] = await Promise.all([loadBuildings('./data/', f), loadRoads('./data/', f), loadTerrain('./data/', f)]);
  const labels = JSON.parse(fs.readFileSync(path.join(root, 'data/labels.json'), 'utf8'));
  const roadIndex = createRoadIndex(roads);
  const ctx = { places: labels.places, numbers: labels.numbers, streetAt: (x, z) => roadIndex.nameAt(x, z, 25) };
  const { shops } = JSON.parse(fs.readFileSync(path.join(root, 'tools/data/vallromanes/overrides/shops.json'), 'utf8'));
  const { placed, skipped } = bakeShops(shops, ctx, structures, (x, z) => sampler.heightAt(x, z));
  for (const s of placed) if (![s.x, s.y, s.z, s.nx, s.nz, s.width].every(Number.isFinite)) throw new Error(`Non-finite sign for ${s.name}`);
  const out = placed.map((s) => ({ name: s.name, sector: s.sector, building: s.building, x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2), nx: +s.nx.toFixed(4), nz: +s.nz.toFixed(4), width: +s.width.toFixed(2), height: s.height }));
  fs.writeFileSync(path.join(root, 'data/shops.json'), JSON.stringify({ source: 'Empreses de Vallromanes (council directory), addresses from OpenStreetMap and map sites', count: out.length, shops: out }));
  console.log(`Fascia signs: ${out.length} placed of ${shops.length}`);
  for (const s of placed) console.log(`  ${s.name.padEnd(32)} ${s.building} wall ${s.wall.len.toFixed(1)} m, sign ${s.width.toFixed(1)} m at y ${s.y.toFixed(1)}${s.estimated ? '  (house number estimated from its neighbours)' : ''}`);
  for (const [name, why] of skipped) console.log(`  NOT PLACED ${name}: ${why}`);
  if (!out.length) throw new Error('No sign placed');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(`build-shops failed: ${err.message}`); process.exit(1); });
}
