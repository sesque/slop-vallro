import assert from 'node:assert/strict';
import test from 'node:test';
import { centroid, confineToRing, nearestOnRings, orientedBox, pointInRings, pushOutOfSolid, reverseRing, signedArea, simplifyRing } from '../js/geo/polygon.js';

const square = [0, 0, 10, 0, 10, 10, 0, 10]; // positive area in the x, z plane
const hole = [4, 4, 4, 6, 6, 6, 6, 4]; // negative area

test('signedArea, reverseRing and centroid', () => {
  assert.equal(signedArea(square), 100);
  assert.equal(signedArea(reverseRing(square)), -100);
  assert.equal(signedArea(hole), -4);
  assert.deepEqual(centroid(square), [5, 5]);
  assert.deepEqual(reverseRing([0, 0, 1, 0, 1, 1]), [1, 1, 1, 0, 0, 0]);
});

test('simplifyRing drops duplicates, the closing vertex and collinear points but keeps corners', () => {
  const noisy = [0, 0, 0, 0, 5, 0.02, 10, 0, 10, 10, 5, 10.03, 0, 10, 0, 0];
  const s = simplifyRing(noisy, 0.1);
  assert.equal(s.length, 8);
  assert.equal(Math.abs(signedArea(s)), 100);
  assert.deepEqual(simplifyRing([0, 0, 1, 0, 0, 1], 5), [0, 0, 1, 0, 0, 1]);
  assert.equal(simplifyRing([0, 0, 1, 0, 1, 1, 0, 1], 0).length, 8);
});

test('pointInRings treats holes as outside', () => {
  assert.ok(pointInRings(1, 1, [square, hole]));
  assert.ok(!pointInRings(5, 5, [square, hole]));
  assert.ok(!pointInRings(11, 5, [square, hole]));
});

test('nearestOnRings finds the closest edge point across rings', () => {
  const r = nearestOnRings(5, 5.5, [square, hole]);
  assert.equal(r.qx, 5);
  assert.equal(r.qz, 6);
  assert.ok(Math.abs(r.d2 - 0.25) < 1e-12);
});

test('pushOutOfSolid: outside overlap, centre inside, hole and clear cases', () => {
  const rings = [square, hole];
  assert.equal(pushOutOfSolid(rings, -2, 5, 1), null);
  const out = pushOutOfSolid(rings, -0.5, 5, 1); // circle overlaps the west wall from outside
  assert.ok(Math.abs(out.x + 1) < 1e-9 && out.nx === -1);
  const inside = pushOutOfSolid(rings, 1, 5, 0.5); // centre in the solid, nearest edge is the west wall
  assert.ok(Math.abs(inside.x - -0.5) < 1e-9 && inside.nx === -1);
  const inHole = pushOutOfSolid(rings, 5, 5, 0.5); // inside the courtyard, 1 m from its walls: free
  assert.equal(inHole, null);
  const nearHole = pushOutOfSolid(rings, 4.7, 5, 0.5); // courtyard, 0.7 m from the wall at x = 4... clear
  assert.equal(nearHole, null);
  const touchHole = pushOutOfSolid(rings, 4.2, 5, 0.5); // overlaps the courtyard wall: pushed toward the courtyard centre
  assert.ok(touchHole.x > 4.2 && touchHole.nx === 1);
});

test('orientedBox finds the minimum-area rectangle of a rotated rectangle', () => {
  const a = 0.5; // rotation in radians
  const c = Math.cos(a), s = Math.sin(a);
  const rect = [[-6, -2], [6, -2], [6, 2], [-6, 2]].flatMap(([x, z]) => [50 + x * c - z * s, 20 + x * s + z * c]);
  const b = orientedBox(rect);
  assert.ok(Math.abs(b.cx - 50) < 1e-9 && Math.abs(b.cz - 20) < 1e-9);
  assert.ok(Math.abs(b.hx - 6) < 1e-9 && Math.abs(b.hz - 2) < 1e-9);
  assert.ok(Math.abs(Math.abs(b.ux * c + b.uz * s) - 1) < 1e-9);
  assert.ok(Math.abs(b.area - 48) < 1e-9);
});

test('confineToRing keeps points inside by a margin and pulls outside ones back in', () => {
  const same = confineToRing(square, 5, 5, 1);
  assert.deepEqual([same.x, same.z], [5, 5]);
  const edge = confineToRing(square, 0.2, 5, 1); // too close: moved to 1 m from the west edge
  assert.ok(Math.abs(edge.x - 1) < 1e-9 && edge.z === 5);
  const out = confineToRing(square, -40, 5, 2);
  assert.ok(Math.abs(out.x - 2) < 1e-9 && out.z === 5);
  const corner = confineToRing(square, 30, 30, 1);
  assert.ok(pointInRings(corner.x, corner.z, [square]));
});
