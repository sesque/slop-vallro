import * as THREE from 'three/webgpu';
import { color, mix, smoothstep } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from '../tsl-materials.js';
import { createTreeField } from '../trees.js';

// js/world/props.js
// The point props of the survey: trees (the upstream instanced tree field), street lamps with night lights pooled near the
// camera, utility poles, pillars, manholes, gullies, tree pits and fountains, plus small colliders for the trunks and posts.

const LAMP_HEAD_Y = 5.5;
const LAMP_REACH = 14.5;
const LAMP_POOL = 36;
const LAMP_RANGE = 110; // m from the camera within which lamps may light up
const LAMP_INTENSITY = 30; // as the upstream street lights (street-details.js)
const SPECIES_WEIGHTS = [0.4, 0.3, 0.3]; // plane, locust, elm: the species the tree field has
// Garden trees are smaller and sparser than Manhattan's street trees: closer detail levels, and the shortest visibility tier
const TREE_LOD = { near: 45, mid: 170, shadowLevels: 2 }; // the whole-crown cards beyond 170 m cast no shadow
const TREE_TIER = 2;

// A unit-radius cylinder or box placed in a part's own frame, merged into one geometry
function part(geometry, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = {}) {
  const g = geometry.clone();
  g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

export function lampGeometry() {
  // pole, a bracket arm reaching +z over the road, the lantern head on its end
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.075, 0.1, LAMP_HEAD_Y, 8), { y: LAMP_HEAD_Y / 2 }),
    part(new THREE.BoxGeometry(0.07, 0.07, 1.25), { y: LAMP_HEAD_Y - 0.05, z: 0.55 }),
    part(new THREE.BoxGeometry(0.34, 0.1, 0.5), { y: LAMP_HEAD_Y - 0.02, z: 1.2 })
  ]);
}

export function poleGeometry() {
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.1, 0.14, 8.4, 8), { y: 4.2 }),
    part(new THREE.BoxGeometry(1.7, 0.09, 0.09), { y: 7.7 }),
    part(new THREE.BoxGeometry(1.2, 0.09, 0.09), { y: 7.1 })
  ]);
}

export function pillarGeometry() {
  return mergeGeometries([
    part(new THREE.BoxGeometry(0.44, 1.5, 0.44), { y: 0.75 }),
    part(new THREE.BoxGeometry(0.56, 0.12, 0.56), { y: 1.56 })
  ]);
}

export function fountainGeometry() {
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.95, 1.05, 0.5, 14), { y: 0.25 }),
    part(new THREE.CylinderGeometry(0.16, 0.2, 1.2, 8), { y: 0.9 }),
    part(new THREE.CylinderGeometry(0.5, 0.3, 0.14, 12), { y: 1.5 })
  ]);
}

const flatDisc = (r, segments = 14) => new THREE.CircleGeometry(r, segments).rotateX(-Math.PI / 2);
const flatBox = (w, d) => new THREE.BoxGeometry(w, 0.025, d).translate(0, 0.0125, 0);

// A circle collider for a trunk or a post: AABB for the broad phase and `pushOut(x, z, r)` like the building outlines
export function createCircleCollider(x, z, radius, maxY) {
  return {
    minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius, maxY,
    pushOut(px, pz, r) {
      const d = Math.hypot(px - x, pz - z);
      const reach = r + radius;
      if (d >= reach) return null;
      const nx = d > 1e-9 ? (px - x) / d : 1, nz = d > 1e-9 ? (pz - z) / d : 0;
      return { x: x + nx * reach, z: z + nz * reach, nx, nz };
    }
  };
}

// Heading about +y that turns a lamp's bracket (local +z) towards the road: from the nearest street's left normal
export function lampYaw(x, z, roadIndex, fallback = 0) {
  const hit = roadIndex ? roadIndex.query(x, z, 14) : null;
  if (!hit || !hit.edge || !Number.isFinite(hit.lateral)) return fallback;
  const e = hit.edge;
  // walk to the segment that contains arc length s to read the direction of travel there
  let s = 0;
  for (let i = 0; i + 1 < e.pts.length; i++) {
    const len = Math.hypot(e.pts[i + 1][0] - e.pts[i][0], e.pts[i + 1][1] - e.pts[i][1]);
    if (s + len >= hit.s || i + 2 === e.pts.length) {
      const tx = (e.pts[i + 1][0] - e.pts[i][0]) / (len || 1), tz = (e.pts[i + 1][1] - e.pts[i][1]) / (len || 1);
      const side = hit.lateral >= 0 ? -1 : 1; // the road is on the other side of the lamp from where it stands
      return Math.atan2(side * -tz, side * tx);
    }
    s += len;
  }
  return fallback;
}

const hash = (a, b) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export function treeSites(treePositions, ground) {
  const sites = [];
  for (let i = 0; i < treePositions.length; i += 3) {
    const x = treePositions[i], z = treePositions[i + 1];
    const r = hash(x, z);
    let species = 0, acc = 0;
    for (let k = 0; k < SPECIES_WEIGHTS.length; k++) { acc += SPECIES_WEIGHTS[k]; if (r < acc) { species = k; break; } }
    // Garden and street trees here are smaller than the upstream plane trees of Manhattan
    sites.push({ x, y: ground(x, z), z, scale: 0.5 + hash(z, x) * 0.4, tier: TREE_TIER, species, yaw: hash(x + 1, z + 2) * Math.PI * 2 });
  }
  return sites;
}

function instanced(geometry, material, matrices, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length / 16);
  mesh.name = name;
  mesh.instanceMatrix.array.set(matrices);
  // A storage attribute: small instanced meshes otherwise re-upload their matrices on every draw (js/main.js does the same)
  mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(mesh.instanceMatrix.array, 16);
  mesh.frustumCulled = false; // the instances span the whole municipality; the sphere of the base geometry would cull them
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * `props` = { tree, lamp, pole, pillar, manhole, gully, treePit, fountain } as Float32Array [x, z, heading, ...];
 * `ground(x, z)` the terrain, `surface(x, z)` the height a vehicle stands at (on a road, the asphalt).
 */
export function buildProps(scene, props, { ground, surface = ground, roadIndex = null, trees = true } = {}) {
  const group = new THREE.Group();
  group.name = 'VallromanesProps';
  const dummy = new THREE.Object3D();
  const colliders = [];
  const matrices = (list, { y = ground, yaw = (i) => list[i + 2], scale = 1, lift = 0, collider = null } = {}) => {
    const out = new Float32Array((list.length / 3) * 16);
    for (let i = 0, k = 0; i < list.length; i += 3, k++) {
      const x = list[i], z = list[i + 1];
      dummy.position.set(x, y(x, z) + lift, z);
      dummy.rotation.set(0, yaw(i), 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      dummy.matrix.toArray(out, k * 16);
      if (collider) colliders.push(createCircleCollider(x, z, collider.r, dummy.position.y + collider.h));
    }
    return out;
  };

  const metal = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.6 });
  metal.colorNode = color(0x3d4146);
  const wood = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  wood.colorNode = color(0x5b4632);
  const stone = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  stone.colorNode = color(0xb7b0a2);
  const iron = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.7 });
  iron.colorNode = color(0x2b2c2f);
  const soil = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  soil.colorNode = color(0x4c3b2a);
  const bulbGlow = new THREE.MeshBasicNodeMaterial();
  bulbGlow.colorNode = mix(color(0x8f918c), color(0xfff1d6).mul(2.1), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));

  const meshes = [];
  const add = (m) => { meshes.push(m); group.add(m); return m; };

  // Lamps: the bracket points over the road; a flat glowing lens sits under the head
  const lampYaws = [];
  for (let i = 0; i < props.lamp.length; i += 3) lampYaws.push(lampYaw(props.lamp[i], props.lamp[i + 1], roadIndex, props.lamp[i + 2]));
  const lampMats = matrices(props.lamp, { y: surface, yaw: (i) => lampYaws[i / 3], collider: { r: 0.12, h: LAMP_HEAD_Y } });
  add(instanced(lampGeometry(), metal, lampMats, 'lamps'));
  const lensMats = new Float32Array(lampMats.length);
  const lensOffset = new THREE.Matrix4().makeTranslation(0, LAMP_HEAD_Y - 0.09, 1.2);
  const m = new THREE.Matrix4();
  for (let k = 0; k < lampMats.length / 16; k++) { m.fromArray(lampMats, k * 16).multiply(lensOffset).toArray(lensMats, k * 16); }
  const lens = add(instanced(new THREE.PlaneGeometry(0.3, 0.42).rotateX(Math.PI / 2), bulbGlow, lensMats, 'lamp lenses'));
  lens.castShadow = false;
  const lampSites = [];
  for (let k = 0; k < props.lamp.length / 3; k++) {
    m.fromArray(lampMats, k * 16);
    const head = new THREE.Vector3(0, LAMP_HEAD_Y - 0.15, 1.2).applyMatrix4(m);
    lampSites.push({ x: head.x, y: head.y, z: head.z });
  }

  add(instanced(poleGeometry(), wood, matrices(props.pole, { collider: { r: 0.15, h: 8 } }), 'poles'));
  add(instanced(pillarGeometry(), stone, matrices(props.pillar, { collider: { r: 0.26, h: 1.6 } }), 'pillars'));
  add(instanced(flatDisc(0.32), iron, matrices(props.manhole, { y: surface, lift: 0.02 }), 'manholes'));
  add(instanced(flatBox(0.6, 0.34), iron, matrices(props.gully, { y: surface, lift: 0.015 }), 'gullies'));
  add(instanced(flatDisc(0.55), soil, matrices(props.treePit, { lift: 0.025 }), 'tree pits'));
  add(instanced(fountainGeometry(), stone, matrices(props.fountain, { collider: { r: 1.0, h: 1.6 } }), 'fountains'));
  for (const mesh of meshes) mesh.castShadow = mesh !== lens && mesh.name !== 'manholes' && mesh.name !== 'gullies' && mesh.name !== 'tree pits';

  // Trees: the upstream instanced field with its own levels of detail; a trunk collider each
  const sites = trees ? treeSites(props.tree, ground) : [];
  const field = createTreeField(scene, sites, TREE_LOD);
  group.add(field.group);
  for (const s of sites) colliders.push(createCircleCollider(s.x, s.z, 0.28, s.y + 6));

  // Night lights: a pool of point lights moved onto the lamps nearest the camera once the lighting preset is dusk or later
  const pool = [];
  for (let i = 0; i < LAMP_POOL; i++) {
    const light = new THREE.PointLight(0xffe0aa, 0, LAMP_REACH, 1.35);
    light.position.set(0, -1000, 0);
    group.add(light);
    pool.push(light);
  }
  const near = [];
  function update(camera) {
    const glow = cityUniforms.uInteriorGlow.value;
    const scale = Math.min(1.25, Math.max(0, (glow - 0.36) * 1.15)); // fades in as dusk approaches, as the bulbs do
    if (scale <= 0.001) {
      for (const l of pool) { l.intensity = 0; l.position.set(0, -1000, 0); }
      return;
    }
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    near.length = 0;
    for (const s of lampSites) {
      const d2 = (s.x - cx) ** 2 + (s.z - cz) ** 2 + (s.y - cy) ** 2;
      if (d2 < LAMP_RANGE * LAMP_RANGE) near.push([d2, s]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const cutoff = near.length > LAMP_POOL ? Math.sqrt(near[LAMP_POOL][0]) : LAMP_RANGE;
    pool.forEach((l, i) => {
      if (i >= near.length) { l.intensity = 0; l.position.set(0, -1000, 0); return; }
      const [d2, s] = near[i];
      const t = Math.min(1, Math.max(0, (cutoff - Math.sqrt(d2)) / (cutoff * 0.38)));
      l.position.set(s.x, s.y, s.z);
      l.intensity = LAMP_INTENSITY * scale * t * t * (3 - 2 * t);
    });
  }

  scene.add(group);
  function dispose() {
    scene.remove(group);
    for (const mesh of meshes) mesh.geometry.dispose();
    for (const mat of [metal, wood, stone, iron, soil, bulbGlow]) mat.dispose();
    field.group.parent?.remove(field.group);
  }
  return { group, field, colliders, update, dispose, stats: { trees: sites.length, lamps: lampSites.length, colliders: colliders.length } };
}
