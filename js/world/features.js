import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  color,
  attribute,
  uv,
  mix,
  smoothstep,
  step,
  floor,
  fract,
  sin,
  dot,
  abs,
  max,
  min,
  positionWorld,
  normalWorldGeometry
} from 'three/tsl';
import {
  appendBridge, appendScreen, appendStairs, appendStream, appendWall, appendWater, KIND_SURFACE, newBuffers, SCREEN, SOLID, toTypedBuffers, WATER
} from './feature-geometry.js';

// js/world/features.js
// Walls, retaining walls, hedges, fences, barriers, bridges, stairs, streams, pools and ponds, merged per 256 m chunk into
// three meshes (opaque, alpha-tested screens, water), plus colliders for the walls that stop a walker.

export const CHUNK_SIZE = 256;
// Walls lower than this (base to top, in metres, 25 cm of it buried) can be stepped over and have no collider
export const MIN_BLOCKING = 1.0;
const BLOCKING = new Set(['wall', 'gardenWall', 'retaining', 'hedge', 'fence', 'wire', 'railing', 'barrier']);

const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const vnoise = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  return mix(mix(hash(i), hash(i.add(vec2(1, 0))), u.x), mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), u.x), u.y);
});
const flag = (cond) => cond.select(float(1.0), float(0.0));

/** Opaque features: plastered walls, dressed-stone retaining walls, hedges, steps, bridges, pool rims and tanks. */
export function createSolidMaterial() {
  const surf = attribute('info', 'vec4').x;
  const st = uv();
  const along = st.x;
  const height = st.y;
  const top = flag(normalWorldGeometry.y.greaterThan(0.7));
  const grain = hash(floor(positionWorld.xz.mul(9.0).add(positionWorld.y.mul(7.0))));

  // Plaster walls: cream and sand, a capstone on top
  const plaster = mix(color(0xe3d9c3), color(0xcdbf9f), hash(floor(vec2(along.div(6.0), 0.5))));
  const wall = mix(plaster.mul(float(0.92).add(grain.mul(0.14))), color(0xb9b3a6), top);

  // Retaining walls: courses 0.32 m high of blocks 0.55 m long, every other course shifted, mortar between them
  const row = floor(height.div(0.32));
  const col = floor(along.add(fract(row.mul(0.5)).mul(0.55)).div(0.55));
  const inRow = fract(height.div(0.32));
  const inCol = fract(along.add(fract(row.mul(0.5)).mul(0.55)).div(0.55));
  const mortar = max(smoothstep(0.07, 0.0, inRow), smoothstep(0.04, 0.0, inCol));
  const block = mix(color(0x867e72), color(0xa39b8c), hash(vec2(col, row)));
  const retaining = mix(block.mul(float(0.9).add(grain.mul(0.2))), color(0x5d5850), mortar.mul(0.7));

  // Hedges: dense leaf mottling in two greens
  // Sides use (metres along, height); the top uses the ground plane
  const leaf = mix(vnoise(vec2(along, height).mul(3.4)), vnoise(positionWorld.xz.mul(3.4)), top);
  const hedge = mix(color(0x2f4a21), color(0x4a6b2c), leaf.mul(0.7).add(grain.mul(0.3)));

  const concrete = mix(color(0xb8b3a8), color(0xa49f94), grain);
  const stair = mix(concrete.mul(0.86), concrete, top);
  const coping = mix(color(0xd9d4c7), color(0xc9c4b6), grain);
  const tank = mix(color(0xb6b0a3), color(0x9d978a), grain);

  let c = wall;
  c = mix(c, retaining, flag(surf.equal(1.0)));
  c = mix(c, hedge, flag(surf.equal(2.0)));
  c = mix(c, stair, flag(surf.equal(3.0)));
  c = mix(c, concrete, flag(surf.equal(4.0)));
  c = mix(c, coping, flag(surf.equal(5.0)));
  c = mix(c, tank, flag(surf.equal(6.0)));
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = c;
  material.roughness = 0.95;
  material.metalness = 0;
  return material;
}

/** Alpha-tested screens: bar fences, chain-link wire, railings and corrugated crash barriers. */
export function createScreenMaterial() {
  const info = attribute('info', 'vec4');
  const surf = info.x;
  const h = info.y;
  const st = uv();
  const u = st.x;
  const v = st.y;
  const bars = (pitch, wide) => step(fract(u.div(pitch)), wide);
  const band = (a, b) => step(a, v).mul(step(v, b));

  const fence = max(max(bars(0.11, 0.2), band(0.08, 0.14)), max(band(h.sub(0.1), h), band(h.mul(0.5), h.mul(0.5).add(0.05))));
  const diamond = max(step(fract(u.add(v).div(0.1)), 0.09), step(fract(u.sub(v).div(0.1)), 0.09));
  const wire = max(max(diamond, band(h.sub(0.04), h)), step(fract(u.div(3.0)), 0.02));
  const railing = max(max(bars(0.13, 0.17), band(h.sub(0.07), h)), band(0.08, 0.13));
  const barrier = max(band(0.42, 0.78), max(step(fract(u.div(2.0)), 0.05).mul(step(v, 0.78)), band(0.0, 0.0)));

  let mask = fence;
  mask = mix(mask, wire, flag(surf.equal(1.0)));
  mask = mix(mask, railing, flag(surf.equal(2.0)));
  mask = mix(mask, barrier, flag(surf.equal(3.0)));
  let c = color(0x1f2a22);
  c = mix(c, color(0x6f7b72), flag(surf.equal(1.0)));
  c = mix(c, color(0x22262b), flag(surf.equal(2.0)));
  c = mix(c, mix(color(0x9ea4a8), color(0xb4babe), fract(v.mul(18.0))), flag(surf.equal(3.0)));

  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  material.colorNode = c;
  material.opacityNode = mask;
  material.alphaTest = 0.5;
  material.roughness = 0.6;
  material.metalness = 0.3;
  return material;
}

/** Pool water, pond water and the beds of streams and ditches. */
export function createWaterMaterial() {
  const surf = attribute('info', 'vec4').x;
  const ripple = vnoise(positionWorld.xz.mul(1.3));
  const pool = mix(color(0x2fa8cf), color(0x59c4e0), ripple);
  const pond = mix(color(0x3a5a46), color(0x2c4535), ripple);
  const stream = mix(color(0x857b6d), color(0x4d5757), vnoise(positionWorld.xz.mul(2.4)));
  const ditch = mix(color(0x6d6a58), color(0x59574a), ripple);
  let c = pool;
  c = mix(c, pond, flag(surf.equal(1.0)));
  c = mix(c, stream, flag(surf.equal(2.0)));
  c = mix(c, ditch, flag(surf.equal(3.0)));
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = c;
  material.roughnessNode = mix(float(0.06), float(0.85), max(flag(surf.equal(2.0)), flag(surf.equal(3.0))));
  material.metalness = 0;
  return material;
}

// A wall line as a collider: the segments (minus those on a carriageway), a capsule test against them
export function createLineCollider(line, roadIndex = null) {
  const segs = [];
  let maxTop = -Infinity;
  const half = Math.max(0.03, (line.thick || 0.1) / 2);
  for (let i = 0; i + 1 < line.pts.length; i++) {
    const a = line.pts[i], b = line.pts[i + 1];
    maxTop = Math.max(maxTop, a[3], b[3]);
    if (Math.min(a[3] - a[2], b[3] - b[2]) < MIN_BLOCKING) continue;
    if (roadIndex && roadIndex.surfaceAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) === 'road') continue;
    segs.push(a[0], a[1], b[0], b[1]);
  }
  if (!segs.length) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < segs.length; i += 2) {
    minX = Math.min(minX, segs[i]); maxX = Math.max(maxX, segs[i]);
    minZ = Math.min(minZ, segs[i + 1]); maxZ = Math.max(maxZ, segs[i + 1]);
  }
  return {
    minX: minX - half, maxX: maxX + half, minZ: minZ - half, maxZ: maxZ + half, maxY: maxTop, id: line.id,
    pushOut(x, z, r) {
      let best = Infinity, qx = 0, qz = 0, sx = 1, sz = 0;
      for (let i = 0; i < segs.length; i += 4) {
        const ax = segs[i], az = segs[i + 1], bx = segs[i + 2], bz = segs[i + 3];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
        const px = ax + t * dx, pz = az + t * dz;
        const d = Math.hypot(x - px, z - pz);
        if (d < best) { best = d; qx = px; qz = pz; sx = -dz; sz = dx; }
      }
      const reach = r + half;
      if (best >= reach) return null;
      let nx, nz;
      if (best > 1e-9) { nx = (x - qx) / best; nz = (z - qz) / best; }
      else { const l = Math.hypot(sx, sz) || 1; nx = sx / l; nz = sz / l; }
      const move = reach - best;
      return { x: x + nx * move, z: z + nz * move, nx, nz };
    }
  };
}

export function buildFeatures(scene, { lines, water, flights }, ground, { roadIndex = null } = {}) {
  const group = new THREE.Group();
  group.name = 'VallromanesFeatures';
  const materials = { solid: createSolidMaterial(), screen: createScreenMaterial(), water: createWaterMaterial() };
  const chunks = new Map();
  const bucket = (x, z) => {
    const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = { solid: newBuffers(), screen: newBuffers(), water: newBuffers() }));
    return c;
  };
  const colliders = [];
  for (const line of lines) {
    const c = bucket(line.pts[0][0], line.pts[0][1]);
    const [target, surf] = KIND_SURFACE[line.kind];
    if (target === 'solid') appendWall(c.solid, line.pts, line.thick, surf);
    else if (target === 'screen') appendScreen(c.screen, line.pts, surf);
    else if (target === 'water') appendStream(c.water, line.pts, line.width, surf);
    else appendBridge(c.solid, line.pts, line.width);
    if (BLOCKING.has(line.kind)) {
      const col = createLineCollider(line, roadIndex);
      if (col) colliders.push(col);
    }
  }
  for (const body of water) {
    const [x, z] = [body.outer[0], body.outer[1]];
    const c = bucket(x, z);
    appendWater(c.solid, c.water, body, ground);
  }
  for (const f of flights) appendStairs(bucket(f.steps[0][0], f.steps[0][1]).solid, f);

  let triangles = 0;
  for (const [key, c] of chunks) {
    for (const name of ['solid', 'screen', 'water']) {
      if (!c[name].index.length) continue;
      const buf = toTypedBuffers(c[name]);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(buf.position, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(buf.normal, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(buf.uv, 2));
      geometry.setAttribute('info', new THREE.BufferAttribute(buf.info, 4));
      geometry.setIndex(new THREE.BufferAttribute(buf.index, 1));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, materials[name]);
      mesh.name = `features ${name} ${key}`;
      mesh.castShadow = name === 'solid';
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      triangles += buf.index.length / 3;
    }
  }
  scene.add(group);

  function dispose() {
    scene.remove(group);
    for (const m of group.children) m.geometry.dispose();
    for (const m of Object.values(materials)) m.dispose();
  }
  return { group, colliders, dispose, stats: { lines: lines.length, water: water.length, flights: flights.length, chunks: chunks.size, triangles, colliders: colliders.length }, SOLID, SCREEN, WATER };
}
