// js/world/street-geometry.js
// Builds the street surfaces from the baked road graph (data/roads.json): an asphalt (or dirt) ribbon along every edge
// at the smooth profile height, kerb faces and raised pavements on the sides that have them, junction patches at
// the nodes. Pure geometry (no GPU objects), so it runs under Node for tests.
//
// Vertex layout: position, normal, uv = (arc length along the edge in m, lateral offset from the centreline in m,
// positive to the left), info = (surface, centre line allowed, centre line from s, centre line to s).

export const SURF = { ASPHALT: 0, SIDEWALK: 1, KERB: 2, DIRT: 3 };
export const LIFT = 0.04; // the asphalt rides this far above the (burned) terrain so the two never z-fight
export const CURB = 0.14; // pavement height above the asphalt
export const TRACK_LIFT = 0.03;
// The terrain inside a road corridor is baked this far below the road profile, so quantisation and triangle
// interpolation of the terrain can never poke through the asphalt (tools/vallromanes/burn-roads.mjs)
export const ROAD_DEPTH = 0.1;
const JUNCTION_SIDES = 12;
const MARK_MIN_WIDTH = 5.2; // narrower streets get no centre line
const MARK_TRIM_MARGIN = 0.4;

export function newBuffers() {
  return { position: [], normal: [], uv: [], info: [], index: [] };
}

const isTrack = (e) => e.cls === 'track';
const isDirt = (e) => e.cls === 'track' || e.cls === 'urbanUnpaved';

function arcLengths(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return s;
}

// Sub-polyline between arc lengths s0 and s1 (interpolated end points), or null if it is shorter than 0.5 m
export function slicePolyline(pts, s0, s1) {
  const s = arcLengths(pts);
  const total = s[s.length - 1];
  s0 = Math.max(0, s0);
  s1 = Math.min(total, s1);
  if (s1 - s0 < 0.5) return null;
  const at = (target) => {
    let i = 1;
    while (i < s.length - 1 && s[i] < target) i++;
    const t = (target - s[i - 1]) / ((s[i] - s[i - 1]) || 1);
    const a = pts[i - 1], b = pts[i];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
  };
  const out = [at(s0)];
  for (let i = 1; i < pts.length - 1; i++) if (s[i] > s0 + 1e-6 && s[i] < s1 - 1e-6) out.push(pts[i]);
  out.push(at(s1));
  return { pts: out, s0 };
}

// Left unit normal (-tz, tx) and the mitre scale per vertex (the offset is stretched at bends, within [1, 2])
function frames(pts) {
  return pts.map((p, i) => {
    const dirs = [];
    if (i > 0) { const l = Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) || 1; dirs.push([(p[0] - pts[i - 1][0]) / l, (p[1] - pts[i - 1][1]) / l]); }
    if (i + 1 < pts.length) { const l = Math.hypot(pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]) || 1; dirs.push([(pts[i + 1][0] - p[0]) / l, (pts[i + 1][1] - p[1]) / l]); }
    let tx = dirs.reduce((a, d) => a + d[0], 0), tz = dirs.reduce((a, d) => a + d[1], 0);
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    const cos = dirs.length ? Math.max(0.5, tx * dirs[0][0] + tz * dirs[0][1]) : 1;
    return { tx, tz, nx: -tz, nz: tx, miter: Math.min(2, 1 / cos) };
  });
}

export function addVertex(out, x, y, z, n, u, v, info) {
  const k = out.position.length / 3;
  out.position.push(x, y, z);
  out.normal.push(n[0], n[1], n[2]);
  out.uv.push(u, v);
  out.info.push(info[0], info[1], info[2], info[3]);
  return k;
}

// Triangles of a quad (a, b, c, d) = (A_i, B_i, B_i+1, A_i+1) whose face normal points up (+y) or along `dir`
export function addQuad(out, a, b, c, d, facing) {
  const p = (k) => [out.position[k * 3], out.position[k * 3 + 1], out.position[k * 3 + 2]];
  const [pa, pb, pc] = [p(a), p(b), p(c)];
  const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  if (n[0] * facing[0] + n[1] * facing[1] + n[2] * facing[2] >= 0) out.index.push(a, b, c, a, c, d);
  else out.index.push(a, c, b, a, d, c);
}

/**
 * A strip along `pts` ([[x, z, y]], with y the profile height) between lateral offsets offA and offB (positive to the
 * left of the direction of travel), at heights y + liftA and y + liftB. `s0` is the arc length of the first vertex.
 */
export function pushRibbon(out, pts, offA, offB, liftA, liftB, surf, s0, mark = [0, 0, 0]) {
  const f = frames(pts);
  const s = arcLengths(pts);
  const ids = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, z, y] = pts[i];
    // surface normal from the slope along the profile and across the strip (across is flat)
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
    const run = Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1;
    const slope = (next[2] - prev[2]) / run;
    const nn = [-f[i].tx * slope, 1, -f[i].tz * slope];
    const nl = Math.hypot(nn[0], nn[1], nn[2]);
    const n = [nn[0] / nl, nn[1] / nl, nn[2] / nl];
    const info = [surf, mark[0], mark[1], mark[2]];
    const m = f[i].miter;
    const a = addVertex(out, x + f[i].nx * offA * m, y + liftA, z + f[i].nz * offA * m, n, s0 + s[i], offA, info);
    const b = addVertex(out, x + f[i].nx * offB * m, y + liftB, z + f[i].nz * offB * m, n, s0 + s[i], offB, info);
    ids.push([a, b]);
  }
  for (let i = 0; i + 1 < ids.length; i++) addQuad(out, ids[i][0], ids[i][1], ids[i + 1][1], ids[i + 1][0], [0, 1, 0]);
}

// The vertical face of a kerb at lateral offset `off`, from lift0 up to lift1; it faces the carriageway
export function pushKerbFace(out, pts, off, lift0, lift1, side, s0) {
  const f = frames(pts);
  const s = arcLengths(pts);
  const ids = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, z, y] = pts[i];
    const m = f[i].miter;
    const n = [-side * f[i].nx, 0, -side * f[i].nz]; // towards the centreline
    const info = [SURF.KERB, 0, 0, 0];
    const lo = addVertex(out, x + f[i].nx * off * m, y + lift0, z + f[i].nz * off * m, n, s0 + s[i], off, info);
    const hi = addVertex(out, x + f[i].nx * off * m, y + lift1, z + f[i].nz * off * m, n, s0 + s[i], off, info);
    ids.push([lo, hi]);
  }
  for (let i = 0; i + 1 < ids.length; i++) addQuad(out, ids[i][0], ids[i][1], ids[i + 1][1], ids[i + 1][0], [-side * f[i].nx, 0, -side * f[i].nz]);
}

// Distance from a node's centre at which pavements and the centre line stop so that side streets stay open
export function nodeTrims(nodes, edges) {
  const incident = nodes.map(() => []);
  for (const e of edges) if (!isTrack(e)) { incident[e.a].push(e); if (e.b !== e.a) incident[e.b].push(e); }
  return incident.map((list) => (list.length >= 3 ? Math.max(...list.map((e) => Math.max(e.halfL, e.halfR))) + MARK_TRIM_MARGIN : 0));
}

export function appendEdge(out, e, trims) {
  const tA = trims[e.a] || 0, tB = trims[e.b] || 0;
  const total = arcLengths(e.pts).slice(-1)[0];
  const dirt = isDirt(e);
  const lift = isTrack(e) ? TRACK_LIFT : LIFT;
  const surf = dirt ? SURF.DIRT : SURF.ASPHALT;
  const width = e.halfL + e.halfR;
  const centreLine = !dirt && width >= MARK_MIN_WIDTH;
  const markFrom = tA, markTo = total - tB;
  pushRibbon(out, e.pts, e.halfL, -e.halfR, lift, lift, surf, 0, [centreLine ? 1 : 0, markFrom, markTo]);

  // Pavements and kerbs: trimmed at junctions
  const trimmed = slicePolyline(e.pts, tA, total - tB);
  if (!trimmed || dirt) return;
  for (const side of [1, -1]) {
    const sw = side > 0 ? e.swL : e.swR;
    if (!(sw > 0)) continue;
    const half = side > 0 ? e.halfL : e.halfR;
    const off = side * half;
    pushKerbFace(out, trimmed.pts, off, LIFT, LIFT + CURB, side, trimmed.s0);
    pushRibbon(out, trimmed.pts, off, side * (half + sw), LIFT + CURB, LIFT + CURB, SURF.SIDEWALK, trimmed.s0);
  }
}

// An asphalt disc at every junction node, filling the wedges between the incident ribbons
export function appendJunction(out, node, radius) {
  const [x, z, y] = node;
  const centre = addVertex(out, x, y + LIFT, z, [0, 1, 0], 0, 1, [SURF.ASPHALT, 0, 0, 0]);
  const ring = [];
  for (let i = 0; i < JUNCTION_SIDES; i++) {
    const a = (i / JUNCTION_SIDES) * Math.PI * 2;
    ring.push(addVertex(out, x + Math.cos(a) * radius, y + LIFT, z + Math.sin(a) * radius, [0, 1, 0], 0, 1, [SURF.ASPHALT, 0, 0, 0]));
  }
  for (let i = 0; i < JUNCTION_SIDES; i++) addQuad(out, centre, ring[i], ring[(i + 1) % JUNCTION_SIDES], centre, [0, 1, 0]);
}

export function junctionRadii(nodes, edges) {
  const radius = nodes.map(() => 0);
  const count = nodes.map(() => 0);
  for (const e of edges) {
    if (isTrack(e)) continue;
    for (const n of new Set([e.a, e.b])) {
      count[n]++;
      radius[n] = Math.max(radius[n], Math.max(e.halfL, e.halfR));
    }
  }
  return radius.map((r, i) => (count[i] >= 3 ? r + 0.1 : 0));
}

export function toTypedBuffers(out) {
  const indexed = out.position.length / 3 > 65535 ? Uint32Array : Uint16Array;
  return {
    position: Float32Array.from(out.position),
    normal: Float32Array.from(out.normal),
    uv: Float32Array.from(out.uv),
    info: Float32Array.from(out.info),
    index: indexed.from(out.index)
  };
}
