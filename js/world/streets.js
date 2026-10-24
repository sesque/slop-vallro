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
  min,
  max,
  positionWorld
} from 'three/tsl';
import { cityUniforms } from '../tsl-materials.js';
import { appendEdge, appendJunction, junctionRadii, newBuffers, nodeTrims, toTypedBuffers } from './street-geometry.js';

// js/world/streets.js
// Asphalt, kerbs, pavements, centre lines, junction patches and dirt tracks of the baked road graph, merged per 256 m
// chunk, with one procedural material.

export const CHUNK_SIZE = 256;

export function createStreetMaterial() {
  const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
  const vnoise = Fn(([p]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    return mix(mix(hash(i), hash(i.add(vec2(1, 0))), u.x), mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), u.x), u.y);
  });
  const info = attribute('info', 'vec4');
  const surf = info.x;
  const st = uv();
  const along = st.x;
  const across = st.y;
  const flag = (cond) => cond.select(float(1.0), float(0.0));
  const wet = cityUniforms.uRoadWetness;

  // Asphalt: two scales of mottling, fine aggregate speckle, a darker polished band where wheels run
  const patch = vnoise(positionWorld.xz.mul(0.35));
  const speckle = hash(floor(positionWorld.xz.mul(38.0)));
  let asphalt = mix(color(0x2f3134), color(0x484a4e), patch.mul(0.8).add(speckle.mul(0.2)));
  asphalt = asphalt.mul(float(1.0).sub(wet.mul(0.35)));
  // Centre line: 2 m dashes every 6 m, white, only inside the marked range of the edge (not through junctions)
  const dash = step(fract(along.div(6.0)), 0.34);
  const line = smoothstep(0.11, 0.08, abs(across)).mul(dash).mul(info.y).mul(step(info.z, along)).mul(step(along, info.w));
  asphalt = mix(asphalt, color(0xe9e6dc), line.mul(0.88));

  // Pavement: 1.5 m concrete flags with joints
  const flagUV = vec2(along, across).div(1.5);
  const gridDist = min(min(fract(flagUV.x), float(1.0).sub(fract(flagUV.x))), min(fract(flagUV.y), float(1.0).sub(fract(flagUV.y))));
  const joint = smoothstep(0.03, 0.0, gridDist);
  let concrete = mix(color(0xb9b4a8), color(0xa7a296), hash(floor(flagUV)));
  concrete = concrete.mul(float(1.0).sub(joint.mul(0.28))).mul(float(0.94).add(speckle.mul(0.1)));

  const kerb = mix(color(0x9a978e), color(0x86837b), speckle);

  // Earth tracks: ochre soil, darker where the wheels pack it down, stones
  const soil = mix(color(0x9a7c57), color(0x7b6244), vnoise(positionWorld.xz.mul(0.8)));
  const dirt = soil.mul(float(0.9).add(speckle.mul(0.2)));

  let c = asphalt;
  c = mix(c, concrete, flag(surf.equal(1.0)));
  c = mix(c, kerb, flag(surf.equal(2.0)));
  c = mix(c, dirt, flag(surf.equal(3.0)));

  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = c;
  // Wet asphalt is smoother; pavement, kerb and earth stay matt
  const roadRough = float(0.92).sub(wet.mul(0.5));
  material.roughnessNode = mix(roadRough, float(0.93), max(flag(surf.equal(1.0)), max(flag(surf.equal(2.0)), flag(surf.equal(3.0)))));
  material.metalness = 0;
  return material;
}

export function buildStreets(scene, roads, { material = createStreetMaterial() } = {}) {
  const group = new THREE.Group();
  group.name = 'VallromanesStreets';
  const nodes = roads.nodes.map(([x, z, y]) => ({ x, z, y }));
  const trims = nodeTrims(nodes, roads.edges);
  const radii = junctionRadii(nodes, roads.edges);
  const chunks = new Map();
  const bucket = (x, z) => {
    const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
    let out = chunks.get(key);
    if (!out) chunks.set(key, (out = newBuffers()));
    return out;
  };
  for (const e of roads.edges) appendEdge(bucket(e.pts[0][0], e.pts[0][1]), e, trims);
  roads.nodes.forEach((n, i) => { if (radii[i] > 0) appendJunction(bucket(n[0], n[1]), n, radii[i]); });

  let triangles = 0;
  for (const [key, out] of chunks) {
    const buf = toTypedBuffers(out);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buf.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(buf.normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(buf.uv, 2));
    geometry.setAttribute('info', new THREE.BufferAttribute(buf.info, 4));
    geometry.setIndex(new THREE.BufferAttribute(buf.index, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `streets ${key}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    triangles += buf.index.length / 3;
  }
  scene.add(group);

  function dispose() {
    scene.remove(group);
    for (const m of group.children) m.geometry.dispose();
    material.dispose();
  }
  return { group, dispose, trims, stats: { edges: roads.edges.length, chunks: chunks.size, triangles } };
}
