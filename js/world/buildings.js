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
  positionWorld
} from 'three/tsl';
import { cityUniforms } from '../tsl-materials.js';
import { pushOutOfSolid } from '../geo/polygon.js';
import { appendStructure, newBuffers, RUINS_HEIGHT, SURF, toTypedBuffers } from './building-geometry.js';

// js/world/buildings.js
// The real buildings of the BUE survey: one merged mesh per 256 m chunk (walls, roofs, plinths), a facade material with
// procedural windows, and polygon colliders for the controllers.

export const CHUNK_SIZE = 256;
const RUINS = 'ruins';
const KIND = { building: 0, shed: 1, porch: 2, canopy: 3, construction: 4, tank: 5, ruins: 6, greenhouse: 7, wip: 8, monument: 9, cemetery: 10, tower: 11 };

/**
 * Plastered Mediterranean facades with a procedural window grid. Per vertex it reads `uv` (u = metres along the wall,
 * v = floors above the highest ground, so v < 0 is the plinth) and `info` = (window rows under the eave, surface type,
 * colour seed, kind). Roofs get terracotta tile courses or grey flat-roof gravel, slabs plain concrete.
 */
export function createBuildingMaterial() {
  const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
  const info = attribute('info', 'vec4');
  const rows = info.x;
  const surf = info.y;
  const pal = floor(info.z); // facade palette class from the Catastro photos (0 none), see encodeSeed
  const flag = (cond) => cond.select(float(1.0), float(0.0));
  const seed = info.z.sub(pal).sub(0.01).div(0.98);
  const hasPal = flag(pal.greaterThan(0.5));
  const kind = floor(info.w);
  // use and era of the building (building-geometry.js styleOf) ride in the fraction of info.w
  const styleCode = floor(fract(info.w).mul(32.0).add(0.5));
  const plain = styleCode.lessThan(24.0).select(float(1.0), float(0.0)); // 0 for the landmark looks
  const useCode = floor(styleCode.div(4.0)).mul(plain);
  const era = styleCode.sub(floor(styleCode.div(4.0)).mul(4.0)).mul(plain);
  // landmarks (styleCode 24..31): 1 town hall, 2 school, 3 masia, 4 church nave, 5 nursery school, 8 church tower
  const lm = max(styleCode.sub(23.0), 0.0);
  const isLm = (n) => flag(lm.equal(n));
  const facadeUV = uv();

  // Window grid: one bay every ~3.4 m, one row per floor
  // older houses have narrower bays
  const bayCoord = facadeUV.x.div(float(3.4).sub(flag(era.equal(1.0)).mul(0.7))).add(seed.mul(7.0));
  const cu = fract(bayCoord);
  const cell = floor(bayCoord);
  const row = floor(facadeUV.y);
  const fv = fract(facadeUV.y);
  const hasWindow = step(0.0, facadeUV.y)
    .mul(flag(row.add(0.5).lessThan(rows)))
    .mul(max(float(1.0).sub(isLm(8.0)), flag(row.add(1.5).greaterThan(rows)))) // the tower has only its belfry row
    .mul(step(0.18, hash(vec2(cell, row).add(seed.mul(31.0)))))
    .mul(flag(surf.notEqual(3.0)));
  const inCol = smoothstep(0.2, 0.17, abs(cu.sub(0.5)));
  const inRow = smoothstep(0.22, 0.26, fv).mul(smoothstep(0.8, 0.76, fv));
  const windowMask = inCol.mul(inRow).mul(hasWindow);
  const frameMask = smoothstep(0.25, 0.22, abs(cu.sub(0.5)))
    .mul(smoothstep(0.16, 0.2, fv)).mul(smoothstep(0.86, 0.82, fv)).mul(hasWindow);

  // Plaster colour from the seed: cream, sand, apricot, white, rose, light grey
  const palette = floor(seed.mul(5.999));
  let plaster = color(0xe9e0cd);
  plaster = palette.equal(1.0).select(color(0xd8c59d), plaster);
  plaster = palette.equal(2.0).select(color(0xe4c3a0), plaster);
  plaster = palette.equal(3.0).select(color(0xf0ebe3), plaster);
  plaster = palette.equal(4.0).select(color(0xd9b3a1), plaster);
  plaster = palette.equal(5.0).select(color(0xbdb8ac), plaster);
  // Facade class read by eye from the Catastro photos (facade-palette.mjs): 1 white, 2 cream, 3 ochre, 4 pink, 5 terracotta, 6 brick,
  // 7 grey, 8 stone, 9 dark cladding. Rendered classes tint the plaster; brick and stone get a pattern; a little light and dark per house.
  let classed = color(0xf1ede4);
  classed = pal.equal(2.0).select(color(0xeadfb4), classed);
  classed = pal.equal(3.0).select(color(0xd9b97e), classed);
  classed = pal.equal(4.0).select(color(0xe0b3a5), classed);
  classed = pal.equal(5.0).select(color(0xc77b57), classed);
  classed = pal.equal(7.0).select(color(0xa9a8a3), classed);
  classed = pal.equal(9.0).select(color(0x5c4a3c), classed);
  const bricks = floor(vec2(facadeUV.x.mul(4.5).add(floor(facadeUV.y.mul(14.0)).mul(0.5)), facadeUV.y.mul(14.0)));
  const brickWall = mix(mix(color(0xa4573d), color(0x8a4632), hash(bricks.add(seed.mul(9.0)))), color(0xcfc5b4), max(smoothstep(0.88, 0.96, fract(facadeUV.y.mul(14.0))), smoothstep(0.9, 0.97, fract(facadeUV.x.mul(4.5).add(floor(facadeUV.y.mul(14.0)).mul(0.5)))).mul(0.8)).mul(0.6));
  const stoneWall = mix(mix(color(0xb5aa92), color(0x948a76), hash(floor(vec2(facadeUV.x.mul(2.4), facadeUV.y.mul(5.5))).add(seed.mul(17.0)))), color(0x7f7563), max(smoothstep(0.9, 0.97, fract(facadeUV.x.mul(2.4))), smoothstep(0.88, 0.96, fract(facadeUV.y.mul(5.5)))).mul(0.6));
  classed = mix(classed, brickWall, flag(pal.equal(6.0)));
  classed = mix(classed, stoneWall, flag(pal.equal(8.0)));
  plaster = mix(plaster, classed.mul(float(0.94).add(seed.mul(0.12))), hasPal);
  // Outbuildings (sheds, tanks, construction, ruins) are plainer and greyer; greenhouses read as glass
  const outbuilding = max(max(flag(kind.equal(1.0)), flag(kind.equal(5.0))), max(flag(kind.equal(4.0)), flag(kind.equal(6.0))));
  plaster = mix(plaster, color(0xb4afa4), outbuilding.mul(0.7));
  plaster = mix(plaster, color(0xa9c4c8), flag(kind.equal(7.0)).mul(0.8));
  // Old houses (before 1950) are warmer and rougher, recent ones (1990 on) whiter; farm buildings and industry are plain concrete, shops and
  // public buildings light
  plaster = mix(plaster, color(0xcdb68e), flag(era.equal(1.0)).mul(0.4).mul(float(1.0).sub(hasPal)));
  plaster = mix(plaster, color(0xf1ede5), flag(era.equal(3.0)).mul(0.3).mul(float(1.0).sub(hasPal)));
  plaster = mix(plaster, color(0xb9b6ad), flag(useCode.equal(1.0)).mul(0.75));
  plaster = mix(plaster, color(0xa4a9ad), flag(useCode.equal(2.0)).mul(0.8));
  plaster = mix(plaster, color(0xf1ebdf), max(flag(useCode.equal(3.0)), flag(useCode.equal(4.0))).mul(0.6));
  const grain = hash(positionWorld.xz.mul(7.3).add(positionWorld.y.mul(5.1)));
  // Landmark facades (photographs on Wikimedia Commons)
  const blocks = floor(vec2(facadeUV.x.mul(2.4), facadeUV.y.mul(5.5)));
  const blockHash = hash(blocks.add(seed.mul(17.0)));
  const mortar = max(smoothstep(0.9, 0.97, fract(facadeUV.x.mul(2.4))), smoothstep(0.88, 0.96, fract(facadeUV.y.mul(5.5))));
  const rubble = mix(mix(color(0xb9aa8d), color(0x9d9078), blockHash), color(0x7f7563), mortar.mul(0.7)); // masia: rubble stone
  const ashlar = mix(mix(color(0xa29e92), color(0x8a857a), blockHash), color(0x6f6b62), mortar.mul(0.6)); // church tower: grey masonry
  const band = max(smoothstep(0.78, 0.84, fv), smoothstep(0.1, 0.04, fv)); // a white band at every floor line
  const brickHall = mix(mix(color(0x8c3f2b), color(0x74321f), blockHash.mul(0.8)), color(0xf2eee6), band.mul(0.9)); // town hall above the ground floor
  const stoneHall = mix(color(0xd6a692), color(0xc8967f), hash(floor(vec2(facadeUV.x.mul(1.4), facadeUV.y.mul(3.0)))));
  const hallWall = mix(brickHall, stoneHall, step(facadeUV.y, 1.0));
  const schoolWall = mix(mix(color(0xe3cf5b), color(0xd8c24c), grain.mul(0.5)), mix(color(0xa9adb0), color(0x8f9498), step(0.5, fract(facadeUV.y.mul(7.0)))), step(1.0, facadeUV.y).mul(0.75));
  plaster = mix(plaster, color(0xf0ece4), isLm(4.0));
  plaster = mix(plaster, rubble, isLm(3.0));
  plaster = mix(plaster, ashlar, isLm(8.0));
  plaster = mix(plaster, mix(color(0xb4cbe2), color(0xa5bfdc), grain.mul(0.6)), isLm(5.0)); // nursery: pale blue walls
  plaster = mix(plaster, hallWall, isLm(1.0));
  plaster = mix(plaster, schoolWall, isLm(2.0));

  let wall = plaster.mul(float(0.9).add(grain.mul(0.16)));
  wall = mix(wall, color(0xfaf7f0), max(frameMask.sub(windowMask), 0.0).mul(0.9));
  // Glass: dark with a bluish sky tint that varies from window to window; a shaded band under the lintel
  const glass = mix(color(0x0d151d), color(0x2f4558), hash(vec2(cell, row)).mul(0.7)).mul(float(1.0).sub(smoothstep(0.62, 0.78, fv).mul(0.45)));
  wall = mix(wall, glass, windowMask);
  // Plinth: darker stone below the highest ground
  wall = mix(wall, color(0x8b8274).mul(float(0.85).add(grain.mul(0.3))), smoothstep(0.0, -0.05, facadeUV.y).mul(flag(surf.equal(0.0))));

  // Tile courses run along the contour lines (constant y), with a little mottling per tile
  const courses = fract(positionWorld.y.mul(6.5));
  const tileHash = hash(floor(positionWorld.xz.mul(0.8)));
  let tiles = mix(color(0xa8502f), color(0x934329), tileHash.mul(0.6)).mul(float(0.86).add(courses.mul(0.2)));
  // farm and industrial pitched roofs are sheet metal, not clay tile
  tiles = mix(tiles, color(0x8a8f94).mul(float(0.9).add(courses.mul(0.15))), max(flag(useCode.equal(1.0)), flag(useCode.equal(2.0))).mul(0.85));
  const gravel = mix(color(0x9d9a92), color(0x84827b), hash(positionWorld.xz.mul(2.3)));

  let colorNode = wall;
  colorNode = mix(colorNode, tiles, flag(surf.equal(1.0)));
  colorNode = mix(colorNode, gravel, flag(surf.equal(2.0)));
  colorNode = mix(colorNode, color(0xb7b3ab), flag(surf.equal(3.0)));

  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = colorNode;
  // Glass is smooth, everything else matt
  material.roughnessNode = mix(float(0.92), float(0.14), windowMask);
  material.metalness = 0;
  // At night some windows are lit; the glow follows the lighting preset (cityUniforms.uInteriorGlow)
  const lit = step(0.55, hash(vec2(cell, row).add(seed.mul(113.0))));
  material.emissiveNode = vec3(1.0, 0.78, 0.5).mul(windowMask).mul(lit).mul(cityUniforms.uInteriorGlow).mul(0.35);
  return material;
}

// A polygon collider for the controllers (js/controllers.js resolveHorizontalCollision): AABB for the broad phase,
// `pushOut(x, z, r)` for the circle test against the real outline (courtyards stay open).
export function createCollider(s) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const outer = s.rings[0];
  for (let i = 0; i < outer.length; i += 2) {
    if (outer[i] < minX) minX = outer[i];
    if (outer[i] > maxX) maxX = outer[i];
    if (outer[i + 1] < minZ) minZ = outer[i + 1];
    if (outer[i + 1] > maxZ) maxZ = outer[i + 1];
  }
  const maxY = s.kindName === RUINS ? Math.min(s.top, s.base + RUINS_HEIGHT) : s.top;
  return { minX, maxX, minZ, maxZ, maxY, id: s.id, pushOut: (x, z, r) => pushOutOfSolid(s.rings, x, z, r) };
}

export function buildBuildings(scene, structures, { material = createBuildingMaterial() } = {}) {
  const group = new THREE.Group();
  group.name = 'VallromanesBuildings';
  const cells = new Map();
  for (const s of structures) {
    const [outer] = s.rings;
    let cx = 0, cz = 0;
    for (let i = 0; i < outer.length; i += 2) { cx += outer[i]; cz += outer[i + 1]; }
    cx /= outer.length / 2;
    cz /= outer.length / 2;
    const key = `${Math.floor(cx / CHUNK_SIZE)},${Math.floor(cz / CHUNK_SIZE)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(s);
  }

  let triangles = 0;
  const colliders = [];
  for (const [key, list] of cells) {
    const out = newBuffers();
    for (const s of list) {
      appendStructure(out, s, { ruins: s.kindName === RUINS });
      if (!s.open) colliders.push(createCollider(s));
    }
    const buf = toTypedBuffers(out);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buf.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(buf.normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(buf.uv, 2));
    geometry.setAttribute('info', new THREE.BufferAttribute(buf.info, 4));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `buildings ${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    triangles += buf.position.length / 9;
  }
  scene.add(group);

  function dispose() {
    scene.remove(group);
    for (const m of group.children) m.geometry.dispose();
    material.dispose();
  }

  return { group, colliders, dispose, stats: { structures: structures.length, chunks: cells.size, triangles }, KIND, SURF };
}
