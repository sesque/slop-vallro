// js/world/trunks.js
// Collision for the woodland trees without making a collider object for each of the 130 000 of them: a grid of the trunk positions,
// and a small pool of circle colliders (the contract of controllers.js: AABB + pushOut(x, z, r)) filled for the trunks near a point.

const CELL = 16;
const TRUNK_HEIGHT = 9; // m of trunk and crown a helicopter can hit

export function createTrunkField(sites, { baseRadius = 0.3 } = {}) {
  const xs = new Float32Array(sites.length), zs = new Float32Array(sites.length), rs = new Float32Array(sites.length), tops = new Float32Array(sites.length);
  const cells = new Map();
  sites.forEach((s, i) => {
    xs[i] = s.x; zs[i] = s.z; rs[i] = baseRadius * s.scale; tops[i] = s.y + TRUNK_HEIGHT * s.scale;
    const k = Math.floor(s.x / CELL) * 65536 + Math.floor(s.z / CELL);
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(i);
  });
  const pool = [];
  const out = [];
  const make = () => {
    const c = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, maxY: 0, x: 0, z: 0, radius: 0 };
    c.pushOut = (px, pz, r) => {
      const d = Math.hypot(px - c.x, pz - c.z), reach = r + c.radius;
      if (d >= reach) return null;
      const nx = d > 1e-9 ? (px - c.x) / d : 1, nz = d > 1e-9 ? (pz - c.z) / d : 0;
      return { x: c.x + nx * reach, z: c.z + nz * reach, nx, nz };
    };
    return c;
  };
  /** Circle colliders for the trunks within `r` metres of (x, z); the array and its objects are reused by the next call. */
  function near(x, z, r) {
    out.length = 0;
    const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL), j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = cells.get(i * 65536 + j);
        if (!list) continue;
        for (const t of list) {
          if (Math.hypot(xs[t] - x, zs[t] - z) > r + rs[t]) continue;
          const c = pool[out.length] || (pool[out.length] = make());
          c.x = xs[t]; c.z = zs[t]; c.radius = rs[t];
          c.minX = c.x - c.radius; c.maxX = c.x + c.radius; c.minZ = c.z - c.radius; c.maxZ = c.z + c.radius; c.maxY = tops[t];
          out.push(c);
        }
      }
    }
    return out;
  }
  return { near, count: sites.length };
}
