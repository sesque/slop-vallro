import assert from 'node:assert/strict';
import test from 'node:test';
import { roofStats, NODATA } from '../tools/vallromanes/lidar-roofs.mjs';
import { FLAG, ROOF, refineWithLidar, LIDAR_FLAT_RELIEF } from '../tools/vallromanes/build-buildings.mjs';
import { E0, N0, H0 } from '../tools/vallromanes/frame.mjs';

// a 40 x 40 m DSM window whose north-west corner is local (-20, -20)
const meta = { width: 40, height: 40, originE: E0 - 20, originN: N0 + 20 };
const grid = (fn) => {
  const dsm = new Float32Array(1600);
  for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) dsm[j * 40 + i] = fn(i - 20 + 0.5, j - 20 + 0.5); // local x, z of the pixel centre
  return { meta, dsm };
};
const square = (x0, z0, x1, z1) => [Float32Array.from([x0, z0, x1, z0, x1, z1, x0, z1])];

test('roofStats: a flat roof gives one level, a ridged roof a spread between eave and ridge', () => {
  const flat = roofStats(square(-6, -6, 6, 6), grid((x, z) => (Math.abs(x) < 6 && Math.abs(z) < 6 ? H0 + 8 : H0 + 1)));
  assert.ok(Math.abs(flat.median - 8) < 1e-6 && flat.ridge - flat.eave < 1e-6);
  const gable = roofStats(square(-6, -6, 6, 6), grid((x, z) => (Math.abs(x) < 6 && Math.abs(z) < 6 ? H0 + 6 + 3 * (1 - Math.abs(x) / 6) : H0)));
  assert.ok(gable.ridge - gable.eave > 1.5 && gable.eave > 6 && gable.ridge <= 9.01);
});

test('roofStats ignores the pixels at the walls, no-data and tiny footprints', () => {
  const edge = roofStats(square(-6, -6, 6, 6), grid((x, z) => (Math.abs(x) < 5.4 && Math.abs(z) < 5.4 ? H0 + 8 : H0 + 20)));
  assert.ok(Math.abs(edge.median - 8) < 1e-6, 'the wall pixels (20 m) are left out');
  assert.equal(roofStats(square(-6, -6, 6, 6), grid(() => NODATA)), null);
  assert.equal(roofStats(square(0, 0, 2, 2), grid(() => H0 + 5)), null, 'nothing is left of a 2 m square');
});

const baked = (extra = {}) => ({ base: 0, baseMax: 1, baseMean: 0.5, top: 6, floors: 2, flags: 0, ...extra });

test('refineWithLidar: a buried top takes the roof level and loses its flags', () => {
  const r = refineWithLidar(baked({ top: 1.1, flags: FLAG.BURIED }), { roof: ROOF.FLAT, rise: 0 }, { median: 6.4, eave: 6.3, ridge: 6.5 }, 0, false, 0.5);
  assert.equal(r.top, 6.4);
  assert.ok(r.changed.top && r.flags & FLAG.LIDAR_TOP && !(r.flags & FLAG.BURIED));
  assert.equal(r.floors, Math.round((6.4 - 0.5) / 3));
});

test('refineWithLidar: a top within 1.2 m of the roof level is kept; sheds count, other kinds do not', () => {
  assert.equal(refineWithLidar(baked(), { roof: ROOF.FLAT, rise: 0 }, { median: 6.8, eave: 6.7, ridge: 6.9 }, 0, false, 0.5).changed.top, false);
  assert.equal(refineWithLidar(baked({ top: 1.1, flags: FLAG.BURIED }), { roof: ROOF.FLAT, rise: 0 }, { median: 6, eave: 6, ridge: 6 }, 1, false, 0.5).changed.top, true);
  assert.equal(refineWithLidar(baked({ top: 1.1, flags: FLAG.BURIED }), { roof: ROOF.FLAT, rise: 0 }, { median: 6, eave: 6, ridge: 6 }, 4, false, 0.5).changed.top, false);
  assert.equal(refineWithLidar(baked(), { roof: ROOF.HIP, rise: 1.2 }, null, 0, false, 0.5).roof, ROOF.HIP, 'no LiDAR, no change');
});

test('refineWithLidar: a hip roof with no relief is flat, and one with relief takes its rise from it', () => {
  const flat = refineWithLidar(baked(), { roof: ROOF.HIP, rise: 1.5 }, { median: 6, eave: 5.8, ridge: 5.8 + LIDAR_FLAT_RELIEF - 0.1 }, 0, false, 0.5);
  assert.equal(flat.roof, ROOF.FLAT);
  assert.equal(flat.rise, 0);
  const pitched = refineWithLidar(baked(), { roof: ROOF.HIP, rise: 1.5 }, { median: 6, eave: 5, ridge: 7.6 }, 0, false, 0.5);
  assert.equal(pitched.roof, ROOF.HIP);
  assert.equal(pitched.rise, 2.6);
});
