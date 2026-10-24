// Plain 2D polygon helpers shared by the baking pipeline and the runtime (x, z plane, metres).
// A ring is a flat array [x0, z0, x1, z1, ...] without a repeated closing vertex. Orientation convention for baked
// polygons: outer rings have a positive signed area (shoelace over x, z), holes a negative one.

export function signedArea(ring) {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  return a / 2;
}

export function reverseRing(ring) {
  const out = new Array(ring.length);
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = ring[(n - 1 - i) * 2];
    out[i * 2 + 1] = ring[(n - 1 - i) * 2 + 1];
  }
  return out;
}

export function centroid(ring) {
  let a = 0, cx = 0, cz = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
    a += f;
    cx += (ring[j * 2] + ring[i * 2]) * f;
    cz += (ring[j * 2 + 1] + ring[i * 2 + 1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (let i = 0; i < n; i++) { sx += ring[i * 2]; sz += ring[i * 2 + 1]; }
    return [sx / n, sz / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

// Distance from (x, z) to segment a-b, with the closest point
function closestOnSegment(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  const qx = ax + t * dx, qz = az + t * dz;
  return { qx, qz, d2: (x - qx) ** 2 + (z - qz) ** 2 };
}

// Removes repeated and (within `tol` metres) redundant vertices with Douglas-Peucker on the closed ring. Keeps at
// least three vertices. The farthest vertex pair splits the ring so that no corner is arbitrarily protected.
export function simplifyRing(ring, tol = 0.1) {
  // Drop consecutive duplicates first
  const pts = [];
  const n0 = ring.length / 2;
  for (let i = 0; i < n0; i++) {
    const x = ring[i * 2], z = ring[i * 2 + 1];
    const last = pts.length - 2;
    if (last >= 0 && pts[last] === x && pts[last + 1] === z) continue;
    pts.push(x, z);
  }
  if (pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2;
  const n = pts.length / 2;
  if (n <= 3 || tol <= 0) return pts;

  // Split at vertex 0 and the vertex farthest from it
  let far = 1, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i * 2] - pts[0]) ** 2 + (pts[i * 2 + 1] - pts[1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const tol2 = tol * tol;
  const stack = [[0, far], [far, n]]; // second chain wraps back to vertex 0
  while (stack.length) {
    const [s, e] = stack.pop();
    const ei = e % n;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const { d2 } = closestOnSegment(pts[i * 2], pts[i * 2 + 1], pts[s * 2], pts[s * 2 + 1], pts[ei * 2], pts[ei * 2 + 1]);
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out.length >= 6 ? out : pts;
}

// Even-odd point-in-polygon over several rings (outer rings and holes together)
export function pointInRings(x, z, rings) {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2], zi = ring[i * 2 + 1], xj = ring[j * 2], zj = ring[j * 2 + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function nearestOnRings(x, z, rings) {
  let best = { d2: Infinity, qx: x, qz: z };
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const c = closestOnSegment(x, z, ring[j * 2], ring[j * 2 + 1], ring[i * 2], ring[i * 2 + 1]);
      if (c.d2 < best.d2) best = c;
    }
  }
  return best;
}

/**
 * Circle against a polygon with holes: returns where to move a circle of radius `r` centred at (x, z) so that it no
 * longer overlaps the solid (inside the outer ring, outside the holes), or null if it does not overlap. `nx, nz` is
 * the unit push direction. A centre inside the solid is pushed out through the nearest edge.
 */
export function pushOutOfSolid(rings, x, z, r) {
  const { d2, qx, qz } = nearestOnRings(x, z, rings);
  const inside = pointInRings(x, z, rings);
  const d = Math.sqrt(d2);
  if (!inside && d >= r) return null;
  let nx, nz;
  if (d > 1e-9) {
    nx = (x - qx) / d;
    nz = (z - qz) / d;
    if (inside) { nx = -nx; nz = -nz; }
  } else {
    nx = 1; nz = 0;
  }
  const dist = inside ? -d : d; // signed: negative inside the solid
  const move = r - dist;
  return { x: x + nx * move, z: z + nz * move, nx, nz };
}

// Smallest-area oriented rectangle around the ring: centre, unit long axis (ux, uz), half extents along (hx) and
// across (hz) the long axis. Tries every convex-hull edge direction.
export function orientedBox(ring) {
  const n = ring.length / 2;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([ring[i * 2], ring[i * 2 + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = (p[0] - a[0]) * ux + (p[1] - a[1]) * uz;
      const v = -(p[0] - a[0]) * uz + (p[1] - a[1]) * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, a, ux, uz, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  const { a, ux, uz } = best;
  const mu = (best.minU + best.maxU) / 2, mv = (best.minV + best.maxV) / 2;
  let hx = (best.maxU - best.minU) / 2, hz = (best.maxV - best.minV) / 2;
  let axX = ux, axZ = uz;
  if (hz > hx) { // make the first axis the long one
    [hx, hz] = [hz, hx];
    axX = -uz; axZ = ux;
  }
  return { cx: a[0] + mu * ux - mv * uz, cz: a[1] + mu * uz + mv * ux, ux: axX, uz: axZ, hx, hz, area: best.area };
}

// Keeps a point inside a ring, at least `margin` metres from its edge; points outside are moved to the edge and in.
export function confineToRing(ring, x, z, margin = 0) {
  const rings = [ring];
  const { d2, qx, qz } = nearestOnRings(x, z, rings);
  const inside = pointInRings(x, z, rings);
  const d = Math.sqrt(d2);
  if (inside && d >= margin) return { x, z };
  let dx, dz;
  if (d > 1e-9) {
    dx = (qx - x) / d;
    dz = (qz - z) / d;
    if (inside) { dx = -dx; dz = -dz; } // too close to the edge from inside: move away from it
  } else {
    // Exactly on the edge: probe which side is inside
    dx = 1; dz = 0;
    if (!pointInRings(qx + 0.01, qz, rings)) { dx = -1; }
  }
  return { x: qx + dx * margin, z: qz + dz * margin };
}
