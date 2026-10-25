import { createTreeField } from '../trees.js';

// js/world/woodland.js
// The woods of the municipality as instanced trees, planted from the baked canopy height grid (data/canopy.*): a tree in
// about one cell in three where the vegetation is taller than TREE_MIN, sized by that height. Only the near field is
// drawn (WOODLAND_LOD); further out the dark forest floor of the ground shader stands for the woods.

export const TREE_MIN = 4.5; // m of vegetation height from which a cell is woodland
const CELL_SHARE = 0.3; // one tree per about 55 m2 of woodland (cells are 4 m, crowns 6-8 m)
export const WOODLAND_LOD = { near: 55, mid: 190, maxDist: 520, shadowLevels: 1 }; // only the full-detail trees cast shadows
const SPECIES_WEIGHTS = [0.4, 0.3, 0.3]; // plane, locust, elm: the species the tree field has

function hash(a, b, salt = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Tree sites { x, y, z, scale, species, yaw, tier } from `canopy` ({ meta, data } as loadCanopy returns it). `ground(x, z)` is the
 * terrain height; `allow(x, z)` rejects spots (outside the municipality, on a street...); `surveyed` = flat [x, z, ...] of the
 * surveyed trees, whose cells are left to them.
 */
export function woodlandSites(canopy, { ground, allow = () => true, surveyed = [] }) {
  const { meta, data } = canopy;
  const { width, height, cell, step, originX, originZ } = meta;
  const taken = new Set();
  for (let i = 0; i < surveyed.length; i += 2) taken.add(Math.floor((surveyed[i] - originX) / cell) + ',' + Math.floor((surveyed[i + 1] - originZ) / cell));
  const sites = [];
  for (let cj = 0; cj < height; cj++) {
    for (let ci = 0; ci < width; ci++) {
      const h = data[cj * width + ci] * step;
      if (h < TREE_MIN || taken.has(ci + ',' + cj)) continue;
      if (hash(ci, cj) > CELL_SHARE) continue;
      const x = originX + (ci + 0.15 + 0.7 * hash(ci, cj, 1)) * cell, z = originZ + (cj + 0.15 + 0.7 * hash(ci, cj, 2)) * cell;
      if (!allow(x, z)) continue;
      const r = hash(ci, cj, 3);
      let species = 0, acc = 0;
      for (let k = 0; k < SPECIES_WEIGHTS.length; k++) { acc += SPECIES_WEIGHTS[k]; if (r < acc) { species = k; break; } }
      sites.push({ x, y: ground(x, z), z, scale: Math.min(1.25, Math.max(0.55, 0.3 + h / 20)), tier: 0, species, yaw: hash(ci, cj, 4) * Math.PI * 2 });
    }
  }
  return sites;
}

export function buildWoodland(scene, canopy, options) {
  const sites = woodlandSites(canopy, options);
  const field = createTreeField(scene, sites, WOODLAND_LOD);
  scene.add(field.group);
  return { field, sites, update: field.update, stats: { trees: sites.length } };
}
