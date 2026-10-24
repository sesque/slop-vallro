import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeFeatures, densify, joinChains, lineKindOf, LINE_KINDS, pairRings, verticalProfile } from '../tools/vallromanes/build-features.mjs';
import { signedArea } from '../js/geo/polygon.js';

const kind = (name) => LINE_KINDS.find((k) => k.name === name);
const flat = () => 100;
const line = (cas, pts) => ({ kind: 'line', cas, parts: [pts.map(([x, z, y]) => [x, y, z])] }); // BUE order: [x, y, z]

test('lines map to feature kinds by CAS code', () => {
  assert.equal(LINE_KINDS[lineKindOf('CON_15_LN')].name, 'wall');
  assert.equal(LINE_KINDS[lineKindOf('CON_14LS_LN')].name, 'retaining');
  assert.equal(LINE_KINDS[lineKindOf('CON_14LN_LN')].name, 'retaining');
  assert.equal(LINE_KINDS[lineKindOf('VEG_04_LN')].name, 'hedge');
  assert.equal(LINE_KINDS[lineKindOf('COM_13ES_LN')].name, 'bridge');
  assert.equal(lineKindOf('CON_23_LN'), -1); // stairs are baked elsewhere
  assert.equal(lineKindOf('HID_11EX_LN'), -1); // pools are rings
});

test('densify adds vertices so that no segment exceeds the step and interpolates the height', () => {
  const pts = densify([[0, 0, 10], [10, 0, 20]], 3);
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[2], [5, 0, 15]);
  assert.equal(densify([[0, 0, 0], [1, 0, 0]], 5).length, 2);
});

test('verticalProfile: a plausible survey height is the top, otherwise the default height above the ground', () => {
  const wall = kind('wall');
  const [base, top] = verticalProfile(wall, [[0, 0, 101.6]], flat)[0];
  assert.ok(Math.abs(top - 101.6) < 1e-9 && Math.abs(base - 99.75) < 1e-9); // top kept, 25 cm into the ground
  const wrong = verticalProfile(wall, [[0, 0, 100.1]], flat)[0]; // 0.1 m: not a wall height
  assert.ok(Math.abs(wrong[1] - 101.8) < 1e-9);
  const tall = verticalProfile(wall, [[0, 0, 110]], flat)[0];
  assert.ok(Math.abs(tall[1] - 101.8) < 1e-9);
  const wire = verticalProfile(kind('wire'), [[0, 0, 100.3]], flat)[0];
  assert.ok(Math.abs(wire[1] - 101.4) < 1e-9, 'wire fence heights come from the default, not the survey Z');
  const stream = verticalProfile(kind('stream'), [[0, 0, 95]], flat)[0];
  assert.deepEqual(stream, [100, 100]);
  const deck = verticalProfile(kind('bridge'), [[0, 0, 103]], flat)[0];
  assert.deepEqual(deck, [102.5, 103]);
});

test('a retaining wall stands on the lower ground beside it and reaches the crest', () => {
  const slope = (x, z) => 100 + z * 0.5; // terrain rises with z: the low side is z < 0
  const pts = [[0, 0, 103], [10, 0, 103]];
  const [base, top] = verticalProfile(kind('retaining'), pts, slope)[0];
  assert.ok(Math.abs(top - 103) < 1e-9);
  assert.ok(Math.abs(base - (100 - 0.75 - 0.25)) < 1e-9, `base ${base}`); // ground at z = -1.5 is 99.25, minus the embed
  const absurd = verticalProfile(kind('retaining'), [[0, 0, 140], [10, 0, 140]], slope)[0];
  assert.ok(Math.abs(absurd[1] - (99.25 + 1.5)) < 1e-9);
});

test('joinChains links pieces end to end (either direction) and leaves unrelated ones alone', () => {
  const chains = joinChains([[[0, 0], [5, 0]], [[10, 5], [5, 0.1]], [[10, 5], [0.1, 5.1], [0, 0.1]], [[50, 50], [60, 50]]]);
  assert.equal(chains.length, 2);
  const ring = chains.find((c) => c.length > 4);
  assert.ok(Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.3, 'closed');
});

test('pairRings gives each inner ring to the smallest outer ring around it, once', () => {
  const sq = (x, z, s) => [x, z, x + s, z, x + s, z + s, x, z + s];
  const outers = [{ ring: sq(0, 0, 10), y: 1 }, { ring: sq(0, 0, 40), y: 1 }];
  const inners = [{ ring: sq(2, 2, 5), y: 1 }];
  const pairs = pairRings(outers, inners);
  assert.equal(pairs.filter((p) => p.inner).length, 1);
  assert.equal(pairs[0].inner, inners[0]);
  assert.equal(pairs[1].inner, null);
});

test('bakeFeatures: vertex layout, water rings oriented positive, slivers skipped', () => {
  const ringPts = (x, z, s, y) => [[x, z, y], [x + s, z, y], [x + s, z + s, y], [x, z + s, y], [x, z, y]];
  const data = [
    line('CON_15_LN', [[0, 0, 101.6], [12, 0, 101.6]]),
    line('CON_15_LN', [[0, 5, 101], [0.1, 5, 101]]), // sliver
    line('VEG_04_LN', [[0, 10, 101.7], [8, 10, 101.7]]),
    line('HID_11EX_LN', ringPts(20, 20, 8, 100.2)),
    line('HID_11IN_LN', ringPts(21, 21, 6, 100.2)),
    line('HID_10_LN', ringPts(40, 40, 6, 99.5)),
    line('CON_23_LN', [[1, 1, 100], [2, 1, 100]])
  ];
  const out = bakeFeatures(data, flat);
  assert.equal(out.lines.length, 2);
  assert.equal(out.skipped, 1);
  assert.equal(out.lines[0].n, 5); // 12 m wall densified every 3 m
  const v = out.verts.slice(0, 4);
  assert.deepEqual(Array.from(v), [0, 0, 9975, 10160]); // x, z, base, top in cm
  assert.equal(out.verts.length, (out.lines[0].n + out.lines[1].n) * 4);
  assert.equal(out.water.length, 2);
  const pool = out.water.find((w) => w.type === 'pool'), pond = out.water.find((w) => w.type === 'pond');
  assert.ok(pool.inner && !pond.inner);
  assert.ok(signedArea(pool.outer) > 0 && signedArea(pool.inner) > 0);
  assert.ok(Math.abs(pool.y - 100.2) < 1e-9);
});

import { clipLine, stairCorridors } from '../tools/vallromanes/build-features.mjs';

// A flight climbing along +x from x = 10: 6 steps 0.5 m apart, 2 m wide across z in [0, 2]
const flight = { climb: [1, 0], width: 2, steps: Array.from({ length: 6 }, (_, k) => [10 + k * 0.5, 0, 10 + k * 0.5, 2, 100 + k * 0.2]) };

test('stair corridors cover the flight plus two metres at each end and a little at the sides', () => {
  const c = stairCorridors([flight]);
  assert.ok(c.contains(11, 1) && c.contains(8.1, 1) && c.contains(14.4, 1));
  assert.ok(!c.contains(7.5, 1) && !c.contains(15, 1));
  assert.ok(c.contains(11, -0.2) && !c.contains(11, -0.5) && !c.contains(11, 2.5));
  assert.equal(c.count, 1);
});

test('a wall across the foot of a flight is cut into two lines, a wall beside it is left whole', () => {
  const c = stairCorridors([flight]);
  const across = clipLine([[9, -5, 100], [9, 8, 100]], c); // crosses the corridor 1 m before the first step
  assert.equal(across.length, 2);
  assert.ok(across[0][across[0].length - 1][1] <= -0.2 + 0.5 && across[1][0][1] >= 2.2 - 0.5);
  const beside = clipLine([[8, 5, 100], [20, 5, 100]], c);
  assert.equal(beside.length, 1);
  const inside = clipLine([[9.5, 0.5, 100], [9.5, 1.5, 100]], c);
  assert.equal(inside.length, 0);
});

test('bakeFeatures cuts walls but not barriers where a flight crosses, and pieces keep unique ids', () => {
  const c = stairCorridors([flight]);
  const data = [line('CON_15_LN', [[9, -5, 101.8], [9, 8, 101.8]]), line('COM_16_LN', [[9, -5, 100.75], [9, 8, 100.75]])];
  const out = bakeFeatures(data, flat, c);
  const walls = out.lines.filter((l) => LINE_KINDS[l.kind].name === 'wall');
  assert.equal(walls.length, 2);
  assert.equal(out.lines.filter((l) => LINE_KINDS[l.kind].name === 'barrier').length, 1);
  assert.equal(new Set(out.lines.map((l) => l.id)).size, out.lines.length);
  const uncut = bakeFeatures(data, flat);
  assert.equal(uncut.lines.filter((l) => LINE_KINDS[l.kind].name === 'wall').length, 1);
});
