// js/geo/map-math.js
// The pure parts of the town map: the view transform, a hillshaded elevation image, accent-blind search and a greedy
// label layout. No DOM or canvas here, so it runs under Node for tests.

/** A north-up view: world x grows to the right, world z (south) grows downwards on the screen. `scale` is pixels per metre. */
export function createView(cx, cz, scale, width, height) {
  return {
    cx, cz, scale, width, height,
    toX: (x) => (x - cx) * scale + width / 2,
    toY: (z) => (z - cz) * scale + height / 2,
    worldX: (sx) => (sx - width / 2) / scale + cx,
    worldZ: (sy) => (sy - height / 2) / scale + cz,
    sees(minX, minZ, maxX, maxZ, pad = 0) {
      const hw = (width / 2 + pad) / scale, hh = (height / 2 + pad) / scale;
      return maxX >= cx - hw && minX <= cx + hw && maxZ >= cz - hh && minZ <= cz + hh;
    }
  };
}

/** The view that shows `bbox` ({ minX, maxX, minZ, maxZ }) as large as possible inside width x height, with a margin. */
export function fitView(bbox, width, height, margin = 0.94) {
  const scale = Math.min(width / (bbox.maxX - bbox.minX), height / (bbox.maxZ - bbox.minZ)) * margin;
  return createView((bbox.minX + bbox.maxX) / 2, (bbox.minZ + bbox.maxZ) / 2, scale, width, height);
}

/** Zooms about the screen point (sx, sy), keeping the world point under it fixed; the scale stays within [min, max]. */
export function zoomAt(view, factor, sx, sy, min, max) {
  const scale = Math.min(max, Math.max(min, view.scale * factor));
  const wx = view.worldX(sx), wz = view.worldZ(sy);
  return createView(wx - (sx - view.width / 2) / scale, wz - (sy - view.height / 2) / scale, scale, view.width, view.height);
}

/** Lower-case, accent-free text, for searching "Plaça" with "placa" and "Sauló" with "saulo". */
export function normalizeText(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Entries { name, ... } matching `query`, best first: names that start with it, then words that start with it, then
 * names that contain it. Ties keep the order of `entries`; names are listed once.
 */
export function searchEntries(query, entries, limit = 8) {
  const q = normalizeText(query);
  if (!q) return [];
  const scored = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    const n = normalizeText(e.name);
    let rank = -1;
    if (n.startsWith(q)) rank = 0;
    else if (n.split(/[\s'’-]+/).some((w) => w.startsWith(q))) rank = 1;
    else if (n.includes(q)) rank = 2;
    if (rank < 0 || seen.has(`${n}:${e.kind || ''}`)) return;
    seen.add(`${n}:${e.kind || ''}`);
    scored.push({ rank, i, e });
  });
  scored.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.e);
}

/**
 * Greedy label placement: items { text, x, y (screen), priority, angle? } are tried by descending priority and kept when
 * their box overlaps no kept one. `measure(text)` gives the text width in pixels; the box is padded by `pad`.
 */
export function layoutLabels(items, measure, { fontPx = 11, pad = 3, max = 400 } = {}) {
  const kept = [];
  const boxes = [];
  const sorted = [...items].sort((a, b) => b.priority - a.priority);
  for (const it of sorted) {
    if (kept.length >= max) break;
    const w = measure(it.text) + pad * 2, h = fontPx + pad * 2;
    // the axis-aligned box around a rotated label
    const c = Math.abs(Math.cos(it.angle || 0)), s = Math.abs(Math.sin(it.angle || 0));
    const bw = w * c + h * s, bh = w * s + h * c;
    const box = [it.x - bw / 2, it.y - bh / 2, it.x + bw / 2, it.y + bh / 2];
    if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    boxes.push(box);
    kept.push(it);
  }
  return kept;
}

/**
 * A hillshaded, elevation-tinted RGBA image of a height grid (`heights[j * width + i]` in metres, `cell` metres apart).
 * Light comes from the north-west; `lowH` and `highH` set the tint ramp. Row 0 is the northern edge when `northUp`
 * is set (the local z axis points south, so a grid with z growing with j is already north-up).
 */
export function hillshade(heights, width, height, cell, { lowH = 0, highH = 430, azimuth = 315, altitude = 42, exaggeration = 1.6 } = {}) {
  const out = new Uint8ClampedArray(width * height * 4);
  const az = ((360 - azimuth + 90) * Math.PI) / 180, alt = (altitude * Math.PI) / 180;
  const lx = Math.cos(alt) * Math.cos(az), lz = -Math.cos(alt) * Math.sin(az), ly = Math.sin(alt);
  const at = (i, j) => heights[Math.min(height - 1, Math.max(0, j)) * width + Math.min(width - 1, Math.max(0, i))];
  // low ground olive-green, mid ground straw, high ground grey-ochre
  const ramp = [[0, [118, 138, 84]], [0.45, [178, 170, 112]], [0.8, [196, 178, 140]], [1, [214, 206, 188]]];
  const tint = (t) => {
    for (let k = 1; k < ramp.length; k++) {
      if (t <= ramp[k][0]) {
        const f = (t - ramp[k - 1][0]) / (ramp[k][0] - ramp[k - 1][0]);
        return ramp[k - 1][1].map((v, c) => v + (ramp[k][1][c] - v) * f);
      }
    }
    return ramp[ramp.length - 1][1];
  };
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const dx = ((at(i + 1, j) - at(i - 1, j)) / (2 * cell)) * exaggeration;
      const dz = ((at(i, j + 1) - at(i, j - 1)) / (2 * cell)) * exaggeration;
      const nl = Math.hypot(dx, 1, dz);
      const lambert = Math.max(0, (-dx * lx + ly - dz * lz) / nl);
      const shade = 0.55 + 0.75 * lambert; // 1.0 on the flat under this light
      const t = Math.min(1, Math.max(0, (at(i, j) - lowH) / (highH - lowH)));
      const [r, g, b] = tint(t);
      const k = (j * width + i) * 4;
      out[k] = r * shade; out[k + 1] = g * shade; out[k + 2] = b * shade; out[k + 3] = 255;
    }
  }
  return out;
}
