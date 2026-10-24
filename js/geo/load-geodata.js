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

// Walls, hedges, fences, barriers, streams, bridges as polylines [[x, z, base, top], ...] and the water bodies as rings
export async function loadFeatures(baseUrl = './data/', fetchImpl = globalThis.fetch) {
  const [metaRes, binRes] = await Promise.all([fetchImpl(`${baseUrl}features.json`), fetchImpl(`${baseUrl}features.bin`)]);
  if (!metaRes.ok) throw new Error(`features.json: HTTP ${metaRes.status}`);
  if (!binRes.ok) throw new Error(`features.bin: HTTP ${binRes.status}`);
  const meta = await metaRes.json();
  if (meta.vertexEncoding !== 'int32-cm-x-z-base-top') throw new Error(`Unsupported feature encoding ${meta.vertexEncoding}`);
  const cm = new Int32Array(await binRes.arrayBuffer());
  const lines = meta.lines.map((l) => {
    if ((l.o + l.n) * 4 > cm.length) throw new Error(`features.bin too short for ${l.id}`);
    const pts = [];
    for (let i = 0; i < l.n; i++) { const k = (l.o + i) * 4; pts.push([cm[k] / 100, cm[k + 1] / 100, cm[k + 2] / 100, cm[k + 3] / 100]); }
    return { id: l.id, kind: meta.kinds[l.kind].name, thick: meta.kinds[l.kind].thick, width: meta.kinds[l.kind].width, pts };
  });
  const water = meta.water.map((w) => ({ id: w.id, type: w.type, y: w.y, outer: Float32Array.from(w.outer, (v) => v / 100), inner: w.inner ? Float32Array.from(w.inner, (v) => v / 100) : null }));
  return { meta, lines, water };
}

export async function loadStairs(baseUrl = './data/', fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${baseUrl}stairs.json`);
  if (!res.ok) throw new Error(`stairs.json: HTTP ${res.status}`);
  const meta = await res.json();
  return { meta, flights: meta.flights };
}

// Point props as Float32Array [x, z, heading, ...] per type: { tree, lamp, pole, pillar, manhole, gully, treePit, fountain }
export async function loadProps(baseUrl = './data/', fetchImpl = globalThis.fetch) {
  const [metaRes, binRes] = await Promise.all([fetchImpl(`${baseUrl}props.json`), fetchImpl(`${baseUrl}props.bin`)]);
  if (!metaRes.ok) throw new Error(`props.json: HTTP ${metaRes.status}`);
  if (!binRes.ok) throw new Error(`props.bin: HTTP ${binRes.status}`);
  const meta = await metaRes.json();
  if (meta.encoding !== 'float32-x-z-angle') throw new Error(`Unsupported prop encoding ${meta.encoding}`);
  const all = new Float32Array(await binRes.arrayBuffer());
  const props = {};
  for (const t of meta.types) {
    if ((t.offset + t.count) * 3 > all.length) throw new Error(`props.bin too short for ${t.name}`);
    props[t.name] = all.slice(t.offset * 3, (t.offset + t.count) * 3);
  }
  return { meta, props };
}
