import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTerrainSampler, decodePlanar } from '../js/geo/terrain-sampler.js';
import { loadTerrain } from '../js/geo/load-geodata.js';
import { buildTier, encodeHeights, encodePlanar, resampleBox, SCALE } from '../tools/vallromanes/build-terrain.mjs';
import { E0, H0, N0 } from '../tools/vallromanes/frame.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function plane(width, height, cell, minX, minZ, fn) {
  const heights = new Float32Array(width * height);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) heights[j * width + i] = fn(minX + i * cell, minZ + j * cell);
  return { cell, width, height, minX, minZ, heights };
}

test('sampler: bilinear height, exact on a plane, clamped outside', () => {
  const t = plane(11, 11, 2, -10, -10, (x, z) => 100 + 0.5 * x - 0.25 * z);
  const s = createTerrainSampler([t]);
  assert.ok(Math.abs(s.heightAt(3.3, -4.1) - (100 + 0.5 * 3.3 + 0.25 * 4.1)) < 1e-4);
  assert.ok(Math.abs(s.heightAt(-10, -10) - (100 - 5 + 2.5)) < 1e-4);
  assert.ok(Number.isFinite(s.heightAt(1e6, -1e6)));
  assert.equal(s.heightAt(1e6, 0), s.heightAt(10, 0));
});

test('sampler: normal of a sloped plane, and flat ground points straight up', () => {
  const s = createTerrainSampler([plane(11, 11, 2, -10, -10, (x) => 0.5 * x)]);
  const [nx, ny, nz] = s.normalAt(0, 0);
  const len = Math.hypot(0.5, 1);
  assert.ok(Math.abs(nx + 0.5 / len) < 1e-6 && Math.abs(ny - 1 / len) < 1e-6 && Math.abs(nz) < 1e-9);
  assert.deepEqual(createTerrainSampler([plane(5, 5, 1, 0, 0, () => 3)]).normalAt(2, 2), [0, 1, 0]);
});

test('sampler: uses the fine tier inside its rectangle and the coarse tier elsewhere', () => {
  const fine = plane(11, 11, 1, 0, 0, () => 10);
  const coarse = plane(11, 11, 10, -50, -50, () => 20);
  const s = createTerrainSampler([fine, coarse]);
  assert.equal(s.heightAt(5, 5), 10);
  assert.equal(s.heightAt(30, 30), 20);
  assert.deepEqual(s.bounds, { minX: -50, maxX: 50, minZ: -50, maxZ: 50 });
  assert.throws(() => createTerrainSampler([]));
});

test('planar predictor round trips and rejects residuals that overflow int16', () => {
  const w = 9, h = 7;
  const q = new Uint16Array(w * h).map((_, k) => 500 + ((k * 37) % 91) + Math.floor(k / w) * 3);
  const back = decodePlanar(encodePlanar(q, w, h), w, h, SCALE);
  for (let k = 0; k < q.length; k++) assert.ok(Math.abs(back[k] - q[k] * SCALE) < 1e-6);
  assert.throws(() => encodePlanar(Uint16Array.from([0, 0, 0, 65000]), 2, 2), /int16/);
});

test('encodeHeights quantises above H0 and rejects heights below it', () => {
  assert.deepEqual([...encodeHeights([H0, H0 + 1, H0 + 1.02])], [0, 20, 20]);
  assert.throws(() => encodeHeights([H0 - 1]), /outside/);
  assert.throws(() => encodeHeights([NaN]), /outside/);
});

test('resampleBox averages the pixels around each vertex and clamps at the edge', () => {
  const w = 4, h = 4;
  const src = Float32Array.from({ length: 16 }, (_, k) => k);
  const out = resampleBox(src, w, h, 2, 2, 2, 1, 1); // vertex at corner (2,2): pixels (1..2, 1..2)
  assert.equal(out[0], (5 + 6 + 9 + 10) / 4);
  const edge = resampleBox(src, w, h, 2, 0, 0, 1, 1); // corner (0,0): only pixel (0,0) exists
  assert.equal(edge[0], 0);
  assert.throws(() => resampleBox(Float32Array.from([-9999]), 1, 1, 1, 0, 0, 1, 1), /No valid/);
});

test('buildTier maps source pixels to local x/z (north is -z)', () => {
  // 8 × 8 source whose value encodes its own column (E) and row: H = H0 + col/10 + row. Origin is NW corner.
  const meta = { originE: E0 - 4, originN: N0 + 4, width: 8, height: 8, nodata: -9999 };
  const heights = Float32Array.from({ length: 64 }, (_, k) => H0 + (k % 8) / 10 + Math.floor(k / 8));
  const t = buildTier({ meta, heights }, 'fine', 2, { minX: -4, maxX: 4, minZ: -4, maxZ: 4 });
  assert.equal(t.minX, -4);
  assert.equal(t.minZ, -4); // north edge (row 0) is z = N0 - (N0 + 4) = -4
  assert.equal(t.width, 5);
  assert.equal(t.height, 5);
  const centre = t.u16[2 * 5 + 2] * SCALE; // vertex at x = 0, z = 0 -> source corner (4, 4)
  const expect = H0 + ((3 + 4) / 2) / 10 + (3 + 4) / 2 - H0;
  assert.ok(Math.abs(centre - expect) <= SCALE / 2 + 1e-6);
});

const baked = fs.existsSync(`${root}data/terrain.bin`);
test('baked terrain loads through loadTerrain and agrees with the BUE frame', { skip: !baked }, async () => {
  const fetchImpl = async (url) => {
    const file = `${root}${url.replace('./', '')}`;
    if (!fs.existsSync(file)) return { ok: false, status: 404 };
    const buf = fs.readFileSync(file);
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString()), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  };
  const { sampler, frame } = await loadTerrain('./data/', fetchImpl);
  assert.equal(frame.H0, H0);
  const y = sampler.heightAt(0, 0); // Ajuntament, about 150 m a.s.l.
  assert.ok(y > 40 && y < 120, `Ajuntament at y = ${y}`);
  assert.ok(sampler.normalAt(0, 0)[1] > 0.7);
  await assert.rejects(loadTerrain('./nowhere/', fetchImpl), /HTTP 404/);
});
