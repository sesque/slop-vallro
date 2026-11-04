import assert from 'node:assert/strict';
import test from 'node:test';
import { assignPalette, CLASSES, NEIGHBOUR_M, palOf } from '../tools/vallromanes/facade-palette.mjs';
import { encodeSeed, seedOf } from '../js/world/building-geometry.js';

test('palOf numbers the classes from 1 and gives 0 to an unknown letter', () => {
  assert.equal(palOf('w'), 1);
  assert.equal(palOf('d'), CLASSES.length);
  assert.equal(palOf('?'), 0);
});

test('a building takes its own photo class, a neighbour within range inherits the nearest, a far one stays unclassed', () => {
  const items = [
    { x: 0, z: 0, ref: 'A' }, // photographed: terracotta
    { x: 200, z: 0, ref: 'B' }, // photographed: brick
    { x: 20, z: 0, ref: 'C' }, // no label, near A
    { x: 190, z: 5, ref: null }, // not in the Catastro, near B
    { x: 100, z: 100, ref: 'D' }, // photographed but class x (not in the file), far from everything
    { x: 100, z: 0, ref: null } // 100 m from both
  ];
  const r = assignPalette(items, { A: 't', B: 'b' });
  assert.deepEqual(r.pal, [palOf('t'), palOf('b'), palOf('t'), palOf('b'), 0, 0]);
  assert.equal(r.own, 2);
  assert.equal(r.inherited, 2);
  assert.equal(r.none, 2);
  assert.ok(NEIGHBOUR_M >= 20);
});

test('the colour seed keeps the class in the integer part and the hash in the fraction', () => {
  for (const pal of [0, 1, 5, 9]) for (const h of [0, 0.37, 1]) {
    const e = encodeSeed(h, pal);
    assert.equal(Math.floor(e), pal);
    assert.ok(Math.abs((e - pal - 0.01) / 0.98 - h) < 1e-9);
    assert.ok(Math.abs(Math.fround(e) - e) < 1e-6 && Math.floor(Math.fround(e)) === pal);
  }
  assert.ok(seedOf('ffffffff') <= 1);
});
