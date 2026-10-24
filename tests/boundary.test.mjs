import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DEFAULT_SRC, extractBoundary, lonLatToUtm31, pointInPolygons, ringArea, summarise } from '../tools/vallromanes/build-boundary.mjs';

test('UTM 31N: central meridian and equator are exact', () => {
  const [e, n] = lonLatToUtm31(3, 0);
  assert.ok(Math.abs(e - 500000) < 1e-6);
  assert.ok(Math.abs(n) < 1e-6);
  const [e2, n2] = lonLatToUtm31(3, 41.5);
  assert.ok(Math.abs(e2 - 500000) < 1e-6);
  assert.ok(n2 > 4.59e6 && n2 < 4.61e6);
});

test('ringArea and pointInPolygons handle holes', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  assert.equal(Math.abs(ringArea(outer)), 100);
  assert.ok(pointInPolygons(1, 1, [[outer, hole]]));
  assert.ok(!pointInPolygons(5, 5, [[outer, hole]]));
  assert.ok(!pointInPolygons(11, 5, [[outer, hole]]));
});

test('extractBoundary needs exactly one match by INE code', () => {
  const feature = (code) => ({ properties: { CODIMUNI: code }, geometry: { type: 'MultiPolygon', coordinates: [[[[2, 41], [2.1, 41], [2.1, 41.1], [2, 41]]]] } });
  const gj = { features: [feature('082969'), feature('081234')] };
  assert.equal(extractBoundary(gj).utm.length, 1);
  assert.throws(() => extractBoundary({ features: [feature('081234')] }), /exactly one/);
  assert.throws(() => extractBoundary({ features: [feature('082969'), feature('082961')] }), /exactly one/);
});

test('real ICGC data: Vallromanes has the declared area and contains the Ajuntament', { skip: !fs.existsSync(DEFAULT_SRC) }, () => {
  const { properties, utm } = extractBoundary(JSON.parse(fs.readFileSync(DEFAULT_SRC, 'utf8')));
  const s = summarise(utm);
  assert.ok(Math.abs(s.areaKm2 - properties.AREAM5000) / properties.AREAM5000 < 0.01);
  assert.ok(pointInPolygons(441416.78, 4598030.37, utm));
  assert.ok(!pointInPolygons(450000, 4598030, utm));
});
