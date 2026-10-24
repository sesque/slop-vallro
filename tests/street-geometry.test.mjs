import assert from 'node:assert/strict';
import test from 'node:test';
import { appendEdge, appendJunction, junctionRadii, newBuffers, nodeTrims, pushKerbFace, pushRibbon, slicePolyline, SURF, LIFT, CURB, toTypedBuffers } from '../js/world/street-geometry.js';

const edge = (extra = {}) => ({ a: 0, b: 1, cls: 'urban', halfL: 3, halfR: 3, swL: 1.5, swR: 1.5, pts: [[0, 0, 10], [40, 0, 10]], ...extra });

function triangles(out) {
  const p = out.position, tris = [];
  for (let t = 0; t < out.index.length; t += 3) {
    const [a, b, c] = [out.index[t], out.index[t + 1], out.index[t + 2]].map((k) => [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    tris.push({ a, b, c, n: [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], k: [out.index[t], out.index[t + 1], out.index[t + 2]] });
  }
  return tris;
}

test('slicePolyline interpolates the ends and drops pieces under half a metre', () => {
  const s = slicePolyline([[0, 0, 0], [10, 0, 10], [20, 0, 10]], 5, 15);
  assert.deepEqual(s.pts[0], [5, 0, 5]);
  assert.deepEqual(s.pts[1], [10, 0, 10]);
  assert.deepEqual(s.pts[2], [15, 0, 10]);
  assert.equal(s.s0, 5);
  assert.equal(slicePolyline([[0, 0, 0], [10, 0, 0]], 4.8, 5.1), null);
  assert.equal(slicePolyline([[0, 0, 0], [10, 0, 0]], 8, 3), null);
});

test('a ribbon spans the lateral offsets at the lifted profile height, with up-facing triangles and uv = (s, offset)', () => {
  const out = newBuffers();
  pushRibbon(out, [[0, 0, 10], [10, 0, 11], [20, 0, 12]], 3, -2, LIFT, LIFT, SURF.ASPHALT, 0);
  const pos = out.position;
  const zs = [], ys = [];
  for (let i = 0; i < pos.length; i += 3) { zs.push(pos[i + 2]); ys.push(pos[i + 1]); }
  // travelling +x the left normal is (-tz, tx) = (0, 1): +z is left
  assert.equal(Math.max(...zs), 3);
  assert.equal(Math.min(...zs), -2);
  assert.ok(Math.abs(Math.min(...ys) - (10 + LIFT)) < 1e-9 && Math.abs(Math.max(...ys) - (12 + LIFT)) < 1e-9);
  for (const t of triangles(out)) assert.ok(t.n[1] > 0, 'faces up');
  assert.deepEqual([out.uv[0], out.uv[1], out.uv[2], out.uv[3]], [0, 3, 0, -2]);
  assert.deepEqual([out.uv[out.uv.length - 2], out.uv[out.uv.length - 1]], [20, -2]);
  assert.ok(out.normal[1] > 0.9 && out.normal[0] < 0, 'the normal leans back on an uphill ribbon');
});

test('a kerb face is vertical and faces the carriageway on both sides', () => {
  for (const side of [1, -1]) {
    const out = newBuffers();
    pushKerbFace(out, [[0, 0, 5], [10, 0, 5]], side * 3, LIFT, LIFT + CURB, side, 0);
    for (const t of triangles(out)) {
      assert.ok(Math.abs(t.n[1]) < 1e-9, 'vertical');
      assert.ok(t.n[2] * -side > 0, `side ${side} faces the centreline`);
    }
    const ys = out.position.filter((_, i) => i % 3 === 1);
    assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - CURB) < 1e-9);
  }
});

test('an urban edge with pavements adds asphalt, two kerb faces and two pavement strips; dirt edges only the ribbon', () => {
  const out = newBuffers();
  appendEdge(out, edge(), [0, 0]);
  const surfaces = new Set();
  for (let i = 0; i < out.info.length; i += 4) surfaces.add(out.info[i]);
  assert.deepEqual([...surfaces].sort(), [SURF.ASPHALT, SURF.SIDEWALK, SURF.KERB]);
  const dirt = newBuffers();
  appendEdge(dirt, edge({ cls: 'track', halfL: 1.5, halfR: 1.5, swL: 0, swR: 0 }), [0, 0]);
  assert.deepEqual([...new Set(dirt.info.filter((_, i) => i % 4 === 0))], [SURF.DIRT]);
  const oneSide = newBuffers();
  appendEdge(oneSide, edge({ swR: 0 }), [0, 0]);
  const zs = oneSide.position.filter((_, i) => i % 3 === 2);
  assert.ok(Math.max(...zs) > 4 && Math.min(...zs) >= -3 - 1e-9, 'no pavement on the right');
});

test('pavements are cut back at junctions while the asphalt ribbon runs on', () => {
  const nodes = [[0, 0, 10], [40, 0, 10], [20, 0, 10], [20, 30, 10], [20, -30, 10]];
  const edges = [
    edge({ a: 0, b: 2, pts: [[0, 0, 10], [20, 0, 10]] }),
    edge({ a: 2, b: 1, pts: [[20, 0, 10], [40, 0, 10]] }),
    edge({ a: 2, b: 3, pts: [[20, 0, 10], [20, 30, 10]] }),
    edge({ a: 2, b: 4, pts: [[20, 0, 10], [20, -30, 10]] })
  ];
  const trims = nodeTrims(nodes.map(([x, z, y]) => ({ x, z, y })), edges);
  assert.ok(trims[2] > 3 && trims[2] < 4);
  assert.equal(trims[0], 0);
  const out = newBuffers();
  appendEdge(out, edges[0], trims);
  const sidewalkX = [];
  for (let i = 0; i < out.info.length / 4; i++) if (out.info[i * 4] === SURF.SIDEWALK) sidewalkX.push(out.position[i * 3]);
  assert.ok(Math.max(...sidewalkX) <= 20 - trims[2] + 1e-9, 'pavement stops before the side street');
  const asphaltX = [];
  for (let i = 0; i < out.info.length / 4; i++) if (out.info[i * 4] === SURF.ASPHALT) asphaltX.push(out.position[i * 3]);
  assert.equal(Math.max(...asphaltX), 20);
  // centre line marking range stops at the same distance
  const mark = out.info.slice(0, 4);
  assert.deepEqual([mark[1], mark[2], mark[3]], [1, 0, 20 - trims[2]]);
  const radii = junctionRadii(nodes.map(([x, z, y]) => ({ x, z, y })), edges);
  assert.ok(radii[2] > 3 && radii[0] === 0);
});

test('narrow streets get no centre line, junction discs lie flat at the node height', () => {
  const out = newBuffers();
  appendEdge(out, edge({ halfL: 2, halfR: 2 }), [0, 0]);
  assert.equal(out.info[1], 0);
  const j = newBuffers();
  appendJunction(j, [5, 7, 20], 3);
  assert.ok(j.position.filter((_, i) => i % 3 === 1).every((y) => Math.abs(y - (20 + LIFT)) < 1e-9));
  assert.ok(triangles(j).every((t) => t.n[1] >= 0));
  const buf = toTypedBuffers(out);
  assert.ok(buf.index instanceof Uint16Array && buf.position.length === buf.normal.length);
});
