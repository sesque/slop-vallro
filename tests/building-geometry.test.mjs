import assert from 'node:assert/strict';
import test from 'node:test';
import { appendStructure, FLOOR_HEIGHT, newBuffers, SURF, toTypedBuffers } from '../js/world/building-geometry.js';

const outer = [0, 0, 12, 0, 12, 6, 0, 6]; // positive area in x, z
const hole = [4, 2, 4, 4, 8, 4, 8, 2]; // negative area

function structure(extra = {}) {
  return { id: '89abcdef', kind: 0, open: false, base: 100, baseMax: 101, top: 108, floors: 2, roof: 0, rise: 0, rings: [outer], ...extra };
}

function triangles(out) {
  const p = out.position, n = out.normal, tris = [];
  for (let t = 0; t < p.length / 9; t++) {
    const v = (k) => [p[t * 9 + k * 3], p[t * 9 + k * 3 + 1], p[t * 9 + k * 3 + 2]];
    const a = v(0), b = v(1), c = v(2);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    tris.push({ a, b, c, cross: cr, normal: [n[t * 9], n[t * 9 + 1], n[t * 9 + 2]], surf: out.info[t * 12 + 1], rows: out.info[t * 12] });
  }
  return tris;
}

test('flat building: walls face outward and the cap faces up, geometry is consistent', () => {
  const out = newBuffers();
  appendStructure(out, structure());
  const tris = triangles(out);
  assert.equal(tris.length, 4 * 2 + 2); // 4 walls x 2 + a 2-triangle cap
  const centre = [6, 3];
  for (const t of tris) {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(dot(t.cross, t.normal) > 0, 'winding agrees with the normal');
    if (t.surf === SURF.WALL) {
      assert.equal(t.normal[1], 0);
      const mid = [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3];
      assert.ok((mid[0] - centre[0]) * t.normal[0] + (mid[1] - centre[1]) * t.normal[2] > 0, 'wall faces away from the centre');
    } else {
      assert.equal(t.surf, SURF.FLAT);
      assert.equal(t.normal[1], 1);
    }
  }
  const ys = out.position.filter((_, i) => i % 3 === 1);
  assert.equal(Math.min(...ys), 100 - 0.4);
  assert.equal(Math.max(...ys), 108);
});

test('window rows count whole floors under the eave from the highest ground', () => {
  const out = newBuffers();
  appendStructure(out, structure({ top: 108, baseMax: 101 }));
  assert.equal(out.info[0], Math.floor((108 - 101) / FLOOR_HEIGHT - 0.15)); // 2
  const low = newBuffers();
  appendStructure(low, structure({ top: 102, baseMax: 101.5 }));
  assert.equal(low.info[0], 0);
});

test('courtyard: hole walls face into the courtyard and the cap leaves the hole open', () => {
  const out = newBuffers();
  appendStructure(out, structure({ rings: [outer, hole] }));
  const tris = triangles(out);
  const centre = [6, 3];
  const holeWalls = tris.filter((t) => t.surf === SURF.WALL && t.a[0] > 3.9 && t.a[0] < 8.1 && t.a[2] > 1.9 && t.a[2] < 4.1 && t.b[0] > 3.9 && t.b[0] < 8.1);
  assert.equal(holeWalls.length, 8);
  for (const t of holeWalls) {
    const mid = [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3];
    assert.ok((centre[0] - mid[0]) * t.normal[0] + (centre[1] - mid[1]) * t.normal[2] > 0, 'courtyard wall faces the courtyard centre');
  }
  let area = 0;
  for (const t of tris.filter((q) => q.surf === SURF.FLAT)) area += Math.hypot(...t.cross) / 2;
  assert.ok(Math.abs(area - (72 - 8)) < 1e-6, `cap area ${area}`);
});

test('hip roof: faces up, eaves below the top and ridge above it, covers the footprint', () => {
  const out = newBuffers();
  appendStructure(out, structure({ roof: 1, rise: 1.4 }));
  const tris = triangles(out);
  const roof = tris.filter((t) => t.surf === SURF.TILE);
  assert.ok(roof.length >= 4);
  let projected = 0;
  for (const t of roof) {
    assert.ok(t.normal[1] > 0, 'roof faces up');
    projected += Math.abs(t.cross[1]) / 2; // area projected onto the ground plane
  }
  assert.ok(Math.abs(projected - 72) < 1e-6, `projected roof area ${projected}`);
  const ys = roof.flatMap((t) => [t.a[1], t.b[1], t.c[1]]);
  assert.ok(Math.abs(Math.min(...ys) - (108 - 1.4 * 0.55)) < 1e-9);
  assert.ok(Math.abs(Math.max(...ys) - (108 + 1.4 * 0.45)) < 1e-9);
  assert.ok(tris.filter((t) => t.surf === SURF.WALL).every((t) => Math.max(t.a[1], t.b[1], t.c[1]) <= 108 - 1.4 * 0.55 + 1e-9));
});

test('open slab (porch, canopy): top face up, underside down, short rim, no tall walls', () => {
  const out = newBuffers();
  appendStructure(out, structure({ open: true, kind: 3, top: 104 }));
  const tris = triangles(out);
  assert.ok(tris.every((t) => t.surf === SURF.SLAB));
  assert.ok(tris.some((t) => t.normal[1] === 1) && tris.some((t) => t.normal[1] === -1));
  const ys = out.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.abs(Math.min(...ys) - 103.7) < 1e-9 && Math.max(...ys) === 104);
});

test('ruins are cut down to low walls and never get a pitched roof', () => {
  const out = newBuffers();
  appendStructure(out, structure({ roof: 1, rise: 1.4, top: 112 }), { ruins: true });
  const ys = out.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.max(...ys) <= 102 + 1e-9);
  assert.ok(triangles(out).every((t) => t.surf !== SURF.TILE));
});

test('toTypedBuffers returns float arrays of matching sizes', () => {
  const out = newBuffers();
  appendStructure(out, structure());
  const b = toTypedBuffers(out);
  assert.equal(b.position.length, b.normal.length);
  assert.equal(b.uv.length / 2, b.position.length / 3);
  assert.equal(b.info.length / 4, b.position.length / 3);
});

test('gable roof along the long axis: two sloping faces up, two vertical gable ends facing outward, same eave and ridge heights', () => {
  const out = newBuffers();
  appendStructure(out, structure({ roof: 2, rise: 2 }));
  const tris = triangles(out);
  const roof = tris.filter((t) => t.surf === SURF.TILE);
  assert.equal(roof.length, 4, 'two faces of two triangles');
  let projected = 0;
  for (const t of roof) { assert.ok(t.normal[1] > 0); projected += Math.abs(t.cross[1]) / 2; }
  assert.ok(Math.abs(projected - 72) < 1e-6, `projected roof area ${projected}`);
  const eave = 108 - 2 * 0.55, ridge = 108 + 2 * 0.45;
  const ys = roof.flatMap((t) => [t.a[1], t.b[1], t.c[1]]);
  assert.ok(Math.abs(Math.min(...ys) - eave) < 1e-9 && Math.abs(Math.max(...ys) - ridge) < 1e-9);
  // the ridge runs along x (the 12 m side): its ends are at x = 0 and x = 12 on the ridge line z = 3
  const ridgePts = roof.flatMap((t) => [t.a, t.b, t.c]).filter((p) => Math.abs(p[1] - ridge) < 1e-9);
  assert.ok(ridgePts.every((p) => Math.abs(p[2] - 3) < 1e-9) && Math.min(...ridgePts.map((p) => p[0])) === 0 && Math.max(...ridgePts.map((p) => p[0])) === 12);
  // gable ends: vertical wall triangles above the eave, normals along -x and +x
  const gables = tris.filter((t) => t.surf === SURF.WALL && Math.abs(t.normal[1]) < 1e-9 && t.a[1] >= eave - 1e-9 && t.b[1] >= eave - 1e-9 && t.c[1] >= eave - 1e-9 && Math.max(t.a[1], t.b[1], t.c[1]) > eave + 1e-9);
  assert.equal(gables.length, 2);
  assert.deepEqual(gables.map((t) => Math.sign(t.normal[0])).sort(), [-1, 1]);
});

test('gable roof along the short axis puts the ridge across the building', () => {
  const out = newBuffers();
  appendStructure(out, structure({ roof: 3, rise: 2 }));
  const ridge = 108 + 2 * 0.45;
  const ridgePts = triangles(out).filter((t) => t.surf === SURF.TILE).flatMap((t) => [t.a, t.b, t.c]).filter((p) => Math.abs(p[1] - ridge) < 1e-9);
  assert.ok(ridgePts.every((p) => Math.abs(p[0] - 6) < 1e-9), 'the ridge is the line x = 6');
  assert.ok(Math.min(...ridgePts.map((p) => p[2])) === 0 && Math.max(...ridgePts.map((p) => p[2])) === 6);
});

test('a bell tower: a plain shaft from the foundation up to a four-sided spire at the baked top', () => {
  const out = newBuffers();
  appendStructure(out, structure({ roof: 2, rise: 2, tower: [10, 3, 4, 125] }));
  const tris = triangles(out);
  const tx = (t) => [t.a, t.b, t.c].every((p) => p[0] >= 7.99 && p[0] <= 12.01 && p[2] >= 0.99 && p[2] <= 5.01);
  const tower = tris.filter(tx).filter((t) => Math.max(t.a[1], t.b[1], t.c[1]) > 110 || Math.min(t.a[1], t.b[1], t.c[1]) < 100);
  const spire = tower.filter((t) => t.surf === SURF.TILE);
  assert.equal(spire.length, 4);
  for (const t of spire) assert.ok(t.normal[1] > 0, 'spire faces up and out');
  const ys = tower.flatMap((t) => [t.a[1], t.b[1], t.c[1]]);
  assert.equal(Math.max(...ys), 125);
  assert.ok(Math.min(...ys) < 100, 'the shaft starts at the foundation');
  const walls = tower.filter((t) => t.surf === SURF.WALL && Math.abs(t.normal[1]) < 1e-9);
  assert.ok(walls.length >= 8, 'four wall quads');
  for (const t of walls) {
    const mx = (t.a[0] + t.b[0] + t.c[0]) / 3 - 10, mz = (t.a[2] + t.b[2] + t.c[2]) / 3 - 3;
    assert.ok(mx * t.normal[0] + mz * t.normal[2] > 0, 'tower walls face outward');
  }
});
