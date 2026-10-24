// Downloads the ICGC LiDAR terrain (DTM) or surface (DSM) model (CC BY 4.0) for the municipality plus a margin,
// reading only the needed window of the Catalonia-wide Cloud Optimized GeoTIFF through HTTP range requests.
//   node tools/vallromanes/fetch-icgc-dtm.mjs [--product dtm|dsm] [--level 1] [--margin 200] [--out <dir>]
// DTM levels: 0 = 0.5 m, 1 = 1 m, 2 = 2 m, 3 = 4 m. DSM level 0 is 1 m (2021-2023 LiDAR), then 2 m, 4 m ...
// Writes <product>-<res>m.f32 (little-endian float32, row-major, north row first, nodata -9999) and a .json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fromUrl } from 'geotiff';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RAW = path.join(root, 'tools/data/vallromanes/raw');
const DATACLOUD = 'https://datacloud.icgc.cat/datacloud';
export const PRODUCTS = {
  dtm: { url: `${DATACLOUD}/model-elevacions-terreny/tif_unzip/model-elevacions-terreny-lidar-catalunya-50cm-2021-2023.tif`, baseRes: 0.5, title: 'Model d\'elevacions del terreny LiDAR Catalunya 50 cm 2021-2023' },
  dsm: { url: `${DATACLOUD}/model-superficies/tif_unzip/model-superficies-lidar-catalunya-1m-2021-2023.tif`, baseRes: 1, title: 'Model de superfícies LiDAR Catalunya 1 m 2021-2023' }
};
export const NODATA = -9999;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

// Pixel window (in the chosen level) covering bbox + margin. Overview levels carry no georeferencing, so the
// origin comes from level 0 and the resolution from the width ratio.
export function windowFor(bbox, margin, origin, res) {
  const x0 = Math.floor((bbox.minE - margin - origin[0]) / res);
  const x1 = Math.ceil((bbox.maxE + margin - origin[0]) / res);
  const y0 = Math.floor((origin[1] - (bbox.maxN + margin)) / res);
  const y1 = Math.ceil((origin[1] - (bbox.minN - margin)) / res);
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

async function main() {
  const product = arg('--product', 'dtm');
  if (!PRODUCTS[product]) throw new Error(`Unknown product "${product}" (dtm or dsm)`);
  const { url, baseRes, title } = PRODUCTS[product];
  const level = Number(arg('--level', '1'));
  const margin = Number(arg('--margin', '200'));
  const outDir = path.resolve(arg('--out', path.join(RAW, 'icgc/dtm')));
  const boundary = JSON.parse(fs.readFileSync(path.join(RAW, 'boundary/vallromanes-boundary.json'), 'utf8'));

  const tiff = await fromUrl(url, { allowFullFile: false });
  const base = await tiff.getImage(0);
  const img = await tiff.getImage(level);
  const origin = base.getOrigin();
  const res = (baseRes * base.getWidth()) / img.getWidth();
  const w = windowFor(boundary.bboxUtm, margin, origin, res);
  if (w.x0 < 0 || w.y0 < 0 || w.x1 > img.getWidth() || w.y1 > img.getHeight()) throw new Error('Window outside the raster');
  console.log(`level ${level}: ${res} m/px, window ${w.width} × ${w.height} px (${(w.width * res).toFixed(0)} × ${(w.height * res).toFixed(0)} m)`);

  const t0 = Date.now();
  const [band] = await img.readRasters({ window: [w.x0, w.y0, w.x1, w.y1], samples: [0], interleave: false });
  console.log(`read in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  let valid = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    if (Number.isNaN(v)) throw new Error('NaN in DTM');
    if (v === NODATA) continue;
    valid++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!valid) throw new Error('Window is empty (all nodata)');

  const meta = {
    source: `ICGC ${title} (CC BY 4.0)`,
    product, url, level, crs: 'EPSG:25831', res, nodata: NODATA,
    width: w.width, height: w.height,
    originE: origin[0] + w.x0 * res, originN: origin[1] - w.y0 * res, // north-west corner of the window
    margin, valid, nodataCount: band.length - valid, minH: min, maxH: max
  };
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.join(outDir, `${product}-${res}m`);
  fs.writeFileSync(stem + '.f32', Buffer.from(new Float32Array(band).buffer));
  fs.writeFileSync(stem + '.json', JSON.stringify(meta, null, 2));
  console.log(`valid ${valid} / ${band.length} samples (${meta.nodataCount} nodata), height ${min.toFixed(2)} → ${max.toFixed(2)} m`);
  console.log(`written ${stem}.f32 (${(band.length * 4 / 1e6).toFixed(0)} MB) and .json`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(`fetch-icgc-dtm failed: ${err.message}`); process.exit(1); });
}
