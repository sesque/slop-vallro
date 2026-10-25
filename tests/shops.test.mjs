import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { bakeShops, findBuilding, placeSign, resolvePoint, spreadSigns } from '../tools/vallromanes/build-shops.mjs';
import { lonLatToLocal } from '../tools/vallromanes/utm.mjs';
import { CELL_H, CELL_W, SIGN_DEPTH, atlasSize, buildSignGeometry, cellUv } from '../js/world/sign-geometry.js';

// a 12 x 6 m building with its long wall along z = 6 (the street is to the south, z grows southwards)
const house = (id = 'h1', x0 = 0, z0 = 0) => ({ id, kind: 0, top: 10, base: 0, rings: [Float32Array.from([x0, z0, x0 + 12, z0, x0 + 12, z0 + 6, x0, z0 + 6])] });

test('lonLatToLocal agrees with a point checked on the ground (the town hall of the Commons category)', () => {
  const p = lonLatToLocal(2 + 17 / 60 + 52.39 / 3600, 41 + 31 / 60 + 54.52 / 3600);
  assert.ok(Math.abs(p.x - 11.1) < 0.3 && Math.abs(p.z + 3.8) < 0.3, `${p.x}, ${p.z}`);
});

test('findBuilding: the building that contains a point, else the nearest within reach, else none', () => {
  const s = [house('a'), house('b', 100, 0)];
  assert.equal(findBuilding(s, 5, 3).id, 'a');
  assert.equal(findBuilding(s, 5, 15).id, 'a', '9 m south of the wall');
  assert.equal(findBuilding(s, 50, 3), null);
});

test('resolvePoint: survey places, degrees, house numbers, and a missing number estimated between its neighbours', () => {
  const ctx = {
    places: [{ name: 'Can Matias', x: 10, z: 20 }, { name: 'Golf', x: 1, z: 1 }, { name: 'Golf', x: 2, z: 2 }],
    numbers: [{ text: '39', x: 0, z: 0, building: 'b39' }, { text: '43', x: 40, z: 0, building: null }, { text: '40', x: 5, z: 5, building: 'b40' }, { text: '7', x: 999, z: 999 }, { text: '42-44', x: 60, z: 0 }],
    streetAt: (x, z) => (x === 999 ? 'Carrer Altre' : 'Rambla')
  };
  assert.deepEqual(resolvePoint({ place: 'Can Matias' }, ctx), { x: 10, z: 20 });
  assert.equal(resolvePoint({ place: 'Golf', index: 1 }, ctx).x, 2);
  assert.equal(resolvePoint({ place: 'Nowhere' }, ctx), null);
  assert.ok(resolvePoint({ lat: 41.53, lon: 2.29 }, ctx).x < 0);
  assert.equal(resolvePoint({ street: 'Rambla', number: '39' }, ctx).building, 'b39');
  assert.equal(resolvePoint({ street: 'Rambla', number: '44' }, ctx).x, 60, 'a range of numbers covers its members');
  const between = resolvePoint({ street: 'Rambla', number: '41' }, ctx);
  assert.ok(between.estimated && Math.abs(between.x - 20) < 1e-9, 'half way between 39 and 43');
  assert.equal(resolvePoint({ street: 'Carrer Altre', number: '9' }, ctx), null);
});

test('placeSign: on the wall nearest the anchor, facing out, above the door, inside the wall', () => {
  const sign = placeSign(house(), { x: 6, z: 7 }, 'Ca la Pilu', () => 0);
  assert.ok(Math.abs(sign.z - 6) < 1e-6, 'on the south wall');
  assert.ok(Math.abs(sign.nx) < 1e-9 && sign.nz === 1, 'its outward normal points south');
  assert.equal(sign.y, 3.1);
  assert.ok(sign.x - sign.width / 2 >= -1e-9 && sign.x + sign.width / 2 <= 12 + 1e-9);
  const low = placeSign({ ...house(), top: 3.5 }, { x: 6, z: 7 }, 'Ca la Pilu', () => 0);
  assert.ok(low.y + low.height <= 3.5, 'a low building gets a lower sign');
});

test('spreadSigns: shops on one wall sit side by side without overlap and inside the wall', () => {
  const b = house();
  const a = { ...placeSign(b, { x: 6, z: 7 }, 'Estanc', () => 0), building: 'h1' };
  const c = { ...placeSign(b, { x: 6, z: 7 }, 'Blue Moon', () => 0), building: 'h1' };
  spreadSigns([a, c]);
  assert.ok(Math.abs(a.x - c.x) >= (a.width + c.width) / 2, 'no overlap');
  for (const s of [a, c]) assert.ok(s.x - s.width / 2 >= -1e-6 && s.x + s.width / 2 <= 12 + 1e-6);
  const crowded = [1, 2, 3].map((i) => ({ ...placeSign(b, { x: 6, z: 7 }, 'Un nom molt llarg ' + i, () => 0), building: 'h1' }));
  spreadSigns(crowded);
  const lo = Math.min(...crowded.map((s) => s.x - s.width / 2)), hi = Math.max(...crowded.map((s) => s.x + s.width / 2));
  assert.ok(lo >= -1e-6 && hi <= 12 + 1e-6, 'too many names shrink to fit the wall');
});

test('bakeShops reports what it could not place', () => {
  const ctx = { places: [], numbers: [], streetAt: () => '' };
  const { placed, skipped } = bakeShops([{ name: 'A', sector: 'shop', at: { lat: 41.60, lon: 2.30 } }, { name: 'B', sector: 'shop', at: { street: 'X', number: '1' } }], ctx, [house()], () => 0);
  assert.equal(placed.length, 0);
  assert.equal(skipped.length, 2);
});

test('sign geometry: six faces per sign, the front outward and reading its own cell, the others reading the cell edge', () => {
  const shops = [{ x: 5, y: 3, z: 6, nx: 0, nz: 1, width: 4, height: 0.75 }, { x: 20, y: 3, z: 6, nx: 0, nz: 1, width: 3, height: 0.75 }];
  const g = buildSignGeometry(shops);
  assert.equal(g.position.length / 3, 2 * 6 * 4);
  assert.equal(g.index.length, 2 * 6 * 6);
  // the first face of the first sign: at z = 6 + depth, reading cell 0
  assert.ok([0, 1, 2, 3].every((i) => Math.abs(g.position[i * 3 + 2] - (6 + SIGN_DEPTH)) < 1e-6));
  const c = cellUv(0, 2);
  assert.ok(Math.abs(g.uv[0] - c.u0) < 1e-9 && Math.abs(g.uv[2] - c.u1) < 1e-9);
  // every triangle faces the way its normal says
  for (let t = 0; t < g.index.length; t += 3) {
    const [a, b, d] = [0, 1, 2].map((k) => { const i = g.index[t + k]; return [g.position[i * 3], g.position[i * 3 + 1], g.position[i * 3 + 2], g.normal[i * 3], g.normal[i * 3 + 1], g.normal[i * 3 + 2]]; });
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    assert.ok(cr[0] * a[3] + cr[1] * a[4] + cr[2] * a[5] > 0, 'winding agrees with the normal');
  }
  assert.deepEqual(atlasSize(5), { width: CELL_W * 4, height: CELL_H * 2 });
});

test('the baked shops: signs sit on building walls and do not overlap', () => {
  const shops = JSON.parse(fs.readFileSync(new URL('../data/shops.json', import.meta.url), 'utf8')).shops;
  assert.ok(shops.length >= 15);
  for (const s of shops) {
    assert.ok(Number.isFinite(s.x + s.y + s.z) && s.width >= 1.5 && s.width <= 6.01, s.name);
    assert.ok(Math.abs(Math.hypot(s.nx, s.nz) - 1) < 1e-3, `${s.name}: unit normal`);
  }
  for (let i = 0; i < shops.length; i++) for (let j = i + 1; j < shops.length; j++) {
    const a = shops[i], b = shops[j];
    if (Math.hypot(a.x - b.x, a.z - b.z) < (a.width + b.width) / 2 - 0.05 && Math.abs(a.nx * b.nx + a.nz * b.nz) > 0.9 && Math.abs(a.y - b.y) < 0.7) assert.fail(`${a.name} and ${b.name} overlap`);
  }
});

test('the text of a sign runs from the viewer\'s left to right (not mirrored)', () => {
  // a sign on a south wall (normal +z): someone south of it looks north, so east (+x) is on their right
  const g = buildSignGeometry([{ x: 0, y: 3, z: 0, nx: 0, nz: 1, width: 4, height: 0.75 }]);
  const c = cellUv(0, 1);
  // the front face's first corner (uv u0) is on the west side and its second (uv u1) on the east side
  assert.ok(g.position[0] < g.position[3] && Math.abs(g.uv[0] - c.u0) < 1e-9 && Math.abs(g.uv[2] - c.u1) < 1e-9);
  // and on a north wall (normal -z) the viewer faces south: their right is west
  const n = buildSignGeometry([{ x: 0, y: 3, z: 0, nx: 0, nz: -1, width: 4, height: 0.75 }]);
  assert.ok(n.position[0] > n.position[3]);
});
