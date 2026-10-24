import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerrainSampler } from '../js/geo/terrain-sampler.js';

// terrain.js imports the three.js WebGPU build for materials; load only the pure geometry part when it is absent.
let mod;
try {
  mod = await import('../js/world/terrain.js');
} catch {
  mod = null;
}

const sampler = createTerrainSampler([{
  cell: 1, width: 41, height: 41, minX: -20, minZ: -20,
  heights: Float32Array.from({ length: 41 * 41 }, (_, k) => 5 + 0.2 * Math.sin((k % 41) / 4) + 0.1 * Math.cos(Math.floor(k / 41) / 3))
}]);

test('chunk geometry: surface faces up, skirt faces outward and hangs below the rim', { skip: !mod }, () => {
  const ext = { x0: -10, x1: 10, z0: -10, z1: 10 };
  const g = mod.buildChunkGeometry(sampler, ext, 2);
  const pos = g.attributes.position.array;
  const idx = g.index.array;
  const nx = 10, nz = 10, surface = (nx + 1) * (nz + 1);
  let skirtTris = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const centre = [(a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3];
    if (t / 3 < nx * nz * 2) {
      assert.ok(n[1] > 0, `surface triangle ${t / 3} faces down`);
    } else {
      skirtTris++;
      // outward = away from the chunk centre along the edge's axis
      const out = Math.abs(centre[0]) > Math.abs(centre[1]) ? [Math.sign(centre[0]), 0] : [0, Math.sign(centre[1])];
      assert.ok(n[0] * out[0] + n[2] * out[1] > 0, `skirt triangle ${t / 3} faces inward`);
    }
  }
  assert.equal(skirtTris, 2 * (nx + nz) * 2);
  for (let k = surface; k < pos.length / 3; k++) assert.ok(pos[k * 3 + 1] < 4.6, 'skirt vertices hang below the ground');
  assert.ok(g.index.array.every((v) => v < pos.length / 3));
});

test('chunk geometry: vertices sample the height field and normals are unit length', { skip: !mod }, () => {
  const g = mod.buildChunkGeometry(sampler, { x0: -8, x1: 8, z0: -8, z1: 8 }, 4);
  const p = g.attributes.position.array, n = g.attributes.normal.array;
  for (let k = 0; k < 25; k++) {
    assert.ok(Math.abs(p[k * 3 + 1] - sampler.heightAt(p[k * 3], p[k * 3 + 2])) < 1e-6);
  }
  for (let k = 0; k < n.length / 3; k++) assert.ok(Math.abs(Math.hypot(n[k * 3], n[k * 3 + 1], n[k * 3 + 2]) - 1) < 1e-5);
});

test('chunk geometry: cropped extents that are not a multiple of the cell still tile exactly', { skip: !mod }, () => {
  const g = mod.buildChunkGeometry(sampler, { x0: -7.3, x1: 5.1, z0: -3, z1: 9.9 }, 2);
  const p = g.attributes.position.array;
  const xs = [], zs = [];
  const surface = (Math.round(12.4 / 2) + 1) * (Math.round(12.9 / 2) + 1);
  for (let k = 0; k < surface; k++) { xs.push(p[k * 3]); zs.push(p[k * 3 + 2]); }
  assert.ok(Math.abs(Math.min(...xs) + 7.3) < 1e-6 && Math.abs(Math.max(...xs) - 5.1) < 1e-6);
  assert.ok(Math.abs(Math.min(...zs) + 3) < 1e-6 && Math.abs(Math.max(...zs) - 9.9) < 1e-6);
});
