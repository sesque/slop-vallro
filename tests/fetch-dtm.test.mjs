import assert from 'node:assert/strict';
import test from 'node:test';
import { windowFor } from '../tools/vallromanes/fetch-icgc-dtm.mjs';

test('windowFor returns a pixel window covering bbox + margin, north row first', () => {
  const origin = [259000, 4749000];
  const bbox = { minE: 260000, maxE: 261000, minN: 4740000, maxN: 4741000 };
  const w = windowFor(bbox, 100, origin, 2);
  assert.equal(w.x0, (260000 - 100 - 259000) / 2);
  assert.equal(w.x1, (261000 + 100 - 259000) / 2);
  assert.equal(w.y0, (4749000 - 4741100) / 2);
  assert.equal(w.y1, (4749000 - 4739900) / 2);
  assert.equal(w.width, w.x1 - w.x0);
  assert.equal(w.height, w.y1 - w.y0);
});

test('windowFor rounds outwards for non-integer positions', () => {
  const w = windowFor({ minE: 100.4, maxE: 200.6, minN: 50.4, maxN: 150.6 }, 0, [0, 1000], 1);
  assert.equal(w.x0, 100);
  assert.equal(w.x1, 201);
  assert.equal(w.y0, Math.floor(1000 - 150.6));
  assert.equal(w.y1, Math.ceil(1000 - 50.4));
});
