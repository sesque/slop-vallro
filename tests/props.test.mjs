import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRoadIndex } from '../js/geo/road-index.js';
import { loadProps } from '../js/geo/load-geodata.js';
import { createCircleCollider, fountainGeometry, lampGeometry, lampYaw, pillarGeometry, poleGeometry, treeSites } from '../js/world/props.js';
import { bakeProps, buildingLookup, propTypeOf, PROP_TYPES } from '../tools/vallromanes/build-props.mjs';
import { fsFetch } from '../tools/vallromanes/fs-fetch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const square = [-500, -500, 500, -500, 500, 500, -500, 500];
const point = (cas, x, z, angle = 0) => ({ kind: 'point', cas, coords: [[x, 100, z]], angle });

test('props map CAS codes to types', () => {
  assert.equal(PROP_TYPES[propTypeOf('VEG_03_PT')].name, 'tree');
  assert.equal(PROP_TYPES[propTypeOf('ENE_06_PT')].name, 'lamp');
  assert.equal(PROP_TYPES[propTypeOf('HID_15_PT')].name, 'fountain');
  assert.equal(propTypeOf('CON_29_PT'), -1);
  assert.equal(propTypeOf('ORO_03_PT'), -1);
});

test('bakeProps drops props outside the boundary, trees inside buildings and duplicates, and converts the angle', () => {
  const inBuilding = buildingLookup([{ open: false, rings: [Float32Array.from([10, 10, 20, 10, 20, 20, 10, 20])] }]);
  const { out, dropped } = bakeProps([
    point('VEG_03_PT', 0, 0),
    point('VEG_03_PT', 0.1, 0.1), // duplicate
    point('VEG_03_PT', 15, 15), // inside the building
    point('VEG_03_PT', 900, 900), // outside
    point('ENE_06_PT', 15, 15), // a lamp is kept even there
    point('HID_14_PT', 50, 50, 90),
    { kind: 'line', cas: 'VEG_03_PT', coords: [[0, 0, 0]] }
  ], { boundaryRings: [square], insideBuilding: inBuilding });
  assert.deepEqual(dropped, { outside: 1, inBuilding: 1, duplicate: 1 });
  assert.equal(out[propTypeOf('VEG_03_PT')].length, 3);
  assert.equal(out[propTypeOf('ENE_06_PT')].length, 3);
  const gully = out[propTypeOf('HID_14_PT')];
  assert.ok(Math.abs(gully[2] - -Math.PI / 2) < 1e-6);
});

test('circle colliders push out along the line from the centre and ignore distant circles', () => {
  const c = createCircleCollider(10, 20, 0.28, 6);
  assert.ok(c.minX < 10 && c.maxX > 10 && c.maxY === 6);
  assert.equal(c.pushOut(13, 20, 0.48), null);
  const p = c.pushOut(10.4, 20, 0.48);
  assert.ok(Math.abs(p.x - (10 + 0.76)) < 1e-9 && p.nx === 1 && p.nz === 0);
  const center = c.pushOut(10, 20, 0.48); // dead centre: any direction
  assert.ok(Math.abs(Math.hypot(center.x - 10, center.z - 20) - 0.76) < 1e-9);
});

test('a lamp bracket points across the road from either side', () => {
  const road = { halfL: 3, halfR: 3, swL: 1.5, swR: 1.5, cls: 'urban', a: 0, b: 1, name: 'X', pts: [[0, 0, 10], [100, 0, 10]] }; // travelling +x, left is +z
  const idx = createRoadIndex({ edges: [road] });
  // lamp on the left (+z) pavement: the road is towards -z, local +z must point to world -z: yaw = pi
  const left = lampYaw(50, 4, idx);
  assert.ok(Math.abs(Math.sin(left)) < 1e-9 && Math.cos(left) < -0.99, `left yaw ${left}`);
  const right = lampYaw(50, -4, idx);
  assert.ok(Math.abs(Math.sin(right)) < 1e-9 && Math.cos(right) > 0.99, `right yaw ${right}`);
  assert.equal(lampYaw(500, 500, idx, 1.25), 1.25, 'no street near: the fallback');
  assert.equal(lampYaw(50, 4, null, 0.5), 0.5);
});

test('treeSites: deterministic species mix and sizes, heights from the ground', () => {
  const positions = Float32Array.from({ length: 3000 }, (_, i) => (i % 3 === 2 ? 0 : (i * 7.31) % 400));
  const a = treeSites(positions, (x, z) => x + z), b = treeSites(positions, (x, z) => x + z);
  assert.deepEqual(a, b);
  assert.equal(a.length, 1000);
  const share = [0, 1, 2].map((s) => a.filter((t) => t.species === s).length / a.length);
  assert.ok(share[0] > 0.32 && share[0] < 0.48 && share[1] > 0.22 && share[2] > 0.22, `species ${share}`);
  assert.ok(a.every((t) => t.scale >= 0.5 && t.scale <= 0.9 && t.y === t.x + t.z));
});

test('prop geometries are merged, finite and stand on the ground', () => {
  for (const [geo, height] of [[lampGeometry(), 5.6], [poleGeometry(), 8.5], [pillarGeometry(), 1.62], [fountainGeometry(), 1.57]]) {
    geo.computeBoundingBox();
    assert.ok(Math.abs(geo.boundingBox.min.y) < 0.2, 'rests on y = 0');
    assert.ok(geo.boundingBox.max.y > height - 0.2 && geo.boundingBox.max.y < height + 0.3, `height ${geo.boundingBox.max.y}`);
    assert.ok(geo.attributes.position.array.every(Number.isFinite));
  }
  const lamp = lampGeometry();
  lamp.computeBoundingBox();
  assert.ok(lamp.boundingBox.max.z > 1.3, 'the bracket reaches out along +z');
});

const baked = fs.existsSync(`${root}data/props.bin`);
test('baked props load and the counts match the survey', { skip: !baked }, async () => {
  const { props, meta } = await loadProps('./data/', fsFetch());
  assert.ok(props.tree.length / 3 > 11000 && props.lamp.length / 3 > 1500 && props.pole.length / 3 > 600);
  assert.equal(meta.types.reduce((s, t) => s + t.count * 3, 0), Object.values(props).reduce((s, a) => s + a.length, 0));
  for (const a of Object.values(props)) assert.ok(a.every(Number.isFinite) && a.length % 3 === 0);
  await assert.rejects(loadProps('./nowhere/', fsFetch()), /HTTP 404/);
});
