import assert from 'node:assert/strict';
import test from 'node:test';
import { groupStairs, sameFlight } from '../tools/vallromanes/stairs-group.mjs';

// A flight climbing along +x: step k is a line across z from z0 to z0 + w at x = x0 + k * tread, raised k * riser
function flight(x0, z0, n, { tread = 0.5, riser = 0.2, width = 2, base = 100, flip = false } = {}) {
  return Array.from({ length: n }, (_, k) => {
    const s = { ax: x0 + k * tread, az: z0, bx: x0 + k * tread, bz: z0 + width, z: base + k * riser };
    return flip && k % 2 ? { ax: s.bx, az: s.bz, bx: s.ax, bz: s.az, z: s.z } : s;
  });
}

test('sameFlight needs parallel lines one tread and one riser apart that overlap along their length', () => {
  const [a, b] = flight(0, 0, 2).map((s) => ({ ...s, len: 2, dx: 0, dz: 1, ang: 90, cx: s.ax, cz: s.az + 1 }));
  assert.ok(sameFlight(a, b));
  assert.ok(!sameFlight(a, { ...b, cx: 1.6 }), 'too far across');
  assert.ok(!sameFlight(a, { ...b, cz: 9 }), 'no overlap along the line');
  assert.ok(!sameFlight(a, { ...b, z: a.z }), 'same height');
  assert.ok(!sameFlight(a, { ...b, z: a.z + 1 }), 'a wall, not a riser');
  assert.ok(!sameFlight(a, { ...b, ang: 40 }), 'not parallel');
});

test('steps of one flight are grouped, ordered by height with the climb direction up the flight', () => {
  const flights = groupStairs(flight(10, 5, 6));
  assert.equal(flights.length, 1);
  const f = flights[0];
  assert.equal(f.steps.length, 6);
  assert.deepEqual(f.steps.map((s) => s.z), [100, 100.2, 100.4, 100.6000000000001, 100.8, 101].map((z, i) => 100 + i * 0.2));
  assert.ok(Math.abs(f.climb[0] - 1) < 1e-9 && Math.abs(f.climb[1]) < 1e-9);
  assert.ok(Math.abs(f.rise - 1) < 1e-9 && Math.abs(f.width - 2) < 1e-9);
});

test('a flight listed from the top, or with alternating end points, comes out the same way up', () => {
  const steps = flight(0, 0, 5, { flip: true }).reverse();
  const f = groupStairs(steps)[0];
  assert.equal(f.steps.length, 5);
  assert.ok(f.climb[0] > 0.99);
  for (const s of f.steps) assert.ok(s.az === 0 && s.bz === 2, 'end points are oriented alike');
  const down = groupStairs(flight(0, 0, 4).map((s, k) => ({ ...s, z: 100 - k * 0.2 })))[0];
  assert.ok(down.climb[0] < -0.99, 'the highest step is at the start: the flight climbs towards -x');
});

test('separate flights stay separate and lone step lines are dropped', () => {
  const lines = [...flight(0, 0, 4), ...flight(0, 20, 3), { ax: 50, az: 50, bx: 50, bz: 52, z: 100 }];
  const flights = groupStairs(lines);
  assert.equal(flights.length, 2);
  assert.deepEqual(flights.map((f) => f.steps.length).sort(), [3, 4]);
});

test('two flights side by side do not merge, and a turned flight (landing) splits at the turn', () => {
  const sideBySide = groupStairs([...flight(0, 0, 4), ...flight(0, 2.6, 4)]);
  assert.equal(sideBySide.length, 2);
  const turned = [...flight(0, 0, 3), ...Array.from({ length: 3 }, (_, k) => ({ ax: 3, az: 6 + k * 0.5, bx: 5, bz: 6 + k * 0.5, z: 101 + k * 0.2 }))];
  assert.equal(groupStairs(turned).length, 2);
});
