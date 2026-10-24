// js/walkers-sim.js
// The walking of the town's people on the pavement graph (js/geo/pavement-graph.js), with no rendering so it runs under Node.
// Walkers keep to a pavement, turn corners, sometimes cross at a junction and sometimes stop for a while. They cross only when no
// car holds the junction or is about to enter it; a walker on a crossing marks its node, which makes cars wait (see traffic-sim.js).

const mulberry = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const _o = { x: 0, z: 0, tx: 0, tz: 0 };

/** Position and unit tangent at arc length s of a link. */
export function linkAt(link, s, out = _o) {
  const { cum } = link;
  const last = cum.length - 1;
  s = Math.min(link.length, Math.max(0, s));
  let i = 0;
  while (i < last - 1 && cum[i + 1] < s) i++;
  const len = cum[i + 1] - cum[i] || 1;
  const t = (s - cum[i]) / len;
  out.x = link.x[i] + (link.x[i + 1] - link.x[i]) * t;
  out.z = link.z[i] + (link.z[i + 1] - link.z[i]) * t;
  out.tx = (link.x[i + 1] - link.x[i]) / len;
  out.tz = (link.z[i + 1] - link.z[i]) / len;
  return out;
}

export class WalkerSim {
  /**
   * @param pavements from buildPavementGraph; @param lanes the lane graph, so that walkers can look for cars
   * @param {object} o count, seed, inside(x, z), ring [min, max] m, despawn m, hidden(x, z)
   */
  constructor(pavements, lanes, { count = 80, seed = 7, inside = () => true, ring = [30, 170], despawn = 230, hidden = () => true } = {}) {
    this.pav = pavements;
    this.lanes = lanes;
    this.rnd = mulberry(seed);
    this.inside = inside;
    this.ring = ring;
    this.despawnRadius = despawn;
    this.hidden = hidden;
    this.time = 0;
    this.links = pavements.links.filter((l) => l.kind === 'walk' && l.length > 3);
    this.weight = this.links.reduce((s, l) => s + l.length, 0);
    this.people = [];
    for (let i = 0; i < count; i++) {
      const r = this.rnd;
      this.people.push({
        id: i, active: false, link: null, s: 0, dir: 1, x: 0, z: 0, heading: 0, speed: 0, pace: 1.1 + r() * 0.5, lat: 0, latGoal: 0,
        pause: 0, crossing: null, waiting: 0, seed: i + 1, female: r() < 0.5, scale: 0.92 + r() * 0.16, girth: 0.92 + r() * 0.2,
        hair: r(), armSwing: 0.85 + r() * 0.3, stride: 0.9 + r() * 0.2, rig: null
      });
    }
    this.stats = { spawned: 0, crossings: 0 };
  }

  randomLink() {
    let t = this.rnd() * this.weight;
    for (const l of this.links) {
      t -= l.length;
      if (t <= 0) return l;
    }
    return this.links[this.links.length - 1];
  }

  place(p) {
    linkAt(p.link, p.s);
    const nx = -_o.tz, nz = _o.tx;
    p.x = _o.x + nx * p.lat;
    p.z = _o.z + nz * p.lat;
    p.heading = Math.atan2(_o.tx * p.dir, _o.tz * p.dir);
  }

  spawn(p, fx, fz, rMin, rMax, needHidden = true) {
    if (this.links.length === 0) return false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const link = this.randomLink();
      const s = this.rnd() * link.length;
      linkAt(link, s);
      const d = Math.hypot(_o.x - fx, _o.z - fz);
      if (d < rMin || d > rMax || !this.inside(_o.x, _o.z) || (needHidden && !this.hidden(_o.x, _o.z))) continue;
      p.active = true;
      p.link = link;
      p.s = s;
      p.dir = this.rnd() < 0.5 ? 1 : -1;
      p.lat = p.latGoal = (this.rnd() - 0.5) * 0.9;
      p.pause = this.rnd() < 0.15 ? 2 + this.rnd() * 8 : 0;
      p.speed = 0;
      p.crossing = null;
      p.waiting = 0;
      p.placedFresh = true;
      this.place(p);
      this.stats.spawned++;
      return true;
    }
    return false;
  }

  leaveCrossing(p) {
    if (p.crossing) {
      p.crossing.pedsCrossing = Math.max(0, p.crossing.pedsCrossing - 1);
      p.crossing = null;
    }
  }

  deactivate(p) {
    this.leaveCrossing(p);
    p.active = false;
    p.link = null;
  }

  reset(fx, fz, rMax = this.ring[1]) {
    for (const p of this.people) {
      if (p.active) this.deactivate(p);
      this.spawn(p, fx, fz, 8, rMax, false);
    }
  }

  /** Is it safe to step off the kerb onto the crossing `link` of its junction? */
  clearToCross(link) {
    const node = this.lanes.nodes[link.node];
    const gate = node && node.gate;
    if (!gate) return true;
    if (gate.holder && gate.holder.active) return false;
    for (const il of gate.inLanes) {
      const last = il.cars[il.cars.length - 1];
      if (last && last.speed > 0.8 && il.length - last.s < Math.max(16, last.speed * 3)) return false;
    }
    return true;
  }

  chooseNext(p, end) {
    const options = p.link.ends[end];
    const rnd = this.rnd();
    if (options.length === 0 || rnd < 0.06) return null;
    // corners 55 %, crossings 35 % of the remainder
    const crossings = options.filter((o) => o.link.kind === 'cross');
    const corners = options.filter((o) => o.link.kind !== 'cross');
    if (crossings.length && (corners.length === 0 || this.rnd() < 0.35)) return crossings[Math.floor(this.rnd() * crossings.length)];
    if (corners.length) return corners[Math.floor(this.rnd() * corners.length)];
    return null;
  }

  step(p, dt) {
    if (p.pause > 0) {
      p.pause -= dt;
      p.speed = 0;
      return;
    }
    let want = p.pace;
    // waiting at the kerb for the way across to be clear
    if (p.waitFor) {
      if (this.clearToCross(p.waitFor.link) || (p.waiting += dt) > 25) {
        p.link = p.waitFor.link;
        p.dir = p.waitFor.end === 0 ? 1 : -1;
        p.s = p.waitFor.end === 0 ? 0 : p.link.length;
        p.latGoal = 0;
        p.crossing = this.lanes.nodes[p.link.node];
        p.crossing.pedsCrossing++;
        this.stats.crossings++;
        p.waitFor = null;
        p.waiting = 0;
      } else {
        p.speed = 0;
        return;
      }
    }
    if (p.link.kind === 'cross') want *= 1.2;
    p.speed += (want - p.speed) * Math.min(1, dt * 3);
    p.s += p.dir * p.speed * dt;
    p.lat += Math.max(-dt * 0.8, Math.min(dt * 0.8, p.latGoal - p.lat));
    const end = p.s >= p.link.length ? 1 : p.s <= 0 ? 0 : -1;
    if (end >= 0) {
      if (p.link.kind === 'cross') this.leaveCrossing(p);
      const next = this.chooseNext(p, end);
      if (!next) {
        // turn round (and sometimes stand a moment)
        p.dir = -p.dir;
        p.s = end === 1 ? p.link.length - 0.01 : 0.01;
        if (this.rnd() < 0.3) p.pause = 3 + this.rnd() * 7;
      } else if (next.link.kind === 'cross') {
        p.s = end === 1 ? p.link.length : 0;
        p.speed = 0;
        p.waitFor = next;
      } else {
        p.link = next.link;
        p.dir = next.end === 0 ? 1 : -1;
        p.s = next.end === 0 ? 0 : next.link.length;
        p.latGoal = (this.rnd() - 0.5) * 0.9;
        if (this.rnd() < 0.08) p.pause = 3 + this.rnd() * 9;
      }
    }
    this.place(p);
  }

  update(dt, fx, fz, jumped = false) {
    this.time += dt;
    if (jumped) this.reset(fx, fz);
    let spawns = 2;
    for (const p of this.people) {
      if (!p.active) {
        if (spawns > 0 && this.spawn(p, fx, fz, this.ring[0], this.ring[1])) spawns--;
        continue;
      }
      if (Math.hypot(p.x - fx, p.z - fz) > this.despawnRadius || !this.inside(p.x, p.z)) {
        this.deactivate(p);
        continue;
      }
      this.step(p, dt);
    }
  }
}
