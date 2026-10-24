import { ShapeUtils, Vector2 } from 'three';
import { addQuad, addVertex, newBuffers, pushRibbon, toTypedBuffers } from './street-geometry.js';

// js/world/feature-geometry.js
// Walls, hedges, fences, crash barriers, bridges, stairs, streams, pools and ponds from the baked features
// (data/features.json, data/stairs.json). Pure geometry, so it runs under Node for tests. Three buffer sets, one per
// material (see js/world/features.js): `solid` (opaque masonry, hedges, steps), `screen` (alpha-tested fences and rails),
// `water`. Layout as in street-geometry.js: position, normal, uv, info = (surface, 0, 0, 0), plus an index.
//   solid  uv = (metres along the feature, height y)         screen uv = (metres along, height above the base)

export { newBuffers, toTypedBuffers };
export const SOLID = { WALL: 0, RETAINING: 1, HEDGE: 2, STAIR: 3, BRIDGE: 4, COPING: 5, TANK: 6 };
export const SCREEN = { FENCE: 0, WIRE: 1, RAILING: 2, BARRIER: 3 };
export const WATER = { POOL: 0, POND: 1, STREAM: 2, DITCH: 3 };

// Which surface each baked line kind gets (the kind names of tools/vallromanes/build-features.mjs LINE_KINDS)
export const KIND_SURFACE = {
  wall: ['solid', SOLID.WALL], gardenWall: ['solid', SOLID.WALL], retaining: ['solid', SOLID.RETAINING], hedge: ['solid', SOLID.HEDGE],
  fence: ['screen', SCREEN.FENCE], wire: ['screen', SCREEN.WIRE], railing: ['screen', SCREEN.RAILING], barrier: ['screen', SCREEN.BARRIER],
  stream: ['water', WATER.STREAM], ditch: ['water', WATER.DITCH], bridge: ['bridge', SOLID.BRIDGE]
};
export const WATER_LIFT = 0.03; // the water plate stands this far above its level
export const COPING_HEIGHT = 0.12; // pool rim above the water level
export const DEPTH_BELOW = 0.35; // tanks and bridges reach this far below the lowest ground
const BRIDGE_PARAPET = 0.95;
const BRIDGE_PARAPET_THICK = 0.3;

// Unit tangent and mitred left normal of vertex i of a polyline [[x, z, ...]]
function frameAt(pts, i, closed) {
  const n = pts.length;
  const prev = pts[i > 0 ? i - 1 : (closed ? n - 2 : 0)], next = pts[i < n - 1 ? i + 1 : (closed ? 1 : n - 1)];
  const dirs = [];
  if (prev !== pts[i] && !(prev[0] === pts[i][0] && prev[1] === pts[i][1])) { const l = Math.hypot(pts[i][0] - prev[0], pts[i][1] - prev[1]); dirs.push([(pts[i][0] - prev[0]) / l, (pts[i][1] - prev[1]) / l]); }
  if (next !== pts[i] && !(next[0] === pts[i][0] && next[1] === pts[i][1])) { const l = Math.hypot(next[0] - pts[i][0], next[1] - pts[i][1]); dirs.push([(next[0] - pts[i][0]) / l, (next[1] - pts[i][1]) / l]); }
  let tx = dirs.reduce((a, d) => a + d[0], 0), tz = dirs.reduce((a, d) => a + d[1], 0);
  const l = Math.hypot(tx, tz) || 1;
  tx /= l; tz /= l;
  const cos = dirs.length ? Math.max(0.5, tx * dirs[0][0] + tz * dirs[0][1]) : 1;
  return { tx, tz, nx: -tz, nz: tx, miter: Math.min(2, 1 / cos) };
}

const isClosed = (pts) => pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];

/**
 * A wall of thickness `thick` along `pts` = [[x, z, base, top], ...]: two faces (the left one faces the left of the
 * direction of travel), the top, and caps at both ends of an open line. `surf` goes in info.x.
 */
export function appendWall(out, pts, thick, surf) {
  const closed = isClosed(pts);
  const half = thick / 2;
  const ids = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const [x, z, base, top] = pts[i];
    const f = frameAt(pts, i, closed);
    const ox = f.nx * half * f.miter, oz = f.nz * half * f.miter;
    const info = [surf, 0, 0, 0];
    const left = [f.nx, 0, f.nz], right = [-f.nx, 0, -f.nz], up = [0, 1, 0];
    ids.push({
      lb: addVertex(out, x + ox, base, z + oz, left, s, base, info), lt: addVertex(out, x + ox, top, z + oz, left, s, top, info),
      rb: addVertex(out, x - ox, base, z - oz, right, s, base, info), rt: addVertex(out, x - ox, top, z - oz, right, s, top, info),
      tl: addVertex(out, x + ox, top, z + oz, up, s, 0, info), tr: addVertex(out, x - ox, top, z - oz, up, s, thick, info),
      f
    });
  }
  for (let i = 0; i + 1 < ids.length; i++) {
    const a = ids[i], b = ids[i + 1];
    addQuad(out, a.lb, a.lt, b.lt, b.lb, [a.f.nx, 0, a.f.nz]);
    addQuad(out, a.rb, a.rt, b.rt, b.rb, [-a.f.nx, 0, -a.f.nz]);
    addQuad(out, a.tl, a.tr, b.tr, b.tl, [0, 1, 0]);
  }
  if (!closed && ids.length >= 2) {
    for (const [k, sign] of [[0, -1], [ids.length - 1, 1]]) {
      const e = ids[k], [x, z, base, top] = pts[k];
      const f = e.f, ox = f.nx * half * f.miter, oz = f.nz * half * f.miter;
      const n = [sign * f.tx, 0, sign * f.tz], info = [surf, 0, 0, 0];
      const q = [[x + ox, base], [x - ox, base], [x - ox, top], [x + ox, top]].map(([px, py], j) => addVertex(out, px, py, j < 2 ? z + (j === 0 ? oz : -oz) : z + (j === 2 ? -oz : oz), n, 0, py, info));
      addQuad(out, q[0], q[1], q[2], q[3], n);
    }
  }
}

/** A one-sided strip from base to top along `pts`, for alpha-tested fences and rails (drawn double-sided). */
export function appendScreen(out, pts, surf) {
  const ids = [];
  let s = 0;
  const closed = isClosed(pts);
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const [x, z, base, top] = pts[i];
    const f = frameAt(pts, i, closed);
    const n = [f.nx, 0, f.nz], info = [surf, top - base, 0, 0]; // info.y = the strip's height, for the rails of the pattern
    ids.push([addVertex(out, x, base, z, n, s, 0, info), addVertex(out, x, top, z, n, s, top - base, info), f]);
  }
  for (let i = 0; i + 1 < ids.length; i++) addQuad(out, ids[i][0], ids[i][1], ids[i + 1][1], ids[i + 1][0], [ids[i][2].nx, 0, ids[i][2].nz]);
}

// The polyline shifted sideways by `off` (positive to the left); the third and fourth entries are kept
export function offsetLine(pts, off) {
  const closed = isClosed(pts);
  return pts.map((p, i) => {
    const f = frameAt(pts, i, closed);
    return [p[0] + f.nx * off * f.miter, p[1] + f.nz * off * f.miter, p[2], p[3]];
  });
}

/** A bridge: a deck slab (top at the survey height) with a parapet along both edges. `pts` = [[x, z, bottom, top]]. */
export function appendBridge(solid, pts, width) {
  appendWall(solid, pts, width, SOLID.BRIDGE);
  for (const side of [1, -1]) {
    const edge = offsetLine(pts, side * (width / 2 - BRIDGE_PARAPET_THICK / 2));
    appendWall(solid, edge.map((p) => [p[0], p[1], p[3], p[3] + BRIDGE_PARAPET]), BRIDGE_PARAPET_THICK, SOLID.WALL);
  }
}

/** A stream or ditch: a ribbon of `width` that follows the ground (`pts` = [[x, z, ground, ground]]). */
export function appendStream(water, pts, width, surf) {
  pushRibbon(water, pts.map((p) => [p[0], p[1], p[3]]), width / 2, -width / 2, WATER_LIFT, WATER_LIFT, surf, 0);
}

function fillRing(out, outer, holes, y, surf, face) {
  const toPts = (r) => Array.from({ length: r.length / 2 }, (_, i) => new Vector2(r[i * 2], r[i * 2 + 1]));
  const contour = toPts(outer), holePts = holes.map(toPts);
  const all = contour.concat(...holePts);
  for (const [a, b, c] of ShapeUtils.triangulateShape(contour, holePts)) {
    const ids = [a, b, c].map((k) => addVertex(out, all[k].x, y, all[k].y, [0, face, 0], all[k].x, all[k].y, [surf, 0, 0, 0]));
    // earcut's winding is arbitrary: make the face look along (0, face, 0)
    const ab = [all[b].x - all[a].x, all[b].y - all[a].y], ac = [all[c].x - all[a].x, all[c].y - all[a].y];
    const upNormalY = ac[0] * ab[1] - ac[1] * ab[0]; // y of (b - a) x (c - a) with z as the second plane axis
    const flip = (upNormalY > 0) !== (face > 0);
    out.index.push(ids[0], flip ? ids[2] : ids[1], flip ? ids[1] : ids[2]);
  }
}

// Vertical band along a closed ring from y0 to y1, its face looking out of the ring (or into it when `inward`)
function ringWall(out, ring, y0, y1, surf, inward) {
  const pts = [];
  for (let i = 0; i <= ring.length / 2; i++) pts.push([ring[(i % (ring.length / 2)) * 2], ring[(i % (ring.length / 2)) * 2 + 1], y0, y1]);
  const ids = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const f = frameAt(pts, i, true);
    // outer rings have a positive signed area: their right-hand side (-nx, -nz) is outside
    const sign = inward ? 1 : -1;
    const n = [sign * f.nx, 0, sign * f.nz];
    ids.push([addVertex(out, pts[i][0], y0, pts[i][1], n, s, y0, [surf, 0, 0, 0]), addVertex(out, pts[i][0], y1, pts[i][1], n, s, y1, [surf, 0, 0, 0]), n]);
  }
  for (let i = 0; i + 1 < ids.length; i++) addQuad(out, ids[i][0], ids[i][1], ids[i + 1][1], ids[i + 1][0], ids[i][2]);
}

/**
 * A pool or pond as a raised tank (the terrain is not carved): its body reaches down to the lowest ground around it, the
 * rim (pools) or the bank is at the top, the water plate a little below. `body` = { type, y, outer, inner } in metres
 * (rings flat [x, z, ...], outer positive area); `ground(x, z)` is the terrain. Returns the water level used.
 */
export function appendWater(solid, water, body, ground) {
  const ring = body.outer;
  let maxG = -Infinity, minG = Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const g = ground(ring[i], ring[i + 1]);
    if (g > maxG) maxG = g;
    if (g < minG) minG = g;
  }
  const level = Math.max(body.y, maxG + 0.02);
  const rim = level + (body.type === 'pool' ? COPING_HEIGHT : 0.05);
  const surf = body.type === 'pool' ? WATER.POOL : WATER.POND;
  ringWall(solid, ring, minG - DEPTH_BELOW, rim, SOLID.TANK, false);
  if (body.inner) {
    fillRing(solid, ring, [reverse(body.inner)], rim, SOLID.COPING, 1);
    ringWall(solid, body.inner, level - 0.15, rim, SOLID.COPING, true);
    fillRing(water, body.inner, [], level + WATER_LIFT - 0.1, surf, 1);
  } else {
    fillRing(solid, ring, [], rim, SOLID.COPING, 1);
    fillRing(water, ring, [], level + WATER_LIFT, surf, 1);
  }
  return level;
}

function reverse(ring) {
  const out = new Array(ring.length);
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) { out[i * 2] = ring[(n - 1 - i) * 2]; out[i * 2 + 1] = ring[(n - 1 - i) * 2 + 1]; }
  return out;
}

/**
 * A flight of steps from data/stairs.json: `steps` = [[ax, az, bx, bz, y]] lowest first, `climb` the unit direction
 * up the flight. Each line is the nosing of a step: its riser rises from the previous step's height to its own, and
 * its tread runs back to the next step's line; solid sides reach `drop` below each tread.
 */
export function appendStairs(solid, flight, drop = 0.5) {
  const { steps, climb } = flight;
  const info = [SOLID.STAIR, 0, 0, 0];
  const spacing = [];
  for (let k = 0; k + 1 < steps.length; k++) {
    const c0 = [(steps[k][0] + steps[k][2]) / 2, (steps[k][1] + steps[k][3]) / 2], c1 = [(steps[k + 1][0] + steps[k + 1][2]) / 2, (steps[k + 1][1] + steps[k + 1][3]) / 2];
    spacing.push((c1[0] - c0[0]) * climb[0] + (c1[1] - c0[1]) * climb[1]);
  }
  const sorted = [...spacing].sort((a, b) => a - b);
  const typicalTread = sorted.length ? Math.max(0.2, sorted[Math.floor(sorted.length / 2)]) : 0.3;
  const typicalRise = steps.length > 1 ? Math.max(0.1, (steps[steps.length - 1][4] - steps[0][4]) / (steps.length - 1)) : 0.18;
  const edgeY = (k) => steps[k][4];
  for (let k = 0; k < steps.length; k++) {
    const [ax, az, bx, bz, y] = steps[k];
    const yPrev = k > 0 ? edgeY(k - 1) : y - typicalRise;
    // The far edge of the tread: the next step's line, or one typical tread further up the flight
    const next = k + 1 < steps.length ? steps[k + 1] : [ax + climb[0] * typicalTread, az + climb[1] * typicalTread, bx + climb[0] * typicalTread, bz + climb[1] * typicalTread, y];
    const [cx, cz, dx, dz] = next;
    const down = [-climb[0], 0, -climb[1]];
    const u = Math.hypot(bx - ax, bz - az);
    const riser = [addVertex(solid, ax, yPrev, az, down, 0, yPrev, info), addVertex(solid, bx, yPrev, bz, down, u, yPrev, info), addVertex(solid, bx, y, bz, down, u, y, info), addVertex(solid, ax, y, az, down, 0, y, info)];
    addQuad(solid, riser[0], riser[1], riser[2], riser[3], down);
    const tread = [addVertex(solid, ax, y, az, [0, 1, 0], 0, 0, info), addVertex(solid, bx, y, bz, [0, 1, 0], u, 0, info), addVertex(solid, dx, y, dz, [0, 1, 0], u, typicalTread, info), addVertex(solid, cx, y, cz, [0, 1, 0], 0, typicalTread, info)];
    addQuad(solid, tread[0], tread[1], tread[2], tread[3], [0, 1, 0]);
    // Side panels under the tread, on both ends of the line
    for (const [px, pz, qx, qz] of [[ax, az, cx, cz], [bx, bz, dx, dz]]) {
      const nx = -(qz - pz), nz = qx - px; // perpendicular to the tread edge, either way
      const l = Math.hypot(nx, nz) || 1;
      // outward = away from the flight's centre line
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const sgn = (px - mx) * nx + (pz - mz) * nz >= 0 ? 1 : -1;
      const n = [sgn * nx / l, 0, sgn * nz / l];
      const q = [addVertex(solid, px, y - drop, pz, n, 0, y - drop, info), addVertex(solid, qx, y - drop, qz, n, 1, y - drop, info), addVertex(solid, qx, y, qz, n, 1, y, info), addVertex(solid, px, y, pz, n, 0, y, info)];
      addQuad(solid, q[0], q[1], q[2], q[3], n);
    }
  }
}
