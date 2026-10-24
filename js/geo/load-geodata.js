// Runtime access to the baked Vallromanes data (spec §6). Only the terrain exists so far; the other layers join
// the same loader as their pipeline stages land.
import { createTerrainSampler, decodePlanar } from './terrain-sampler.js';

export async function loadTerrain(baseUrl = './data/', fetchImpl = globalThis.fetch) {
  const [metaRes, binRes] = await Promise.all([fetchImpl(`${baseUrl}terrain.json`), fetchImpl(`${baseUrl}terrain.bin`)]);
  if (!metaRes.ok) throw new Error(`terrain.json: HTTP ${metaRes.status}`);
  if (!binRes.ok) throw new Error(`terrain.bin: HTTP ${binRes.status}`);
  const meta = await metaRes.json();
  const bin = await binRes.arrayBuffer();
  if (meta.encoding !== 'int16-planar-le') throw new Error(`Unsupported terrain encoding ${meta.encoding}`);
  const tiers = meta.tiers.map((t) => {
    if (t.offset + t.bytes > bin.byteLength) throw new Error(`terrain.bin too short for tier ${t.name}`);
    const residuals = new Int16Array(bin.slice(t.offset, t.offset + t.bytes));
    if (residuals.length !== t.width * t.height) throw new Error(`Tier ${t.name}: ${residuals.length} samples, expected ${t.width * t.height}`);
    return { cell: t.cell, width: t.width, height: t.height, minX: t.minX, minZ: t.minZ, heights: decodePlanar(residuals, t.width, t.height, meta.scale) };
  });
  return { meta, frame: meta.frame, sampler: createTerrainSampler(tiers) };
}
