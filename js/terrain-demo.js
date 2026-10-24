import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, metalness, roughness, vec2, vec3 } from 'three/tsl';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { createPostProcessing } from './post-processing.js';
import { isTypingInField } from './city-config.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { loadBoundary, loadBuildings, loadRoads, loadTerrain } from './geo/load-geodata.js';
import { confineToRing } from './geo/polygon.js';
import { createRoadIndex } from './geo/road-index.js';
import { buildTerrain } from './world/terrain.js';
import { buildBuildings } from './world/buildings.js';
import { buildStreets } from './world/streets.js';
import { CURB, LIFT, ROAD_DEPTH, TRACK_LIFT } from './world/street-geometry.js';

// js/terrain-demo.js
// Phase 2-4 milestone: the real Vallromanes terrain, BUE buildings and streets, with the four player modes walking,
// driving and flying over them.
// Started by main.js when the page is opened with ?terrain. Everything NYC-specific (blocks, traffic, map, audio) is
// left out; the lighting, camera, controllers and post-processing are the upstream ones.

// Where the player starts: the Ajuntament, the origin of the local frame
const SPAWN = { x: 0, z: 0, heading: Math.PI };
// Players stay this far inside the municipal boundary (the hard edge of the world)
const EDGE_MARGIN = 3;

export async function initTerrainDemo() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const setStatus = (text) => { if (loadingStatus) loadingStatus.textContent = text; };

  setStatus('Initializing Three.js WebGPURenderer...');
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);
  await renderer.init();
  // WebGPU validation errors are only logged; keep them where the checks of this milestone can read them
  const gpuErrors = [];
  renderer.backend.device?.addEventListener('uncapturederror', (e) => gpuErrors.push(String(e.error?.message).slice(0, 200)));

  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer);

  setStatus('Loading Vallromanes terrain and buildings...');
  const [{ sampler, frame }, boundary, { structures }, roads] = await Promise.all([
    loadTerrain('./data/'), loadBoundary('./data/'), loadBuildings('./data/'), loadRoads('./data/')
  ]);
  const terrain = buildTerrain(scene, sampler);
  const buildings = buildBuildings(scene, structures);
  const streets = buildStreets(scene, roads);
  const roadIndex = createRoadIndex(roads, streets.trims);
  const b = sampler.bounds;
  // The terrain under a street is baked ROAD_DEPTH below the street's profile; the asphalt rides LIFT above the profile
  // and the pavement CURB above that, so what stands or drives on them has to sit that much higher
  const groundHeight = (x, z, mode) => {
    const base = sampler.heightAt(x, z);
    const hit = roadIndex.query(x, z, 0);
    if (!hit || !hit.kind) return base;
    if (hit.edge.cls === 'track' || hit.edge.cls === 'urbanUnpaved') return base + ROAD_DEPTH + TRACK_LIFT;
    return base + ROAD_DEPTH + LIFT + (hit.kind === 'sidewalk' && mode === 'person' ? CURB : 0);
  };
  const world = {
    groundHeight,
    normalAt: sampler.normalAt,
    bounds: { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ },
    confine: (x, z) => confineToRing(boundary.rings[0], x, z, EDGE_MARGIN)
  };

  const controllerManager = new ThirdPersonControllerManager(scene, buildings.colliders);
  controllerManager.setWorld(world);
  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  const touchControls = new TouchControls(controllerManager);

  // Post-processing without SSR (no reflective surfaces yet). The scene pass keeps the upstream MRT layout: some
  // upstream meshes write no colour of their own (depth-only occluders) and need the extra outputs to compile.
  const scenePass = pass(scene, cameraSystem.camera);
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const sceneMRT = mrt({ output, normal: normalView, metalRough: vec2(metalness, roughness) });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);
  const colorGrade = createPostProcessing(renderer, scenePass.getTextureNode('output'), vec3(0.0));
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // HUD: reuse the upstream elements that still make sense, hide the New York ones
  for (const el of document.querySelectorAll('[data-teleport], #btn-teleport, #btn-open-map, #btn-sound, #minimap-card, #cam-menu-btn, #cam-prev, #cam-next')) {
    el.hidden = true;
    el.style.display = 'none';
  }
  const brand = document.querySelector('.brand-title');
  if (brand) brand.textContent = 'Slop Vallromanes';
  document.title = 'Slop Vallromanes · terrain';

  const modeButtons = document.querySelectorAll('[data-mode]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const modeSwitch = document.getElementById('mode-switch');
  const topSpeedMph = { person: 18, car: 81, cyclist: 43, helicopter: 116 };
  const controlHints = {
    person: [[['W', 'S'], 'Walk'], [['A', 'D'], 'Turn'], [['Shift'], 'Sprint'], [['Space'], 'Jump'], [['Drag'], 'Orbit']],
    car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['Shift'], 'Boost'], [['Drag'], 'Orbit']],
    cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn'], [['Shift'], 'Sprint'], [['Drag'], 'Orbit']],
    helicopter: [[['W', 'S'], 'Pitch'], [['A', 'D'], 'Yaw'], [['Space', 'E'], 'Ascend'], [['Q', 'C'], 'Descend'], [['Shift'], 'Boost']]
  };

  function renderControlHints(mode) {
    if (!elControlsHint) return;
    elControlsHint.replaceChildren(...controlHints[mode].map(([keys, action]) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        item.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'hint-label';
      label.textContent = action;
      item.appendChild(label);
      return item;
    }));
  }

  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }

  const cycleModes = ['person', 'car', 'cyclist', 'helicopter'];
  function selectMode(mode) {
    controllerManager.setMode(mode);
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-mode') === mode));
    document.body.dataset.mode = mode;
    placeModeIndicator();
    if (elMode) elMode.textContent = controllerManager.getActiveEntity().label;
    renderControlHints(mode);
    cameraSystem.setCameraPreset('chase', true);
    if (elCamera) elCamera.textContent = cameraSystem.getActivePreset().name;
  }

  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => selectMode(cycleModes[(cycleModes.indexOf(controllerManager.activeMode) + step + cycleModes.length) % cycleModes.length]),
    onCycleCamera: () => {},
    onToggleMap: () => {},
    onCloseMap: () => {}
  });

  function selectTime(timeId) {
    lightingSystem.applyPreset(timeId);
    colorGrade.applyPreset(lightingSystem.activePresetId);
    timeButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-time') === timeId));
  }

  modeButtons.forEach((btn) => btn.addEventListener('click', () => selectMode(btn.getAttribute('data-mode'))));
  timeButtons.forEach((btn) => btn.addEventListener('click', () => selectTime(btn.getAttribute('data-time'))));
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    const mode = { Digit1: 'person', Digit2: 'car', Digit3: 'cyclist', Digit4: 'helicopter' }[e.code];
    if (mode) selectMode(mode);
    if (e.code === 'KeyH') document.getElementById('btn-toggle-hud')?.click();
  });
  window.addEventListener('resize', () => {
    cameraSystem.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    placeModeIndicator();
  });

  // Every mode starts at the Ajuntament, at rest on the ground (the helicopter 100 m up)
  for (const mode of cycleModes) {
    controllerManager.setMode(mode);
    controllerManager.teleportActiveTo(SPAWN.x, SPAWN.z, SPAWN.heading, mode === 'helicopter' ? 100 : null);
  }
  selectMode('person');
  selectTime('midday');
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);

  // Handles for the console and the tests of this milestone
  window.vallromanes = { gpuErrors, THREE, scene, renderer, terrain, buildings, streets, roadIndex, roads, boundary, sampler, controllerManager, cameraSystem, lightingSystem, selectMode };

  // An empty frame first: it configures the scene pass's render target (MSAA samples, depth format), so the pipelines
  // built for the real frames are the ones the pass asks for (js/main.js does the same before compiling shaders)
  scene.visible = false;
  renderPipeline.render();
  scene.visible = true;
  // Then compile the materials the way the scene pass will use them (its target and MRT), as js/main.js does
  setStatus('Compiling shaders...');
  terrain.update(cameraSystem.camera.position);
  renderer.setRenderTarget(scenePass.renderTarget);
  renderer.setMRT(sceneMRT);
  try {
    await renderer.compileAsync(scene, cameraSystem.camera, scene);
  } catch (e) {
    console.warn('[compile]', e); // the first frames compile what is missing
  }
  renderer.setMRT(null);
  renderer.setRenderTarget(null);

  setStatus('Rendering...');
  let lastTime = performance.now();
  let elapsed = 0, frameCount = 0, fpsTimer = 0, framesDrawn = 0;
  renderer.setAnimationLoop((now) => {
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    elapsed += dt;

    gamepadControls.update(dt);
    controllerManager.update(dt, elapsed);
    cameraSystem.update(dt, elapsed);
    terrain.update(cameraSystem.camera.position);
    lightingSystem.update(cameraSystem.currentPos);
    renderPipeline.render();

    if (++framesDrawn === 2 && loadingOverlay) loadingOverlay.classList.add('hidden');

    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const fps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;
      const ent = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const mph = Math.round(Math.abs(ent.speed) * 2.237);
      if (elFps) {
        elFps.textContent = String(fps);
        elFps.className = fps >= 50 ? 'fps-ok' : fps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(mph);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, mph / (topSpeedMph[mode] || 80))})`;
      document.body.classList.toggle('is-boosting', controllerManager.keys.boost && mph > 0);
      // Altitude as metres above sea level (local y is relative to H0)
      if (elAltitude) elAltitude.textContent = String(Math.round(ent.position.y + frame.H0));
      if (elLocation) {
        const street = roadIndex.nameAt(ent.position.x, ent.position.z);
        elLocation.textContent = street ? `Vallromanes · ${street}` : `Vallromanes · x ${Math.round(ent.position.x)}, z ${Math.round(ent.position.z)}`;
      }
    }
  });
}
