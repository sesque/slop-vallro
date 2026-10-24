import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLaneGraph, laneAt, laneProject } from '../js/geo/lane-graph.js';
import { buildPavementGraph } from '../js/geo/pavement-graph.js';
import { nodeTrims } from '../js/world/street-geometry.js';
import { TrafficSim } from '../js/traffic-sim.js';
import { WalkerSim } from '../js/walkers-sim.js';

const edge = (id, a, b, pts, extra = {}) => ({ id, a, b, cls: 'urban', name: id, halfL: 3, halfR: 3, swL: 1.5, swR: 1.5, osm: 'residential', speed: 30, length: Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), pts, ...extra });
// a plus-shaped junction: the east-west street crosses the north-south one at node 0
const plus = () => ({
  nodes: [[0, 0, 10], [100, 0, 10], [-100, 0, 10], [0, 100, 10], [0, -100, 10]],
  edges: [
    edge('e', 0, 1, [[0, 0, 10], [100, 0, 10]]), edge('w', 0, 2, [[0, 0, 10], [-100, 0, 10]]),
    edge('s', 0, 3, [[0, 0, 10], [0, 100, 10]]), edge('n', 0, 4, [[0, 0, 10], [0, -100, 10]])
  ]
});

test('lanes keep to the right of the direction of travel and one-way streets get one lane', () => {
  const roads = plus();
  roads.edges[0].oneway = 1;
  const g = buildLaneGraph(roads);
  const east = g.lanes.filter((l) => l.edge === 'e');
  assert.equal(east.length, 1);
  assert.ok(east[0].z[0] > 0, 'travelling +x, the right-hand side is +z (the map is z-south)');
  const west = g.lanes.find((l) => l.edge === 'w' && l.from === 0);
  assert.ok(west.z[0] < 0, 'travelling -x, the right-hand side is -z');
  assert.equal(g.lanes.filter((l) => l.edge === 's').length, 2);
});

test('a junction connects every lane to the other streets, never back along its own street', () => {
  const g = buildLaneGraph(plus());
  assert.equal(g.nodes[0].control, true);
  for (const l of g.lanes.filter((x) => x.to === 0)) {
    assert.equal(l.next.length, 3);
    assert.ok(l.next.every((n) => n.lane.edge !== l.edge && n.lane.from === 0));
    const straight = l.next.reduce((a, b) => (Math.abs(a.turn) < Math.abs(b.turn) ? a : b));
    assert.ok(Math.abs(straight.turn) < 0.1 && straight.weight >= Math.max(...l.next.map((n) => n.weight)) - 1e-9, 'straight on is the likeliest');
  }
  assert.equal(g.gates.length, 1);
});

test('laneAt and laneProject agree', () => {
  const g = buildLaneGraph(plus());
  const lane = g.lanes.find((l) => l.edge === 'e' && l.from === 0);
  const p = {};
  laneAt(lane, 40, p);
  assert.ok(Math.abs(p.x - 40) < 1e-9 && p.dx > 0.99);
  assert.ok(Math.abs(laneProject(lane, p.x, p.z).s - 40) < 1e-9);
});

test('a car follows its leader and stops for a car that holds the junction', () => {
  const g = buildLaneGraph(plus(), { trims: nodeTrims([...plus().nodes.map((p) => ({ x: p[0], z: p[1], y: p[2] }))], plus().edges) });
  const sim = new TrafficSim(g, { count: 2, seed: 1 });
  const lane = g.lanes.find((l) => l.edge === 'w' && l.to === 0);
  const put = (c, s, speed) => {
    c.active = true; c.lane = lane; c.s = s; c.seg = laneAt(lane, s, {}); const p = {}; laneAt(lane, s, p);
    c.x = p.x; c.z = p.z; c.yaw = Math.atan2(p.dx, p.dz); c.speed = speed; lane.cars.push(c);
  };
  put(sim.cars[0], 60, 0);
  put(sim.cars[1], 10, 8);
  sim.cars[0].stuck = 0;
  sim.target = 0;
  for (let i = 0; i < 100; i++) {
    sim.cars[0].speed = 0; // the leader stands still
    sim.step(sim.cars[1], 0.1);
    assert.ok(sim.cars[1].s < sim.cars[0].s - 4.5 + 0.01, 'never into the car ahead');
  }
  assert.ok(sim.cars[1].speed < 0.3, 'and it has stopped behind it');
});

test('a walker on a crossing makes cars wait; cars let them cross first', () => {
  const roads = plus();
  const trims = nodeTrims(roads.nodes.map((p) => ({ x: p[0], z: p[1], y: p[2] })), roads.edges);
  const g = buildLaneGraph(roads, { trims });
  const sim = new TrafficSim(g, { count: 1, seed: 1 });
  const lane = g.lanes.find((l) => l.edge === 'w' && l.to === 0);
  const c = sim.cars[0];
  const p = {};
  laneAt(lane, 70, p);
  Object.assign(c, { active: true, lane, s: 70, seg: 0, x: p.x, z: p.z, yaw: Math.atan2(p.dx, p.dz), speed: 6 });
  lane.cars.push(c);
  g.nodes[0].pedsCrossing = 1;
  for (let i = 0; i < 300; i++) sim.step(c, 0.1);
  assert.ok(c.lane === lane && c.speed < 0.1 && c.s < lane.length - 4, 'it waits at the line');
  g.nodes[0].pedsCrossing = 0;
  for (let i = 0; i < 300; i++) sim.step(c, 0.1);
  assert.ok(c.lane !== lane || !c.active, 'and goes on once the crossing is free');
});

test('pavement links: corners join round the junction and crossings join the two sides of each street', () => {
  const roads = plus();
  const trims = nodeTrims(roads.nodes.map((p) => ({ x: p[0], z: p[1], y: p[2] })), roads.edges);
  const pav = buildPavementGraph(roads, trims);
  assert.equal(pav.links.filter((l) => l.kind === 'walk').length, 8);
  assert.equal(pav.links.filter((l) => l.kind === 'cross').length, 4);
  for (const l of pav.links.filter((x) => x.kind === 'walk')) {
    assert.ok(l.ends[0].length >= 2, 'each pavement end meets a corner and a crossing');
  }
  for (const l of pav.links.filter((x) => x.kind === 'cross')) assert.ok(l.length > 5 && l.length < 8);
});

test('on the real streets: the graphs are connected enough and walkers never cross under a moving car', () => {
  const roads = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../data/roads.json', import.meta.url)), 'utf8'));
  const trims = nodeTrims(roads.nodes.map((p) => ({ x: p[0], z: p[1], y: p[2] })), roads.edges);
  const g = buildLaneGraph(roads, { trims });
  assert.ok(g.lanes.length > 500);
  assert.ok(g.lanes.filter((l) => l.next.length === 0).length <= 5, 'few lanes dead-end');
  const pav = buildPavementGraph(roads, trims);
  assert.ok(pav.totalLength > 30000);
  const sim = new TrafficSim(g, { count: 60, seed: 4 });
  const walkers = new WalkerSim(pav, g, { count: 60, seed: 4 });
  sim.reset(0, 0);
  walkers.reset(0, 0, 400);
  let violations = 0;
  for (let i = 0; i < 6000; i++) {
    sim.update(0.1, 0, 0);
    walkers.update(0.1, 0, 0);
    for (const gate of g.gates) if (gate.holder && gate.nodes.some((n) => n.pedsCrossing > 0)) violations++;
  }
  assert.equal(violations, 0, 'no car holds a junction while someone is on its crossing');
  assert.ok(walkers.stats.crossings > 20, 'people do cross');
});

test('no deadlocks: over half an hour of driving at three places, cars keep moving', () => {
  const roads = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../data/roads.json', import.meta.url)), 'utf8'));
  const trims = nodeTrims(roads.nodes.map((p) => ({ x: p[0], z: p[1], y: p[2] })), roads.edges);
  const g = buildLaneGraph(roads, { trims });
  for (const [seed, fx, fz] of [[1, 0, 0], [2, -400, 300], [5, -600, -900]]) {
    const sim = new TrafficSim(g, { count: 60, seed });
    sim.reset(fx, fz);
    let overlap = 0;
    for (let i = 0; i < 18000; i++) {
      sim.update(0.1, fx, fz);
      if (i % 50 === 0) {
        for (const l of g.lanes) {
          const c = [...l.cars].sort((a, b) => a.s - b.s);
          for (let k = 1; k < c.length; k++) if (c[k].s - 0.87 - (c[k - 1].s + 3.63) < -3) overlap++;
        }
      }
    }
    assert.ok(sim.stats.stuckRemoved <= 3, `seed ${seed}: ${sim.stats.stuckRemoved} cars were stuck for 90 s`);
    assert.ok(overlap <= 5, `seed ${seed}: cars overlapped ${overlap} times`);
    assert.ok(sim.cars.filter((c) => c.active).length > 10);
  }
});
