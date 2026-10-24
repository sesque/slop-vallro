import assert from 'node:assert/strict';
import test from 'node:test';
import { CELL, NODATA, STEP, buildingMask, canopyGrid } from '../tools/vallromanes/build-canopy.mjs';
import { E0, N0 } from '../tools/vallromanes/frame.mjs';

// a 40 x 40 m window whose north-west corner is at local (-20, -20): x = E - E0, z = N0 - N
const meta = { width: 40, height: 40, originE: E0 - 20, originN: N0 + 20 };
const area = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };

test('a footprint masks the pixels it covers and no others', () => {
  const ring = Float32Array.from([0, 0, 10, 0, 10, 10, 0, 10]); // x 0..10, z 0..10
  const mask = buildingMask([{ rings: [ring] }], meta);
  assert.equal(mask.reduce((a, b) => a + b, 0), 100);
  assert.equal(mask[Math.floor(5 + 20) * 40 + 25], 1);
  assert.equal(mask[Math.floor(15 + 20) * 40 + 25], 0);
});

test('canopy height is the surface minus the terrain, quantised, with buildings and no-data left out', () => {
  const n = meta.width * meta.height;
  const dtm = new Float32Array(n).fill(100);
  const dsm = new Float32Array(n).fill(100);
  const mask = new Uint8Array(n);
  const set = (x0, z0, x1, z1, fn) => { for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) fn(Math.floor(z + 20) * 40 + Math.floor(x + 20)); };
  set(-20, -20, -12, -12, (k) => { dsm[k] = 112; }); // 12 m of trees in the north-west corner (z grows southwards)
  set(4, 4, 12, 12, (k) => { dsm[k] = 120; mask[k] = 1; }); // a building: left out
  set(-4, -4, 4, 4, (k) => { dsm[k] = NODATA; });
  const g = canopyGrid({ dsm, dtm, mask, meta, area });
  assert.equal(g.width, 40 / CELL);
  const at = (x, z) => g.data[Math.floor((z - g.originZ) / CELL) * g.width + Math.floor((x - g.originX) / CELL)];
  assert.equal(at(-18, -18), Math.round(12 / STEP));
  assert.equal(at(8, 8), 0, 'building pixels do not count');
  assert.equal(at(0, 0), 0, 'no-data does not count');
  assert.equal(at(16, 16), 0, 'bare ground');
});
