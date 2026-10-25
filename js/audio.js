// js/audio.js
// The sound of the town, synthesised in the browser with the Web Audio modules kept from the upstream project (audio-synthesis.js:
// engines and wind, audio-events.js: footsteps, horns, crashes, audio-acoustics.js: how much the buildings shelter a spot). Nothing is
// downloaded. The audio context starts on the first click or key press, as browsers require, and the sound button or `N` mutes it.
//   - the player's own engine (car, bicycle, helicopter), footsteps on foot, wind that grows with speed and height;
//   - the engines of the nearest few traffic cars, panned and softened by distance and by the buildings in the way;
//   - a crash when the player's vehicle hits a wall, a tree or a car.

import { createSynthResources, createMotorVoice } from './audio-synthesis.js';
import { createEventResources, playEvent, createWindVoice } from './audio-events.js';
import { CityAcoustics } from './audio-acoustics.js';

const CAR_VOICES = 4; // traffic engines sounded at once
const HEARING = 90; // m: cars further than this make no sound
const SPEED_OF_SOUND = 343;
const KEY = 'vallromanes-sound';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class TownAudio {
  /**
   * @param {object} o controllerManager, traffic (createTraffic's handle), button (the sound button, or null), isNight() (0..1)
   */
  constructor({ controllerManager, traffic, button = null, night = () => 0 }) {
    this.controllers = controllerManager;
    this.traffic = traffic;
    this.button = button;
    this.night = night;
    this.ctx = null;
    this.wantSound = true;
    try { this.wantSound = localStorage.getItem(KEY) !== 'off'; } catch { /* storage can be blocked */ }
    this.acoustics = new CityAcoustics(controllerManager);
    this.player = { kind: null, voice: null };
    this.cars = new Map(); // car id -> { voice, gain, pan }
    this.stepClock = 0;
    this.stepCount = 0;
    this.heading = 0;
    this.lastCrash = -1;
    this.listener = { x: 0, y: 0, z: 0, vx: 0, vz: 0 };
    this.refreshButton();
    if (button) button.addEventListener('click', () => this.toggle());
    // browsers allow audio only after a gesture
    const unlock = () => { this.start(); };
    for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, unlock, { once: true, capture: true });
    controllerManager.setCollisionListener((e) => this.onCrash(e));
  }

  get muted() { return !this.wantSound; }

  refreshButton() {
    const b = this.button;
    if (!b) return;
    b.style.display = '';
    b.setAttribute('aria-pressed', String(this.wantSound));
    b.title = this.wantSound ? 'Mute sound [N]' : 'Unmute sound [N]';
    b.setAttribute('aria-label', this.wantSound ? 'Mute sound' : 'Unmute sound');
    const use = b.querySelector('use');
    if (use) use.setAttribute('href', this.wantSound ? '#i-sound' : '#i-sound-off');
  }

  toggle() {
    this.wantSound = !this.wantSound;
    try { localStorage.setItem(KEY, this.wantSound ? 'on' : 'off'); } catch { /* ignore */ }
    this.refreshButton();
    if (this.wantSound) this.start();
    if (this.master) this.master.gain.setTargetAtTime(this.wantSound ? 0.8 : 0, this.ctx.currentTime, 0.05);
  }

  /** Creates the audio graph (once) and resumes it. Called from the first user gesture. */
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    const ctx = this.ctx = new Context({ latencyHint: 'interactive' });
    this.master = ctx.createGain();
    this.master.gain.value = this.wantSound ? 0.8 : 0;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 6;
    this.master.connect(limiter).connect(ctx.destination);
    this.resources = createEventResources(ctx, createSynthResources(ctx));
    this.wind = createWindVoice(ctx, this.resources, this.master);
  }

  onCrash(e) {
    if (!this.ctx || !this.wantSound || e.speed < 2) return;
    const now = this.ctx.currentTime;
    if (now - this.lastCrash < 0.25) return;
    this.lastCrash = now;
    playEvent(this.ctx, this.resources, 'crash', this.master, { intensity: clamp(e.speed / 14, 0.15, 1), seed: Math.floor(now * 1000) });
  }

  setPlayerVoice(kind) {
    if (this.player.kind === kind) return;
    if (this.player.voice) this.player.voice.dispose();
    this.player = { kind, voice: kind ? createMotorVoice(this.ctx, this.resources, kind, this.master) : null };
  }

  /** Per frame: `entity` is the active player entity, `mode` its mode, `camera` the view camera (the listener). */
  update(dt, entity, mode, camera) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.wantSound) return;
    const now = ctx.currentTime;
    const l = this.listener;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const m = camera.matrixWorld.elements;
    this.heading = Math.atan2(-m[8], -m[10]); // the camera looks along -z of its own frame
    l.vx = (cx - l.x) / Math.max(dt, 1e-3); l.vz = (cz - l.z) / Math.max(dt, 1e-3);
    l.x = cx; l.y = cy; l.z = cz;
    this.acoustics.update(l, now);

    const speed = Math.abs(entity.speed || 0);
    const kind = mode === 'car' ? 'sedan' : mode === 'cyclist' ? 'cyclist' : mode === 'helicopter' ? 'helicopter' : null;
    this.setPlayerVoice(kind);
    if (this.player.voice) {
      this.player.voice.update({ speed, load: clamp(speed / 30, 0, 1), doppler: 1, seed: 1, verticalSpeed: entity.verticalSpeed || 0 }, now);
    }

    // footsteps, at a cadence that follows the pace
    if (mode === 'person' && speed > 0.4 && (entity.position.y - this.controllers.getGroundHeight(entity.position.x, entity.position.z, 'person')) < 0.4) {
      this.stepClock += dt * (1.3 + speed * 0.38);
      if (this.stepClock >= 1) {
        this.stepClock -= 1;
        playEvent(ctx, this.resources, 'footstep', this.master, { seed: ++this.stepCount, intensity: clamp(0.35 + speed * 0.12, 0.3, 1) });
      }
    } else this.stepClock = 0.7;

    this.updateTraffic(dt, now);
    const near = [...this.cars.values()].filter((c) => c.level > 0.2).length;
    this.wind.update({ speed, altitude: Math.max(0, entity.position.y - this.controllers.getGroundHeight(entity.position.x, entity.position.z, 'person')), night: this.night(), traffic: clamp(near / 3, 0, 1), enclosure: this.acoustics.enclosure }, now);
  }

  updateTraffic(dt, now) {
    const ctx = this.ctx, l = this.listener;
    // the nearest cars within hearing
    const heard = [];
    for (const c of this.traffic.sim.cars) {
      if (!c.active) continue;
      const d = Math.hypot(c.x - l.x, c.z - l.z);
      if (d < HEARING) heard.push([d, c]);
    }
    heard.sort((a, b) => a[0] - b[0]);
    const chosen = new Map(heard.slice(0, CAR_VOICES).map(([d, c]) => [c.id, [d, c]]));
    for (const [id, v] of this.cars) {
      if (!chosen.has(id)) { v.voice.dispose(); v.gain.disconnect(); v.pan.disconnect(); this.cars.delete(id); }
    }
    for (const [id, [d, c]] of chosen) {
      let v = this.cars.get(id);
      if (!v) {
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner();
        gain.connect(pan).connect(this.master);
        v = { voice: createMotorVoice(ctx, this.resources, c.body === 'suv' ? 'suv' : 'sedan', gain), gain, pan, level: 0 };
        this.cars.set(id, v);
      }
      // distance, and the buildings in the way; a car you can see is louder than one behind a house
      const blocked = this.acoustics.obstruction({ x: c.x, y: 1, z: c.z }, { x: l.x, y: l.y, z: l.z });
      const level = Math.pow(1 / (1 + d / 10), 1.3) * (1 - 0.75 * blocked) * 0.9;
      v.level = level;
      v.gain.gain.setTargetAtTime(level, now, 0.1);
      const dx = c.x - l.x, dz = c.z - l.z;
      // right of the listener is (-cos yaw, sin yaw) in this frame (x east, z south)
      v.pan.pan.setTargetAtTime(clamp((-dx * Math.cos(this.heading) + dz * Math.sin(this.heading)) / Math.max(d, 8) * 0.8, -0.9, 0.9), now, 0.1);
      // radial speed gives the doppler shift
      const radial = ((Math.sin(c.yaw) * c.speed - l.vx) * dx + (Math.cos(c.yaw) * c.speed - l.vz) * dz) / Math.max(d, 1);
      v.voice.update({ speed: c.speed, load: clamp(c.acc / 1.6, 0, 1), doppler: clamp(SPEED_OF_SOUND / (SPEED_OF_SOUND + radial), 0.88, 1.12), seed: c.id + 3 }, now);
    }
  }

}
