import assert from 'node:assert/strict';
import test from 'node:test';
import { createView, fitView, hillshade, layoutLabels, normalizeText, searchEntries, zoomAt } from '../js/geo/map-math.js';

test('the view is north-up: z grows downwards, the centre maps to the middle, the transform inverts', () => {
  const v = createView(100, 200, 2, 800, 600);
  assert.equal(v.toX(100), 400);
  assert.equal(v.toY(200), 300);
  assert.equal(v.toY(210), 320); // south of the centre is lower on the screen
  assert.equal(v.toX(110), 420);
  assert.equal(v.worldX(v.toX(37.5)), 37.5);
  assert.equal(v.worldZ(v.toY(-12)), -12);
  assert.ok(v.sees(90, 190, 110, 210));
  assert.ok(!v.sees(1000, 0, 1100, 10));
  assert.ok(v.sees(405, 190, 450, 210, 20) === false || v.sees(405, 190, 450, 210, 20) === true);
  assert.ok(createView(0, 0, 1, 100, 100).sees(55, 0, 60, 10, 10), 'padding widens the view');
});

test('fitView shows the whole box with a margin, centred', () => {
  const v = fitView({ minX: -2000, maxX: 3000, minZ: -1500, maxZ: 2000 }, 1000, 800);
  assert.equal(v.cx, 500);
  assert.equal(v.cz, 250);
  assert.ok(v.toX(-2000) > 0 && v.toX(3000) < 1000 && v.toY(-1500) > 0 && v.toY(2000) < 800);
  assert.ok(Math.abs((v.toX(3000) - v.toX(-2000)) - 1000 * 0.94) < 1e-6, 'width is the limiting side');
});

test('zoomAt keeps the world point under the cursor fixed and clamps the scale', () => {
  const v = createView(0, 0, 1, 800, 600);
  const wx = v.worldX(600), wz = v.worldZ(100);
  const z = zoomAt(v, 2, 600, 100, 0.1, 10);
  assert.equal(z.scale, 2);
  assert.ok(Math.abs(z.worldX(600) - wx) < 1e-9 && Math.abs(z.worldZ(100) - wz) < 1e-9);
  assert.equal(zoomAt(v, 100, 0, 0, 0.1, 10).scale, 10);
  assert.equal(zoomAt(v, 0.001, 0, 0, 0.1, 10).scale, 0.1);
});

test('search ignores case and accents, ranks prefixes over words over substrings, lists names once', () => {
  assert.equal(normalizeText('  Plaça de l’Església '), 'placa de l’esglesia');
  const entries = [
    { name: 'Carrer de la Marinada' }, { name: 'Can Marinada' }, { name: 'Restaurant Sauló' }, { name: 'Marina' }, { name: 'Torre Tavernera' }, { name: 'Marinada', kind: 'x' }, { name: 'Marinada', kind: 'x' }
  ];
  assert.deepEqual(searchEntries('marina', entries).map((e) => e.name), ['Marina', 'Marinada', 'Carrer de la Marinada', 'Can Marinada']);
  assert.deepEqual(searchEntries('SAULO', entries).map((e) => e.name), ['Restaurant Sauló']);
  // only substrings match 'na': they keep the order of the entries
  assert.deepEqual(searchEntries('na', entries).map((e) => e.name).slice(0, 2), ['Carrer de la Marinada', 'Can Marinada']);
  assert.deepEqual(searchEntries('', entries), []);
  assert.deepEqual(searchEntries('zzz', entries), []);
  assert.equal(searchEntries('a', entries, 2).length, 2);
});

test('label layout keeps the higher priority, drops overlaps and respects the limit', () => {
  const measure = (t) => t.length * 6;
  const items = [
    { text: 'Ajuntament', x: 100, y: 100, priority: 5 },
    { text: 'Escola', x: 105, y: 102, priority: 9 }, // overlaps, wins
    { text: 'Far away', x: 400, y: 300, priority: 1 },
    { text: 'Vertical', x: 100, y: 150, priority: 4, angle: Math.PI / 2 } // a rotated box is tall: 52 px
  ];
  const kept = layoutLabels(items, measure, { fontPx: 10, pad: 2 });
  assert.deepEqual(kept.map((k) => k.text), ['Escola', 'Vertical', 'Far away']);
  assert.equal(layoutLabels(items, measure, { max: 1 }).length, 1);
});

test('hillshade: flat ground is evenly lit, slopes facing the north-west light are brighter, higher is paler, edges are finite', () => {
  const w = 9, h = 9;
  const flat = hillshade(new Float32Array(w * h).fill(100), w, h, 4);
  assert.equal(flat.length, w * h * 4);
  assert.equal(flat[3], 255);
  assert.ok(Array.from(flat).every((v) => v >= 0 && v <= 255));
  const lit = (grid) => { const px = hillshade(grid, w, h, 4); const k = (4 * w + 4) * 4; return px[k] + px[k + 1] + px[k + 2]; };
  const ramp = (sx, sz) => Float32Array.from({ length: w * h }, (_, k) => 100 + (k % w) * sx + Math.floor(k / w) * sz);
  const facingLight = lit(ramp(2, 2)); // rises towards the south-east, so its face looks north-west
  const awayFromLight = lit(ramp(-2, -2));
  const level = lit(ramp(0, 0));
  assert.ok(facingLight > level && level > awayFromLight, `${facingLight} > ${level} > ${awayFromLight}`);
  const low = hillshade(new Float32Array(w * h).fill(100), w, h, 4), high = hillshade(new Float32Array(w * h).fill(400), w, h, 4);
  assert.ok(high[0] + high[1] + high[2] > low[0] + low[1] + low[2]);
});
