import assert from 'node:assert/strict';
import test from 'node:test';
import { lonLatToUtm31 } from '../tools/vallromanes/build-boundary.mjs';
import { E0, N0 } from '../tools/vallromanes/frame.mjs';
import { matchOsm, osmAttributes, parseMaxspeed, wayToLocal } from '../tools/vallromanes/osm-match.mjs';
import { boundingBoxOf, overpassQuery } from '../tools/vallromanes/fetch-osm.mjs';

// An OSM way along local x (z fixed) built from lon/lat by inverting the projection numerically
function wayAt(zLocal, x0, x1, tags, id = 1) {
  const toLonLat = (x, z) => {
    let lon = 2.31, lat = 41.55;
    for (let k = 0; k < 20; k++) {
      const [e, n] = lonLatToUtm31(lon, lat);
      lon -= ((e - E0) - x) / 75000;
      lat -= ((N0 - n) - z) / -111000;
    }
    return { lon, lat };
  };
  const pts = [];
  for (let x = x0; x <= x1; x += 10) pts.push(toLonLat(x, zLocal));
  return { type: 'way', id, tags, geometry: pts };
}

test('wayToLocal round trips through the projection', () => {
  const w = wayAt(120, -50, 50, { highway: 'residential' });
  const p = wayToLocal(w);
  assert.ok(Math.abs(p[0][0] - -50) < 0.05 && Math.abs(p[0][1] - 120) < 0.05);
  assert.ok(Math.abs(p[p.length - 1][0] - 50) < 0.05);
});

test('parseMaxspeed and osmAttributes', () => {
  assert.equal(parseMaxspeed('30'), 30);
  assert.equal(parseMaxspeed('50 mph'), 80);
  assert.equal(parseMaxspeed('ES:urban'), 50);
  assert.equal(parseMaxspeed('none'), null);
  assert.deepEqual(osmAttributes({ highway: 'residential', oneway: 'yes', lanes: '1', maxspeed: '30', name: 'X' }, true), { osm: 'residential', oneway: 1, lanes: 1, speed: 30, osmName: 'X' });
  assert.equal(osmAttributes({ oneway: 'yes' }, false).oneway, -1);
  assert.equal(osmAttributes({ oneway: '-1' }, true).oneway, -1);
  assert.equal(osmAttributes({ oneway: 'no' }, true).oneway, false);
  assert.equal(osmAttributes({ junction: 'roundabout' }, true).oneway, 1);
  assert.equal(osmAttributes({ highway: 'track' }, true).oneway, undefined);
});

test('an edge matches the way along it, not a distant or crossing one, and the direction decides the oneway sign', () => {
  const edges = [
    { pts: [[-40, 120, 0], [40, 120.5, 0]] }, // along the way
    { pts: [[-40, 300, 0], [40, 300, 0]] }, // nothing near
    { pts: [[40, 119, 0], [-40, 119, 0]] } // along the way but running the other direction
  ];
  const ways = [
    wayAt(120, -60, 60, { highway: 'residential', oneway: 'yes', maxspeed: '30', lanes: '1' }, 11),
    wayAt(160, -60, 60, { highway: 'service' }, 12)
  ];
  const m = matchOsm(edges, ways);
  assert.equal(m[0].wayId, 11);
  assert.equal(m[0].attrs.oneway, 1);
  assert.equal(m[0].attrs.speed, 30);
  assert.equal(m[1], null);
  assert.equal(m[2].attrs.oneway, -1);
});

test('the best covering way wins and a partial overlap below the share is rejected', () => {
  const edge = [{ pts: [[-40, 120, 0], [40, 120, 0]] }];
  const both = matchOsm(edge, [wayAt(126, -60, 60, { highway: 'service' }, 1), wayAt(121, -60, 60, { highway: 'residential' }, 2)]);
  assert.equal(both[0].wayId, 2);
  const partial = matchOsm(edge, [wayAt(120, 10, 60, { highway: 'residential' }, 3)]); // covers only a quarter
  assert.equal(partial[0], null);
});

test('Overpass query uses the municipal bounding box with padding', () => {
  const gj = { features: [{ properties: { CODIMUNI: '082969' }, geometry: { type: 'MultiPolygon', coordinates: [[[[2.28, 41.54], [2.35, 41.54], [2.35, 41.57], [2.28, 41.57], [2.28, 41.54]]]] } }] };
  const b = boundingBoxOf(gj);
  assert.ok(Math.abs(b.west - 2.278) < 1e-9 && Math.abs(b.north - 41.572) < 1e-9);
  const q = overpassQuery(b);
  assert.match(q, /way\["highway"\]\(41\.53800,2\.27800,41\.57200,2\.35200\)/);
  assert.throws(() => boundingBoxOf({ features: [] }), /not found/);
});

test('footways beside a street do not lend it their attributes, but a track may match a path', () => {
  const edges = [{ cls: 'urban', pts: [[-40, 120, 0], [40, 120, 0]] }, { cls: 'track', pts: [[-40, 120, 0], [40, 120, 0]] }];
  const ways = [wayAt(120, -60, 60, { highway: 'footway' }, 5)];
  const m = matchOsm(edges, ways);
  assert.equal(m[0], null);
  assert.equal(m[1].wayId, 5);
  const withRoad = matchOsm([edges[0]], [wayAt(120, -60, 60, { highway: 'footway' }, 5), wayAt(123, -60, 60, { highway: 'residential' }, 6)]);
  assert.equal(withRoad[0].wayId, 6);
});
