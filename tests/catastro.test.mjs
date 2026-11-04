import assert from 'node:assert/strict';
import test from 'node:test';
import { USE, makeIndex, parseBuildings, parseParts, useOf } from '../tools/vallromanes/catastro.mjs';
import { styleOf } from '../js/world/building-geometry.js';
import { E0, N0 } from '../tools/vallromanes/frame.mjs';

const building = (ref, use, year, dwellings = 1) => `<gml:featureMember><bu-ext2d:Building gml:id="ES.SDGC.BU.${ref}">
  <bu-core2d:dateOfConstruction><bu-core2d:DateOfEvent><bu-core2d:beginning>${year}-01-01T00:00:00</bu-core2d:beginning><bu-core2d:end>${year}-01-01T00:00:00</bu-core2d:end></bu-core2d:DateOfEvent></bu-core2d:dateOfConstruction>
  <bu-ext2d:currentUse>${use}</bu-ext2d:currentUse><bu-ext2d:numberOfDwellings>${dwellings}</bu-ext2d:numberOfDwellings></bu-ext2d:Building></gml:featureMember>`;
// a 10 x 10 m part with its south-west corner at local (x0, z0): E = E0 + x, N = N0 - z
const part = (ref, n, floors, x0, z0) => {
  const c = [[x0, z0], [x0 + 10, z0], [x0 + 10, z0 + 10], [x0, z0 + 10], [x0, z0]].map(([x, z]) => `${E0 + x} ${N0 - z}`).join(' ');
  return `<bu-ext2d:BuildingPart gml:id="ES.SDGC.BU.${ref}_part${n}"><bu-ext2d:geometry><gml:posList srsDimension="2">${c}</gml:posList></bu-ext2d:geometry><bu-ext2d:numberOfFloorsAboveGround>${floors}</bu-ext2d:numberOfFloorsAboveGround></bu-ext2d:BuildingPart>`;
};

test('useOf maps the Catastro use text', () => {
  assert.equal(useOf('1_residential'), USE.RESIDENTIAL);
  assert.equal(useOf('2_agriculture'), USE.AGRICULTURE);
  assert.equal(useOf('3_industrial'), USE.INDUSTRIAL);
  assert.equal(useOf('4_2_retail'), USE.RETAIL);
  assert.equal(useOf('4_3_publicServices'), USE.PUBLIC);
  assert.equal(useOf(''), USE.UNKNOWN);
});

test('parseBuildings keeps use and year, and treats the placeholder 1900 and a broken date as unknown', () => {
  const b = parseBuildings(building('A1', '1_residential', 1987, 2) + building('A2', '2_agriculture', 1900) + building('A3', '', '-'));
  assert.deepEqual(b.get('A1'), { use: USE.RESIDENTIAL, year: 1987, dwellings: 2 });
  assert.equal(b.get('A2').year, 0);
  assert.equal(b.get('A3').year, 0);
});

test('parseParts reads floors and the centroid in the local frame', () => {
  const parts = parseParts(part('A1', 1, 2, 100, 50));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].ref, 'A1');
  assert.equal(parts[0].floors, 2);
  assert.ok(Math.abs(parts[0].x - 104) < 1e-6 && Math.abs(parts[0].z - 54) < 1e-6, 'the mean of the five ring points, closing point included');
});

test('a footprint takes the most floors of the parts inside it and the use and year of their building', () => {
  const idx = makeIndex(parseBuildings(building('A1', '3_industrial', 1975)), parseParts(part('A1', 1, 1, 100, 50) + part('A1', 2, 3, 100, 50)));
  const footprint = [Float32Array.from([98, 48, 112, 48, 112, 62, 98, 62])];
  assert.deepEqual(idx.lookup(footprint), { floors: 3, use: USE.INDUSTRIAL, year: 1975, parts: 2, ref: 'A1' });
  assert.equal(idx.lookup([Float32Array.from([0, 0, 5, 0, 5, 5, 0, 5])]), null, 'no part inside: no join');
});

test('styleOf packs use and era into 0..23', () => {
  assert.equal(styleOf({}), 0);
  assert.equal(styleOf({ use: USE.RESIDENTIAL, year: 1930 }), 1);
  assert.equal(styleOf({ use: USE.RESIDENTIAL, year: 1975 }), 2);
  assert.equal(styleOf({ use: USE.RESIDENTIAL, year: 2005 }), 3);
  assert.equal(styleOf({ use: USE.AGRICULTURE, year: 0 }), 4);
  assert.equal(styleOf({ use: USE.PUBLIC, year: 1990 }), 19);
  for (const use of [0, 1, 2, 3, 4, 5, 6]) for (const year of [0, 1900, 1960, 2010]) assert.ok(styleOf({ use, year }) < 24);
});
