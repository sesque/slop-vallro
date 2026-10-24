// js/geo/road-index.js
// Where a point is relative to the baked streets: on the carriageway, on a pavement, or neither, and which street
// is nearest. Used for the height of the pavement under a walker and for street names in the HUD.

const CELL = 16;

/**
 * `roads` = { edges } as in data/roads.json; `trims[node]` = distance from a junction at which pavements stop (see
 * js/world/street-geometry.js nodeTrims). query(x, z) returns { edge, s, lateral, kind, dist } for the closest
 * street whose carriageway or pavement contains the point, else for the closest street within `near` metres
 * with kind null, else null.
 */
export function createRoadIndex(roads, trims = []) {
  const segs = []; // [edgeIndex, ax, az, bx, bz, s0, len]
  const cells = new Map();
  const totals = roads.edges.map((e) => {
    let s = 0;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      const id = segs.length;
      segs.push([roads.edges.indexOf(e), a[0], a[1], b[0], b[1], s, len]);
      const reach = Math.max(e.halfL + (e.swL || 0), e.halfR + (e.swR || 0)) + 1;
      const i0 = Math.floor((Math.min(a[0], b[0]) - reach) / CELL), i1 = Math.floor((Math.max(a[0], b[0]) + reach) / CELL);
      const j0 = Math.floor((Math.min(a[1], b[1]) - reach) / CELL), j1 = Math.floor((Math.max(a[1], b[1]) + reach) / CELL);
      for (let ci = i0; ci <= i1; ci++) for (let cj = j0; cj <= j1; cj++) {
        const k = ci * 100003 + cj;
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push(id);
      }
      s += len;
    }
    return s;
  });

  function query(x, z, near = 8) {
    const list = cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!list) return null;
    let hit = null, closest = null;
    for (const id of list) {
      const [ei, ax, az, bx, bz, s0, len] = segs[id];
      const e = roads.edges[ei];
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      const t = Math.max(0, Math.min(len, (x - ax) * dx + (z - az) * dz));
      const qx = ax + dx * t, qz = az + dz * t;
      const lateral = (x - qx) * -dz + (z - qz) * dx; // positive to the left of the direction of travel
      const dist = Math.hypot(x - qx, z - qz);
      const s = s0 + t;
      const half = lateral >= 0 ? e.halfL : e.halfR;
      const sw = lateral >= 0 ? e.swL : e.swR;
      let kind = null;
      if (dist <= half) kind = 'road';
      else if (sw > 0 && dist <= half + sw && e.cls !== 'track' && s >= (trims[e.a] || 0) && s <= totals[ei] - (trims[e.b] || 0)) kind = 'sidewalk';
      const rec = { edge: e, s, lateral, kind, dist };
      if (kind && (!hit || (kind === 'road' && hit.kind !== 'road') || (kind === hit.kind && dist < hit.dist))) hit = rec;
      if (!closest || dist < closest.dist) closest = rec;
    }
    if (hit) return hit;
    return closest && closest.dist <= near ? { ...closest, kind: null } : null;
  }

  function surfaceAt(x, z) {
    const q = query(x, z, 0);
    return q ? q.kind : null;
  }

  function nameAt(x, z, near = 12) {
    const q = query(x, z, near);
    return q ? q.edge.name || null : null;
  }

  return { query, surfaceAt, nameAt };
}
