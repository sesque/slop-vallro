import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRoadGraph } from '../tools/vallromanes/road-graph.mjs';

const line = (id, cls, ...pts) => ({ id, cls, pts: pts.map(([x, z, y = 0]) => [x, z, y]) });
const total = (g) => g.edges.reduce((s, e) => s + e.length, 0);

test('a crossing without a shared vertex becomes a junction of four edges', () => {
  const g = buildRoadGraph([line('a', 'urban', [0, 0], [20, 0]), line('b', 'urban', [10, -10], [10, 10])]);
  assert.equal(g.nodes.length, 5);
  assert.equal(g.edges.length, 4);
  assert.equal(g.report.crossings, 1);
  assert.ok(Math.abs(total(g) - 40) < 1e-9);
  assert.equal(g.report.components.length, 1);
});

test('a T-junction: a lone endpoint within the snap distance joins the other line', () => {
  const g = buildRoadGraph([line('a', 'urban', [0, 0], [30, 0]), line('b', 'urban', [15, 0.5], [15, 20])]);
  assert.equal(g.edges.length, 3);
  assert.equal(g.report.snappedToLine, 1);
  assert.equal(g.report.components.length, 1);
  const stem = g.edges.find((e) => e.pts.some((p) => p[1] === 20));
  assert.ok(stem.pts.some((p) => p[0] === 15 && p[1] === 0), 'the stem ends exactly on the main line');
});

test('endpoints close together merge, and the chain through the degree-2 node merges into one edge', () => {
  const g = buildRoadGraph([line('a', 'urban', [0, 0], [10, 0]), line('b', 'urban', [10.4, 0.1], [20, 0])]);
  assert.equal(g.report.snappedEndpointClusters, 1);
  assert.equal(g.edges.length, 1);
  assert.equal(g.nodes.length, 2);
  assert.ok(Math.abs(g.edges[0].length - 20) < 0.1);
});

test('classes are not merged through a shared node', () => {
  const g = buildRoadGraph([line('a', 'urban', [0, 0], [10, 0]), line('b', 'track', [10, 0], [20, 0])]);
  assert.equal(g.edges.length, 2);
  assert.equal(g.nodes.length, 3);
});

test('short spurs are removed but long ones and isolated segments stay', () => {
  const lines = [
    line('main', 'urban', [0, 0], [50, 0]),
    line('cross', 'urban', [25, -20], [25, 20]),
    line('spur', 'urban', [40, 0], [40, 2]), // 2 m dangle off the main road
    line('long', 'urban', [10, 0], [10, 15]),
    line('island', 'urban', [100, 100], [102, 100])
  ];
  const g = buildRoadGraph(lines);
  assert.equal(g.report.danglesRemoved, 1);
  assert.equal(g.report.components.length, 2);
  assert.ok(g.edges.some((e) => e.pts.some((p) => p[0] === 10 && p[1] === 15)));
  assert.ok(g.edges.some((e) => e.pts.some((p) => p[0] === 102)));
  assert.ok(!g.edges.some((e) => e.pts.some((p) => p[0] === 40 && p[1] === 2)));
});

test('heights are carried through inserted vertices and ids are stable and unique', () => {
  const lines = [line('a', 'urban', [0, 0, 100], [20, 0, 110]), line('b', 'urban', [10, -10, 105], [10, 10, 105])];
  const g1 = buildRoadGraph(lines), g2 = buildRoadGraph(lines);
  const mid = g1.nodes.find((n) => n.x === 10 && n.z === 0);
  assert.ok(Math.abs(mid.y - 105) < 1e-9);
  assert.deepEqual(g1.edges.map((e) => e.id), g2.edges.map((e) => e.id));
  assert.equal(new Set(g1.edges.map((e) => e.id)).size, g1.edges.length);
});

test('a closed loop survives and degenerate input is ignored', () => {
  const g = buildRoadGraph([
    line('loop', 'urban', [0, 0], [10, 0], [10, 10], [0, 10], [0, 0]),
    line('empty', 'urban', [5, 5]),
    line('dup', 'urban', [50, 50], [50, 50])
  ]);
  assert.equal(g.report.lines, 3);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].a, g.edges[0].b);
  assert.ok(Math.abs(g.edges[0].length - 40) < 1e-9);
});

test('parallel edges between the same two nodes keep distinct ids', () => {
  const g = buildRoadGraph([
    line('a', 'track', [0, 0], [10, 2], [20, 0]),
    line('b', 'track', [0, 0], [10, -2], [20, 0]),
    line('west', 'track', [-30, 0], [0, 0]), // keeps both end nodes at degree 3, so the pair is not merged into a loop
    line('east', 'track', [20, 0], [50, 0])
  ]);
  assert.equal(g.edges.length, 4);
  const pair = g.edges.filter((e) => e.pts.some((p) => p[0] === 10));
  assert.equal(pair.length, 2);
  assert.notEqual(pair[0].id, pair[1].id);
  assert.equal(new Set(g.edges.map((e) => e.id)).size, 4);
});
