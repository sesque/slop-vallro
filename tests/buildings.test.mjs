import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBuildings, chooseRoof, describeStructure, featureRings, FLAG, kindOf, KINDS, ROOF, stableId } from '../tools/vallromanes/build-buildings.mjs';
import { pointInRings, signedArea } from '../js/geo/polygon.js';

const rect = (x, z, w, d, y = 10) => [[x, y, z], [x + w, y, z], [x + w, y, z + d], [x, y, z + d], [x, y, z]];
const boundary = [[-500, -500, 500, -500, 500, 500, -500, 500]];

function feature(cas, parts) {
  return { kind: 'poly', cas, desc: cas, parts, coords: parts[0] };
}

test('kindOf maps CAS codes to structure kinds', () => {
  assert.equal(KINDS[kindOf('CON_01pol_PL')].name, 'building');
  assert.equal(KINDS[kindOf('CON_18polLS_PL')].name, 'construction');
  assert.equal(KINDS[kindOf('CON_18polES_PL')].name, 'construction');
  assert.equal(KINDS[kindOf('CON_09pol_PL')].open, true);
  assert.equal(kindOf('CON_13_PL'), -1); // urban blocks are not structures
  assert.equal(kindOf('VEG_08_PL'), -1);
});

test('stableId is deterministic, depends on the CAS and on the geometry', () => {
  const a = stableId('CON_01pol_PL', [0, 0, 100, 0, 100, 100]);
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, stableId('CON_01pol_PL', [0, 0, 100, 0, 100, 100]));
  assert.notEqual(a, stableId('CON_07pol_PL', [0, 0, 100, 0, 100, 100]));
  assert.notEqual(a, stableId('CON_01pol_PL', [0, 0, 100, 0, 100, 101]));
});

test('featureRings orients the outer ring positive and holes negative, drops tiny holes and the closing vertex', () => {
  const outer = rect(0, 0, 20, 20);
  const cw = [...outer].reverse();
  const hole = rect(5, 5, 4, 4);
  const tiny = rect(15, 15, 0.5, 0.5);
  for (const o of [outer, cw]) {
    const r = featureRings([o, hole, tiny]);
    assert.equal(r.outer.length, 8);
    assert.ok(signedArea(r.outer) > 0);
    assert.equal(r.holes.length, 1);
    assert.ok(signedArea(r.holes[0]) < 0);
  }
});

test('describeStructure: base, baseMax, floors and flags', () => {
  const ring = [0, 0, 10, 0, 10, 10, 0, 10];
  const slope = (x) => x * 0.2; // ground rises 2 m across the footprint
  const d = describeStructure(ring, 8, slope, false);
  assert.equal(d.base, 0);
  assert.equal(d.baseMax, 2);
  assert.equal(d.flags, 0);
  assert.equal(d.floors, Math.round((8 - d.baseMean) / 3));
  const buried = describeStructure(ring, 2.1, slope, false); // top barely above the uphill ground
  assert.ok(buried.flags & FLAG.BURIED);
  const low = describeStructure(ring, 1, () => 0, false);
  assert.ok(low.flags & FLAG.SHORT && low.flags & FLAG.LOW_TOP);
  assert.equal(low.top, 2.2);
  assert.ok(describeStructure(ring, 40, () => 0, false).flags & FLAG.TALL);
  assert.equal(describeStructure(ring, 6, () => 0, true).floors, 1); // open kinds: a slab
});

test('chooseRoof: hip for rectangular buildings, flat for others', () => {
  const rectRing = [0, 0, 12, 0, 12, 6, 0, 6];
  const roof = chooseRoof(rectRing, [], 0);
  assert.equal(roof.roof, ROOF.HIP);
  assert.ok(roof.rise > 0.6 && roof.rise <= 2.2);
  const lShape = [0, 0, 12, 0, 12, 3, 4, 3, 4, 12, 0, 12];
  assert.equal(chooseRoof(lShape, [], 0).roof, ROOF.FLAT);
  assert.equal(chooseRoof(rectRing, [[2, 2, 2, 3, 3, 3]], 0).roof, ROOF.FLAT); // courtyard
  assert.equal(chooseRoof(rectRing, [], 1).roof, ROOF.FLAT); // sheds stay flat
  assert.equal(chooseRoof([0, 0, 12, 0, 12, 2, 0, 2], [], 0).roof, ROOF.FLAT); // too narrow
});

test('buildBuildings: records, ring offsets, binary layout, boundary and degenerate drops', () => {
  const features = [
    feature('CON_01pol_PL', [rect(0, 0, 12, 6, 25), rect(2, 2, 2, 2, 25)]),
    feature('CON_07pol_PL', [rect(30, 0, 4, 3, 22)]),
    feature('CON_09pol_PL', [rect(50, 0, 5, 3, 24)]),
    feature('CON_01pol_PL', [rect(900, 900, 10, 10, 25)]), // outside the boundary
    feature('CON_01pol_PL', [[[0, 5, 100], [0.1, 5, 100], [0.1, 5, 100.1], [0, 5, 100]]]), // sliver
    feature('CON_13_PL', [rect(0, 0, 100, 100, 20)]) // not a structure
  ];
  const { records, bin, dropped } = buildBuildings(features, () => 20, boundary);
  assert.equal(records.length, 3);
  assert.deepEqual(dropped, { degenerate: 1, outside: 1 });
  assert.equal(new Set(records.map((r) => r.id)).size, 3);
  const [house, shed, canopy] = records;
  assert.equal(house.rings.length, 2); // outer + courtyard
  assert.equal(house.roof, ROOF.FLAT); // holes: flat
  assert.equal(house.top, 25);
  assert.equal(house.base, 20);
  assert.equal(shed.kind, 1);
  assert.equal(canopy.floors, 1);
  assert.equal(bin.length, records.flatMap((r) => r.rings).reduce((s, [, n]) => s + n * 2, 0));
  const [start, count] = house.rings[0];
  const ring = Array.from(bin.slice(start * 2, (start + count) * 2), (v) => v / 100);
  assert.ok(signedArea(ring) > 0);
  assert.ok(pointInRings(6, 3, [ring]));
  const [hs, hc] = house.rings[1];
  const hole = Array.from(bin.slice(hs * 2, (hs + hc) * 2), (v) => v / 100);
  assert.ok(signedArea(hole) < 0);
});

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadBoundary, loadBuildings } from '../js/geo/load-geodata.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const baked = fs.existsSync(`${root}data/buildings.bin`) && fs.existsSync(`${root}data/boundary.json`);
const fsFetch = async (url) => {
  const file = `${root}${url.replace('./', '')}`;
  if (!fs.existsSync(file)) return { ok: false, status: 404 };
  const buf = fs.readFileSync(file);
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString()), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
};

test('baked data: structures load, sit inside the municipality and on the terrain', { skip: !baked }, async () => {
  const { structures, meta } = await loadBuildings('./data/', fsFetch);
  const boundary = await loadBoundary('./data/', fsFetch);
  assert.equal(structures.length, meta.count);
  assert.equal(new Set(structures.map((s) => s.id)).size, structures.length);
  assert.ok(structures.length > 4000);
  let inside = 0;
  for (const s of structures) {
    assert.ok(signedArea(s.rings[0]) > 0, `${s.id} outer ring orientation`);
    for (const hole of s.rings.slice(1)) assert.ok(signedArea(hole) < 0, `${s.id} hole orientation`);
    assert.ok(Number.isFinite(s.base) && Number.isFinite(s.top) && s.top >= s.base + 2.2 - 1e-6, `${s.id} heights`);
    assert.ok(s.baseMax >= s.base);
    let cx = 0, cz = 0;
    for (let i = 0; i < s.rings[0].length; i += 2) { cx += s.rings[0][i]; cz += s.rings[0][i + 1]; }
    if (pointInRings(cx / (s.rings[0].length / 2), cz / (s.rings[0].length / 2), boundary.rings)) inside++;
  }
  assert.ok(inside / structures.length > 0.999, `${inside} of ${structures.length} inside the boundary`);
  const houses = structures.filter((s) => s.kindName === 'building');
  const heights = houses.map((s) => s.top - s.base).sort((a, b) => a - b);
  const p50 = heights[Math.floor(heights.length / 2)];
  assert.ok(p50 > 4.5 && p50 < 8, `median building height ${p50}`);
  assert.ok(boundary.meta.areaKm2 > 10 && boundary.meta.areaKm2 < 11);
  await assert.rejects(loadBuildings('./nowhere/', fsFetch), /HTTP 404/);
});
