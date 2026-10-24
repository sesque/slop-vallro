// Flattens the terrain under the roads (spec §5.2, "burn road surfaces into the grid"): inside a road's corridor the
// ground takes the road's smooth profile height, so vehicles do not tilt on DTM noise and the road surface and the
// terrain meet. Outside the corridor the ground blends back to the natural terrain over `blend` metres.

export const BLEND = { urban: 3.5, urbanUnpaved: 3, road: 3.5, track: 2.5 };

// Half width of the flat strip: carriageway + pavement on the wider side + a little margin for the kerb
export function flatHalfWidth(edge) {
  return Math.max(edge.halfL + (edge.swL || 0), edge.halfR + (edge.swR || 0)) + 0.25;
}

const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * `heights`: Float32Array of a vertex grid (w × h) at x = minX + i * cell, z = minZ + j * cell. `edges` have
 * `pts` [[x, z, y(local)], ...] and the widths of data/roads.json. Modifies `heights` in place (local y, as the grid
 * stores H - H0 when `base` = 0, or absolute H with `base` = H0). `depth` lowers the corridor below the profile. Returns
 * the number of vertices changed.
 */
export function burnRoads(heights, grid, edges, { base = 0, depth = 0 } = {}) {
  const { minX, minZ, cell, w, h } = grid;
  const weight = new Float32Array(w * h);
  const target = new Float32Array(w * h);
  const bestD = new Float32Array(w * h).fill(Infinity);
  for (const e of edges) {
    const flat = flatHalfWidth(e);
    const blend = Math.max(BLEND[e.cls] ?? 3, cell * 0.9);
    const R = flat + blend;
    for (let s = 0; s + 1 < e.pts.length; s++) {
      const [ax, az, ay] = e.pts[s], [bx, bz, by] = e.pts[s + 1];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      if (l2 < 1e-12) continue;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - minX) / cell));
      const i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + R - minX) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R - minZ) / cell));
      const j1 = Math.min(h - 1, Math.ceil((Math.max(az, bz) + R - minZ) / cell));
      for (let j = j0; j <= j1; j++) {
        const z = minZ + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = minX + i * cell;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
          if (d >= R) continue;
          const wt = d <= flat ? 1 : 1 - smoothstep((d - flat) / blend);
          const k = j * w + i;
          if (wt > weight[k] + 1e-6 || (Math.abs(wt - weight[k]) <= 1e-6 && d < bestD[k])) {
            weight[k] = wt;
            target[k] = ay + t * (by - ay) + base - depth;
            bestD[k] = d;
          }
        }
      }
    }
  }
  let changed = 0;
  for (let k = 0; k < heights.length; k++) {
    if (weight[k] <= 0) continue;
    heights[k] = heights[k] * (1 - weight[k]) + target[k] * weight[k];
    changed++;
  }
  return changed;
}
