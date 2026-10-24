import assert from 'node:assert/strict';
import test from 'node:test';
import { appendBridge, appendScreen, appendStairs, appendStream, appendWall, appendWater, COPING_HEIGHT, newBuffers, offsetLine, SCREEN, SOLID, WATER } from '../js/world/feature-geometry.js';

function triangles(out) {
  const p = out.position, tris = [];
  for (let t = 0; t < out.index.length; t += 3) {
    const k = [out.index[t], out.index[t + 1], out.index[t + 2]];
    const [a, b, c] = k.map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const vn = [0, 1, 2].map((i) => [out.normal[k[i] * 3], out.normal[k[i] * 3 + 1], out.normal[k[i] * 3 + 2]]);
    tris.push({ a, b, c, n, vn: vn[0], surf: out.info[k[0] * 4], area: Math.hypot(...n) / 2 });
  }
  return tris;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('every triangle of every builder winds the way its normal says', () => {
  const buffers = [];
  const wall = newBuffers(); appendWall(wall, [[0, 0, 0, 2], [10, 0, 0, 2], [10, 8, 0, 2.5]], 0.3, SOLID.WALL); buffers.push(wall);
  const screen = newBuffers(); appendScreen(screen, [[0, 0, 0, 1.2], [10, 0, 0, 1.2]], SCREEN.FENCE); buffers.push(screen);
  const bridge = newBuffers(); appendBridge(bridge, [[0, 0, 4.5, 5], [12, 0, 4.5, 5]], 5); buffers.push(bridge);
  const stairs = newBuffers(); appendStairs(stairs, { climb: [1, 0], steps: [[0, 0, 0, 2, 100], [0.5, 0, 0.5, 2, 100.2], [1, 0, 1, 2, 100.4]] }); buffers.push(stairs);
  const ground = () => 0;
  const solid = newBuffers(), water = newBuffers();
  appendWater(solid, water, { type: 'pool', y: 0.1, outer: [0, 0, 8, 0, 8, 4, 0, 4], inner: [1, 1, 7, 1, 7, 3, 1, 3] }, ground); buffers.push(solid, water);
  for (const out of buffers) {
    for (const t of triangles(out)) {
      if (t.area < 1e-9) continue;
      if (out === screen) continue; // double-sided, any winding
      assert.ok(dot(t.n, t.vn) > 0, 'winding agrees with the normal');
    }
  }
});

test('a wall has outward side faces, an upward top, and caps at the ends of an open line', () => {
  const out = newBuffers();
  appendWall(out, [[0, 0, 0, 2], [10, 0, 0, 2]], 0.4, SOLID.WALL);
  const tris = triangles(out);
  const faces = { left: 0, right: 0, up: 0, ends: 0 };
  for (const t of tris) {
    const n = t.vn;
    if (n[1] > 0.99) faces.up++;
    else if (n[2] > 0.99) faces.left++;
    else if (n[2] < -0.99) faces.right++;
    else if (Math.abs(n[0]) > 0.99) faces.ends++;
  }
  assert.deepEqual(faces, { left: 2, right: 2, up: 2, ends: 4 });
  const xs = out.position.filter((_, i) => i % 3 === 0), zs = out.position.filter((_, i) => i % 3 === 2);
  assert.ok(Math.abs(Math.max(...zs) - 0.2) < 1e-9 && Math.abs(Math.min(...zs) + 0.2) < 1e-9, 'half the thickness each side');
  assert.equal(Math.max(...xs), 10);
  // travelling +x the left side is +z
  const leftTri = tris.find((t) => t.vn[2] > 0.99);
  assert.ok(leftTri.a[2] > 0);
  // a closed line has no end caps
  const closed = newBuffers();
  appendWall(closed, [[0, 0, 0, 1], [4, 0, 0, 1], [4, 4, 0, 1], [0, 4, 0, 1], [0, 0, 0, 1]], 0.2, SOLID.WALL);
  assert.ok(triangles(closed).every((t) => Math.abs(t.vn[0]) < 0.99 || Math.abs(t.vn[2]) > 0 || t.vn[1] > 0));
});

test('wall uv: metres along the wall and the height', () => {
  const out = newBuffers();
  appendWall(out, [[0, 0, 5, 7], [6, 0, 5, 7]], 0.3, SOLID.RETAINING);
  const us = out.uv.filter((_, i) => i % 2 === 0), vs = out.uv.filter((_, i) => i % 2 === 1);
  assert.equal(Math.max(...us), 6);
  assert.ok(vs.includes(5) && vs.includes(7));
  assert.equal(out.info[0], SOLID.RETAINING);
});

test('a screen is a single strip from base to top, with its height above the base as v', () => {
  const out = newBuffers();
  appendScreen(out, [[0, 0, 10, 11.4], [5, 0, 10.5, 11.9], [9, 3, 11, 12.4]], SCREEN.WIRE);
  assert.equal(triangles(out).length, 4);
  const vs = out.uv.filter((_, i) => i % 2 === 1);
  assert.ok(vs.every((v) => v === 0 || Math.abs(v - 1.4) < 1e-9));
  assert.equal(out.info[0], SCREEN.WIRE);
});

test('offsetLine shifts to the left of travel and keeps heights', () => {
  const l = offsetLine([[0, 0, 1, 2], [10, 0, 1, 2]], 3);
  assert.deepEqual(l, [[0, 3, 1, 2], [10, 3, 1, 2]]);
  assert.equal(offsetLine([[0, 0, 1, 2], [10, 0, 1, 2]], -1)[0][1], -1);
});

test('a bridge is a deck slab with a parapet along each edge, standing on the deck', () => {
  const out = newBuffers();
  appendBridge(out, [[0, 0, 4.5, 5], [12, 0, 4.5, 5]], 5);
  const ys = out.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.abs(Math.min(...ys) - 4.5) < 1e-9);
  assert.ok(Math.abs(Math.max(...ys) - 5.95) < 1e-9);
  const zs = out.position.filter((_, i) => i % 3 === 2);
  assert.ok(Math.abs(Math.max(...zs) - 2.5) < 1e-9 && Math.abs(Math.min(...zs) + 2.5) < 1e-9);
  assert.ok(out.info.some((v, i) => i % 4 === 0 && v === SOLID.BRIDGE) && out.info.some((v, i) => i % 4 === 0 && v === SOLID.WALL));
});

test('a stream ribbon follows the ground at its width', () => {
  const water = newBuffers();
  appendStream(water, [[0, 0, 10, 10], [10, 0, 11, 11], [20, 5, 12, 12]], 2, WATER.STREAM);
  const ys = water.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.min(...ys) > 10 && Math.max(...ys) < 12.1);
  assert.ok(triangles(water).every((t) => t.vn[1] > 0));
  assert.equal(water.info[0], WATER.STREAM);
});

test('a pool: coping ring covers outer minus inner, the water plate the inner ring, the body reaches below the ground', () => {
  const solid = newBuffers(), water = newBuffers();
  const ground = (x) => (x < 4 ? 0 : 0.5); // slopes up across the pool
  const level = appendWater(solid, water, { type: 'pool', y: 0.2, outer: [0, 0, 8, 0, 8, 4, 0, 4], inner: [1, 1, 7, 1, 7, 3, 1, 3] }, ground);
  assert.ok(Math.abs(level - 0.52) < 1e-9, 'raised above the highest ground under the ring'); // max(y, maxG + 0.02)
  const coping = triangles(solid).filter((t) => t.surf === SOLID.COPING && t.vn[1] > 0.99);
  const copingArea = coping.reduce((s, t) => s + t.area, 0);
  assert.ok(Math.abs(copingArea - (32 - 12)) < 1e-6, `coping ${copingArea}`);
  const plate = triangles(water);
  assert.ok(Math.abs(plate.reduce((s, t) => s + t.area, 0) - 12) < 1e-6);
  assert.ok(plate.every((t) => t.vn[1] > 0));
  const ys = solid.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.min(...ys) < -0.3 && Math.abs(Math.max(...ys) - (0.52 + COPING_HEIGHT)) < 1e-9);
  const plateY = water.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.max(...plateY) < 0.52 + COPING_HEIGHT);
});

test('a pond without an inner ring is one plate and a bank, and its outer wall faces outward', () => {
  const solid = newBuffers(), water = newBuffers();
  appendWater(solid, water, { type: 'pond', y: 1, outer: [0, 0, 6, 0, 6, 6, 0, 6], inner: null }, () => 1);
  assert.equal(triangles(water).length, 2);
  const wall = triangles(solid).filter((t) => t.surf === SOLID.TANK);
  const centre = [3, 3];
  for (const t of wall) {
    const mid = [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3];
    assert.ok((mid[0] - centre[0]) * t.vn[0] + (mid[1] - centre[1]) * t.vn[2] > 0, 'faces away from the pond centre');
  }
});

test('a flight: a riser and a tread per step, risers face down the flight, treads at the survey heights, sides outward', () => {
  const out = newBuffers();
  const flight = { climb: [1, 0], steps: [[0, 0, 0, 2, 100], [0.5, 0, 0.5, 2, 100.2], [1, 0, 1, 2, 100.4], [1.5, 0, 1.5, 2, 100.6]] };
  appendStairs(out, flight);
  const tris = triangles(out);
  const treads = tris.filter((t) => t.vn[1] > 0.99), risers = tris.filter((t) => t.vn[0] < -0.99), sides = tris.filter((t) => Math.abs(t.vn[2]) > 0.99);
  assert.equal(treads.length, 8);
  assert.equal(risers.length, 8);
  assert.equal(sides.length, 16);
  const treadHeights = [...new Set(treads.map((t) => +t.a[1].toFixed(2)))].sort();
  assert.deepEqual(treadHeights, [100, 100.2, 100.4, 100.6]);
  for (const t of sides) {
    const mid = (t.a[2] + t.b[2] + t.c[2]) / 3;
    assert.ok((mid - 1) * t.vn[2] > 0, 'side panels face away from the flight axis');
  }
  // the first riser starts one typical riser below the first step; the last tread is one typical tread long
  const ys = out.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.abs(Math.max(...ys) - 100.6) < 1e-9);
  const xs = out.position.filter((_, i) => i % 3 === 0);
  assert.ok(Math.abs(Math.max(...xs) - 2.0) < 1e-9);
});
