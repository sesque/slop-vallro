import { ShapeUtils, Vector2 } from 'three';
import { orientedBox } from '../geo/polygon.js';

// js/world/building-geometry.js
// Turns baked structures (data/buildings.json + .bin) into flat-shaded triangle soup: walls (down to below the lowest
// ground so slopes show a plinth, not a gap), a flat or hip roof, or a floating slab for porches and canopies.
// Pure geometry, no GPU objects, so it runs under Node for tests.

export const SURF = { WALL: 0, TILE: 1, FLAT: 2, SLAB: 3 };
export const FLOOR_HEIGHT = 3.0; // m; the facade shader lays its window rows out in these
export const SLAB_THICKNESS = 0.3;
export const FOUNDATION = 0.4; // walls reach this far below the lowest ground
// The baked top is the mean roof level: a hip roof's eave is below it and its ridge above (knowledge.md §3.5)
export const EAVE_FRACTION = 0.55;
export const RIDGE_FRACTION = 0.45;
export const RUINS_HEIGHT = 2.0;

export function newBuffers() {
  return { position: [], normal: [], uv: [], info: [] };
}

function pushVertex(out, x, y, z, nx, ny, nz, u, v, info) {
  out.position.push(x, y, z);
  out.normal.push(nx, ny, nz);
  out.uv.push(u, v);
  out.info.push(info[0], info[1], info[2], info[3]);
}

// Triangle with a flat normal from its winding; `up` / `down` forces the face towards +y / -y by swapping two vertices
function pushTriangle(out, a, b, c, info, face = 0) {
  let [p, q, r] = [a, b, c];
  const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
  const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if ((face > 0 && ny < 0) || (face < 0 && ny > 0)) {
    [q, r] = [r, q];
    nx = -nx; ny = -ny; nz = -nz;
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return;
  nx /= len; ny /= len; nz /= len;
  pushVertex(out, p[0], p[1], p[2], nx, ny, nz, p[3] || 0, p[4] || 0, info);
  pushVertex(out, q[0], q[1], q[2], nx, ny, nz, q[3] || 0, q[4] || 0, info);
  pushVertex(out, r[0], r[1], r[2], nx, ny, nz, r[3] || 0, r[4] || 0, info);
}

// Walls along one ring: outward normal (dz, -dx) for outer rings (positive area) and, for holes (negative area),
// the same expression, which then faces into the courtyard. u = metres along the ring, v = floors above `vBase`.
function pushWalls(out, ring, y0, y1, vBase, info) {
  const n = ring.length / 2;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2], z0 = ring[i * 2 + 1], x1 = ring[j * 2], z1 = ring[j * 2 + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue;
    const nx = (z1 - z0) / len, nz = -(x1 - x0) / len;
    const v0 = (y0 - vBase) / FLOOR_HEIGHT, v1 = (y1 - vBase) / FLOOR_HEIGHT;
    const A = [x0, y0, z0, u, v0], B = [x1, y0, z1, u + len, v0], C = [x1, y1, z1, u + len, v1], D = [x0, y1, z0, u, v1];
    for (const tri of [[A, B, C], [A, C, D]]) {
      // winding so the face looks along (nx, 0, nz)
      const [p, q, r] = tri;
      const cx = (q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1]);
      const cz = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const ordered = cx * nx + cz * nz >= 0 ? tri : [p, r, q];
      for (const v of ordered) pushVertex(out, v[0], v[1], v[2], nx, 0, nz, v[3], v[4], info);
    }
    u += len;
  }
}

// Fills a polygon (with holes) at height y; the face points up or down
function pushCap(out, outer, holes, y, info, face) {
  const toPts = (r) => Array.from({ length: r.length / 2 }, (_, i) => new Vector2(r[i * 2], r[i * 2 + 1]));
  const contour = toPts(outer);
  const holePts = holes.map(toPts);
  const all = contour.concat(...holePts);
  for (const [a, b, c] of ShapeUtils.triangulateShape(contour, holePts)) {
    pushTriangle(out, [all[a].x, y, all[a].y], [all[b].x, y, all[b].y], [all[c].x, y, all[c].y], info, face);
  }
}

// Hip roof over a nearly rectangular footprint: every footprint edge is joined to the ridge by the closest points of
// the ridge segment, which gives the sloping faces and the hipped ends of a rectangle.
function pushHipRoof(out, outer, eaveY, ridgeY, info) {
  const box = orientedBox(outer);
  const half = Math.max(0, box.hx - box.hz); // ridge half-length: 45 degree hips at both ends
  const onRidge = (x, z) => {
    const t = Math.max(-half, Math.min(half, (x - box.cx) * box.ux + (z - box.cz) * box.uz));
    return [box.cx + box.ux * t, ridgeY, box.cz + box.uz * t];
  };
  const n = outer.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = [outer[i * 2], eaveY, outer[i * 2 + 1]], b = [outer[j * 2], eaveY, outer[j * 2 + 1]];
    const ra = onRidge(a[0], a[2]), rb = onRidge(b[0], b[2]);
    pushTriangle(out, a, b, rb, info, 1);
    if (Math.hypot(ra[0] - rb[0], ra[2] - rb[2]) > 1e-4) pushTriangle(out, a, rb, ra, info, 1);
  }
}

/**
 * The style of a building from its Catastro use and year of construction, 0..23: use * 4 + era, with use 0 unknown or
 * residential, 1 agriculture, 2 industrial, 3 retail, 4 public service, 5 other; era 0 unknown, 1 before 1950, 2 1950-1989, 3 1990 on.
 * It rides in the fraction of `info.w` (kind + style / 32) for the facade shader.
 */
export function styleOf(s) {
  const use = s.use === 2 ? 1 : s.use === 3 ? 2 : s.use === 4 ? 3 : s.use === 5 ? 4 : s.use === 6 ? 5 : 0;
  const era = !s.year ? 0 : s.year < 1950 ? 1 : s.year < 1990 ? 2 : 3;
  return use * 4 + era;
}

export function seedOf(id) {
  return parseInt(id, 16) / 0xffffffff;
}

/**
 * Appends one structure to `out`. `s` has { id, open, base, baseMax, top, floors, roof, rise, rings } where `rings`
 * is [outer, ...holes] as flat [x, z, ...] arrays and `kind` is its index into the kinds list (stored in info.w).
 * `roofIsHip` is s.roof === 1; `solidHeight` limits ruins to low walls.
 */
export function appendStructure(out, s, { ruins = false } = {}) {
  const [outer, ...holes] = s.rings;
  const seed = seedOf(s.id);
  const info = (surf, rows = 0) => [rows, surf, seed, s.kind + styleOf(s) / 32];
  const top = ruins ? Math.min(s.top, s.base + RUINS_HEIGHT) : s.top;

  if (s.open) {
    const y0 = top - SLAB_THICKNESS;
    const rows = 0;
    for (const ring of s.rings) pushWalls(out, ring, y0, top, s.baseMax, info(SURF.SLAB, rows));
    pushCap(out, outer, holes, top, info(SURF.SLAB), 1);
    pushCap(out, outer, holes, y0, info(SURF.SLAB), -1);
    return;
  }

  const hip = s.roof === 1 && !ruins;
  const eaveY = hip ? top - s.rise * EAVE_FRACTION : top;
  // Window rows that fit under the eave, counted from the highest ground at the footprint
  let rows = Math.max(0, Math.floor((eaveY - s.baseMax) / FLOOR_HEIGHT - 0.15));
  // Catastro's count of floors above ground is the truth where the building is joined to it, as far as the walls leave room
  if (s.cat) rows = Math.max(1, Math.min(s.floors, Math.floor((eaveY - s.baseMax) / 2.3)));
  for (const ring of s.rings) pushWalls(out, ring, s.base - FOUNDATION, eaveY, s.baseMax, info(SURF.WALL, rows));
  if (hip) {
    pushHipRoof(out, outer, eaveY, top + s.rise * RIDGE_FRACTION, info(SURF.TILE));
  } else {
    pushCap(out, outer, holes, top, info(SURF.FLAT), 1);
  }
}

export function toTypedBuffers(out) {
  return {
    position: Float32Array.from(out.position),
    normal: Float32Array.from(out.normal),
    uv: Float32Array.from(out.uv),
    info: Float32Array.from(out.info)
  };
}
