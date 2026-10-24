// Runtime access to the baked Vallromanes data (spec §6). Terrain, municipal boundary and building footprints so far;
// the other layers join the same loader as their pipeline stages land.
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

export async function loadBoundary(baseUrl = './data/', fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${baseUrl}boundary.json`);
  if (!res.ok) throw new Error(`boundary.json: HTTP ${res.status}`);
  const meta = await res.json();
  return { meta, rings: meta.rings.map((r) => Float32Array.from(r)) };
}

// Structures with their rings as flat Float32Array [x, z, ...] in metres: rings[0] outer (positive area), the rest holes
export async function loadBuildings(baseUrl = './data/', fetchImpl = globalThis.fetch) {
  const [metaRes, binRes] = await Promise.all([fetchImpl(`${baseUrl}buildings.json`), fetchImpl(`${baseUrl}buildings.bin`)]);
  if (!metaRes.ok) throw new Error(`buildings.json: HTTP ${metaRes.status}`);
  if (!binRes.ok) throw new Error(`buildings.bin: HTTP ${binRes.status}`);
  const meta = await metaRes.json();
  if (meta.ringEncoding !== 'int32-cm-xz') throw new Error(`Unsupported building ring encoding ${meta.ringEncoding}`);
  const cm = new Int32Array(await binRes.arrayBuffer());
  const structures = meta.buildings.map((b) => {
    const kind = meta.kinds[b.kind];
    const rings = b.rings.map(([start, count]) => {
      if ((start + count) * 2 > cm.length) throw new Error(`buildings.bin too short for ${b.id}`);
      const ring = new Float32Array(count * 2);
      for (let i = 0; i < ring.length; i++) ring[i] = cm[start * 2 + i] / 100;
      return ring;
    });
    return { id: b.id, kind: b.kind, kindName: kind.name, open: kind.open, base: b.base, baseMax: b.baseMax, top: b.top,
      floors: b.floors, roof: b.roof, rise: b.rise, flags: b.flags, rings };
  });
  return { meta, structures };
}

export async function loadRoads(baseUrl = './data/', fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${baseUrl}roads.json`);
  if (!res.ok) throw new Error(`roads.json: HTTP ${res.status}`);
  const meta = await res.json();
  return { meta, nodes: meta.nodes, edges: meta.edges };
}
