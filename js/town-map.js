import { createView, fitView, hillshade, layoutLabels, searchEntries, zoomAt } from './geo/map-math.js';

// js/town-map.js
// The 2D map of Vallromanes: a hillshaded relief under the buildings, streets, water and labels, as a small radar-style
// minimap and as a full-screen atlas that pans, zooms, searches and teleports. North is up.

const CELL = 256; // m, the size of one cached vector tile
const RELIEF_CELL = 8; // m per pixel of the relief image
const MINIMAP_METRES = 340; // the minimap shows this many metres across
const FULL_MIN_SCALE = 0.08;
const FULL_MAX_SCALE = 6;
const COLORS = {
  building: '#b9aa97', buildingEdge: 'rgba(80,66,52,0.65)', road: '#f6f1e6', roadCasing: '#8d8372', track: 'rgba(110,84,52,0.85)',
  pavement: 'rgba(238,232,220,0.8)', water: '#8cc6e0', stream: '#5e9fc4', boundary: 'rgba(160,45,35,0.85)', player: '#ffc83d', waypoint: '#e63a3a',
  text: '#2b2418', halo: 'rgba(250,247,240,0.92)'
};
const PLACE_STYLE = {
  settlement: { px: 15, minScale: 0, priority: 100, weight: '700' }, masia: { px: 11, minScale: 0.32, priority: 40, weight: '600' },
  hill: { px: 11, minScale: 0.26, priority: 60, weight: '600' }, pass: { px: 10, minScale: 0.3, priority: 50, weight: '600' },
  wood: { px: 10, minScale: 0.3, priority: 30, weight: '500' }, plain: { px: 10, minScale: 0.3, priority: 30, weight: '500' },
  place: { px: 10, minScale: 0.3, priority: 30, weight: '500' }, water: { px: 10, minScale: 0.4, priority: 45, weight: '500' },
  facility: { px: 10, minScale: 0.6, priority: 55, weight: '600' }, business: { px: 10, minScale: 0.8, priority: 25, weight: '500' },
  road: { px: 10, minScale: 0.5, priority: 35, weight: '600' }
};

function tileKey(x, z) {
  return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
}

function ringPath(path, ring) {
  path.moveTo(ring[0], ring[1]);
  for (let i = 2; i < ring.length; i += 2) path.lineTo(ring[i], ring[i + 1]);
  path.closePath();
}

// Vector layers as Path2D per 256 m tile in world metres, drawn with the view's transform applied to the context
function buildLayers({ structures, roads, waterBodies, streams }) {
  const tiles = new Map();
  const tile = (x, z) => {
    const key = tileKey(x, z);
    let t = tiles.get(key);
    if (!t) tiles.set(key, (t = { buildings: new Path2D(), roads: new Path2D(), main: new Path2D(), tracks: new Path2D(), water: new Path2D(), streams: new Path2D(), pavements: new Path2D() }));
    return t;
  };
  for (const s of structures) {
    if (s.open) continue;
    const t = tile(s.rings[0][0], s.rings[0][1]);
    for (const ring of s.rings) ringPath(t.buildings, ring);
  }
  for (const e of roads.edges) {
    const t = tile(e.pts[0][0], e.pts[0][1]);
    const path = e.cls === 'track' ? t.tracks : e.cls === 'road' ? t.main : t.roads;
    path.moveTo(e.pts[0][0], e.pts[0][1]);
    for (let i = 1; i < e.pts.length; i++) path.lineTo(e.pts[i][0], e.pts[i][1]);
  }
  for (const w of waterBodies) ringPath(tile(w.outer[0], w.outer[1]).water, w.outer);
  for (const l of streams) {
    const t = tile(l.pts[0][0], l.pts[0][1]);
    t.streams.moveTo(l.pts[0][0], l.pts[0][1]);
    for (let i = 1; i < l.pts.length; i++) t.streams.lineTo(l.pts[i][0], l.pts[i][1]);
  }
  return tiles;
}

class TownMapSystem {
  /**
   * `data`: { sampler, frame, boundary, roads, structures, waterBodies, streams, labels, roadIndex }.
   * onTeleport(x, z, heading) moves the active player; onToggle(open) lets the app pause its own input.
   */
  constructor({ controllerManager, data, onTeleport, onToggle }) {
    this.controller = controllerManager;
    this.data = data;
    this.onTeleport = onTeleport;
    this.onToggle = onToggle;
    this.waypoint = null;
    this.isFullMapOpen = false;
    this.dirty = true;

    this.minimap = document.getElementById('minimap-canvas');
    this.minimapCard = document.getElementById('minimap-card');
    this.modal = document.getElementById('fullmap-modal');
    this.canvas = document.getElementById('fullmap-canvas');
    this.wrap = document.getElementById('fullmap-canvas-wrap');
    this.search = document.getElementById('fullmap-search');
    this.hover = document.getElementById('fullmap-hover-info');
    this.playerInfo = document.getElementById('fullmap-player-info');
    this.counts = document.getElementById('fullmap-counts');
    this.needle = document.getElementById('map-compass-needle');

    this.bounds = this.boundaryBounds();
    this.tiles = buildLayers(data);
    this.relief = this.buildRelief();
    this.view = null;
    this.size = { w: 800, h: 600 };
    this.results = [];
    this.entries = [
      ...data.labels.teleports.map((t) => ({ name: t.name, kind: 'teleport', x: t.x, z: t.z, sub: t.sub, heading: t.heading })),
      ...data.labels.places.filter((p) => p.kind !== 'road').map((p) => ({ name: p.name, kind: p.kind, x: p.x, z: p.z })),
      ...data.labels.streets.filter((s) => s.major || true).map((s) => ({ name: s.name, kind: 'street', x: s.x, z: s.z }))
    ];
    if (this.counts) this.counts.textContent = `${data.structures.filter((s) => !s.open).length} buildings · ${new Set(data.labels.streets.map((s) => s.name)).size} streets · ${data.labels.teleports.length} destinations`;
    this.initEvents();
    this.resizeMinimap();
  }

  boundaryBounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const ring of this.data.boundary.rings) for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]); minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1]);
    }
    return { minX, maxX, minZ, maxZ };
  }

  // The relief of the whole terrain once, as an image: 8 m per pixel
  buildRelief() {
    const b = this.data.sampler.bounds;
    const w = Math.ceil((b.maxX - b.minX) / RELIEF_CELL), h = Math.ceil((b.maxZ - b.minZ) / RELIEF_CELL);
    const heights = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) heights[j * w + i] = this.data.sampler.heightAt(b.minX + (i + 0.5) * RELIEF_CELL, b.minZ + (j + 0.5) * RELIEF_CELL);
    const pixels = hillshade(heights, w, h, RELIEF_CELL, { lowH: 10, highH: 360 });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
    return { canvas, minX: b.minX, minZ: b.minZ, maxX: b.minX + w * RELIEF_CELL, maxZ: b.minZ + h * RELIEF_CELL };
  }

  insideMunicipality(x, z) {
    return this.data.insideBoundary ? this.data.insideBoundary(x, z) : true;
  }

  // ---- events ----------------------------------------------------------------------------------------------------

  initEvents() {
    this.minimapCard?.addEventListener('click', () => this.toggleFullMap(true));
    document.getElementById('close-fullmap-btn')?.addEventListener('click', () => this.toggleFullMap(false));
    document.getElementById('map-zoom-in')?.addEventListener('click', () => this.zoomBy(1.5));
    document.getElementById('map-zoom-out')?.addEventListener('click', () => this.zoomBy(1 / 1.5));
    document.getElementById('map-center-player')?.addEventListener('click', () => this.centerOnPlayer());
    document.getElementById('map-view-all')?.addEventListener('click', () => this.viewAll());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.isFullMapOpen) this.toggleFullMap(false);
    });
    window.addEventListener('resize', () => { this.resizeMinimap(); if (this.isFullMapOpen) { this.resizeFullCanvas(); this.dirty = true; } });

    const canvas = this.canvas;
    if (!canvas) return;
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cz: this.view.cz, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.view = createView(drag.cx - dx / this.view.scale, drag.cz - dy / this.view.scale, this.view.scale, this.view.width, this.view.height);
          this.dirty = true;
        }
      }
      this.describe(this.view.worldX(sx), this.view.worldZ(sy));
    });
    canvas.addEventListener('pointerup', (e) => {
      const moved = drag?.moved;
      drag = null;
      if (moved) return;
      const r = canvas.getBoundingClientRect();
      this.teleportTo(this.view.worldX(e.clientX - r.left), this.view.worldZ(e.clientY - r.top));
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      this.view = zoomAt(this.view, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, FULL_MIN_SCALE, FULL_MAX_SCALE);
      this.dirty = true;
    }, { passive: false });
    this.search?.addEventListener('input', () => { this.results = searchEntries(this.search.value, this.entries); this.showResults(); });
    this.search?.addEventListener('keydown', (e) => {
      if (e.code === 'Enter' && this.results.length) { this.goTo(this.results[0]); e.preventDefault(); }
      e.stopPropagation(); // typing in the box must not drive the player or toggle the map
    });
  }

  showResults() {
    if (!this.hover) return;
    this.hover.textContent = this.results.length ? `${this.results.map((r) => r.name).slice(0, 5).join(' · ')}  —  Enter to go to ${this.results[0].name}` : (this.search.value ? 'No match' : '');
  }

  goTo(entry) {
    this.view = createView(entry.x, entry.z, Math.max(this.view.scale, 0.9), this.view.width, this.view.height);
    this.waypoint = { x: entry.x, z: entry.z, name: entry.name };
    this.dirty = true;
    if (this.hover) this.hover.textContent = `${entry.name}${entry.sub ? ` · ${entry.sub}` : ''} — click the map to teleport there`;
  }

  describe(x, z) {
    if (!this.hover || this.search === document.activeElement) return;
    const h = this.data.sampler.heightAt(x, z) + this.data.frame.H0;
    const where = this.insideMunicipality(x, z) ? (this.data.roadIndex.nameAt(x, z, 14) || this.nearestPlace(x, z, 120)) : 'outside Vallromanes';
    this.hover.textContent = `${where ? `${where} · ` : ''}${Math.round(h)} m · click to teleport, drag to pan, scroll to zoom`;
  }

  nearestPlace(x, z, reach) {
    let best = null;
    for (const p of this.data.labels.places) {
      if (p.kind === 'road') continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d <= reach && (!best || d < best.d)) best = { d, name: p.name };
    }
    return best ? best.name : null;
  }

  teleportTo(x, z, heading = Math.PI) {
    if (!this.insideMunicipality(x, z)) return;
    const name = this.data.roadIndex.nameAt(x, z, 14) || this.nearestPlace(x, z, 120) || 'Vallromanes';
    const dest = this.onTeleport?.(x, z, heading);
    this.waypoint = { x: dest?.x ?? x, z: dest?.z ?? z, name };
    this.dirty = true;
    this.toggleFullMap(false);
  }

  toggleFullMap(open) {
    if (open === this.isFullMapOpen) return;
    this.isFullMapOpen = open;
    this.modal?.classList.toggle('hidden', !open);
    if (open) {
      this.resizeFullCanvas();
      const p = this.controller.getActiveEntity().position;
      this.view = createView(p.x, p.z, 0.5, this.size.w, this.size.h);
      this.viewAll();
      this.search?.blur();
    }
    this.onToggle?.(open);
  }

  resizeMinimap() {
    if (!this.minimap) return;
    const r = this.minimap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.minimap.width = Math.max(1, Math.round(r.width * dpr));
    this.minimap.height = Math.max(1, Math.round(r.height * dpr));
  }

  resizeFullCanvas() {
    if (!this.canvas || !this.wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.wrap.clientWidth || window.innerWidth, h = this.wrap.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    this.size = { w, h };
    if (this.view) this.view = createView(this.view.cx, this.view.cz, this.view.scale, w, h);
  }

  zoomBy(f) {
    this.view = zoomAt(this.view, f, this.view.width / 2, this.view.height / 2, FULL_MIN_SCALE, FULL_MAX_SCALE);
    this.dirty = true;
  }

  centerOnPlayer() {
    const p = this.controller.getActiveEntity().position;
    this.view = createView(p.x, p.z, Math.max(this.view.scale, 1.1), this.view.width, this.view.height);
    this.dirty = true;
  }

  viewAll() {
    this.view = fitView(this.bounds, this.view.width, this.view.height);
    this.dirty = true;
  }

  // ---- drawing ---------------------------------------------------------------------------------------------------

  drawWorld(ctx, v, { minimap = false } = {}) {
    const r = this.relief;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(r.canvas, v.toX(r.minX), v.toY(r.minZ), (r.maxX - r.minX) * v.scale, (r.maxZ - r.minZ) * v.scale);
    ctx.save();
    ctx.transform(v.scale, 0, 0, v.scale, v.toX(0), v.toY(0)); // world metres (on top of the device pixel ratio); pixel sizes are divided by the scale
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const px = 1 / v.scale;
    const x0 = Math.floor(v.worldX(-40) / CELL), x1 = Math.floor(v.worldX(v.width + 40) / CELL);
    const z0 = Math.floor(v.worldZ(-40) / CELL), z1 = Math.floor(v.worldZ(v.height + 40) / CELL);
    const visible = [];
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const t = this.tiles.get(`${i},${j}`); if (t) visible.push(t); }
    ctx.fillStyle = COLORS.water; ctx.strokeStyle = COLORS.stream;
    for (const t of visible) { ctx.fill(t.water); ctx.lineWidth = Math.max(1.5 * px, 1.4); ctx.stroke(t.streams); }
    ctx.strokeStyle = COLORS.track; ctx.lineWidth = Math.max(1.1 * px, 1.4); ctx.setLineDash([3 * px * 2, 2 * px * 2]);
    for (const t of visible) ctx.stroke(t.tracks);
    ctx.setLineDash([]);
    const roadW = Math.max(1.8 * px, 6.2); // metres: a street is 6 m wide, never thinner than 1.8 px
    for (const [color, extra] of [[COLORS.roadCasing, 2 * px], [COLORS.road, 0]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = roadW + extra;
      for (const t of visible) ctx.stroke(t.roads);
      ctx.lineWidth = Math.max(2.4 * px, 8) + extra;
      for (const t of visible) ctx.stroke(t.main);
    }
    ctx.fillStyle = COLORS.building; ctx.strokeStyle = COLORS.buildingEdge; ctx.lineWidth = px * 0.8;
    for (const t of visible) { ctx.fill(t.buildings, 'evenodd'); if (v.scale > 0.45) ctx.stroke(t.buildings); }
    ctx.strokeStyle = COLORS.boundary; ctx.lineWidth = Math.max(2 * px, 2); ctx.setLineDash([10 * px * 1.6, 6 * px * 1.6]);
    for (const ring of this.data.boundary.rings) { ctx.beginPath(); ctx.moveTo(ring[0], ring[1]); for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]); ctx.closePath(); ctx.stroke(); }
    ctx.restore();
  }

  drawArrow(ctx, x, y, heading, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI - heading);
    ctx.beginPath();
    ctx.moveTo(0, -size); ctx.lineTo(size * 0.72, size * 0.8); ctx.lineTo(0, size * 0.4); ctx.lineTo(-size * 0.72, size * 0.8); ctx.closePath();
    ctx.fillStyle = COLORS.player; ctx.strokeStyle = '#3a2a05'; ctx.lineWidth = Math.max(1, size * 0.14);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawPin(ctx, x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x, y - r * 1.4, r, Math.PI * 0.85, Math.PI * 0.15, false);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.5;
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y - r * 1.4, r * 0.38, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  }

  label(ctx, text, x, y, px, { weight = '600', angle = 0, color = COLORS.text } = {}) {
    ctx.save();
    ctx.translate(x, y);
    if (angle) ctx.rotate(angle);
    ctx.font = `${weight} ${px}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.2; ctx.strokeStyle = COLORS.halo; ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  drawLabels(ctx, v) {
    const items = [];
    const view = (x, z) => [v.toX(x), v.toY(z)];
    const inView = (sx, sy) => sx > -40 && sy > -20 && sx < v.width + 40 && sy < v.height + 20;
    for (const p of this.data.labels.places) {
      const st = PLACE_STYLE[p.kind] || PLACE_STYLE.place;
      if (v.scale < st.minScale) continue;
      const [sx, sy] = view(p.x, p.z);
      if (inView(sx, sy)) items.push({ text: p.name, x: sx, y: sy, priority: st.priority, px: st.px, weight: st.weight, kind: p.kind });
    }
    for (const s of this.data.labels.streets) {
      if (v.scale < (s.major ? 0.3 : 0.65)) continue;
      const [sx, sy] = view(s.x, s.z);
      if (inView(sx, sy)) items.push({ text: s.name, x: sx, y: sy, priority: s.major ? 48 : 20, px: 10, weight: '500', angle: s.angle, kind: 'street' });
    }
    if (v.scale > 2.2) {
      for (const n of this.data.labels.numbers) {
        const [sx, sy] = view(n.x, n.z);
        if (inView(sx, sy)) items.push({ text: n.text, x: sx, y: sy, priority: 5, px: 9, weight: '500', kind: 'number' });
      }
    }
    const measure = (t) => ctx.measureText(t).width;
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    for (const it of layoutLabels(items, (t) => measure(t) * 1.02, { fontPx: 11, pad: 2, max: 500 })) {
      this.label(ctx, it.text, it.x, it.y, it.px, { weight: it.weight, angle: it.angle || 0, color: it.kind === 'water' ? '#1d5f86' : it.kind === 'street' ? '#4a3f2e' : COLORS.text });
    }
  }

  renderFullMap() {
    const ctx = this.canvas?.getContext('2d');
    if (!ctx || !this.view) return;
    const dpr = this.dpr || 1;
    const v = this.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#8f8a7c';
    ctx.fillRect(0, 0, v.width, v.height);
    this.drawWorld(ctx, v);
    this.drawLabels(ctx, v);
    for (const t of this.data.labels.teleports) {
      const sx = v.toX(t.x), sy = v.toY(t.z);
      if (sx > -10 && sy > -10 && sx < v.width + 10 && sy < v.height + 10) this.drawPin(ctx, sx, sy, 6, '#2f7fd1');
    }
    if (this.waypoint) {
      const sx = v.toX(this.waypoint.x), sy = v.toY(this.waypoint.z);
      this.drawPin(ctx, sx, sy, 8, COLORS.waypoint);
      this.label(ctx, this.waypoint.name, sx, sy - 34, 12, { weight: '700', color: '#7a1515' });
    }
    const p = this.controller.getActiveEntity();
    this.drawArrow(ctx, v.toX(p.position.x), v.toY(p.position.z), p.heading, 11);
    this.drawScaleBar(ctx, v);
    this.dirty = false;
  }

  drawScaleBar(ctx, v) {
    const steps = [10, 20, 50, 100, 200, 500, 1000, 2000];
    const metres = steps.find((m) => m * v.scale >= 70) || 2000;
    const w = metres * v.scale, x = 24, y = v.height - 24;
    ctx.save();
    ctx.lineWidth = 4; ctx.strokeStyle = COLORS.halo; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = '#2b2418'; ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y - 4); ctx.stroke();
    this.label(ctx, metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, x + w / 2, y - 12, 11, { weight: '700' });
    ctx.restore();
  }

  renderMinimap() {
    const canvas = this.minimap;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    const p = this.controller.getActiveEntity();
    const v = createView(p.position.x, p.position.z, Math.min(w, h) / MINIMAP_METRES, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#8f8a7c';
    ctx.fillRect(0, 0, w, h);
    this.drawWorld(ctx, v, { minimap: true });
    if (this.waypoint) {
      const sx = v.toX(this.waypoint.x), sy = v.toY(this.waypoint.z);
      if (sx > 0 && sy > 0 && sx < w && sy < h) this.drawPin(ctx, sx, sy, w * 0.04, COLORS.waypoint);
    }
    this.drawArrow(ctx, w / 2, h / 2, p.heading, w * 0.055);
  }

  update() {
    this.renderMinimap();
    if (this.isFullMapOpen) {
      const p = this.controller.getActiveEntity();
      if (this.playerInfo) {
        const x = p.position.x, z = p.position.z;
        const where = this.data.roadIndex.nameAt(x, z, 14) || this.nearestPlace(x, z, 150) || 'Vallromanes';
        this.playerInfo.textContent = `You are at ${where} · ${Math.round(p.position.y + this.data.frame.H0)} m`;
      }
      if (this.dirty || this._lastX !== p.position.x || this._lastZ !== p.position.z || this._lastH !== p.heading) {
        this._lastX = p.position.x; this._lastZ = p.position.z; this._lastH = p.heading;
        this.renderFullMap();
      }
    }
  }
}

export { TownMapSystem };
