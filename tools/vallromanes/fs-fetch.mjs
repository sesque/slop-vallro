// A `fetch` stand-in that reads the baked files in data/ from disk, so the runtime loaders (js/geo/load-geodata.js) can
// be reused by the bake stages and the tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function fsFetch() {
  return async (url) => {
    const file = path.join(root, url.replace(/^\.\//, ''));
    if (!fs.existsSync(file)) return { ok: false, status: 404 };
    const buf = fs.readFileSync(file);
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString()), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  };
}
