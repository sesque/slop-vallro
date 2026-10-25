// js/world/sign-geometry.js
// The fascia signs of the shops as one triangle soup (positions, normals, uvs, indices), with no three.js, so it runs under Node. Every sign is a flat
// box that hangs on a wall: `shop` = { x, y, z (the middle of its bottom edge on the wall), nx, nz (the wall's outward normal), width, height }.
// The front face reads a cell of a text atlas (`cells` = columns of the atlas; cell k is at column k % cells, row floor(k / cells)); the other five
// faces read one pixel inside the same cell, which the atlas paints in the sign's background colour.

export const SIGN_DEPTH = 0.14;
export const CELL_W = 512;
export const CELL_H = 64;

/** The atlas size in pixels for `count` signs in `columns` columns. */
export function atlasSize(count, columns = 4) {
  return { width: CELL_W * columns, height: CELL_H * Math.max(1, Math.ceil(count / columns)) };
}

/** The uv rectangle of cell `k`: { u0, v0, u1, v1 } with v up (the first row is at the top of the image). */
export function cellUv(k, count, columns = 4) {
  const { width, height } = atlasSize(count, columns);
  const col = k % columns, row = Math.floor(k / columns);
  const half = 0.5; // half a pixel in, so that the text does not bleed from the next cell
  return { u0: (col * CELL_W + half) / width, u1: ((col + 1) * CELL_W - half) / width, v1: 1 - (row * CELL_H + half) / height, v0: 1 - ((row + 1) * CELL_H - half) / height, edgeU: (col * CELL_W + 2) / width, edgeV: 1 - (row * CELL_H + 2) / height };
}

export function buildSignGeometry(shops, columns = 4) {
  const position = [], normal = [], uv = [], index = [];
  const quad = (a, b, c, d, n, uvs) => {
    const base = position.length / 3;
    for (const p of [a, b, c, d]) position.push(p[0], p[1], p[2]);
    for (let i = 0; i < 4; i++) normal.push(n[0], n[1], n[2]);
    for (const t of uvs) uv.push(t[0], t[1]);
    // wind so that the face looks along its normal: flip when the triangle's own normal disagrees
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] >= 0) index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else index.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  shops.forEach((s, k) => {
    const c = cellUv(k, shops.length, columns);
    // along the wall, towards the right hand of someone who faces the wall from outside (x east, z south): (nz, -nx)
    const tx = s.nz, tz = -s.nx;
    const hw = s.width / 2, d = SIGN_DEPTH;
    const P = (along, out, y) => [s.x + tx * along + s.nx * out, y, s.z + tz * along + s.nz * out];
    const y0 = s.y, y1 = s.y + s.height;
    const solid = [[c.edgeU, c.edgeV], [c.edgeU, c.edgeV], [c.edgeU, c.edgeV], [c.edgeU, c.edgeV]];
    // front (outward), reading the text from the viewer's left (-along) to the right (+along)
    quad(P(-hw, d, y0), P(hw, d, y0), P(hw, d, y1), P(-hw, d, y1), [s.nx, 0, s.nz], [[c.u0, c.v0], [c.u1, c.v0], [c.u1, c.v1], [c.u0, c.v1]]);
    quad(P(hw, 0, y0), P(-hw, 0, y0), P(-hw, 0, y1), P(hw, 0, y1), [-s.nx, 0, -s.nz], solid); // back, against the wall
    quad(P(-hw, 0, y1), P(hw, 0, y1), P(hw, d, y1), P(-hw, d, y1), [0, 1, 0], solid); // top
    quad(P(-hw, d, y0), P(hw, d, y0), P(hw, 0, y0), P(-hw, 0, y0), [0, -1, 0], solid); // bottom
    quad(P(-hw, 0, y0), P(-hw, d, y0), P(-hw, d, y1), P(-hw, 0, y1), [-tx, 0, -tz], solid); // left end
    quad(P(hw, d, y0), P(hw, 0, y0), P(hw, 0, y1), P(hw, d, y1), [tx, 0, tz], solid); // right end
  });
  return { position: Float32Array.from(position), normal: Float32Array.from(normal), uv: Float32Array.from(uv), index: Uint32Array.from(index) };
}
