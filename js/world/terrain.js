import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  color,
  mix,
  clamp,
  smoothstep,
  floor,
  fract,
  sin,
  dot,
  positionWorld,
  normalWorldGeometry
} from 'three/tsl';

// js/world/terrain.js
// Chunked terrain mesh over the baked height grids (js/geo/terrain-sampler.js): 256 m chunks, three levels of detail
// chosen by camera distance, skirts to hide the cracks between neighbouring levels, and a TSL ground material.

export const CHUNK_SIZE = 256;
// cell = vertex spacing in metres; the level is used up to `until` metres from the chunk (hysteresis avoids flicker).
// Nearby ground matches the 2 m height grid; the far levels are only silhouettes under the haze.
export const LODS = [
  { cell: 2, until: 380 },
  { cell: 8, until: 1400 },
  { cell: 32, until: Infinity }
];
const LOD_HYSTERESIS = 1.12;

/**
 * Wet Mediterranean-hillside ground: dry grass and olive scrub on the gentle slopes, red-brown soil patches, grey
 * limestone where it gets steep. Everything derives from the world position and the geometric normal, so chunks and
 * levels of detail all shade alike and no texture or UV is needed.
 */
export function createTerrainMaterial() {
  const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
  // Smooth value noise on a 2D lattice
  const vnoise = Fn(([p]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    const a = hash(i);
    const b = hash(i.add(vec2(1, 0)));
    const c = hash(i.add(vec2(0, 1)));
    const d = hash(i.add(vec2(1, 1)));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });

  const colorNode = Fn(() => {
    const p = positionWorld.xz;
    const slope = float(1.0).sub(clamp(normalWorldGeometry.y, 0.0, 1.0));
    // Broad patches (hundreds of metres), field-sized patches and fine grain
    const broad = vnoise(p.mul(0.0035));
    const field = vnoise(p.mul(0.021).add(37.0));
    const grain = vnoise(p.mul(1.7)).mul(0.6).add(vnoise(p.mul(5.3)).mul(0.4));

    const grass = mix(color(0x6f7d3f), color(0x9b9560), broad);
    const dryGrass = mix(color(0x8c8a4e), color(0xb2a56c), field);
    const soil = mix(color(0x8a5f3f), color(0x6d4b33), field);
    const rock = mix(color(0x8d8a80), color(0xa8a498), grain);

    // Dry grass on the open ground, soil showing through in patches, rock from ~25 degrees up and solid by ~45
    let base = mix(grass, dryGrass, smoothstep(0.35, 0.75, field));
    base = mix(base, soil, smoothstep(0.62, 0.78, broad).mul(smoothstep(0.1, 0.3, slope)));
    base = mix(base, rock, smoothstep(0.1, 0.3, slope));
    // Higher ground is drier and greyer
    base = mix(base, base.mul(vec3(1.06, 1.0, 0.92)), smoothstep(150.0, 330.0, positionWorld.y.add(70.0)));
    return base.mul(float(0.84).add(grain.mul(0.32)));
  })();

  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = colorNode;
  material.roughness = 0.96;
  material.metalness = 0;
  return material;
}

// Index buffer for an nx × nz quad grid plus a skirt ring: vertices are laid out as the (nx + 1) × (nz + 1) surface
// grid followed by the duplicated rim vertices (west, east, north, south), each dropped by the skirt depth.
function buildIndex(nx, nz) {
  const w = nx + 1;
  const surface = w * (nz + 1);
  const idx = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const west = surface, east = west + nz + 1, north = east + nz + 1, south = north + nx + 1;
  // Each skirt quad joins two consecutive rim vertices to their dropped copies; winding keeps the outside facing out
  for (let j = 0; j < nz; j++) {
    const a = j * w, b = (j + 1) * w, da = west + j, db = west + j + 1;
    idx.push(a, da, b, b, da, db);
    const e = j * w + nx, f = (j + 1) * w + nx, de = east + j, df = east + j + 1;
    idx.push(e, f, de, f, df, de);
  }
  for (let i = 0; i < nx; i++) {
    const a = i, b = i + 1, da = north + i, db = north + i + 1;
    idx.push(a, b, da, b, db, da);
    const s = nz * w + i, t = s + 1, ds = south + i, dt = south + i + 1;
    idx.push(s, ds, t, t, ds, dt);
  }
  return surface + 2 * (nz + 1) + 2 * (nx + 1) > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1);
}

export function buildChunkGeometry(sampler, ext, cell, indexCache = new Map()) {
  const nx = Math.max(1, Math.round((ext.x1 - ext.x0) / cell));
  const nz = Math.max(1, Math.round((ext.z1 - ext.z0) / cell));
  const w = nx + 1;
  const surface = w * (nz + 1);
  const total = surface + 2 * (nz + 1) + 2 * (nx + 1);
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const sx = (ext.x1 - ext.x0) / nx;
  const sz = (ext.z1 - ext.z0) / nz;
  const drop = 3 + cell * 0.6;

  const put = (k, x, y, z, n) => {
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    nor[k * 3] = n[0]; nor[k * 3 + 1] = n[1]; nor[k * 3 + 2] = n[2];
  };
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = ext.x0 + i * sx, z = ext.z0 + j * sz;
      put(j * w + i, x, sampler.heightAt(x, z), z, sampler.normalAt(x, z));
    }
  }
  // Rim copies, dropped; they reuse the rim vertex's normal so the skirt shades like the ground it hides
  const copy = (dst, src) => {
    put(dst, pos[src * 3], pos[src * 3 + 1] - drop, pos[src * 3 + 2], [nor[src * 3], nor[src * 3 + 1], nor[src * 3 + 2]]);
  };
  let k = surface;
  for (let j = 0; j <= nz; j++) copy(k++, j * w);
  for (let j = 0; j <= nz; j++) copy(k++, j * w + nx);
  for (let i = 0; i <= nx; i++) copy(k++, i);
  for (let i = 0; i <= nx; i++) copy(k++, nz * w + i);

  const key = `${nx}x${nz}`;
  let index = indexCache.get(key);
  if (!index) indexCache.set(key, (index = buildIndex(nx, nz)));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

export function buildTerrain(scene, sampler, { material = createTerrainMaterial() } = {}) {
  const group = new THREE.Group();
  group.name = 'VallromanesTerrain';
  const b = sampler.bounds;
  const indexCache = new Map();
  const chunks = [];

  const cx0 = Math.floor(b.minX / CHUNK_SIZE), cx1 = Math.ceil(b.maxX / CHUNK_SIZE);
  const cz0 = Math.floor(b.minZ / CHUNK_SIZE), cz1 = Math.ceil(b.maxZ / CHUNK_SIZE);
  for (let cz = cz0; cz < cz1; cz++) {
    for (let cx = cx0; cx < cx1; cx++) {
      const ext = {
        x0: Math.max(b.minX, cx * CHUNK_SIZE), x1: Math.min(b.maxX, (cx + 1) * CHUNK_SIZE),
        z0: Math.max(b.minZ, cz * CHUNK_SIZE), z1: Math.min(b.maxZ, (cz + 1) * CHUNK_SIZE)
      };
      if (ext.x1 - ext.x0 < 1 || ext.z1 - ext.z0 < 1) continue;
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.name = `terrain ${cx},${cz}`;
      group.add(mesh);
      chunks.push({ mesh, ext, lod: -1, geometries: [null, null, null] });
    }
  }
  scene.add(group);

  function geometryFor(chunk, lod) {
    return chunk.geometries[lod] || (chunk.geometries[lod] = buildChunkGeometry(sampler, chunk.ext, LODS[lod].cell, indexCache));
  }

  // Chooses each chunk's level by its distance to the camera. The finest level is the heavy one (~17k vertices), so
  // it is built when a chunk comes close and thrown away when it leaves; the coarse ones stay cached.
  function update(cameraPos) {
    for (const c of chunks) {
      const dx = Math.max(c.ext.x0 - cameraPos.x, 0, cameraPos.x - c.ext.x1);
      const dz = Math.max(c.ext.z0 - cameraPos.z, 0, cameraPos.z - c.ext.z1);
      const dist = Math.hypot(dx, dz);
      let lod = LODS.length - 1;
      for (let i = 0; i < LODS.length; i++) {
        const limit = LODS[i].until * (c.lod === i ? LOD_HYSTERESIS : 1);
        if (dist < limit) { lod = i; break; }
      }
      if (lod === c.lod) continue;
      c.mesh.geometry = geometryFor(c, lod);
      c.mesh.visible = true;
      if (c.lod === 0 && c.geometries[0]) {
        c.geometries[0].dispose();
        c.geometries[0] = null;
      }
      c.lod = lod;
    }
  }

  function stats() {
    const counts = [0, 0, 0];
    let triangles = 0;
    for (const c of chunks) {
      if (c.lod < 0) continue;
      counts[c.lod]++;
      triangles += c.mesh.geometry.index.count / 3;
    }
    return { chunks: chunks.length, lod: counts, triangles };
  }

  function dispose() {
    scene.remove(group);
    for (const c of chunks) for (const g of c.geometries) g?.dispose();
    material.dispose();
  }

  return { group, update, stats, dispose, heightAt: sampler.heightAt, normalAt: sampler.normalAt, chunks };
}
