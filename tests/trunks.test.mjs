import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrunkField } from '../js/world/trunks.js';

const sites = [{ x: 10, z: 10, y: 5, scale: 1 }, { x: 40, z: 10, y: 5, scale: 2 }, { x: 10.5, z: 11, y: 5, scale: 1 }, { x: 500, z: -300, y: 80, scale: 1 }];

test('trunks near a point: only those within reach, with their own radius and height', () => {
  const f = createTrunkField(sites);
  const near = f.near(10, 10, 5);
  assert.equal(near.length, 2);
  assert.ok(near.every((c) => Math.abs(c.maxX - c.minX - 0.6) < 1e-6 && c.maxY > 5 + 8));
  assert.equal(f.near(40, 10, 1).length, 1);
  assert.ok(Math.abs(f.near(40, 10, 1)[0].maxX - f.near(40, 10, 1)[0].minX - 1.2) < 1e-6, 'a scale 2 tree has twice the radius');
  assert.equal(f.near(200, 200, 20).length, 0);
  assert.equal(f.near(500, -300, 3).length, 1, 'far cells and negative coordinates work');
});

test('pushOut moves a circle clear of the trunk along the line from its centre, and ignores circles that miss it', () => {
  const [t] = createTrunkField([{ x: 0, z: 0, y: 0, scale: 1 }]).near(0, 0, 3);
  const hit = t.pushOut(0.5, 0, 0.4); // the circle reaches 0.7 m; the trunk is 0.3 m
  assert.ok(hit && Math.abs(hit.x - 0.7) < 1e-6 && hit.z === 0 && hit.nx === 1);
  assert.equal(t.pushOut(2, 0, 0.4), null);
  const inside = t.pushOut(0, 0, 0.4); // exactly on the centre: pushed out along +x
  assert.ok(inside && Math.abs(inside.x - 0.7) < 1e-6);
});

test('the pool is reused: a second call overwrites the first', () => {
  const f = createTrunkField(sites);
  const a = f.near(10, 10, 5);
  const first = a[0];
  f.near(40, 10, 1);
  assert.equal(a, f.near(40, 10, 1), 'the same array');
  assert.equal(first.x, 40, 'the same objects, refilled');
});
