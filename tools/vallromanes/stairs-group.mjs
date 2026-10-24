// Groups the survey's step lines (CON_23: one short line per step edge, 0.5 m apart and about 0.2 m higher each) into
// flights (spec §5.5). Two lines belong to the same flight when they are nearly parallel, one tread apart across the
// line direction, overlapping along it, and one riser apart in height.

const CELL = 3;
export const RULE = { maxAngle: 20, minTread: 0.12, maxTread: 0.8, minRiser: 0.04, maxRiser: 0.4, overlap: 0.6, slack: 0.3 };

function prepare(step) {
  const len = Math.hypot(step.bx - step.ax, step.bz - step.az);
  const dx = len > 0 ? (step.bx - step.ax) / len : 1, dz = len > 0 ? (step.bz - step.az) / len : 0;
  const ang = ((Math.atan2(dz, dx) * 180) / Math.PI % 180 + 180) % 180;
  return { ...step, len, dx, dz, ang, cx: (step.ax + step.bx) / 2, cz: (step.az + step.bz) / 2 };
}

export function sameFlight(s, t, rule = RULE) {
  let da = Math.abs(s.ang - t.ang);
  da = Math.min(da, 180 - da);
  if (da > rule.maxAngle) return false;
  const vx = t.cx - s.cx, vz = t.cz - s.cz;
  const along = Math.abs(vx * s.dx + vz * s.dz);
  const across = Math.abs(-vx * s.dz + vz * s.dx);
  const dz = Math.abs(t.z - s.z);
  return across >= rule.minTread && across <= rule.maxTread && along <= ((s.len + t.len) / 2) * rule.overlap + rule.slack && dz >= rule.minRiser && dz <= rule.maxRiser;
}

/**
 * `steps`: [{ ax, az, bx, bz, z }] in the local frame (z = height). Returns the flights with two or more steps:
 * { steps (lowest first, end points oriented alike), climb: [x, z] unit vector up the flight, width, rise }.
 */
export function groupStairs(rawSteps, rule = RULE) {
  const steps = rawSteps.map(prepare);
  const grid = new Map();
  steps.forEach((s, i) => {
    const key = `${Math.floor(s.cx / CELL)},${Math.floor(s.cz / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  const parent = steps.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  steps.forEach((s, i) => {
    const ci = Math.floor(s.cx / CELL), cj = Math.floor(s.cz / CELL);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const j of grid.get(`${ci + di},${cj + dj}`) || []) {
        if (j > i && sameFlight(s, steps[j], rule)) parent[find(j)] = find(i);
      }
    }
  });
  const groups = new Map();
  steps.forEach((s, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); });

  const flights = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.z - b.z);
    const first = group[0];
    // End points oriented like the first step, so a tread's corners pair up
    const ordered = group.map((s) => {
      const flip = s.dx * first.dx + s.dz * first.dz < 0;
      return flip ? { ax: s.bx, az: s.bz, bx: s.ax, bz: s.az, z: s.z } : { ax: s.ax, az: s.az, bx: s.bx, bz: s.bz, z: s.z };
    });
    // Climb direction: from the lowest to the highest step, taken across the lines (not along them)
    const last = group[group.length - 1];
    let cx = last.cx - first.cx, cz = last.cz - first.cz;
    const along = cx * first.dx + cz * first.dz;
    cx -= along * first.dx;
    cz -= along * first.dz;
    const l = Math.hypot(cx, cz);
    if (l < 1e-6) continue;
    const width = group.reduce((s, g) => s + g.len, 0) / group.length;
    flights.push({ steps: ordered, climb: [cx / l, cz / l], width, rise: last.z - first.z });
  }
  return flights;
}
