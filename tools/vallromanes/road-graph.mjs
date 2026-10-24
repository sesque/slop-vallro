// Builds a routable road graph from survey centrelines (spec §5.4, graph construction).
// Input: polylines { id, cls, pts: [[x, z, y], ...] } in the local frame. The steps:
//   1. endpoints within `snap` metres of each other join at their centroid;
//   2. a lone endpoint within `snap` of another line joins it (T-junction), splitting that line there;
//   3. lines that cross without a shared vertex are split at the crossing;
//   4. lines are cut at every shared vertex into edges between nodes;
//   5. chains through degree-2 nodes of the same class merge into one edge;
//   6. spurs shorter than `dangle` metres (one free end, the other end joined) are dropped, then chains merge again.
import { stableId } from './build-buildings.mjs';

const CELL = 8;

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

function closestOnSegment(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return { t, x: a[0] + t * dx, z: a[1] + t * dz, y: a[2] + t * (b[2] - a[2]) };
}

// Proper intersection of segments ab and cd (interior to both): returns { t, u } or null
function intersect(a, b, c, d) {
  const r0 = b[0] - a[0], r1 = b[1] - a[1], s0 = d[0] - c[0], s1 = d[1] - c[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den;
  const u = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
  const e = 1e-6;
  return t > e && t < 1 - e && u > e && u < 1 - e ? { t, u } : null;
}

class SegmentGrid {
  constructor() { this.cells = new Map(); }
  key(i, j) { return i * 100003 + j; }
  add(entry, a, b) {
    const i0 = Math.floor(Math.min(a[0], b[0]) / CELL), i1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const j0 = Math.floor(Math.min(a[1], b[1]) / CELL), j1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.key(i, j);
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(entry);
    }
  }
  near(x, z, r) {
    const out = new Set();
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
      for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
        const list = this.cells.get(this.key(i, j));
        if (list) for (const e of list) out.add(e);
      }
    }
    return out;
  }
}

export function buildRoadGraph(lines, { snap = 0.75, dangle = 3 } = {}) {
  const report = { lines: lines.length, snappedEndpointClusters: 0, snappedToLine: 0, crossings: 0, danglesRemoved: 0 };
  // Clean input: drop repeated vertices and degenerate lines
  const polys = [];
  for (const l of lines) {
    const pts = [];
    for (const p of l.pts) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) pts.push([p[0], p[1], p[2]]);
    }
    if (pts.length >= 2) polys.push({ id: l.id, cls: l.cls, pts });
  }

  // Index the original segments
  const grid = new SegmentGrid();
  polys.forEach((poly, li) => {
    for (let si = 0; si + 1 < poly.pts.length; si++) grid.add({ li, si }, poly.pts[si], poly.pts[si + 1]);
  });
  const inserts = polys.map(() => new Map()); // line -> seg -> [{t, x, z, y}]
  const insert = (li, si, t, x, z, y) => {
    const m = inserts[li];
    if (!m.has(si)) m.set(si, []);
    m.get(si).push({ t, x, z, y });
  };

  // 1. endpoint clusters
  const ends = [];
  polys.forEach((poly, li) => { ends.push({ li, end: 0 }); ends.push({ li, end: poly.pts.length - 1 }); });
  const endPt = (e) => polys[e.li].pts[e.end];
  const parent = ends.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const endGrid = new Map();
  ends.forEach((e, i) => {
    const p = endPt(e);
    const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
    if (!endGrid.has(k)) endGrid.set(k, []);
    endGrid.get(k).push(i);
  });
  ends.forEach((e, i) => {
    const p = endPt(e);
    const ci = Math.floor(p[0] / CELL), cj = Math.floor(p[1] / CELL);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const j of endGrid.get(`${ci + di},${cj + dj}`) || []) {
        if (j > i && dist2(p, endPt(ends[j])) <= snap * snap) parent[find(j)] = find(i);
      }
    }
  });
  const clusters = new Map();
  ends.forEach((_, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(i); });
  const joined = new Set();
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    report.snappedEndpointClusters++;
    let sx = 0, sz = 0, sy = 0;
    for (const i of members) { const p = endPt(ends[i]); sx += p[0]; sz += p[1]; sy += p[2]; }
    const c = [sx / members.length, sz / members.length, sy / members.length];
    for (const i of members) { const p = endPt(ends[i]); p[0] = c[0]; p[1] = c[1]; p[2] = c[2]; joined.add(i); }
  }

  // 2. lone endpoints onto another line
  ends.forEach((e, i) => {
    if (joined.has(i)) return;
    const p = endPt(e);
    let best = null;
    for (const s of grid.near(p[0], p[1], snap)) {
      if (s.li === e.li) continue;
      const a = polys[s.li].pts[s.si], b = polys[s.li].pts[s.si + 1];
      const q = closestOnSegment(p, a, b);
      const d = Math.hypot(q.x - p[0], q.z - p[1]);
      if (d <= snap && (!best || d < best.d)) best = { d, s, q, a, b };
    }
    if (!best) return;
    report.snappedToLine++;
    const { q, s, a, b } = best;
    // Onto an existing vertex of the other line: reuse its exact coordinates
    const va = Math.hypot(q.x - a[0], q.z - a[1]), vb = Math.hypot(q.x - b[0], q.z - b[1]);
    if (va <= 1e-3 || vb <= 1e-3) {
      const v = va <= vb ? a : b;
      p[0] = v[0]; p[1] = v[1]; p[2] = v[2];
    } else {
      insert(s.li, s.si, q.t, q.x, q.z, q.y);
      p[0] = q.x; p[1] = q.z; p[2] = q.y;
    }
  });

  // 3. crossings between original segments
  const seen = new Set();
  for (const [, list] of grid.cells) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const A = list[x], B = list[y];
        if (A.li === B.li && Math.abs(A.si - B.si) < 2) continue; // neighbours on the same line share a vertex
        const key = A.li < B.li || (A.li === B.li && A.si < B.si) ? `${A.li}.${A.si}-${B.li}.${B.si}` : `${B.li}.${B.si}-${A.li}.${A.si}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const a = polys[A.li].pts[A.si], b = polys[A.li].pts[A.si + 1], c = polys[B.li].pts[B.si], d = polys[B.li].pts[B.si + 1];
        const hit = intersect(a, b, c, d);
        if (!hit) continue;
        report.crossings++;
        const x0 = a[0] + hit.t * (b[0] - a[0]), z0 = a[1] + hit.t * (b[1] - a[1]);
        const yy = (a[2] + hit.t * (b[2] - a[2]) + c[2] + hit.u * (d[2] - c[2])) / 2;
        insert(A.li, A.si, hit.t, x0, z0, yy);
        insert(B.li, B.si, hit.u, x0, z0, yy);
      }
    }
  }

  // Apply the insertions
  for (let li = 0; li < polys.length; li++) {
    const poly = polys[li];
    const out = [];
    for (let si = 0; si < poly.pts.length; si++) {
      out.push(poly.pts[si]);
      const ins = inserts[li].get(si);
      if (ins && si + 1 < poly.pts.length) {
        ins.sort((p, q) => p.t - q.t);
        for (const v of ins) {
          const last = out[out.length - 1];
          if (Math.hypot(v.x - last[0], v.z - last[1]) > 1e-6) out.push([v.x, v.z, v.y]);
        }
      }
    }
    poly.pts = out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-6);
  }

  // 4. nodes: line ends and coordinates shared by two or more vertices
  const keyOf = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const uses = new Map();
  for (const poly of polys) for (const p of poly.pts) uses.set(keyOf(p), (uses.get(keyOf(p)) || 0) + 1);
  const nodeIndex = new Map();
  const nodes = [];
  const nodeFor = (p) => {
    const k = keyOf(p);
    let id = nodeIndex.get(k);
    if (id === undefined) { id = nodes.length; nodeIndex.set(k, id); nodes.push({ id, x: p[0], z: p[1], y: p[2] }); }
    return id;
  };
  let edges = [];
  for (const poly of polys) {
    let start = 0;
    for (let i = 1; i < poly.pts.length; i++) {
      const isNode = i === poly.pts.length - 1 || uses.get(keyOf(poly.pts[i])) > 1;
      if (!isNode) continue;
      const pts = poly.pts.slice(start, i + 1);
      edges.push({ a: nodeFor(pts[0]), b: nodeFor(pts[pts.length - 1]), cls: poly.cls, pts, src: poly.id });
      start = i;
    }
  }

  const degree = () => {
    const deg = new Array(nodes.length).fill(0);
    for (const e of edges) { deg[e.a]++; deg[e.b]++; }
    return deg;
  };
  const lengthOf = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

  // 5. merge chains through degree-2 nodes of the same class
  function mergeChains() {
    let changed = true;
    while (changed) {
      changed = false;
      const deg = degree();
      const incident = new Map();
      edges.forEach((e, i) => { for (const n of new Set([e.a, e.b])) { if (!incident.has(n)) incident.set(n, []); incident.get(n).push(i); } });
      for (const [n, list] of incident) {
        if (deg[n] !== 2 || list.length !== 2) continue;
        const [i1, i2] = list;
        const e1 = edges[i1], e2 = edges[i2];
        if (e1.cls !== e2.cls) continue;
        // orient: e1 ends at n, e2 starts at n
        const f1 = e1.b === n ? e1 : { ...e1, a: e1.b, b: e1.a, pts: [...e1.pts].reverse() };
        const f2 = e2.a === n ? e2 : { ...e2, a: e2.b, b: e2.a, pts: [...e2.pts].reverse() };
        const merged = { a: f1.a, b: f2.b, cls: e1.cls, pts: f1.pts.concat(f2.pts.slice(1)), src: e1.src };
        edges = edges.filter((_, i) => i !== i1 && i !== i2);
        edges.push(merged);
        changed = true;
        break; // incident map is stale now
      }
    }
  }
  mergeChains();

  // 6. short spurs
  for (let pass = 0; pass < 10; pass++) {
    const deg = degree();
    const keep = edges.filter((e) => {
      const spur = (deg[e.a] === 1 && deg[e.b] >= 3) || (deg[e.b] === 1 && deg[e.a] >= 3);
      return !(spur && lengthOf(e.pts) < dangle);
    });
    if (keep.length === edges.length) break;
    report.danglesRemoved += edges.length - keep.length;
    edges = keep;
    mergeChains();
  }

  // Renumber the surviving nodes
  const deg = degree();
  const remap = new Map();
  const outNodes = [];
  for (const n of nodes) if (deg[n.id] > 0) { remap.set(n.id, outNodes.length); outNodes.push({ id: outNodes.length, x: n.x, z: n.z, y: n.y }); }
  const usedIds = new Set();
  const outEdges = edges.map((e, i) => {
    const length = lengthOf(e.pts);
    const first = e.pts[0], last = e.pts[e.pts.length - 1], mid = e.pts[Math.floor(e.pts.length / 2)];
    // ends, middle vertex and length: parallel edges between the same two nodes still get distinct ids
    const cm = [first, mid, last].flatMap((p) => [Math.round(p[0] * 100), Math.round(p[1] * 100)]).concat(Math.round(length * 100));
    let id = stableId(e.cls, cm);
    for (let n = 1; usedIds.has(id); n++) id = stableId(e.cls, cm.concat(n)); // vanishingly rare
    usedIds.add(id);
    return { id, a: remap.get(e.a), b: remap.get(e.b), cls: e.cls, length, pts: e.pts, index: i };
  });

  // Connected components
  const comp = outNodes.map((_, i) => i);
  const cfind = (i) => { while (comp[i] !== i) { comp[i] = comp[comp[i]]; i = comp[i]; } return i; };
  for (const e of outEdges) comp[cfind(e.a)] = cfind(e.b);
  const compLen = new Map();
  for (const e of outEdges) compLen.set(cfind(e.a), (compLen.get(cfind(e.a)) || 0) + e.length);
  report.components = [...compLen.values()].sort((a, b) => b - a);
  report.nodes = outNodes.length;
  report.edges = outEdges.length;
  for (const e of outEdges) e.component = cfind(e.a);
  return { nodes: outNodes, edges: outEdges, report };
}
