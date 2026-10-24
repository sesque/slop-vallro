import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStairIndex } from '../js/geo/stair-index.js';
import { loadFeatures, loadStairs } from '../js/geo/load-geodata.js';
import { fsFetch } from '../tools/vallromanes/fs-fetch.mjs';
import { createLineCollider, MIN_BLOCKING } from '../js/world/features.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const wall = (pts, thick = 0.25) => ({ id: 'w', kind: 'wall', thick, pts });

test('a wall collider pushes a circle out sideways and ignores low or distant ones', () => {
  const c = createLineCollider(wall([[0, 0, 98, 101], [10, 0, 98, 101]]));
  assert.ok(c && c.maxY === 101);
  assert.equal(c.pushOut(5, 3, 0.48), null);
  const p = c.pushOut(5, 0.4, 0.48); // inside the capsule: pushed to the +z side by r + half thickness
  assert.ok(Math.abs(p.z - (0.48 + 0.125)) < 1e-9 && p.nz === 1);
  const q = c.pushOut(5, -0.3, 0.48);
  assert.ok(q.nz === -1 && Math.abs(q.z + 0.605) < 1e-9);
  const end = c.pushOut(10.4, 0, 0.48); // beyond the end: pushed away from the end point
  assert.ok(end.nx === 1 && end.x > 10.4);
  assert.equal(createLineCollider(wall([[0, 0, 100, 100.4], [10, 0, 100, 100.4]])), null, `under ${MIN_BLOCKING} m is stepped over`);
});

test('wall segments on a carriageway are left out of the collider', () => {
  const roadIndex = { surfaceAt: (x) => (x >= 10 && x <= 20 ? 'road' : null) };
  const c = createLineCollider(wall([[0, 0, 98, 101], [10, 0, 98, 101], [20, 0, 98, 101], [30, 0, 98, 101]]), roadIndex);
  assert.equal(c.pushOut(15, 0.1, 0.48), null, 'the middle segment crosses the road');
  assert.ok(c.pushOut(5, 0.1, 0.48) && c.pushOut(25, 0.1, 0.48));
  assert.equal(createLineCollider(wall([[0, 0, 98, 101], [10, 0, 98, 101]]), { surfaceAt: () => 'road' }), null);
});

test('stair index: the tread height under a point, the highest tread wins, nothing off the flight', () => {
  const flight = { climb: [1, 0], steps: [[0, 0, 0, 2, 100], [0.5, 0, 0.5, 2, 100.2], [1, 0, 1, 2, 100.4]] };
  const idx = createStairIndex([flight]);
  assert.equal(idx.heightAt(0.25, 1), 100);
  assert.equal(idx.heightAt(0.75, 1), 100.2);
  assert.equal(idx.heightAt(1.2, 1), 100.4); // the last tread runs one tread beyond its line
  assert.equal(idx.heightAt(0.25, 2.5), null);
  assert.equal(idx.heightAt(-0.5, 1), null);
  assert.equal(idx.heightAt(500, 500), null);
  assert.equal(idx.count, 3);
});

const baked = fs.existsSync(`${root}data/features.bin`) && fs.existsSync(`${root}data/stairs.json`);
test('baked features and stairs load consistently', { skip: !baked }, async () => {
  const { lines, water } = await loadFeatures('./data/', fsFetch());
  assert.ok(lines.length > 10000 && water.length > 400);
  assert.equal(new Set(lines.map((l) => l.id)).size, lines.length);
  for (const l of lines) {
    assert.ok(l.pts.length >= 2);
    for (const p of l.pts) assert.ok(p.every(Number.isFinite) && p[3] >= p[2], `${l.id} base/top`);
  }
  assert.ok(water.every((w) => w.outer.length >= 6 && (!w.inner || w.inner.length >= 6)));
  const { flights } = await loadStairs('./data/', fsFetch());
  assert.ok(flights.length > 1000);
  const idx = createStairIndex(flights);
  const f = flights[0];
  const mid = [(f.steps[0][0] + f.steps[0][2]) / 2 + f.climb[0] * 0.1, (f.steps[0][1] + f.steps[0][3]) / 2 + f.climb[1] * 0.1];
  assert.equal(idx.heightAt(mid[0], mid[1]) >= f.steps[0][4] - 1e-9, true);
  await assert.rejects(loadFeatures('./nowhere/', fsFetch()), /HTTP 404/);
});
