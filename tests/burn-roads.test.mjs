import assert from 'node:assert/strict';
import test from 'node:test';
import { burnRoads, flatHalfWidth } from '../tools/vallromanes/burn-roads.mjs';

function grid(w, h, cell, fn) {
  const heights = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) heights[j * w + i] = fn(i * cell, j * cell);
  return { heights, grid: { minX: 0, minZ: 0, cell, w, h } };
}
const road = (pts, extra = {}) => ({ cls: 'urban', halfL: 3, halfR: 3, swL: 1.5, swR: 1.5, pts, ...extra });

test('flatHalfWidth covers the carriageway, the pavement and a margin', () => {
  assert.equal(flatHalfWidth(road([])), 4.75);
  assert.equal(flatHalfWidth(road([], { halfL: 2, halfR: 3, swL: 0, swR: 0 })), 3.25);
});

test('the corridor takes the road profile, outside it the terrain is untouched, the edge blends in between', () => {
  // terrain tilted across the road (rises with z), road along x at z = 40 with its own flat profile at y = 10
  const { heights, grid: g } = grid(81, 81, 1, (x, z) => 10 + (z - 40) * 0.2);
  const before = Float32Array.from(heights);
  const changed = burnRoads(heights, g, [road([[0, 40, 10], [80, 40, 10]])]);
  assert.ok(changed > 0);
  const at = (x, z) => heights[z * 81 + x];
  for (const z of [36, 38, 40, 42, 44]) assert.ok(Math.abs(at(40, z) - 10) < 1e-5, `z=${z}`); // flat strip, 4.75 m each side
  assert.equal(at(40, 10), before[10 * 81 + 40]); // far away: unchanged
  assert.equal(at(40, 70), before[70 * 81 + 40]);
  // across the blend the height moves monotonically from the road to the terrain
  const run = [45, 46, 47, 48, 49].map((z) => at(40, z) - (10 + (z - 40) * 0.2));
  assert.ok(run.every((v, i) => i === 0 || Math.abs(v) <= Math.abs(run[i - 1]) + 1e-6), `blend residuals ${run}`);
});

test('the profile height follows the road along its length', () => {
  const { heights, grid: g } = grid(81, 41, 1, () => 0);
  burnRoads(heights, g, [road([[0, 20, 0], [80, 20, 8]])]);
  assert.ok(Math.abs(heights[20 * 81 + 40] - 4) < 0.05);
  assert.ok(Math.abs(heights[20 * 81 + 70] - 7) < 0.05);
});

test('base shifts targets (the terrain grid holds absolute heights) and the nearer road wins at overlaps', () => {
  const { heights, grid: g } = grid(41, 41, 1, () => 100);
  burnRoads(heights, g, [road([[0, 10, 1], [40, 10, 1]]), road([[0, 30, 5], [40, 30, 5]])], { base: 100 });
  assert.ok(Math.abs(heights[10 * 41 + 20] - 101) < 1e-4);
  assert.ok(Math.abs(heights[30 * 41 + 20] - 105) < 1e-4);
  assert.ok(Math.abs(heights[16 * 41 + 20] - 101) < 3.5); // between the roads it blends between the two profiles
});

test('on a coarse grid the blend is at least about one cell wide', () => {
  const { heights, grid: g } = grid(41, 41, 4, () => 0);
  burnRoads(heights, g, [road([[0, 80, 10], [160, 80, 10]], { cls: 'track', halfL: 1.75, halfR: 1.75, swL: 0, swR: 0 })]);
  const col = Array.from({ length: 41 }, (_, j) => heights[j * 41 + 20]);
  const touched = col.filter((v) => v > 0).length;
  assert.ok(touched >= 3 && touched <= 7, `touched ${touched}`);
  assert.ok(Math.abs(col[20] - 10) < 1e-5);
});

test('depth buries the corridor below the profile without moving the blend edge outwards', () => {
  const { heights, grid: g } = grid(81, 81, 1, () => 10);
  burnRoads(heights, g, [road([[0, 40, 10], [80, 40, 10]])], { depth: 0.1 });
  assert.ok(Math.abs(heights[40 * 81 + 40] - 9.9) < 1e-5);
  assert.ok(Math.abs(heights[43 * 81 + 40] - 9.9) < 1e-5); // still inside the flat strip
  assert.equal(heights[5 * 81 + 40], 10); // far away
});
