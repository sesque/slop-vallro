import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, metalness, roughness, vec2, vec3 } from 'three/tsl';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { createPostProcessing } from './post-processing.js';
import { isTypingInField } from './town-config.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { TownMapSystem } from './town-map.js';
import { loadBoundary, loadBuildings, loadFeatures, loadLabels, loadProps, loadRoads, loadStairs, loadTerrain } from './geo/load-geodata.js';
import { confineToRing, pointInRings } from './geo/polygon.js';
import { createRoadIndex } from './geo/road-index.js';
import { createStairIndex } from './geo/stair-index.js';
import { buildTerrain } from './world/terrain.js';
import { buildBuildings } from './world/buildings.js';
import { buildStreets } from './world/streets.js';
import { buildFeatures } from './world/features.js';
import { buildProps } from './world/props.js';
import { CURB, LIFT, ROAD_DEPTH, TRACK_LIFT } from './world/street-geometry.js';

// js/town.js
// Slop Vallromanes: the real terrain, buildings, streets, walls, stairs, water and trees of the municipality, with the
// four player modes (walk, drive, cycle, fly), the map, the teleport list and the HUD. The baked data comes from data/ (see
// tools/vallromanes); the lighting, cameras, controllers and post-processing are the upstream ones.

// Where a first visit starts: the Ajuntament, the origin of the local frame
const SPAWN = { x: 0, z: 0, heading: Math.PI };
// Players stay this far inside the municipal boundary (the hard edge of the world)
const EDGE_MARGIN = 3;
const SAVE_KEY = 'vallromanes-player-state';
const MODES = ['person', 'car', 'cyclist', 'helicopter'];
// Boosted top speeds in km/h (controllers.js caps them at 8.2, 36, 19 & 52 m/s): the full scale of the speed meter
const TOP_SPEED_KMH = { person: 30, car: 130, cyclist: 70, helicopter: 187 };
const CONTROL_HINTS = {
  person: [[['W', 'S'], 'Walk'], [['A', 'D'], 'Turn'], [['Shift'], 'Sprint'], [['Space'], 'Jump'], [['Drag'], 'Orbit']],
  car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['Shift'], 'Boost'], [['Drag'], 'Orbit']],
  cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn'], [['Shift'], 'Sprint'], [['Drag'], 'Orbit']],
  helicopter: [[['W', 'S'], 'Pitch'], [['A', 'D'], 'Yaw'], [['Space', 'E'], 'Ascend'], [['Q', 'C'], 'Descend'], [['Shift'], 'Boost']]
};
const CATEGORY_ORDER = ['village', 'leisure', 'stay', 'masia', 'hill'];
// Number keys of the cameras: 5 6 7 follow, 8 9 0 the first three vantage points
const CAMERA_KEYS = ['5', '6', '7', '8', '9', '0'];

export async function initTown() {
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
  // WebGPU validation errors are only logged; keep them where checks can read them (window.vallromanes.gpuErrors)
  const gpuErrors = [];
  renderer.backend.device?.addEventListener('uncapturederror', (e) => gpuErrors.push(String(e.error?.message).slice(0, 200)));

  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer);

  setStatus('Loading the terrain, buildings and streets of Vallromanes...');
  const [{ sampler, frame }, boundary, { structures }, roads, featureData, stairData, { props: propData }, labels] = await Promise.all([
    loadTerrain('./data/'), loadBoundary('./data/'), loadBuildings('./data/'), loadRoads('./data/'), loadFeatures('./data/'),
    loadStairs('./data/'), loadProps('./data/'), loadLabels('./data/')
  ]);
  setStatus('Building the town...');
  const terrain = buildTerrain(scene, sampler);
  const buildings = buildBuildings(scene, structures);
  const streets = buildStreets(scene, roads);
  const roadIndex = createRoadIndex(roads, streets.trims);
  const features = buildFeatures(scene, { lines: featureData.lines, water: featureData.water, flights: stairData.flights }, sampler.heightAt, { roadIndex });
  const stairIndex = createStairIndex(stairData.flights);
  const b = sampler.bounds;
  // The terrain under a street is baked ROAD_DEPTH below the street's profile; the asphalt rides LIFT above the profile
  // and the pavement CURB above that, so what stands or drives on them has to sit that much higher
  const groundHeight = (x, z, mode) => {
    const base = sampler.heightAt(x, z);
    if (mode === 'person') {
      const step = stairIndex.heightAt(x, z);
      if (step !== null) return step;
    }
    const hit = roadIndex.query(x, z, 0);
    if (!hit || !hit.kind) return base;
    if (hit.edge.cls === 'track' || hit.edge.cls === 'urbanUnpaved') return base + ROAD_DEPTH + TRACK_LIFT;
    return base + ROAD_DEPTH + LIFT + (hit.kind === 'sidewalk' && mode === 'person' ? CURB : 0);
  };
  const props = buildProps(scene, propData, { ground: sampler.heightAt, surface: (x, z) => groundHeight(x, z, 'car'), roadIndex });
  const world = {
    groundHeight,
    normalAt: sampler.normalAt,
    bounds: { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ },
    confine: (x, z) => confineToRing(boundary.rings[0], x, z, EDGE_MARGIN)
  };

  const controllerManager = new ThirdPersonControllerManager(scene, [...buildings.colliders, ...features.colliders, ...props.colliders]);
  controllerManager.setWorld(world);
  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  cameraSystem.setWorld(world);
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

  // ---- HUD ---------------------------------------------------------------------------------------------------------
  const modeButtons = document.querySelectorAll('[data-mode]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const modeSwitch = document.getElementById('mode-switch');
  // There is no audio yet (phase 7 and later): its button stays hidden
  const soundButton = document.getElementById('btn-sound');
  if (soundButton) soundButton.style.display = 'none';

  function renderControlHints(mode) {
    if (!elControlsHint) return;
    elControlsHint.replaceChildren(...CONTROL_HINTS[mode].map(([keys, action]) => {
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

  // The pill under the selected mode glides from button to button
  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }
  touchControls.onAvailabilityChange = placeModeIndicator;

  function selectMode(mode) {
    controllerManager.setMode(mode);
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-mode') === mode));
    document.body.dataset.mode = mode;
    placeModeIndicator();
    if (elMode) elMode.textContent = controllerManager.getActiveEntity().label;
    renderControlHints(mode);
    // On a scenic camera, a mode change brings the view back to the player
    if (cameraSystem.getActivePreset().category !== 'follow') selectCamera('chase', false);
  }

  let cameraButtons = [];
  function selectCamera(id, snap = false) {
    cameraSystem.setCameraPreset(id, snap);
    cameraButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-camera') === id));
    if (elCamera) elCamera.textContent = cameraSystem.getActivePreset().name;
  }

  function cycleCamera(step) {
    const n = CAMERA_PRESETS.length;
    const idx = CAMERA_PRESETS.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(CAMERA_PRESETS[(idx + step + n) % n].id, true);
  }

  function selectTime(timeId) {
    lightingSystem.applyPreset(timeId);
    colorGrade.applyPreset(lightingSystem.activePresetId);
    timeButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-time') === timeId));
  }

  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => selectMode(MODES[(MODES.indexOf(controllerManager.activeMode) + step + MODES.length) % MODES.length]),
    onCycleCamera: cycleCamera,
    onToggleMap: () => mapSystem.toggleFullMap(!mapSystem.isFullMapOpen),
    onCloseMap: () => mapSystem.toggleFullMap(false)
  });

  // Popovers (native [popover]: light dismiss & Esc for free) open against the control that toggles them: data-anchor
  // names the element they sit above / below, data-align the one whose right edge they line up with
  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => { if (pop.matches(':popover-open')) pop.hidePopover(); });
  }
  popovers.forEach((pop) => {
    const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      if (invoker) invoker.classList.toggle('is-open', open);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });

  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  // The camera list: the follow cameras, then the vantage points of the town
  const cameraList = document.getElementById('camera-list');
  if (cameraList) {
    const nodes = [];
    let section = '';
    CAMERA_PRESETS.forEach((preset, i) => {
      if (preset.category !== section) {
        section = preset.category;
        nodes.push(element('div', 'pop-title', section === 'follow' ? 'Follow' : 'Scenic'));
      }
      const btn = element('button', `pop-item cam-btn${preset.id === 'chase' ? ' active' : ''}`);
      btn.type = 'button';
      btn.dataset.camera = preset.id;
      btn.append(element('span', 'pop-name', preset.name));
      if (CAMERA_KEYS[i]) btn.append(element('kbd', '', CAMERA_KEYS[i]));
      btn.addEventListener('click', () => { selectCamera(preset.id, true); closePopovers(); });
      nodes.push(btn);
    });
    cameraList.replaceChildren(...nodes);
    cameraButtons = [...cameraList.querySelectorAll('[data-camera]')];
  }

  // Where you are, as a place name over a street name plate
  let locationText = '';
  function renderLocation(place, street) {
    const text = `${place}|${street || ''}`;
    if (!elLocation || text === locationText) return;
    locationText = text;
    const nodes = [element('div', 'location-place', place)];
    if (street) {
      const row = element('div', 'location-signs');
      row.append(element('span', 'street-sign', street));
      nodes.push(row);
    }
    elLocation.replaceChildren(...nodes);
  }
  const nearestPlace = (x, z, reach = 160) => {
    let best = null;
    for (const p of labels.places) {
      if (p.kind === 'road' || p.kind === 'water' || p.kind === 'wood' || p.kind === 'plain') continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d <= reach && (!best || d < best.d)) best = { d, name: p.name };
    }
    return best ? best.name : 'Vallromanes';
  };

  function teleportTo(x, z, heading = Math.PI) {
    const destination = controllerManager.teleportActiveTo(x, z, heading);
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    return destination;
  }

  // The teleport list: the destinations of data/labels.json by category
  const teleportList = document.getElementById('teleport-list');
  if (teleportList) {
    const nodes = [];
    for (const category of CATEGORY_ORDER) {
      const items = labels.teleports.filter((t) => t.category === category);
      if (!items.length) continue;
      nodes.push(element('div', 'pop-title', labels.categories[category] || category));
      for (const t of items) {
        const btn = element('button', 'pop-item tp-btn');
        btn.type = 'button';
        btn.dataset.teleport = t.id;
        btn.append(element('span', 'pop-name', t.name), element('span', 'pop-sub', t.sub));
        btn.addEventListener('click', () => {
          const dest = teleportTo(t.x, t.z, t.heading);
          mapSystem.waypoint = { x: dest.x, z: dest.z, name: t.name };
          closePopovers();
        });
        nodes.push(btn);
      }
    }
    teleportList.replaceChildren(...nodes);
  }

  const mapSystem = new TownMapSystem({
    controllerManager,
    data: {
      sampler, frame, boundary, roads, structures, waterBodies: featureData.water,
      streams: featureData.lines.filter((l) => l.kind === 'stream' || l.kind === 'ditch'), labels, roadIndex,
      insideBoundary: (x, z) => pointInRings(x, z, boundary.rings)
    },
    onTeleport: teleportTo,
    onToggle: (open) => {
      controllerManager.resetInput();
      touchControls.setEnabled(!open);
      gamepadControls.setEnabled(!open);
      if (open) closePopovers();
    }
  });
  document.getElementById('btn-open-map')?.addEventListener('click', () => mapSystem.toggleFullMap(true));

  modeButtons.forEach((btn) => btn.addEventListener('click', () => selectMode(btn.getAttribute('data-mode'))));
  timeButtons.forEach((btn) => btn.addEventListener('click', () => selectTime(btn.getAttribute('data-time'))));
  document.getElementById('cam-prev')?.addEventListener('click', () => cycleCamera(-1));
  document.getElementById('cam-next')?.addEventListener('click', () => cycleCamera(1));
  // A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });
  hudToggleBtn?.addEventListener('click', () => {
    document.body.classList.toggle('hud-minimized');
    const isMin = document.body.classList.contains('hud-minimized');
    hudToggleBtn.setAttribute('aria-pressed', String(isMin));
    hudToggleBtn.setAttribute('aria-label', isMin ? 'Show HUD' : 'Hide HUD');
    hudToggleBtn.title = isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]';
    if (isMin) closePopovers();
  });

  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const mode = { Digit1: 'person', Digit2: 'car', Digit3: 'cyclist', Digit4: 'helicopter' }[e.code];
    if (mode) { selectMode(mode); return; }
    const digit = /^Digit(\d)$/.exec(e.code);
    if (digit) {
      const preset = CAMERA_PRESETS[CAMERA_KEYS.indexOf(digit[1])];
      if (preset) selectCamera(preset.id, true);
      return;
    }
    switch (e.code) {
      case 'KeyV': cycleCamera(e.shiftKey ? -1 : 1); break;
      case 'KeyH': hudToggleBtn?.click(); break;
      case 'KeyM': if (!e.repeat) mapSystem.toggleFullMap(!mapSystem.isFullMapOpen); break;
    }
  });
  window.addEventListener('resize', () => {
    cameraSystem.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    placeModeIndicator();
  });

  // ---- starting position: the saved one, or the Ajuntament -----------------------------------------------------------
  for (const mode of MODES) {
    controllerManager.setMode(mode);
    controllerManager.teleportActiveTo(SPAWN.x, SPAWN.z, SPAWN.heading, mode === 'helicopter' ? 100 : null);
  }
  let startMode = 'person';
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (saved?.version === 1) {
      for (const mode of MODES) {
        const p = saved.entities?.[mode];
        if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
        controllerManager.setMode(mode);
        controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y);
      }
      if (MODES.includes(saved.activeMode)) startMode = saved.activeMode;
    }
  } catch { /* Missing or unavailable storage does not prevent playing. */ }
  function savePlayerState() {
    try {
      const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, e]) => [mode, { x: e.position.x, y: e.position.y, z: e.position.z, heading: e.heading }]));
      localStorage.setItem(SAVE_KEY, JSON.stringify({ version: 1, activeMode: controllerManager.activeMode, entities }));
    } catch { /* Storage may be disabled or full. */ }
  }
  window.addEventListener('pagehide', savePlayerState);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });

  selectMode(startMode);
  selectCamera('chase', true);
  selectTime('midday');
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);

  // Handles for the console and for checks of the running page
  window.vallromanes = {
    gpuErrors, THREE, scene, renderer, terrain, buildings, streets, features, props, stairIndex, roadIndex, roads, boundary, sampler,
    labels, mapSystem, controllerManager, cameraSystem, lightingSystem, selectMode, selectCamera, selectTime, teleportTo
  };

  // An empty frame first: it configures the scene pass's render target (MSAA samples, depth format), so the pipelines
  // built for the real frames are the ones the pass asks for
  scene.visible = false;
  renderPipeline.render();
  scene.visible = true;
  // Then compile the materials the way the scene pass will use them (its target and MRT)
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
  let elapsed = 0, frameCount = 0, fpsTimer = 0, framesDrawn = 0, nextSave = 0;
  renderer.setAnimationLoop((now) => {
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    if (!window.innerWidth || !window.innerHeight) return; // the pane is collapsed: a zero-size swap chain is an error
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    elapsed += dt;

    gamepadControls.update(dt);
    controllerManager.update(dt, elapsed);
    cameraSystem.update(dt, elapsed);
    terrain.update(cameraSystem.camera.position);
    props.update(cameraSystem.camera);
    lightingSystem.update(cameraSystem.currentPos);
    mapSystem.update();
    renderPipeline.render();
    if (!document.hidden && now >= nextSave) { savePlayerState(); nextSave = now + 5000; }

    if (++framesDrawn === 2 && loadingOverlay) loadingOverlay.classList.add('hidden');

    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const fps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;
      const ent = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const kmh = Math.round(Math.abs(ent.speed) * 3.6);
      if (elFps) {
        elFps.textContent = String(fps);
        elFps.className = fps >= 50 ? 'fps-ok' : fps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(kmh);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, kmh / (TOP_SPEED_KMH[mode] || 100))})`;
      document.body.classList.toggle('is-boosting', controllerManager.keys.boost && kmh > 0);
      // Altitude as metres above sea level (local y is relative to H0)
      if (elAltitude) elAltitude.textContent = String(Math.round(ent.position.y + frame.H0));
      // The followed player's place, or the camera's on the scenic cameras
      const where = cameraSystem.getActivePreset().category === 'follow' ? ent.position : cameraSystem.currentPos;
      renderLocation(nearestPlace(where.x, where.z), roadIndex.nameAt(where.x, where.z));
    }
  });
}
