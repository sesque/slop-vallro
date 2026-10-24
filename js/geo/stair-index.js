// js/geo/stair-index.js
// The height of the steps under a point, so a walker climbs a flight instead of wading through it. Every tread of
// data/stairs.json is a quad (its own line to the next step's line) at the step's height.

const CELL = 4;

export function createStairIndex(flights) {
  const treads = []; // [ax, az, bx, bz, nextBx, nextBz, nextAx, nextAz, y]
  const cells = new Map();
  for (const f of flights) {
    const { steps, climb } = f;
    const spacing = steps.length > 1 ? Math.max(0.2, Math.hypot(steps[1][0] - steps[0][0], steps[1][1] - steps[0][1])) : 0.3;
    for (let k = 0; k < steps.length; k++) {
      const [ax, az, bx, bz, y] = steps[k];
      const next = steps[k + 1] || [ax + climb[0] * spacing, az + climb[1] * spacing, bx + climb[0] * spacing, bz + climb[1] * spacing, y];
      const t = [ax, az, bx, bz, next[2], next[3], next[0], next[1], y];
      const id = treads.length;
      treads.push(t);
      const xs = [t[0], t[2], t[4], t[6]], zs = [t[1], t[3], t[5], t[7]];
      for (let i = Math.floor(Math.min(...xs) / CELL); i <= Math.floor(Math.max(...xs) / CELL); i++) {
        for (let j = Math.floor(Math.min(...zs) / CELL); j <= Math.floor(Math.max(...zs) / CELL); j++) {
          const key = i * 100003 + j;
          let list = cells.get(key);
          if (!list) cells.set(key, (list = []));
          list.push(id);
        }
      }
    }
  }

  // Point in the convex quad a, b, nextB, nextA (a-b is the step's line, nextA-nextB the next one)
  function inside(t, x, z) {
    const ring = [[t[0], t[1]], [t[2], t[3]], [t[4], t[5]], [t[6], t[7]]];
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = ring[i], b = ring[(i + 1) % 4];
      const cross = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (Math.abs(cross) < 1e-9) continue;
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  /** The height (local y) of the highest tread under (x, z), or null when the point is not on a flight. */
  function heightAt(x, z) {
    const list = cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!list) return null;
    let best = null;
    for (const id of list) {
      const t = treads[id];
      if (inside(t, x, z) && (best === null || t[8] > best)) best = t[8];
    }
    return best;
  }

  return { heightAt, count: treads.length };
}
