// Road widths, sidewalks and names for the graph edges (spec §5.4).
//   widths: rays perpendicular to the centreline every 5 m hit the nearest kerb / edge line on each side; the median
//           per side is the half width. Defaults by class when nothing is found.
//   sidewalks: where there is a kerb, the distance from it to the first limit / block / facade / wall line.
//   names: street labels (TOP_05) matched to the nearest edge running in the label's direction, then propagated.
import { signedArea } from '../../js/geo/polygon.js';

const CELL = 12;
const SAMPLE_EVERY = 5;
const MAX_RAY = 14;

export const DEFAULT_HALF = { urban: 3.0, urbanUnpaved: 2.5, road: 3.5, track: 1.75 };
export const HALF_RANGE = { urban: [1.5, 6.5], urbanUnpaved: [1.2, 5], road: [2, 8], track: [0.8, 4] };
export const SIDEWALK_RANGE = [0.8, 3.0];
export const SIDEWALK_DEFAULT = 1.5; // kerb present but no limit line close by

export class SegmentIndex {
  constructor() { this.cells = new Map(); this.segs = []; }
  add(ax, az, bx, bz) {
    const id = this.segs.length / 4;
    this.segs.push(ax, az, bx, bz);
    const i0 = Math.floor(Math.min(ax, bx) / CELL), i1 = Math.floor(Math.max(ax, bx) / CELL);
    const j0 = Math.floor(Math.min(az, bz) / CELL), j1 = Math.floor(Math.max(az, bz) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = i * 100003 + j;
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(id);
    }
  }
  addPolyline(pts, closed = false) {
    for (let i = 0; i + 1 < pts.length; i++) this.add(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (closed && pts.length > 2) this.add(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]);
  }
  // Distance along the ray (px, pz) + t * (dx, dz) to the first segment, or Infinity. Cells along the ray are visited.
  rayHit(px, pz, dx, dz, maxD, minD = 0.02) {
    let best = maxD;
    const seen = new Set();
    const steps = Math.ceil(maxD / (CELL / 2));
    for (let s = 0; s <= steps; s++) {
      const x = px + dx * Math.min(maxD, s * (CELL / 2)), z = pz + dz * Math.min(maxD, s * (CELL / 2));
      const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        for (const id of this.cells.get((ci + di) * 100003 + cj + dj) || []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const ax = this.segs[id * 4], az = this.segs[id * 4 + 1], bx = this.segs[id * 4 + 2], bz = this.segs[id * 4 + 3];
          const ex = bx - ax, ez = bz - az;
          const den = dx * ez - dz * ex;
          if (Math.abs(den) < 1e-12) continue;
          const t = ((ax - px) * ez - (az - pz) * ex) / den;
          const u = ((ax - px) * dz - (az - pz) * dx) / den;
          if (t > minD && t < best && u >= 0 && u <= 1) best = t;
        }
      }
    }
    return best < maxD ? best : Infinity;
  }
}

// Points every `step` metres along a polyline with their unit tangent
export function samplePolyline(pts, step = SAMPLE_EVERY) {
  const out = [];
  let acc = 0, next = step / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
    while (next <= acc + len) {
      const t = next - acc;
      out.push({ x: a[0] + tx * t, z: a[1] + tz * t, tx, tz, s: next });
      next += step;
    }
    acc += len;
  }
  if (!out.length && pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    out.push({ x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, tx: (b[0] - a[0]) / len, tz: (b[1] - a[1]) / len, s: len / 2 });
  }
  return out;
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};

/**
 * `index` = { kerb, edge, limit, obstacle } SegmentIndex instances. Returns, per edge:
 * { halfL, halfR, swL, swR, kerbL, kerbR, measured }. "Left" is the side of the left-hand normal (-tz, tx) in the
 * x, z plane.
 */
export function measureEdge(edge, index) {
  const samples = samplePolyline(edge.pts);
  const side = { L: { kerb: [], edge: [], sw: [] }, R: { kerb: [], edge: [], sw: [] } };
  const edgeIdx = edge.cls === 'track' ? index.trackEdge : index.edge;
  for (const s of samples) {
    for (const [name, nx, nz] of [['L', -s.tz, s.tx], ['R', s.tz, -s.tx]]) {
      const kerb = index.kerb.rayHit(s.x, s.z, nx, nz, MAX_RAY);
      if (Number.isFinite(kerb)) {
        side[name].kerb.push(kerb);
        // First thing beyond the kerb: a pavement limit, block outline, facade, wall or fence
        const obs = Math.min(index.limit.rayHit(s.x, s.z, nx, nz, kerb + 4.6, kerb + 0.3), index.obstacle.rayHit(s.x, s.z, nx, nz, kerb + 4.6, kerb + 0.3));
        side[name].sw.push(Number.isFinite(obs) ? obs - kerb : null);
      }
      const e = edgeIdx.rayHit(s.x, s.z, nx, nz, MAX_RAY);
      if (Number.isFinite(e)) side[name].edge.push(e);
    }
  }
  const out = { samples: samples.length };
  const [lo, hi] = HALF_RANGE[edge.cls] || HALF_RANGE.urban;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  for (const name of ['L', 'R']) {
    const s = side[name];
    const kerbShare = samples.length ? s.kerb.length / samples.length : 0;
    const hasKerb = edge.cls !== 'track' && kerbShare >= 0.3;
    let half = hasKerb ? median(s.kerb) : median(s.edge);
    out[`measured${name}`] = half !== null;
    out[`kerb${name}`] = hasKerb;
    out[`half${name}`] = half;
    if (hasKerb) {
      const swv = s.sw.filter((v) => v !== null && v >= 0.6);
      const sw = swv.length >= Math.max(1, s.sw.length * 0.3) ? clamp(median(swv), SIDEWALK_RANGE[0], SIDEWALK_RANGE[1]) : SIDEWALK_DEFAULT;
      out[`sw${name}`] = +sw.toFixed(2);
    } else {
      out[`sw${name}`] = 0;
    }
    if (half !== null) half = clamp(half, lo, hi);
    out[`half${name}`] = half;
  }
  // One side measured: mirror it; none: class default
  const dflt = DEFAULT_HALF[edge.cls] ?? 3;
  if (out.halfL === null && out.halfR === null) { out.halfL = out.halfR = dflt; }
  else if (out.halfL === null) out.halfL = out.halfR;
  else if (out.halfR === null) out.halfR = out.halfL;
  out.halfL = +out.halfL.toFixed(2);
  out.halfR = +out.halfR.toFixed(2);
  out.measured = out.measuredL || out.measuredR;
  return out;
}

// ---- names -------------------------------------------------------------------------------------------------------

// Angle in degrees, 0..180, of an edge's local direction around a point, CCW from east in UTM (x east, z = -north)
function directionDeg(tx, tz) {
  let a = (Math.atan2(-tz, tx) * 180) / Math.PI;
  a = ((a % 180) + 180) % 180;
  return a;
}
const angleDiff = (a, b) => {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
};

/**
 * `labels`: [{ x, z, angle (deg, as stored in the BUE), text }]. Each label names the closest street edge within
 * `radius` metres whose direction (mod 180) is within `tolerance` degrees of the label's. `convention` converts the
 * stored angle: 'ccw' = counter-clockwise from east (CAD), 'cw-north' = clockwise from north (GIS).
 */
export function matchNames(edges, labels, { radius = 25, tolerance = 30, convention = 'ccw' } = {}) {
  const votes = edges.map(() => new Map());
  let matched = 0;
  for (const label of labels) {
    const want = convention === 'ccw' ? ((label.angle % 180) + 180) % 180 : ((90 - label.angle) % 180 + 180) % 180;
    let best = null;
    edges.forEach((e, i) => {
      if (e.cls !== 'urban' && e.cls !== 'urbanUnpaved' && e.cls !== 'road') return;
      for (let k = 0; k + 1 < e.pts.length; k++) {
        const a = e.pts[k], b = e.pts[k + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
        if (l2 < 1e-9) continue;
        const t = Math.max(0, Math.min(1, ((label.x - a[0]) * dx + (label.z - a[1]) * dz) / l2));
        const d = Math.hypot(label.x - (a[0] + t * dx), label.z - (a[1] + t * dz));
        if (d > radius) continue;
        const dir = directionDeg(dx / Math.sqrt(l2), dz / Math.sqrt(l2));
        if (angleDiff(dir, want) > tolerance) continue;
        if (!best || d < best.d) best = { d, i };
      }
    });
    if (!best) continue;
    matched++;
    votes[best.i].set(label.text, (votes[best.i].get(label.text) || 0) + 1);
  }
  const names = votes.map((v) => (v.size ? [...v.entries()].sort((a, b) => b[1] - a[1])[0][0] : null));
  return { names, matched };
}

// Names flow along a street: an unnamed edge takes the name of a neighbour at a node where the continuation is the
// straightest one (turn below `maxTurn` degrees) and the street has no other candidate. Repeats until stable.
export function propagateNames(edges, nodes, names, { maxTurn = 35 } = {}) {
  const out = [...names];
  const dirAtNode = (e, node) => {
    const fromStart = e.a === node;
    const p = fromStart ? e.pts[0] : e.pts[e.pts.length - 1];
    const q = fromStart ? e.pts[Math.min(e.pts.length - 1, 1)] : e.pts[Math.max(0, e.pts.length - 2)];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  };
  const incident = nodes.map(() => []);
  edges.forEach((e, i) => { incident[e.a].push(i); if (e.b !== e.a) incident[e.b].push(i); });
  const street = (e) => e.cls === 'urban' || e.cls === 'urbanUnpaved' || e.cls === 'road';
  let changed = true;
  let rounds = 0;
  while (changed && rounds++ < 50) {
    changed = false;
    edges.forEach((e, i) => {
      if (out[i] || !street(e)) return;
      let best = null;
      for (const node of [e.a, e.b]) {
        const d0 = dirAtNode(e, node);
        for (const j of incident[node]) {
          if (j === i || !out[j]) continue;
          const d1 = dirAtNode(edges[j], node);
          const turn = (Math.acos(Math.max(-1, Math.min(1, -(d0[0] * d1[0] + d0[1] * d1[1])))) * 180) / Math.PI; // 0 = straight on
          if (turn <= maxTurn && (!best || turn < best.turn)) best = { turn, name: out[j] };
        }
      }
      if (best) { out[i] = best.name; changed = true; }
    });
  }
  return out;
}

// Ring helper for block polygons: outline segments of a polygon ring as an array of [x, z]
export function ringPoints(part) {
  return part.map((p) => [p[0], p[2]]);
}

export { signedArea };
