// js/traffic-sim.js
// The driving of the town's cars on the lane graph (js/geo/lane-graph.js), with no rendering so it runs under Node.
// Each car follows the vehicle ahead (Intelligent Driver Model), slows for bends, turns and slopes, steers to a point
// ahead on its lane (pure pursuit on a bicycle model, so corners are rounded), and crosses a junction only when it holds the
// junction: one car at a time, higher-ranked streets first, never into a lane it cannot clear, never over a pavement
// crossing in use. Cars live in a fixed pool and are placed on lanes in a ring around the focus, out of sight.

import { laneAt, laneProject } from './geo/lane-graph.js';

const IDM = { a: 1.6, b: 2.6, T: 1.3, s0: 2.0, delta: 4 };
const REAR = 0.87; // rear bumper behind the rear axle
const FRONT = 3.63; // front bumper ahead of it
const WHEELBASE = 2.76;
const CENTER = 1.38; // the model's origin ahead of the rear axle
const BEND_BRAKE = 2.2;
const STOP_LINE = 4.5; // m before the node the front bumper stops
// Is there room at the start of lane `nl` for a car to clear the junction in front of it?
function hasRoom(nl) {
  for (const o of nl.cars) if (o.s - REAR < 10) return false;
  return !(nl.length > 16 && (nl.cars.length + 1) * 7 > nl.length - 2); // a full short link would block the junction behind it
}
const wrap = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _p = { x: 0, z: 0, y: 0, dx: 0, dz: 0 };

export class TrafficSim {
  /**
   * @param graph from buildLaneGraph
   * @param {object} o count (car pool), seed, inside(x, z) (false outside the playable area), spawnRing [min, max] m,
   *   despawn m, hidden(x, z) (true when a point is surely out of the player's sight)
   */
  constructor(graph, { count = 60, spacing = 110, seed = 1, inside = () => true, ring = [110, 380], despawn = 450, hidden = () => true } = {}) {
    this.graph = graph;
    this.rnd = mulberry(seed);
    this.inside = inside;
    this.ring = ring;
    this.despawnRadius = despawn;
    this.hidden = hidden;
    this.time = 0;
    this.cars = [];
    for (let i = 0; i < count; i++) this.cars.push(this.makeCar(i));
    this.lanes = graph.lanes.filter((l) => l.length > 6);
    this.laneWeight = this.lanes.reduce((s, l) => s + l.length, 0);
    this.spacing = spacing; // metres of lane per car, so a sparse corner of the town does not fill up
    this.target = count;
    this.targetAge = Infinity;
    this.obstacles = [];
    this.stats = { spawned: 0, finished: 0, stuckRemoved: 0 };
  }

  makeCar(i) {
    const r = this.rnd;
    return {
      id: i, active: false, lane: null, s: 0, seg: 0, x: 0, z: 0, yaw: 0, speed: 0, acc: 0, next: null, holding: null,
      stuck: 0, blink: 0, turnLeft: 0, ld: 4, wheelSpin: 0, slow: 0.85 + r() * 0.25, kind: r(), body: r() < 0.4 ? 'suv' : 'sedan', steer: 0, pitch: 0, roll: 0, y: 0
    };
  }

  /** Centre of the car's body (the model origin). */
  center(c, out) {
    out.x = c.x + Math.sin(c.yaw) * CENTER;
    out.z = c.z + Math.cos(c.yaw) * CENTER;
    return out;
  }

  randomLane() {
    let t = this.rnd() * this.laneWeight;
    for (const l of this.lanes) {
      t -= l.length;
      if (t <= 0) return l;
    }
    return this.lanes[this.lanes.length - 1];
  }

  /** Puts car `c` on a lane at a random spot between `rMin` and `rMax` metres from (fx, fz), if a free one is found. */
  spawn(c, fx, fz, rMin, rMax, needHidden = true) {
    for (let attempt = 0; attempt < 14; attempt++) {
      const lane = this.randomLane();
      const s = this.rnd() * lane.length;
      laneAt(lane, s, _p);
      const d = Math.hypot(_p.x - fx, _p.z - fz);
      if (d < rMin || d > rMax || !this.inside(_p.x, _p.z) || (needHidden && !this.hidden(_p.x, _p.z))) continue;
      if (lane.length - s < 12 && lane.next.length === 0) continue;
      // not inside a junction, or between two that share a gate
      const gTo = this.graph.nodes[lane.to].gate, gFrom = this.graph.nodes[lane.from].gate;
      if ((gTo && lane.length - s < lane.stop + FRONT + 8) || (gFrom && (s < 14 || gFrom === gTo))) continue;
      if (lane.cars.some((o) => Math.abs(o.s - s) < 16)) continue;
      c.active = true;
      c.lane = lane;
      c.s = s;
      c.seg = laneAt(lane, s, _p);
      c.x = _p.x; c.z = _p.z;
      c.yaw = Math.atan2(_p.dx, _p.dz);
      c.speed = Math.min(lane.limit, 9) * 0.7;
      c.acc = 0; c.stuck = 0; c.holding = null; c.next = null; c.blink = 0;
      c.ld = 4;
      lane.cars.push(c);
      this.stats.spawned++;
      return true;
    }
    return false;
  }

  deactivate(c) {
    if (c.holding && c.holding.holder === c) c.holding.holder = null;
    c.holding = null;
    if (c.lane) {
      const i = c.lane.cars.indexOf(c);
      if (i >= 0) c.lane.cars.splice(i, 1);
    }
    c.active = false;
    c.lane = null;
  }

  /** Removes every car and places them again around (fx, fz), anywhere in range: for a teleport or the first frame. */
  /** How many cars the lanes around (fx, fz) carry: one per `spacing` metres of lane within the spawn ring. */
  retarget(fx, fz) {
    this.targetAge = 0;
    let reach = 0;
    for (const l of this.lanes) if (Math.hypot(l.mx - fx, l.mz - fz) < this.ring[1]) reach += l.length;
    this.target = Math.min(this.cars.length, Math.round(reach / this.spacing));
  }

  reset(fx, fz, rMax = this.ring[1]) {
    this.retarget(fx, fz);
    for (const c of this.cars) if (c.active) this.deactivate(c);
    for (const l of this.graph.lanes) l.cars.length = 0;
    for (const g of this.graph.gates) g.holder = null;
    let n = 0;
    for (const c of this.cars) if (n < this.target && this.spawn(c, fx, fz, 25, rMax, false)) n++;
  }

  ensureNext(c) {
    if (c.next) return;
    const lane = c.lane;
    if (lane.length - c.s > 90) return;
    const opts = lane.next;
    if (opts.length === 0) return;
    let total = 0;
    for (const o of opts) total += o.weight;
    let t = this.rnd() * total;
    let pick = opts[opts.length - 1];
    for (const o of opts) { t -= o.weight; if (t <= 0) { pick = o; break; } }
    c.next = pick;
    c.blink = Math.abs(pick.turn) > 0.45 ? (pick.turn > 0 ? -1 : 1) : 0;
  }

  /** The highest speed the bends, the coming turn and the lane's limit leave `c` right now. */
  targetSpeed(c) {
    const lane = c.lane;
    let v = lane.limit * c.slow;
    const { cum, vb } = lane;
    for (let i = c.seg + 1; i < cum.length; i++) {
      const d = cum[i] - c.s;
      if (d > 80) break;
      if (vb[i] < Infinity) v = Math.min(v, Math.sqrt(vb[i] * vb[i] + 2 * BEND_BRAKE * Math.max(0, d)));
    }
    if (c.next) {
      const rem = lane.length - c.s;
      v = Math.min(v, Math.sqrt(c.next.vTurn ** 2 + 2 * BEND_BRAKE * Math.max(0, rem - 2)));
      const nl = c.next.lane;
      for (let i = 1; i < nl.cum.length; i++) {
        const d = rem + nl.cum[i];
        if (d > 60) break;
        if (nl.vb[i] < Infinity) v = Math.min(v, Math.sqrt(nl.vb[i] * nl.vb[i] + 2 * BEND_BRAKE * d));
      }
      v = Math.min(v, nl.limit * c.slow + 2);
    }
    return v;
  }

  /** Can `c` take the junction it is approaching? */
  canEnter(c, gate) {
    c.why = '';
    if (gate.holder && gate.holder !== c && gate.holder.active) return (c.why = 'held'), false;
    if (gate.nodes.some((n) => n.pedsCrossing > 0)) return (c.why = 'walkers'), false;
    const nl = c.next && c.next.lane;
    if (!nl) return false;
    if (!hasRoom(nl)) return (c.why = 'room'), false;
    // give way to faster streets with a car close to the junction (unless it has waited a long time)
    if (c.stuck < 15) {
      for (const il of gate.inLanes) {
        if (il === c.lane || il.rank <= c.lane.rank) continue;
        const last = il.cars[il.cars.length - 1];
        if (last && last.holding !== gate && il.length - (last.s + FRONT) < Math.max(18, last.speed * 3.5)) return (c.why = 'priority'), false;
      }
    }
    // ... and to a car that stands at its line and has waited longer (much longer, if its street ranks lower)
    for (const il of gate.inLanes) {
      if (il === c.lane) continue;
      const last = il.cars[il.cars.length - 1];
      if (last && last.speed < 0.5 && last.next && hasRoom(last.next.lane) && il.length - (last.s + FRONT) < (il.stop ?? STOP_LINE) + 5 && last.stuck > c.stuck + (il.rank < c.lane.rank ? 15 : 1.5)) return (c.why = 'queue'), false;
    }
    return true;
  }

  /** The nearest thing ahead of `c` as { gap, speed } (bumper to bumper), or null. */
  leader(c) {
    const lane = c.lane;
    const frontS = c.s + FRONT;
    let best = null;
    const list = lane.cars;
    for (let j = 0; j < list.length; j++) {
      const o = list[j];
      if (o === c || o.s <= c.s) continue;
      const gap = o.s - REAR - frontS;
      if (!best || gap < best.gap) best = { gap, speed: o.speed };
    }
    if (!best && c.next) {
      const nl = c.next.lane;
      const rem = lane.length - frontS;
      for (const o of nl.cars) {
        const gap = rem + o.s - REAR;
        if (!best || gap < best.gap) best = { gap, speed: o.speed };
      }
    }
    // things in the way that are not cars: the player and walkers, if they stand in the car's path
    if (this.obstacles.length) {
      const fx = c.x + Math.sin(c.yaw) * FRONT, fz = c.z + Math.cos(c.yaw) * FRONT;
      const sx = Math.sin(c.yaw), sz = Math.cos(c.yaw);
      for (const ob of this.obstacles) {
        const ax = ob.x - fx, az = ob.z - fz;
        const along = ax * sx + az * sz, side = Math.abs(ax * sz - az * sx);
        if (along > -1 && along < 35 && side < ob.r + 1.25) {
          const gap = along - ob.r;
          if (!best || gap < best.gap) best = { gap, speed: ob.speed || 0 };
        }
      }
    }
    return best;
  }

  accelerate(c) {
    const v0 = this.targetSpeed(c);
    const v = c.speed;
    let acc = IDM.a * (1 - Math.pow(v / Math.max(0.5, v0), IDM.delta));
    const follow = (gap, vl) => {
      const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * (v - vl)) / (2 * Math.sqrt(IDM.a * IDM.b)));
      const g = Math.max(0.2, gap);
      return IDM.a * (1 - Math.pow(v / Math.max(0.5, v0), IDM.delta) - (sStar / g) ** 2);
    };
    const lead = this.leader(c);
    if (lead) acc = Math.min(acc, follow(lead.gap, lead.speed));
    // the junction ahead
    const next = c.next;
    const node = this.graph.nodes[c.lane.to];
    const gate = node.gate;
    if (gate && c.holding !== gate && next) {
      const toLine = c.lane.length - (c.s + FRONT) - (c.lane.stop ?? STOP_LINE);
      if (toLine < 45) {
        if (toLine < 12 && !c.lane.cars.some((o) => o !== c && o.s > c.s) && this.canEnter(c, gate)) {
          if (c.holding && c.holding.holder === c) c.holding.holder = null;
          gate.holder = c;
          c.holding = gate;
        } else if (toLine > -STOP_LINE) {
          acc = Math.min(acc, follow(Math.max(0.2, toLine + IDM.s0 * 0.4), 0));
        }
      }
    }
    return Math.max(-9, Math.min(IDM.a, acc));
  }

  step(c, dt) {
    this.ensureNext(c);
    c.acc = this.accelerate(c);
    c.speed = Math.max(0, c.speed + c.acc * dt);
    if (c.speed < 0.15 && c.acc <= 0) c.speed = 0;

    // pure pursuit of a point ahead on the lane (and the next one, past its end)
    const ld = Math.min(9, 3 + 0.55 * c.speed);
    c.ld = ld;
    const lane = c.lane;
    const s2 = c.s + ld;
    if (s2 <= lane.length || !c.next) laneAt(lane, s2, _p, c.seg);
    else laneAt(c.next.lane, s2 - lane.length, _p, 0);
    const alpha = wrap(Math.atan2(_p.x - c.x, _p.z - c.z) - c.yaw);
    const steer = Math.max(-0.62, Math.min(0.62, Math.atan2(2 * WHEELBASE * Math.sin(alpha), ld)));
    c.steer = steer;
    const dist = c.speed * dt;
    c.yaw = wrap(c.yaw + (dist / WHEELBASE) * Math.tan(steer));
    c.x += Math.sin(c.yaw) * dist;
    c.z += Math.cos(c.yaw) * dist;
    c.wheelSpin = (c.wheelSpin + dist / 0.35) % (Math.PI * 2);

    const pr = laneProject(lane, c.x, c.z, c.seg, 5);
    c.s = Math.max(c.s, pr.s);
    c.seg = pr.seg;
    // on to the next lane at its end, or once the car is nearer to the next lane than to this one (a corner is cut)
    let cross = c.s >= lane.length - 0.3;
    if (!cross && c.next && lane.length - c.s < 5) cross = laneProject(c.next.lane, c.x, c.z, 0, 3).dist < pr.dist;
    if (cross) {
      if (!c.next) { this.stats.finished++; this.deactivate(c); return; }
      lane.cars.splice(lane.cars.indexOf(c), 1);
      c.lane = c.next.lane;
      c.lane.cars.push(c);
      c.next = null;
      const q = laneProject(c.lane, c.x, c.z, 0, 4);
      c.s = q.s;
      c.seg = q.seg;
    }
    // let go of the junction once the whole car is through it
    if (c.holding) {
      const g = c.holding, nodes = this.graph.nodes;
      const inside = (id) => nodes[id].gate === g;
      const lane = c.lane;
      const atEnd = inside(lane.to) && lane.length - c.s < 40;
      const atStart = inside(lane.from) && (c.s - REAR <= 3.5 || (inside(lane.to) && lane.length < 40));
      // a car stuck in the queue ahead lets go, so that the queue behind it can clear the junction (the tail may overlap)
      const stalled = c.stuck > 4 && c.speed < 0.3 && (atStart ? c.s - REAR < 12 : false);
      if ((!atEnd && !atStart) || stalled) {
        if (g.holder === c) g.holder = null;
        c.holding = null;
        c.blink = 0;
      }
    }
    if (c.speed < 0.2) c.stuck += dt; else c.stuck = 0;
  }

  /** Advances all cars by `dt` seconds; (fx, fz) is the point to keep the traffic around (the camera or the player). */
  update(dt, fx, fz, jumped = false) {
    this.time += dt;
    if (jumped) this.reset(fx, fz);
    const lanes = this.graph.lanes;
    for (const l of lanes) l.cars.sort((a, b) => a.s - b.s);
    if ((this.targetAge += dt) > 2) this.retarget(fx, fz);
    let active = 0;
    for (const c of this.cars) if (c.active) active++;
    let spawns = 2;
    for (const c of this.cars) {
      if (!c.active) {
        if (spawns > 0 && active < this.target && this.spawn(c, fx, fz, this.ring[0], this.ring[1])) { spawns--; active++; }
        continue;
      }
      if (Math.hypot(c.x - fx, c.z - fz) > this.despawnRadius || c.stuck > 90 || !this.inside(c.x, c.z)) {
        if (c.stuck > 90) this.stats.stuckRemoved++;
        this.deactivate(c);
        continue;
      }
      this.step(c, dt);
    }
  }
}
