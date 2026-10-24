// Terrain height and normal queries over the baked height grids (spec §6).
// `tiers` are ordered fine to coarse. Each tier is a vertex grid: heights[j * width + i] is the height y (metres,
// local frame) at x = minX + i * cell, z = minZ + j * cell. Queries use the finest tier that contains the point
// and clamp to the coarsest tier outside it.

// Inverse of the planar predictor used by tools/vallromanes/build-terrain.mjs: each stored int16 is the difference
// between a quantised height and left + up - upLeft (edges fall back to left or up). Returns heights in metres.
export function decodePlanar(i16, width, height, scale) {
  const q = new Int32Array(i16.length);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      const left = i ? q[k - 1] : (j ? q[k - width] : 0);
      const up = j ? q[k - width] : left;
      const upLeft = i && j ? q[k - width - 1] : left;
      q[k] = i16[k] + left + up - upLeft;
    }
  }
  const out = new Float32Array(q.length);
  for (let k = 0; k < q.length; k++) out[k] = q[k] * scale;
  return out;
}

export function decodeHeights(u16, scale = 0.01) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = u16[i] * scale;
  return out;
}

function sampleTier(t, x, z) {
  const fx = (x - t.minX) / t.cell;
  const fz = (z - t.minZ) / t.cell;
  const i = Math.max(0, Math.min(t.width - 2, Math.floor(fx)));
  const j = Math.max(0, Math.min(t.height - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i));
  const tz = Math.max(0, Math.min(1, fz - j));
  const h = t.heights;
  const k = j * t.width + i;
  const a = h[k] + (h[k + 1] - h[k]) * tx;
  const b = h[k + t.width] + (h[k + t.width + 1] - h[k + t.width]) * tx;
  return a + (b - a) * tz;
}

export function createTerrainSampler(tiers) {
  if (!tiers.length) throw new Error('terrain sampler needs at least one tier');
  const last = tiers[tiers.length - 1];

  function tierAt(x, z) {
    for (const t of tiers) {
      if (x >= t.minX && x <= t.minX + (t.width - 1) * t.cell && z >= t.minZ && z <= t.minZ + (t.height - 1) * t.cell) return t;
    }
    return last;
  }

  function heightAt(x, z) {
    return sampleTier(tierAt(x, z), x, z);
  }

  // Unit surface normal (x, y, z) from central differences over one cell of the tier in use.
  function normalAt(x, z) {
    const t = tierAt(x, z);
    const d = t.cell;
    const dx = sampleTier(t, x + d, z) - sampleTier(t, x - d, z);
    const dz = sampleTier(t, x, z + d) - sampleTier(t, x, z - d);
    const nx = -dx / (2 * d) + 0; // + 0 turns -0 into 0
    const nz = -dz / (2 * d) + 0;
    const len = Math.hypot(nx, 1, nz);
    return [nx / len, 1 / len, nz / len];
  }

  const bounds = {
    minX: Math.min(...tiers.map((t) => t.minX)),
    maxX: Math.max(...tiers.map((t) => t.minX + (t.width - 1) * t.cell)),
    minZ: Math.min(...tiers.map((t) => t.minZ)),
    maxZ: Math.max(...tiers.map((t) => t.minZ + (t.height - 1) * t.cell))
  };

  return { heightAt, normalAt, tiers, bounds };
}
