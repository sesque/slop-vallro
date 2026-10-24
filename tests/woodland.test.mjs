import assert from 'node:assert/strict';
import test from 'node:test';
import { TREE_MIN, woodlandSites } from '../js/world/woodland.js';

// a 10 x 10 cell grid of 4 m cells: the western half is 12 m woodland, the eastern half bare
const meta = { width: 10, height: 10, cell: 4, step: 0.5, originX: 100, originZ: -200 };
const data = new Uint8Array(100);
for (let j = 0; j < 10; j++) for (let i = 0; i < 5; i++) data[j * 10 + i] = 24;

test('trees grow only where the canopy is tall, at a plausible density and size', () => {
  const sites = woodlandSites({ meta, data }, { ground: () => 5 });
  assert.ok(sites.length > 5 && sites.length < 30, `${sites.length} trees in 50 cells`);
  for (const s of sites) {
    assert.ok(s.x >= 100 && s.x < 120, 'inside the woodland half');
    assert.ok(s.z >= -200 && s.z < -160);
    assert.equal(s.y, 5);
    assert.ok(s.scale >= 0.55 && s.scale <= 1.25);
  }
  assert.ok(TREE_MIN <= 12);
  assert.deepEqual(sites, woodlandSites({ meta, data }, { ground: () => 5 }), 'the same every time');
});

test('streets, the boundary and surveyed trees keep woodland trees away', () => {
  const all = woodlandSites({ meta, data }, { ground: () => 0 });
  assert.equal(woodlandSites({ meta, data }, { ground: () => 0, allow: () => false }).length, 0);
  const first = all[0];
  const kept = woodlandSites({ meta, data }, { ground: () => 0, surveyed: [first.x, first.z] });
  assert.equal(kept.length, all.length - 1, 'the cell of a surveyed tree is left to it');
});
