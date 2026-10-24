import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRoadIndex } from '../js/geo/road-index.js';
import { loadRoads } from '../js/geo/load-geodata.js';
import { nodeTrims } from '../js/world/street-geometry.js';

const edge = (extra) => ({ a: 0, b: 1, cls: 'urban', name: 'Carrer Prova', halfL: 3, halfR: 2.5, swL: 1.5, swR: 0, pts: [[0, 0, 10], [40, 0, 10]], ...extra });

test('classifies carriageway, pavement and nothing, with the left side towards +z for travel along +x', () => {
  const idx = createRoadIndex({ edges: [edge()] });
  assert.equal(idx.surfaceAt(20, 0), 'road');
  assert.equal(idx.surfaceAt(20, 2.9), 'road');
  assert.equal(idx.surfaceAt(20, 3.5), 'sidewalk'); // left (+z) has a 1.5 m pavement
  assert.equal(idx.surfaceAt(20, 4.6), null);
  assert.equal(idx.surfaceAt(20, -2.4), 'road');
  assert.equal(idx.surfaceAt(20, -3.0), null); // right side: no pavement
  assert.equal(idx.surfaceAt(60, 0), null);
  const q = idx.query(20, 1);
  assert.ok(Math.abs(q.s - 20) < 1e-9 && Math.abs(q.lateral - 1) < 1e-9);
});

test('pavements stop at junctions (trims) and tracks have none', () => {
  const nodes = [{ x: 0, z: 0, y: 10 }, { x: 40, z: 0, y: 10 }, { x: 20, z: 0, y: 10 }, { x: 20, z: 30, y: 10 }, { x: 20, z: -30, y: 10 }];
  const edges = [
    edge({ a: 0, b: 2, pts: [[0, 0, 10], [20, 0, 10]], swR: 1.5 }),
    edge({ a: 2, b: 1, pts: [[20, 0, 10], [40, 0, 10]], swR: 1.5 }),
    edge({ a: 2, b: 3, pts: [[20, 0, 10], [20, 30, 10]] }),
    edge({ a: 2, b: 4, pts: [[20, 0, 10], [20, -30, 10]] })
  ];
  const idx = createRoadIndex({ edges }, nodeTrims(nodes, edges));
  assert.equal(idx.surfaceAt(10, 3.6), 'sidewalk');
  assert.equal(idx.surfaceAt(16.9, 3.2), null, 'the pavement stops before the side street (and the side street pavement starts after it)');
  assert.equal(idx.surfaceAt(19, 3.6), 'road', 'and the side street mouth is carriageway');
  const track = createRoadIndex({ edges: [edge({ cls: 'track', swL: 1.5, halfL: 1.5, halfR: 1.5 })] });
  assert.equal(track.surfaceAt(20, 2.0), null);
  assert.equal(track.surfaceAt(20, 1.0), 'road');
});

test('names come from the nearest street within reach', () => {
  const idx = createRoadIndex({ edges: [edge(), edge({ name: 'Passeig Llarg', pts: [[0, 50, 12], [40, 50, 12]] })] });
  assert.equal(idx.nameAt(10, 4), 'Carrer Prova');
  assert.equal(idx.nameAt(10, 47), 'Passeig Llarg');
  assert.equal(idx.nameAt(10, 25), null);
  assert.equal(idx.nameAt(200, 200), null);
});

const root = fileURLToPath(new URL('../', import.meta.url));
test('baked roads load and index consistently', { skip: !fs.existsSync(`${root}data/roads.json`) }, async () => {
  const fsFetch = async (url) => {
    const file = `${root}${url.replace('./', '')}`;
    if (!fs.existsSync(file)) return { ok: false, status: 404 };
    const buf = fs.readFileSync(file);
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString()) };
  };
  const roads = await loadRoads('./data/', fsFetch);
  assert.ok(roads.edges.length > 500);
  assert.equal(new Set(roads.edges.map((e) => e.id)).size, roads.edges.length);
  for (const e of roads.edges) {
    assert.ok(e.halfL > 0 && e.halfR > 0 && e.pts.length >= 2);
    assert.ok(e.a < roads.nodes.length && e.b < roads.nodes.length);
  }
  const nodes = roads.nodes.map(([x, z, y]) => ({ x, z, y }));
  const idx = createRoadIndex(roads, nodeTrims(nodes, roads.edges));
  // the middle of every urban edge lies on its own carriageway
  for (const e of roads.edges.filter((r) => r.cls === 'urban').slice(0, 40)) {
    const m = e.pts[Math.floor(e.pts.length / 2)];
    assert.equal(idx.surfaceAt(m[0], m[1]), 'road');
  }
  await assert.rejects(loadRoads('./nowhere/', fsFetch), /HTTP 404/);
});
