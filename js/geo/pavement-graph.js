// js/geo/pavement-graph.js
// The pavements as a graph for walkers. Every urban street with a pavement gives one link per side, running between the
// trimmed ends that js/world/street-geometry.js draws. At each street node the link ends join their neighbours around the
// corner, and at junctions (three streets or more) a crossing link runs over the carriageway between the two sides of a
// street. Pure data, no DOM or three.js, so it runs under Node for tests.

const wrap = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

function arc(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}

/** The part of the polyline `pts` ([x, z, y]) between arc lengths s0 and s1, or null when that is shorter than 0.5 m. */
function slice(pts, s0, s1) {
  if (s1 - s0 < 0.5) return null;
  const cum = arc(pts);
  const at = (s) => {
    let i = 0;
    while (i < pts.length - 2 && cum[i + 1] < s) i++;
    const t = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    return [0, 1, 2].map((k) => pts[i][k] + (pts[i + 1][k] - pts[i][k]) * Math.min(1, Math.max(0, t)));
  };
  const out = [at(s0)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > s0 + 0.01 && cum[i] < s1 - 0.01) out.push(pts[i]);
  out.push(at(s1));
  return out;
}

/** `pts` shifted `off` metres to the +lateral side ((-dz, dx) of the direction of travel), mitred. */
function offsetLine(pts, off) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dx = (b[0] - a[0]) / l, dz = (b[1] - a[1]) / l;
    let k = 1;
    if (i > 0 && i < n - 1) {
      const d1 = Math.atan2(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]), d2 = Math.atan2(pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]);
      k = Math.min(1.6, 1 / Math.max(0.3, Math.cos(wrap(d2 - d1) / 2)));
    }
    return [p[0] - dz * off * k, p[1] + dx * off * k, p[2]];
  });
}

/**
 * `roads` = { nodes, edges } as in data/roads.json; `trims` = nodeTrims(...) from street-geometry.js.
 * Returns { links, nodes } with links { id, kind: 'walk' | 'corner' | 'cross', edge, node, x[], z[], cum[], length, ends: [[{ link, end }], [...]] }:
 * `ends[0]` lists where a walker leaving the start of the link may go on, `ends[1]` the same at its far end.
 */
export function buildPavementGraph(roads, trims = []) {
  const links = [];
  const nodeInfo = roads.nodes.map((p, id) => ({ id, x: p[0], z: p[1], y: p[2], spokes: [], crossings: [] }));
  const make = (kind, edge, node, pts) => {
    const cum = arc(pts);
    const link = { id: links.length, kind, edge, node, x: pts.map((p) => p[0]), z: pts.map((p) => p[1]), y: pts.map((p) => p[2]), cum, length: cum[cum.length - 1], ends: [[], []] };
    links.push(link);
    return link;
  };

  // pavement links per street side, and the spokes (street ends) around each node
  for (const e of roads.edges) {
    if (e.cls !== 'urban' || e.a === e.b) continue;
    const total = arc(e.pts).slice(-1)[0];
    const sl = slice(e.pts, trims[e.a] || 0, total - (trims[e.b] || 0));
    if (!sl) continue;
    const sides = {};
    for (const side of [1, -1]) {
      const sw = side > 0 ? e.swL : e.swR, half = side > 0 ? e.halfL : e.halfR;
      if (!(sw > 0)) continue;
      sides[side] = make('walk', e.id, null, offsetLine(sl, side * (half + sw * 0.5)));
    }
    // the +angle side of a spoke pointing away from node a is +lateral; from node b it is -lateral
    for (const [node, end, plus, minus] of [[e.a, 0, sides[1], sides[-1]], [e.b, 1, sides[-1], sides[1]]]) {
      const from = nodeInfo[node];
      const p = end === 0 ? e.pts[1] : e.pts[e.pts.length - 2];
      const q = end === 0 ? e.pts[0] : e.pts[e.pts.length - 1];
      from.spokes.push({ edge: e, end, angle: Math.atan2(p[1] - q[1], p[0] - q[0]), plus, minus });
    }
  }

  const join = (la, ea, lb, eb) => {
    la.ends[ea].push({ link: lb, end: eb });
    lb.ends[eb].push({ link: la, end: ea });
  };
  for (const n of nodeInfo) {
    const spokes = n.spokes.sort((a, b) => a.angle - b.angle);
    const k = spokes.length;
    if (k < 2) continue;
    for (let i = 0; i < k; i++) {
      const s = spokes[i], t = spokes[(i + 1) % k];
      // the +angle side of s meets the -angle side of the next spoke round the node, over a short link across the corner (the two ends
      // can be several metres apart, and a walker must walk it, not jump it)
      if (s.plus && t.minus && s.plus !== t.minus) {
        const a = s.plus, b = t.minus;
        const ia = s.end === 0 ? 0 : a.x.length - 1, ib = t.end === 0 ? 0 : b.x.length - 1;
        if (Math.hypot(a.x[ia] - b.x[ib], a.z[ia] - b.z[ib]) < 0.25) join(a, s.end, b, t.end);
        else {
          const c = make('corner', s.edge.id, n.id, [[a.x[ia], a.z[ia], a.y[ia]], [b.x[ib], b.z[ib], b.y[ib]]]);
          join(a, s.end, c, 0);
          join(b, t.end, c, 1);
        }
      }
    }
    if (k >= 3) {
      for (const s of spokes) {
        if (!s.plus || !s.minus) continue;
        const a = s.plus, b = s.minus;
        const ia = s.end === 0 ? 0 : a.x.length - 1, ib = s.end === 0 ? 0 : b.x.length - 1;
        const c = make('cross', s.edge.id, n.id, [[a.x[ia], a.z[ia], a.y[ia]], [b.x[ib], b.z[ib], b.y[ib]]]);
        join(a, s.end, c, 0);
        join(b, s.end, c, 1);
        n.crossings.push(c);
      }
    }
  }
  return { links, nodes: nodeInfo, totalLength: links.filter((l) => l.kind === 'walk').reduce((s, l) => s + l.length, 0) };
}
