import * as THREE from 'three/webgpu';
import { cityUniforms, createContactShadowMaterial } from './tsl-materials.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import { BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, buildSteerableWheelGeo, createLoftedCarMaterial } from './actor-models.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { TrafficSim } from './traffic-sim.js';
import { WalkerSim } from './walkers-sim.js';

// js/traffic.js
// The town's cars and people on the screen. The driving and the walking are decided by traffic-sim.js and walkers-sim.js on
// the lane and pavement graphs; this file puts the cars (instanced lofted bodies, spinning wheels, lamps, contact shadows and
// night headlights) and the people (skinned rigs with planted feet, see pedestrians.js) on the ground.

const CAR_PROXY_DISTANCE = 90; // beyond this a car is the ~250-triangle stand-in
const NEAR_DRAW = 45; // cars and people this near are drawn even off-screen: their shadows reach into the view
const HEADLIGHT_POOL = 32;
const MAX_LIGHT_DIST = 90;
const WHEELBASE_CENTER = 1.38;
const PALETTE = [
  [0xe9ecef, 5], [0xb8bec6, 5], [0x4b5057, 4], [0x1b1e23, 4], [0x1f3f73, 2], [0x7a1f26, 2], [0xd7dbe0, 3], [0x2d4a3a, 1], [0x8d9299, 3]
];
const PALETTE_TOTAL = PALETTE.reduce((s, p) => s + p[1], 0);

const smooth = (d, start, end) => {
  const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
  return t * t * (3 - 2 * t);
};

/**
 * @param scene the three.js scene to add to
 * @param {object} o laneGraph, pavements, groundHeight(x, z, mode), inside(x, z), cars, people
 * @returns { group, sim, walkers, update(dt, elapsed, camera, focus, playerEntity, mode), stats() }
 */
export function createTraffic(scene, { laneGraph, pavements, groundHeight, inside = () => true, cars = 60, people = 80 }) {
  const group = new THREE.Group();
  group.name = 'Traffic';
  scene.add(group);

  const sim = new TrafficSim(laneGraph, { count: cars, inside, seed: 11 });
  const walkers = new WalkerSim(pavements, laneGraph, { count: people, inside, seed: 23 });

  const dummy = new THREE.Object3D();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const bodyM = new THREE.Matrix4();
  const wheelM = new THREE.Matrix4();
  const local = new THREE.Object3D();
  const tint = new THREE.Color();

  // ---- cars ---------------------------------------------------------------------------------------------------------
  const kinds = ['sedan', 'suv'];
  const bodies = {};
  const unitPlane = new THREE.PlaneGeometry(1, 1);
  unitPlane.rotateX(-Math.PI * 0.5);
  const lodMesh = (geo, mat, n) => {
    geo.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    return new THREE.InstancedMesh(geo, mat, n);
  };
  const n = Math.max(1, cars);
  for (const kind of kinds) {
    const mat = createLoftedCarMaterial(BODY_SPECS[kind]);
    bodies[kind] = {
      near: lodMesh(buildCarGeometry(BODY_SPECS[kind], false), mat, n),
      far: lodMesh(buildCarProxyGeometry(BODY_SPECS[kind]), mat, n)
    };
  }
  const bodyMeshes = kinds.flatMap((k) => [bodies[k].near, bodies[k].far]);
  const wheelMat = createLoftedCarMaterial(BODY_SPECS.sedan, 0x8d9299);
  const wheelLeft = new THREE.InstancedMesh(buildSteerableWheelGeo(BODY_SPECS.sedan, -1), wheelMat, n * 2);
  const wheelRight = new THREE.InstancedMesh(buildSteerableWheelGeo(BODY_SPECS.sedan, 1), wheelMat, n * 2);
  const shadows = new THREE.InstancedMesh(unitPlane, createContactShadowMaterial(), n);
  shadows.renderOrder = 998;
  for (const m of [...bodyMeshes, wheelLeft, wheelRight]) m.castShadow = m.receiveShadow = true;
  const carMeshes = [...bodyMeshes, wheelLeft, wheelRight, shadows];
  group.add(...carMeshes);
  // one degenerate instance each, so that every pipeline compiles before the first car appears
  for (const m of carMeshes) {
    m.frustumCulled = false;
    m.setMatrixAt(0, zero);
    m.count = 1;
  }

  // headlights: a pool of clustered spot lights handed to the nearest cars at dusk and night
  const lightGroup = new THREE.Group();
  group.add(lightGroup);
  const spots = [];
  for (let i = 0; i < HEADLIGHT_POOL; i++) {
    const spot = createVehicleHeadlight();
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    lightGroup.add(spot, spot.target);
    spots.push(spot);
  }

  // ---- people -------------------------------------------------------------------------------------------------------
  const crowd = new PersonCrowd(Math.max(1, people));
  group.add(...crowd.meshes);
  for (const p of walkers.people) {
    p.rig = new PersonRig({ seed: p.seed, scale: p.scale, female: p.female, girth: p.girth, hair: p.hair, armSwing: p.armSwing, stride: p.stride });
  }
  const personGround = (_o, x, z) => groundHeight(x, z, 'person');

  // ---- per frame ----------------------------------------------------------------------------------------------------
  const frustum = new THREE.Frustum();
  const proj = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  let hasView = false;
  const visible = (x, y, z, r, focusX, focusZ) => {
    if (Math.hypot(x - focusX, z - focusZ) < NEAR_DRAW) return true;
    if (!hasView) return true;
    sphere.center.set(x, y, z);
    sphere.radius = r;
    // the four side planes only: the depth planes of a reversed depth buffer are not what Frustum expects
    for (let i = 0; i < 4; i++) if (frustum.planes[i].distanceToPoint(sphere.center) < -r) return false;
    return true;
  };

  let lastFx = Infinity, lastFz = Infinity;
  let updates = 0;
  const lit = [];
  let visibleCars = 0;
  let visiblePeople = 0;

  const tilt = (c) => {
    // the body lies on the ground under its four wheels
    const sy = Math.sin(c.yaw), cy = Math.cos(c.yaw);
    const rx = c.x - sy * 0.0, rz = c.z - cy * 0.0;
    const fx = c.x + sy * 2.76, fz = c.z + cy * 2.76;
    const yR = groundHeight(rx, rz, 'car'), yF = groundHeight(fx, fz, 'car');
    const mx = c.x + sy * WHEELBASE_CENTER, mz = c.z + cy * WHEELBASE_CENTER;
    const lx = mx + cy * 0.83, lz = mz - sy * 0.83, ox = mx - cy * 0.83, oz = mz + sy * 0.83;
    const yL = groundHeight(lx, lz, 'car'), yO = groundHeight(ox, oz, 'car');
    return { y: (yR + yF) * 0.5, pitch: -Math.atan2(yF - yR, 2.76), roll: Math.atan2(yL - yO, 1.66) };
  };

  function drawCar(c, dt, focusX, focusZ, camPos) {
    const sy = Math.sin(c.yaw), cy = Math.cos(c.yaw);
    const mx = c.x + sy * WHEELBASE_CENTER, mz = c.z + cy * WHEELBASE_CENTER;
    const near = Math.hypot(mx - focusX, mz - focusZ);
    if (!visible(mx, groundHeight(mx, mz, 'car') + 1, mz, 6, focusX, focusZ)) return;
    const t = tilt(c);
    // ease the attitude, so a bumpy lane does not make the body shake
    const k = Math.min(1, dt * 9);
    c.pitch += (t.pitch - c.pitch) * k;
    c.roll += (t.roll - c.roll) * k;
    c.y = t.y;
    const kind = c.body;
    const inst = near < CAR_PROXY_DISTANCE ? bodies[kind].near : bodies[kind].far;
    const slot = inst.count++;
    dummy.position.set(mx, c.y, mz);
    dummy.rotation.set(c.pitch, c.yaw, c.roll, 'YXZ');
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bodyM.copy(dummy.matrix);
    inst.setMatrixAt(slot, bodyM);

    const attrs = inst.geometry.attributes;
    tint.setHex(c.paint);
    attrs.paintColor.array.set([tint.r, tint.g, tint.b], slot * 3);
    const blinkOn = c.blink !== 0 && (sim.time + c.id * 0.37) % 0.8 <= 0.4;
    attrs.carState.array.set([c.acc < -0.8 || c.speed < 0.3 ? 1 : 0, blinkOn && c.blink < 0 ? 1 : 0, blinkOn && c.blink > 0 ? 1 : 0, 0], slot * 4);

    // contact shadow, flat on the ground
    dummy.rotation.set(0, c.yaw, 0, 'YXZ');
    dummy.position.set(mx, c.y + 0.03, mz);
    dummy.scale.set(2.22, 1, 5.05);
    dummy.updateMatrix();
    shadows.setMatrixAt(visibleCars, dummy.matrix);

    if (near < CAR_PROXY_DISTANCE) {
      const spec = BODY_SPECS.sedan;
      const spin = c.wheelSpin;
      for (let w = 0; w < 2; w++) {
        const wz = w === 0 ? spec.wheelZ : -spec.wheelZ;
        for (const side of [-1, 1]) {
          local.position.set(side * spec.wheelX, spec.wheelRadius, wz);
          local.rotation.set(spin + w * 0.55, w === 0 ? c.steer : 0, 0, 'YXZ');
          local.scale.set(1, 1, 1);
          local.updateMatrix();
          wheelM.multiplyMatrices(bodyM, local.matrix);
          (side < 0 ? wheelLeft : wheelRight).setMatrixAt(visibleCars * 2 + w, wheelM);
        }
      }
    } else {
      wheelLeft.setMatrixAt(visibleCars * 2, zero);
      wheelLeft.setMatrixAt(visibleCars * 2 + 1, zero);
      wheelRight.setMatrixAt(visibleCars * 2, zero);
      wheelRight.setMatrixAt(visibleCars * 2 + 1, zero);
    }
    visibleCars++;

    const d2 = (mx - camPos.x) ** 2 + (mz - camPos.z) ** 2 + (c.y - camPos.y) ** 2;
    if (d2 < MAX_LIGHT_DIST * MAX_LIGHT_DIST) lit.push({ c, d: Math.sqrt(d2), matrix: bodyM.clone() });
  }

  function updateLights() {
    const glow = cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    // front lamps are off at midday and golden hour and fade in for dusk and night
    const beam = Math.min(1.28, Math.max(0, (glow - 0.6) * 1.45));
    lit.sort((a, b) => a.d - b.d);
    let used = 0;
    if (beam > 0.001) {
      const cutoff = lit.length > HEADLIGHT_POOL / 2 ? Math.min(MAX_LIGHT_DIST, lit[HEADLIGHT_POOL / 2].d) : MAX_LIGHT_DIST;
      for (let i = 0; i < lit.length && used + 2 <= HEADLIGHT_POOL; i++) {
        const fade = smooth(lit[i].d, cutoff * 0.62, cutoff);
        if (fade <= 0.001) continue;
        for (let side = -1; side <= 1; side += 2) {
          const spot = spots[used++];
          placeVehicleHeadlight(spot, BODY_SPECS[lit[i].c.body], side, lit[i].matrix);
          spot.distance = HEADLIGHTS.distance;
          spot.intensity = HEADLIGHTS.intensity * beam * fade;
        }
      }
    }
    for (let i = used; i < HEADLIGHT_POOL; i++) {
      spots[i].intensity = 0;
      spots[i].position.set(0, -1000, 0);
    }
  }

  function update(dt, elapsed, camera, focus, playerEntity = null, mode = 'person') {
    const fx = focus.x, fz = focus.z;
    const jumped = Math.hypot(fx - lastFx, fz - lastFz) > 160;
    lastFx = fx;
    lastFz = fz;
    hasView = Boolean(camera);
    if (camera) {
      camera.updateMatrixWorld();
      proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(proj);
    }

    // the player is something in the way of the cars
    sim.obstacles.length = 0;
    if (playerEntity && mode !== 'helicopter' && playerEntity.position.y < 40) {
      const p = playerEntity.position;
      sim.obstacles.push({ x: p.x, z: p.z, r: mode === 'car' ? 1.6 : mode === 'cyclist' ? 0.9 : 0.5, speed: Math.abs(playerEntity.speed || 0) });
    }

    sim.update(dt, fx, fz, jumped);
    walkers.update(dt, fx, fz, jumped);

    for (const m of carMeshes) m.count = 0;
    lit.length = 0;
    visibleCars = 0;
    const camPos = camera ? camera.position : { x: fx, y: 0, z: fz };
    for (const c of sim.cars) {
      if (!c.active) continue;
      if (c.paint === undefined) {
        let t = ((c.id * 0.6180339887) % 1) * PALETTE_TOTAL;
        c.paint = PALETTE[0][0];
        for (const [hex, w] of PALETTE) { t -= w; if (t <= 0) { c.paint = hex; break; } }
      }
      drawCar(c, dt, fx, fz, camPos);
    }
    const hideEmpty = ++updates > 2;
    for (const m of bodyMeshes) {
      m.visible = m.count > 0 || !hideEmpty;
      if (m.count === 0) {
        if (!hideEmpty) { m.setMatrixAt(0, zero); m.count = 1; m.instanceMatrix.needsUpdate = true; }
        continue;
      }
      m.instanceMatrix.needsUpdate = true;
      m.geometry.attributes.paintColor.needsUpdate = true;
      m.geometry.attributes.carState.needsUpdate = true;
    }
    const sync = (m, count) => {
      m.visible = count > 0 || !hideEmpty;
      if (count === 0) {
        if (!hideEmpty) { m.setMatrixAt(0, zero); m.count = 1; m.instanceMatrix.needsUpdate = true; } else m.count = 0;
        return;
      }
      m.count = count;
      m.instanceMatrix.needsUpdate = true;
    };
    sync(wheelLeft, visibleCars * 2);
    sync(wheelRight, visibleCars * 2);
    sync(shadows, visibleCars);
    updateLights();

    // people: every walker's gait advances; only those that can be seen pose their bones and are drawn
    crowd.begin();
    visiblePeople = 0;
    for (const p of walkers.people) {
      if (!p.active) continue;
      const draw = visible(p.x, groundHeight(p.x, p.z, 'person') + 1, p.z, 3, fx, fz);
      if (p.placedFresh) { p.rig.placed = false; p.placedFresh = false; }
      p.rig.update(dt, p.x, p.z, p.heading, personGround, p, 0, draw);
      if (!draw) continue;
      crowd.add(p.rig, Math.hypot(p.x - fx, p.z - fz));
      visiblePeople++;
    }
    crowd.end();
  }

  // The cars as colliders for the player (js/controllers.js dynamicColliders): three circles along the body, like the player's own car
  const carPool = [];
  const carOut = [];
  const makeCarCollider = () => {
    const c = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, maxY: 2.2, sx: 0, sz: 0, cx: 0, cz: 0 };
    c.pushOut = (px, pz, r) => {
      let best = null, depth = 0;
      for (const off of [-1.3, 0, 1.3]) {
        const ox = c.cx + c.sx * off, oz = c.cz + c.sz * off;
        const d = Math.hypot(px - ox, pz - oz), reach = r + 0.95, pen = reach - d;
        if (pen > depth) {
          depth = pen;
          const nx = d > 1e-9 ? (px - ox) / d : -c.sz, nz = d > 1e-9 ? (pz - oz) / d : c.sx;
          best = { x: ox + nx * reach, z: oz + nz * reach, nx, nz };
        }
      }
      return best;
    };
    return c;
  };
  function collidersNear(x, z, r) {
    carOut.length = 0;
    for (const car of sim.cars) {
      if (!car.active) continue;
      const mx = car.x + Math.sin(car.yaw) * WHEELBASE_CENTER, mz = car.z + Math.cos(car.yaw) * WHEELBASE_CENTER;
      if (Math.abs(mx - x) > r + 4 || Math.abs(mz - z) > r + 4) continue;
      const c = carPool[carOut.length] || (carPool[carOut.length] = makeCarCollider());
      c.cx = mx; c.cz = mz; c.sx = Math.sin(car.yaw); c.sz = Math.cos(car.yaw);
      c.minX = mx - 3; c.maxX = mx + 3; c.minZ = mz - 3; c.maxZ = mz + 3; c.maxY = car.y + 2;
      carOut.push(c);
    }
    return carOut;
  }

  const stats = () => ({
    cars: sim.cars.filter((c) => c.active).length, carsDrawn: visibleCars, people: walkers.people.filter((p) => p.active).length,
    peopleDrawn: visiblePeople, waiting: sim.cars.filter((c) => c.active && c.stuck > 20).length, ...sim.stats
  });

  return { group, sim, walkers, update, stats, collidersNear };
}
