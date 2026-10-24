import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadLabels } from '../js/geo/load-geodata.js';
import { attachNumbers, bakePlaces, dedupePlaces, pickTeleports, streetLabels, terrainKind, TELEPORTS, titleCase } from '../tools/vallromanes/build-labels.mjs';
import { fsFetch } from '../tools/vallromanes/fs-fetch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = (cas, t, x, z) => ({ kind: 'text', cas, text: t, coords: [[x, 0, z]] });

test('capital-letter names become title case, mixed-case names are left alone', () => {
  assert.equal(titleCase('VALLROMANES'), 'Vallromanes');
  assert.equal(titleCase("CLOT DE LES MERLES"), 'Clot De Les Merles');
  assert.equal(titleCase('Can Corbera'), 'Can Corbera');
  assert.equal(titleCase('A'), 'A');
});

test('terrain names are told apart by their first word, accents included', () => {
  assert.equal(terrainKind('Turó de Can Colomer'), 'hill');
  assert.equal(terrainKind("Turó d'en Moreu"), 'hill');
  assert.equal(terrainKind('el Pedró'), 'hill');
  assert.equal(terrainKind('la Roca Foradada'), 'hill');
  assert.equal(terrainKind('Coll de Forns'), 'pass');
  assert.equal(terrainKind('Bosc de Can Mitjans'), 'wood');
  assert.equal(terrainKind('Plana de Can Palau'), 'plain');
  assert.equal(terrainKind('Mas Vallromanes'), 'place');
});

test('places: kinds from the CAS codes, repeated names within 80 m are one place, far ones are two', () => {
  const places = bakePlaces([
    text('TOP_09EQ_TX', 'Ajuntament', 0, 0), text('TOP_09EQ_TX', 'Ajuntament', 10, 10),
    text('TOP_06_TX', 'Can Palau', 100, 0), text('TOP_06_TX', 'Can Palau', 400, 0),
    text('TOP_08AL_TX', 'LA SOLEIA', 5, 5), text('TOP_11PD_TX', 'Turó de Can Rabassa', 50, 50), text('TOP_07_TX', '12', 1, 1)
  ]);
  assert.deepEqual(places.map((p) => [p.kind, p.name]), [['facility', 'Ajuntament'], ['masia', 'Can Palau'], ['masia', 'Can Palau'], ['settlement', 'La Soleia'], ['hill', 'Turó de Can Rabassa']]);
  assert.equal(new Set(places.map((p) => p.id)).size, places.length);
  assert.equal(dedupePlaces([{ kind: 'a', name: 'X', x: 0, z: 0 }, { kind: 'b', name: 'X', x: 1, z: 1 }]).length, 2);
});

test('street labels: one per name every 250 m on the middle of long edges, reading left to right', () => {
  const edge = (name, pts, cls = 'urban') => ({ name, cls, length: Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), pts });
  const labels = streetLabels([
    edge('Carrer Llarg', [[0, 0, 0], [300, 0, 0]]), edge('Carrer Llarg', [[300, 0, 0], [450, 0, 0]]), edge('Carrer Llarg', [[0, 20, 0], [100, 20, 0]]), edge('Carrer Llarg', [[800, 0, 0], [900, 0, 0]]),
    edge('Carrer Curt', [[0, 50, 0], [20, 50, 0]]), edge('Camí', [[0, 80, 0], [60, 80, 0]], 'track'), edge(null, [[0, 90, 0], [90, 90, 0]]),
    edge('Carrer Invers', [[100, 0, 0], [0, 0, 0]])
  ]);
  const llarg = labels.filter((l) => l.name === 'Carrer Llarg');
  // the 300 m edge; the 150 m and 100 m edges are within 250 m of it; the 100 m one at x = 800 is far enough
  assert.equal(llarg.length, 2);
  assert.ok(llarg.every((l) => l.major));
  assert.ok(!labels.some((l) => l.name === 'Camí'));
  assert.equal(labels.filter((l) => l.name === 'Carrer Curt').length, 1, 'a short street still gets one label');
  assert.equal(labels.find((l) => l.name === 'Carrer Curt').major, false);
  const inv = labels.find((l) => l.name === 'Carrer Invers');
  assert.ok(Math.abs(inv.angle) < 1e-9, 'a westbound street is written the right way up');
  assert.ok(labels.every((l) => l.angle > -Math.PI / 2 && l.angle <= Math.PI / 2));
});

test('house numbers attach to the building they stand in or beside', () => {
  const sq = (x, z, s) => Float32Array.from([x, z, x + s, z, x + s, z + s, x, z + s]);
  const structures = [{ id: 'b1', kindName: 'building', rings: [sq(0, 0, 10)] }, { id: 'sh', kindName: 'shed', rings: [sq(50, 0, 5)] }, { id: 'b2', kindName: 'building', rings: [sq(30, 0, 10)] }];
  const n = attachNumbers([text('TOP_07_TX', '5', 5, 5), text('TOP_07_TX', '7', 12, 5), text('TOP_07_TX', '9', 52, 2), text('TOP_07_TX', '10', 52, 30), text('TOP_07_TX', '11', 200, 200)], structures);
  // inside, 2 m away, beside a shed (so the house 12 m away), too far from any house, nothing near
  assert.deepEqual(n.map((x) => x.building), ['b1', 'b1', 'b2', null, null]);
  assert.deepEqual(n.map((x) => x.text), ['5', '7', '9', '10', '11']);
});

test('teleports: curated names in order, sub-title from the street or the category, outside places dropped', () => {
  const places = [
    { kind: 'facility', name: 'Ajuntament', x: 0, z: 0 }, { kind: 'facility', name: 'Zona Esportiva', x: 5, z: 5 }, { kind: 'facility', name: 'Zona Esportiva', x: 900, z: 900 },
    { kind: 'hill', name: 'el Pedró', x: -250, z: 186 }, { kind: 'masia', name: 'Can Corbera', x: -1600, z: 200 }, { kind: 'facility', name: 'Bar sense nom', x: 1, z: 1 }
  ];
  const tp = pickTeleports(places, { streetNear: (x, z) => (Math.abs(x) < 10 ? 'Plaça de la Vila' : null), inside: (x) => x > -1000 });
  assert.deepEqual(tp.map((t) => t.name), ['Ajuntament', 'Zona Esportiva', 'el Pedró']);
  assert.equal(tp[0].sub, 'near Plaça de la Vila');
  assert.equal(tp[2].sub, 'Hill');
  assert.equal(tp[1].x, 5, 'the first of repeated names');
  assert.equal(new Set(tp.map((t) => t.id)).size, tp.length);
  assert.ok(tp.every((t) => Number.isFinite(t.heading)));
  assert.ok(TELEPORTS.every(([, name, kind, re]) => name && kind && re instanceof RegExp));
});

const baked = fs.existsSync(`${root}data/labels.json`);
test('baked labels load, stay inside the municipality and include the Ajuntament at the origin', { skip: !baked }, async () => {
  const { places, streets, numbers, teleports } = await loadLabels('./data/', fsFetch());
  assert.ok(places.length > 150 && streets.length > 100 && numbers.length > 800 && teleports.length >= 25);
  const aj = teleports.find((t) => t.name === 'Ajuntament');
  assert.ok(Math.hypot(aj.x, aj.z) < 5);
  assert.ok(teleports.every((t) => t.name && t.sub && t.category));
  assert.ok(streets.every((s) => s.name && Number.isFinite(s.angle)));
  await assert.rejects(loadLabels('./nowhere/', fsFetch()), /HTTP 404/);
});
