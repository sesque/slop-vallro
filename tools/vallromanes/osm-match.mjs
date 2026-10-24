// Copies traffic attributes from OpenStreetMap ways (oneway, lanes, maxspeed, highway class, name) onto the road graph
// edges (spec §5.4). An edge matches the way that stays within `tol` metres of it along at least `share` of its length.
import { lonLatToUtm31 } from './build-boundary.mjs';
import { E0, N0 } from './frame.mjs';
import { samplePolyline } from './road-attributes.mjs';

// Overpass "out geom" element -> polyline in the local frame [[x, z], ...]
export function wayToLocal(way) {
  return way.geometry.map(({ lon, lat }) => {
    const [e, n] = lonLatToUtm31(lon, lat);
    return [e - E0, N0 - n];
  });
}

function distToPolyline(x, z, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

function direction(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

// "30", "30 km/h", "50 mph", "ES:urban" -> km/h or null
export function parseMaxspeed(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h)?$/i.exec(s);
  if (m) return Math.round(Number(m[1]) * (m[2] && m[2].toLowerCase() === 'mph' ? 1.609 : 1));
  if (/urban$/i.test(s)) return 50;
  if (/living_street$/i.test(s)) return 20;
  return null;
}

export function osmAttributes(tags, alongEdge) {
  const out = {};
  if (tags.highway) out.osm = tags.highway;
  const oneway = tags.oneway;
  if (oneway === 'yes' || oneway === 'true' || oneway === '1') out.oneway = alongEdge ? 1 : -1;
  else if (oneway === '-1') out.oneway = alongEdge ? -1 : 1;
  else if (tags.junction === 'roundabout') out.oneway = alongEdge ? 1 : -1;
  else if (oneway === 'no') out.oneway = false;
  const lanes = parseInt(tags.lanes, 10);
  if (Number.isFinite(lanes) && lanes > 0) out.lanes = lanes;
  const speed = parseMaxspeed(tags.maxspeed);
  if (speed) out.speed = speed;
  if (tags.name) out.osmName = tags.name;
  return out;
}

// Ways nobody drives on: they must not lend their attributes to a street or a road running alongside them
export const PEDESTRIAN_WAYS = new Set(['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'bridleway', 'corridor']);
const accepts = (edge, way) => edge.cls === 'track' || !PEDESTRIAN_WAYS.has(way.tags.highway);

/**
 * `edges`: baked road edges ({ cls, pts: [[x, z, y]] }); `ways`: Overpass ways with geometry. Returns one entry per edge:
 * null or { wayId, share, mean, attrs }.
 */
export function matchOsm(edges, ways, { tol = 8, share = 0.8 } = {}) {
  const polys = ways.filter((w) => w.geometry && w.geometry.length >= 2 && w.tags?.highway).map((w) => ({ way: w, pts: wayToLocal(w) }));
  return edges.map((e) => {
    const samples = samplePolyline(e.pts, 4);
    if (!samples.length) return null;
    const eDir = direction(e.pts);
    let best = null;
    for (const p of polys) {
      if (!accepts(e, p.way)) continue;
      let inside = 0, sum = 0;
      for (const s of samples) {
        const d = distToPolyline(s.x, s.z, p.pts);
        if (d <= tol) { inside++; sum += d; }
      }
      const cover = inside / samples.length;
      if (cover < share) continue;
      const mean = sum / inside;
      if (!best || cover > best.cover + 1e-9 || (Math.abs(cover - best.cover) <= 1e-9 && mean < best.mean)) best = { p, cover, mean };
    }
    if (!best) return null;
    const wDir = direction(best.p.pts);
    const along = eDir[0] * wDir[0] + eDir[1] * wDir[1] >= 0;
    return { wayId: best.p.way.id, share: +best.cover.toFixed(2), mean: +best.mean.toFixed(2), attrs: osmAttributes(best.p.way.tags, along) };
  });
}
