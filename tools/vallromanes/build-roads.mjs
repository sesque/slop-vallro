// Bakes the road network (spec §5.4, phase 4): graph, widths, sidewalks, names and a smooth height profile.
//   node tools/vallromanes/build-roads.mjs
// Reads the BUE centrelines and edge lines, writes data/roads.json. Manual fixes go in
// tools/data/vallromanes/overrides/roads.json, keyed by edge id: { name, halfL, halfR, swL, swR, oneway, lanes, speed,
// hide }. Traffic attributes default to two-way, one lane each way and 30 km/h in town; OSM matching comes later.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E0, N0, H0, toLocal } from './frame.mjs';
import { readBue } from './read-bue.mjs';
import { buildRoadGraph } from './road-graph.mjs';
import { matchNames, measureEdge, propagateNames, SegmentIndex } from './road-attributes.mjs';
import { matchOsm } from './osm-match.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');
const OVERRIDES = path.join(root, 'tools/data/vallromanes/overrides/roads.json');
const OSM = path.join(RAW, 'osm/vallromanes.json');

export const CLASS_BY_CAS = { COM_18_LN: 'urban', COM_19_LN: 'urbanUnpaved', COM_23_LN: 'road', COM_24_LN: 'track' };
export const DEFAULTS = {
  urban: { lanes: 2, speed: 30, oneway: false },
  urbanUnpaved: { lanes: 2, speed: 20, oneway: false },
  road: { lanes: 2, speed: 50, oneway: false },
  track: { lanes: 1, speed: 15, oneway: false }
};
const SMOOTH_WINDOW = 10; // m, half width of the triangular height filter
const NODE_BLEND = 12; // m over which an edge's ends are bent to the shared node height
const SIMPLIFY_TOL = 0.12; // m, 3D

const dist3 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

// Polyline resampled every `step` metres (x, z, y linear), always keeping the first and last vertex
export function resample(pts, step = 1) {
  const out = [pts[0].slice()];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let s = step - carry;
    while (s < len - 1e-9) {
      const t = s / len;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
      s += step;
    }
    carry = len - (s - step);
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(last[0] - out[out.length - 1][0], last[1] - out[out.length - 1][1]) > 1e-6) out.push(last.slice());
  return out;
}

// Triangular moving average of the heights over +-window metres along a (roughly evenly spaced) polyline
export function smoothHeights(pts, window = SMOOTH_WINDOW) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return pts.map((p, i) => {
    let sum = 0, wsum = 0;
    for (let j = i; j >= 0 && s[i] - s[j] <= window; j--) { const w = 1 - (s[i] - s[j]) / (window + 1e-9); sum += pts[j][2] * w; wsum += w; }
    for (let j = i + 1; j < pts.length && s[j] - s[i] <= window; j++) { const w = 1 - (s[j] - s[i]) / (window + 1e-9); sum += pts[j][2] * w; wsum += w; }
    return [p[0], p[1], sum / wsum];
  });
}

// Bends the heights near both ends so they meet the node heights ya (start) and yb (end)
export function pinEnds(pts, ya, yb, blend = NODE_BLEND) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = s[s.length - 1];
  const r = Math.min(blend, total / 2);
  const da = ya - pts[0][2], db = yb - pts[pts.length - 1][2];
  return pts.map((p, i) => {
    let y = p[2];
    if (r > 0) {
      if (s[i] < r) y += da * (1 - s[i] / r);
      if (total - s[i] < r) y += db * (1 - (total - s[i]) / r);
    } else {
      y = i === 0 ? ya : yb;
    }
    return [p[0], p[1], y];
  });
}

// Douglas-Peucker in 3D that always keeps the end vertices
export function simplify3D(pts, tol = SIMPLIFY_TOL) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    const a = pts[s], b = pts[e];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2)) : 0;
      const d = Math.hypot(p[0] - (a[0] + t * ab[0]), p[1] - (a[1] + t * ab[1]), p[2] - (a[2] + t * ab[2]));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Smooth profile for the whole graph: every edge smoothed on its own, then bent to a height shared by its nodes
export function profileGraph(graph) {
  const smoothed = graph.edges.map((e) => smoothHeights(resample(e.pts, 1)));
  const sum = graph.nodes.map(() => 0), count = graph.nodes.map(() => 0);
  graph.edges.forEach((e, i) => {
    const p = smoothed[i];
    sum[e.a] += p[0][2]; count[e.a]++;
    sum[e.b] += p[p.length - 1][2]; count[e.b]++;
  });
  const nodeY = graph.nodes.map((n, i) => (count[i] ? sum[i] / count[i] : n.y));
  graph.nodes.forEach((n, i) => { n.y = nodeY[i]; });
  return graph.edges.map((e, i) => simplify3D(pinEnds(smoothed[i], nodeY[e.a], nodeY[e.b])));
}

export function readInputs(dir) {
  const features = readBue(dir, { transform: toLocal });
  const lines = [];
  for (const f of features) {
    if (f.kind !== 'line' || !CLASS_BY_CAS[f.cas]) continue;
    for (const part of f.parts) lines.push({ id: f.cas, cls: CLASS_BY_CAS[f.cas], pts: part.map(([x, y, z]) => [x, z, y]) });
  }
  const index = { kerb: new SegmentIndex(), edge: new SegmentIndex(), trackEdge: new SegmentIndex(), limit: new SegmentIndex(), obstacle: new SegmentIndex() };
  for (const f of features) {
    for (const part of f.parts) {
      const pts = part.map(([x, , z]) => [x, z]);
      if (f.kind === 'line') {
        if (/^COM_17/.test(f.cas)) index.kerb.addPolyline(pts);
        else if (/^COM_02/.test(f.cas)) index.edge.addPolyline(pts);
        else if (/^COM_04/.test(f.cas)) index.trackEdge.addPolyline(pts);
        else if (/^COM_03/.test(f.cas)) index.limit.addPolyline(pts);
        else if (/^CON_(01|15|16|17)_LN$/.test(f.cas)) index.obstacle.addPolyline(pts);
      } else if (f.kind === 'poly' && f.cas === 'CON_13_PL') {
        index.obstacle.addPolyline(pts, true);
      }
    }
  }
  const labels = features
    .filter((f) => f.kind === 'text' && /^TOP_05(AV|CR)_TX$/.test(f.cas))
    .map((f) => ({ x: f.coords[0][0], z: f.coords[0][2], angle: f.angle, text: f.text }));
  return { lines, index, labels };
}

export function applyOverrides(record, override) {
  if (!override) return record;
  const out = { ...record };
  for (const k of ['name', 'halfL', 'halfR', 'swL', 'swR', 'oneway', 'lanes', 'speed', 'hide']) if (override[k] !== undefined) out[k] = override[k];
  return out;
}

export function bakeRoads({ lines, index, labels }, overrides = {}, osmWays = null) {
  const graph = buildRoadGraph(lines);
  const profiles = profileGraph(graph);
  const measured = graph.edges.map((e) => measureEdge(e, index));
  const direct = matchNames(graph.edges, labels);
  const names = propagateNames(graph.edges, graph.nodes, direct.names);

  // OSM attributes (when the extract exists), only over the defaults; the BUE names stay, OSM fills the gaps
  const osm = osmWays ? matchOsm(graph.edges.map((e, i) => ({ cls: e.cls, pts: profiles[i] })), osmWays) : null;
  const unknownOverrides = Object.keys(overrides).filter((id) => !graph.edges.some((e) => e.id === id));
  const edges = graph.edges.map((e, i) => {
    const m = measured[i];
    const d = DEFAULTS[e.cls];
    const pts = profiles[i];
    let length = 0;
    for (let k = 1; k < pts.length; k++) length += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const rec = {
      id: e.id, a: e.a, b: e.b, cls: e.cls, name: names[i],
      halfL: m.halfL, halfR: m.halfR, swL: m.swL, swR: m.swR, kerbL: m.kerbL, kerbR: m.kerbR, measured: m.measured,
      oneway: d.oneway, lanes: d.lanes, speed: d.speed,
      length: +length.toFixed(2),
      pts: pts.map(([x, z, y]) => [+x.toFixed(2), +z.toFixed(2), +y.toFixed(2)])
    };
    const m2 = osm?.[i];
    if (m2) {
      Object.assign(rec, m2.attrs);
      if (!rec.name && m2.attrs.osmName) rec.name = m2.attrs.osmName;
      delete rec.osmName;
    }
    return applyOverrides(rec, overrides[e.id]);
  }).filter((e) => !e.hide);
  return { graph, edges, nodes: graph.nodes, names, measured, direct, unknownOverrides, osmMatched: osm ? osm.filter(Boolean).length : null };
}

function report(result) {
  const { graph, edges, measured, direct, unknownOverrides } = result;
  const urban = edges.filter((e) => e.cls === 'urban');
  const km = (list) => (list.reduce((s, e) => s + e.length, 0) / 1000).toFixed(1);
  console.log(`Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges (${graph.report.snappedEndpointClusters} endpoint clusters, ${graph.report.snappedToLine} T-snaps, ${graph.report.crossings} crossings, ${graph.report.danglesRemoved} spurs removed)`);
  for (const cls of Object.keys(DEFAULTS)) {
    const list = edges.filter((e) => e.cls === cls);
    const w = list.map((e) => e.halfL + e.halfR).sort((a, b) => a - b);
    console.log(`  ${cls.padEnd(13)} ${String(list.length).padStart(4)} edges ${km(list).padStart(5)} km   width P10/P50/P90 ${w[Math.floor(w.length * 0.1)]?.toFixed(1)}/${w[Math.floor(w.length * 0.5)]?.toFixed(1)}/${w[Math.floor(w.length * 0.9)]?.toFixed(1)} m   measured ${list.filter((e) => e.measured).length}`);
  }
  const comps = graph.report.components;
  const compOfEdge = new Map(graph.edges.map((e) => [e.id, e.component]));
  const lenByComp = new Map();
  for (const e of urban) lenByComp.set(compOfEdge.get(e.id), (lenByComp.get(compOfEdge.get(e.id)) || 0) + e.length);
  const bestShare = Math.max(...lenByComp.values()) / urban.reduce((s, e) => s + e.length, 0);
  console.log(`Connectivity: ${comps.length} components; the largest holds ${(100 * bestShare).toFixed(1)}% of the urban length (gate >= 95%)`);
  if (bestShare < 0.95) throw new Error('Road graph: the main component holds under 95% of the urban length');
  const named = urban.filter((e) => e.name).length;
  console.log(`Names: ${direct.matched} of the street labels matched an edge; ${named} of ${urban.length} urban edges named (${(100 * named / urban.length).toFixed(0)}%, ${(100 * urban.filter((e) => e.name).reduce((s, e) => s + e.length, 0) / urban.reduce((s, e) => s + e.length, 0)).toFixed(0)}% of the length; gate >= 90% of edges)`);
  const sidewalks = urban.filter((e) => e.swL > 0 && e.swR > 0).length;
  console.log(`Sidewalks: both sides on ${sidewalks} of ${urban.length} urban edges`);
  const grades = [];
  for (const e of edges) for (let k = 1; k < e.pts.length; k++) {
    const l = Math.hypot(e.pts[k][0] - e.pts[k - 1][0], e.pts[k][1] - e.pts[k - 1][1]);
    if (l > 4) grades.push(Math.abs(e.pts[k][2] - e.pts[k - 1][2]) / l * 100);
  }
  grades.sort((a, b) => a - b);
  console.log(`Grade of the baked profile (segments > 4 m): P50 ${grades[Math.floor(grades.length * 0.5)].toFixed(1)}%  P90 ${grades[Math.floor(grades.length * 0.9)].toFixed(1)}%  P99 ${grades[Math.floor(grades.length * 0.99)].toFixed(1)}%  max ${grades[grades.length - 1].toFixed(1)}%`);
  const verts = edges.reduce((s, e) => s + e.pts.length, 0);
  console.log(`Vertices after 3D simplification (${SIMPLIFY_TOL} m): ${verts}`);
  if (result.osmMatched !== null) console.log(`OSM: ${result.osmMatched} of ${result.edges.length} edges matched a way`);
  else console.log('OSM: no extract (run tools/vallromanes/fetch-osm.mjs); traffic attributes use the class defaults');
  if (unknownOverrides.length) console.warn(`WARNING: overrides for unknown edge ids: ${unknownOverrides.join(', ')}`);
}

function main() {
  const inputs = readInputs(path.join(RAW, 'bue'));
  const overrides = fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) : {};
  const osmWays = fs.existsSync(OSM) ? JSON.parse(fs.readFileSync(OSM, 'utf8')).elements.filter((e) => e.type === 'way') : null;
  const result = bakeRoads(inputs, overrides, osmWays);
  report(result);
  for (const e of result.edges) {
    if (![e.halfL, e.halfR, e.length].every(Number.isFinite) || e.pts.some((p) => !p.every(Number.isFinite))) throw new Error(`Non-finite road data in ${e.id}`);
  }
  const out = {
    frame: { E0, N0, H0, crs: 'EPSG:25831' }, source: 'Diputació de Barcelona BUE 1:1000 (COM_18/19/23/24 centrelines)',
    classes: DEFAULTS,
    nodes: result.nodes.map((n) => [+n.x.toFixed(2), +n.z.toFixed(2), +n.y.toFixed(2)]),
    edges: result.edges
  };
  fs.writeFileSync(path.join(root, 'data/roads.json'), JSON.stringify(out));
  console.log(`written data/roads.json (${(fs.statSync(path.join(root, 'data/roads.json')).size / 1e3).toFixed(0)} kB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (err) { console.error(`build-roads failed: ${err.message}`); process.exit(1); }
}
