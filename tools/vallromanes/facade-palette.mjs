// Facade palette per building. The Catastro photo of a building (file name = its cadastral reference) was classed by eye into
// a facade colour or material (tools/data/vallromanes/overrides/facade-palette.json: reference -> letter). A building takes its
// own photo's class; one without a usable photo takes the class of the nearest classed building within NEIGHBOUR_M, else 0
// (the old seeded palette). The class is a small integer, PAL: 0 none, then the letters in order.

export const CLASSES = 'wcopt' + 'bgsd'; // white, cream, ochre, pink, terracotta, brick, grey, stone, dark cladding
export const NEIGHBOUR_M = 40;
const CELL = 40;

export const palOf = (letter) => CLASSES.indexOf(letter) + 1; // 0 when unknown

/**
 * items: [{ x, z, ref }] (ref may be null). labels: { ref: letter }. Returns { pal: number[], own, inherited, none }.
 */
export function assignPalette(items, labels) {
  const pal = items.map((it) => (it.ref ? palOf(labels[it.ref]) : 0));
  const cells = new Map();
  items.forEach((it, i) => {
    if (!pal[i]) return;
    const k = `${Math.floor(it.x / CELL)},${Math.floor(it.z / CELL)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });
  const own = pal.filter(Boolean).length;
  let inherited = 0;
  const out = pal.slice();
  items.forEach((it, i) => {
    if (pal[i]) return;
    const ci = Math.floor(it.x / CELL), cj = Math.floor(it.z / CELL);
    let best = -1, bd = NEIGHBOUR_M * NEIGHBOUR_M;
    for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) {
      for (const j of cells.get(`${a},${b}`) || []) {
        const d = (items[j].x - it.x) ** 2 + (items[j].z - it.z) ** 2;
        if (d < bd || (d === bd && j < best)) { bd = d; best = j; }
      }
    }
    if (best >= 0) { out[i] = pal[best]; inherited++; }
  });
  return { pal: out, own, inherited, none: out.filter((p) => !p).length };
}
