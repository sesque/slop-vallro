// js/geo/lane-graph.js
// A directed lane graph for cars, built from the baked streets (data/roads.json). Every drivable edge gives one lane per
// direction of travel (one for one-way streets), offset to the right-hand side of the carriageway as Spain drives. Lanes meet
// at the street nodes; a node with three or more drivable edges is an intersection with a right-of-way ranking.
// Pure data, no DOM or three.js, so it runs under Node for tests.

const CLUSTER = 40;
const SHORT_HOP = 30;
const DRIVABLE = new Set(['urban', 'urbanUnpaved', 'road']);

// OSM highway class -> priority at junctions (higher goes first)
const RANK = { secondary: 5, secondary_link: 4, tertiary: 4, unclassified: 3, residential: 3, living_street: 2, service: 1, track: 1 };

/** The right-of-way rank of a baked edge. */
export function edgeRank(e) {
  return RANK[e.osm] ?? (e.cls === 'road' ? 3 : e.cls === 'urbanUnpaved' ? 2 : 3);
}

const wrap = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

/** The polyline `pts` ([x, z, y]) shifted `off` metres to the right of its direction of travel (miter, capped). */
function offsetLine(pts, off) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    // half the turn at this vertex stretches the offset by 1 / cos(half angle)
    const p = pts[i], q = pts[Math.max(0, i - 1)], r = pts[Math.min(n - 1, i + 1)];
    let k = 1;
    if (i > 0 && i < n - 1) {
      const d1 = Math.atan2(p[0] - q[0], p[1] - q[1]), d2 = Math.atan2(r[0] - p[0], r[1] - p[1]);
      k = Math.min(1.6, 1 / Math.max(0.3, Math.cos(wrap(d2 - d1) / 2)));
    }
    out.push([p[0] - dz * off * k, p[1] + dx * off * k, p[2]]);
  }
  return out;
}

/**
 * Lanes from `roads` ({ nodes, edges }). Options: `aLat` (m/s², lateral grip budget that limits the speed in bends) and
 * `speedScale` (share of the posted limit that drivers keep to), `trims` (nodeTrims: where the crossings are, so that cars stop
 * before them).
 * Returns { lanes, nodes, laneNear, totalLength } where each lane is
 * { id, edge, from, to, rank, x[], z[], y[], cum[], length, limit, vb[], grade, next[], uturn, cars[] } and each node is
 * { id, x, z, y, inLanes[], outLanes[], control, gate, pedsCrossing }, where gate = { id, nodes[], inLanes[], holder } is shared by junctions
 * within CLUSTER metres of each other.
 */
export function buildLaneGraph(roads, { aLat = 2.6, speedScale = 0.9, trims = [] } = {}) {
  const edges = roads.edges.filter((e) => DRIVABLE.has(e.cls) && e.pts.length >= 2 && e.a !== e.b);
  const nodes = roads.nodes.map((p, id) => ({ id, x: p[0], z: p[1], y: p[2], inLanes: [], outLanes: [], edgeCount: 0, rank: 0, control: false, gate: null, pedsCrossing: 0 }));
  const lanes = [];
  const byEdge = new Map();

  for (const e of edges) {
    nodes[e.a].edgeCount++;
    nodes[e.b].edgeCount++;
    const rank = edgeRank(e);
    nodes[e.a].rank = Math.max(nodes[e.a].rank, rank);
    nodes[e.b].rank = Math.max(nodes[e.b].rank, rank);
    const limit = Math.min(e.cls === 'urbanUnpaved' ? 20 : 90, e.speed || 30) / 3.6 * speedScale;
    const pair = [];
    for (const dir of [1, -1]) {
      if (e.oneway === 1 && dir === -1) continue;
      if (e.oneway === -1 && dir === 1) continue;
      // data "L" is the side with positive lateral, which is the physical right of the direction a -> b
      const half = dir === 1 ? e.halfL : e.halfR;
      const off = Math.min(2.4, Math.max(1.1, half * 0.5));
      const src = dir === 1 ? e.pts : [...e.pts].reverse();
      const line = offsetLine(src, off);
      const lane = makeLane(lanes.length, e, dir === 1 ? e.a : e.b, dir === 1 ? e.b : e.a, line, limit, rank, aLat);
      lanes.push(lane);
      pair.push(lane);
    }
    byEdge.set(e.id, pair);
  }
  for (const l of lanes) {
    l.stop = (trims[l.to] || 3) + 1.2;
    nodes[l.from].outLanes.push(l);
    nodes[l.to].inLanes.push(l);
  }
  for (const n of nodes) n.control = n.edgeCount >= 3;

  // junctions closer than CLUSTER metres share one gate, so that a car between them cannot hold one end and wait for the other
  const root = nodes.map((_, i) => i);
  const find = (i) => { while (root[i] !== i) i = root[i] = root[root[i]]; return i; };
  for (const l of lanes) if (l.length < CLUSTER && nodes[l.from].control && nodes[l.to].control) root[find(l.from)] = find(l.to);
  const gates = new Map();
  for (const n of nodes) {
    if (!n.control) continue;
    const r = find(n.id);
    if (!gates.has(r)) gates.set(r, { id: r, nodes: [], inLanes: [], holder: null });
    const gate = gates.get(r);
    gate.nodes.push(n);
    n.gate = gate;
  }
  // a bend (a node with two streets) within a few metres of a junction belongs to it too: the stop line lies before it
  for (let grew = true; grew;) {
    grew = false;
    for (const l of lanes) {
      if (l.length >= SHORT_HOP) continue;
      const a = nodes[l.from], b = nodes[l.to];
      if (a.gate && !b.gate && b.edgeCount === 2) { b.gate = a.gate; a.gate.nodes.push(b); grew = true; }
      else if (b.gate && !a.gate && a.edgeCount === 2) { a.gate = b.gate; b.gate.nodes.push(a); grew = true; }
    }
  }
  for (const gate of gates.values()) {
    for (const n of gate.nodes) for (const l of n.inLanes) if (!gate.nodes.includes(nodes[l.from])) gate.inLanes.push(l);
  }

  // connections
  for (const l of lanes) {
    const tx = l.x[l.x.length - 1] - l.x[l.x.length - 2], tz = l.z[l.z.length - 1] - l.z[l.z.length - 2];
    const heading = Math.atan2(tx, tz);
    const outs = nodes[l.to].outLanes;
    l.next = [];
    for (const o of outs) {
      if (o.edge === l.edge) {
        if (outs.length === 1 || nodes[l.to].edgeCount === 1) l.uturn = o; // a dead end turns round
        continue;
      }
      const turn = wrap(Math.atan2(o.x[1] - o.x[0], o.z[1] - o.z[0]) - heading);
      l.next.push({ lane: o, turn, weight: Math.max(0.12, 0.55 + 0.45 * Math.cos(turn)) * (0.6 + o.rank * 0.2) });
    }
    if (l.next.length === 0 && l.uturn) l.next.push({ lane: l.uturn, turn: Math.PI, weight: 1 });
    // the speed that a turn into each successor allows
    for (const nx of l.next) nx.vTurn = Math.max(2.2, 9 * Math.cos(Math.min(Math.abs(nx.turn), Math.PI) / 2) ** 1.4 + 2.2);
  }

  // coarse index: lane midpoints
  const laneNear = (x, z, r) => {
    const out = [];
    for (const l of lanes) {
      const dx = l.mx - x, dz = l.mz - z, reach = r + l.length * 0.5;
      if (dx * dx + dz * dz <= reach * reach) out.push(l);
    }
    return out;
  };
  return { lanes, nodes, gates: [...gates.values()], byEdge, laneNear, totalLength: lanes.reduce((s, l) => s + l.length, 0) };
}

function makeLane(id, e, from, to, line, limit, rank, aLat) {
  const n = line.length;
  const x = new Float64Array(n), z = new Float64Array(n), y = new Float64Array(n), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = line[i][0]; z[i] = line[i][1]; y[i] = line[i][2];
    if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  }
  const length = cum[n - 1];
  // speed allowed at each vertex by the bend there (v = sqrt(aLat / curvature)), and the mean grade
  const vb = new Float64Array(n).fill(Infinity);
  for (let i = 1; i < n - 1; i++) {
    const d1 = Math.atan2(x[i] - x[i - 1], z[i] - z[i - 1]), d2 = Math.atan2(x[i + 1] - x[i], z[i + 1] - z[i]);
    const ang = Math.abs(wrap(d2 - d1));
    const span = (cum[i + 1] - cum[i - 1]) * 0.5;
    if (ang > 0.02 && span > 0.1) vb[i] = Math.max(2.5, Math.sqrt(aLat / (ang / span)));
  }
  const grade = length > 1 ? Math.abs(y[n - 1] - y[0]) / length : 0;
  const slopeFactor = 1 - Math.min(0.35, Math.max(0, grade - 0.07) * 2.2);
  return {
    id, edge: e.id, name: e.name, from, to, rank, x, z, y, cum, length, limit: limit * slopeFactor, vb, grade,
    mx: (x[0] + x[n - 1]) / 2, mz: (z[0] + z[n - 1]) / 2, next: [], uturn: null, cars: []
  };
}

/** Point and unit tangent at arc length `s` on `lane` (clamped), written to `out` = { x, z, y, dx, dz }; returns the segment. */
export function laneAt(lane, s, out, hint = 0) {
  const { cum } = lane;
  const last = cum.length - 1;
  s = Math.min(lane.length, Math.max(0, s));
  let i = Math.min(Math.max(hint, 0), last - 1);
  while (i > 0 && cum[i] > s) i--;
  while (i < last - 1 && cum[i + 1] < s) i++;
  const len = cum[i + 1] - cum[i] || 1;
  const t = (s - cum[i]) / len;
  out.x = lane.x[i] + (lane.x[i + 1] - lane.x[i]) * t;
  out.z = lane.z[i] + (lane.z[i + 1] - lane.z[i]) * t;
  out.y = lane.y[i] + (lane.y[i + 1] - lane.y[i]) * t;
  out.dx = (lane.x[i + 1] - lane.x[i]) / len;
  out.dz = (lane.z[i + 1] - lane.z[i]) / len;
  return i;
}

/** Arc length of the point of `lane` nearest (x, z), searched from segment `hint` over `reach` segments both ways. */
export function laneProject(lane, x, z, hint = 0, reach = 4) {
  const last = lane.cum.length - 1;
  const i0 = Math.max(0, hint - reach), i1 = Math.min(last - 1, hint + reach);
  let best = Infinity, bs = 0, bi = i0;
  for (let i = i0; i <= i1; i++) {
    const ax = lane.x[i], az = lane.z[i];
    const dx = lane.x[i + 1] - ax, dz = lane.z[i + 1] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = (x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2;
    if (d < best) { best = d; bs = lane.cum[i] + Math.sqrt(l2) * t; bi = i; }
  }
  return { s: bs, seg: bi, dist: Math.sqrt(best) };
}
