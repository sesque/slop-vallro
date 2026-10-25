// WGS84 / ETRS89 longitude, latitude -> the local frame (EPSG:25831, UTM zone 31N; Krueger series, millimetre accuracy). Used for places that
// OpenStreetMap or a map site gives in degrees; the runtime never sees degrees.
import { E0, N0 } from './frame.mjs';

export function lonLatToUtm31(lon, lat) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lon0 = (3 * Math.PI) / 180;
  const n = f / (2 - f);
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180 - lon0;
  const A = (a / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
  const alpha = [n / 2 - (2 * n * n) / 3 + (5 * n ** 3) / 16, (13 * n * n) / 48 - (3 * n ** 3) / 5, (61 * n ** 3) / 240];
  const q = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - q * Math.atanh(q * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  alpha.forEach((al, i) => { const j = i + 1; E += al * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); N += al * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); });
  return [500000 + k0 * A * E, k0 * A * N];
}

/** { x, z } in the local frame of a point given in degrees. */
export function lonLatToLocal(lon, lat) {
  const [e, n] = lonLatToUtm31(lon, lat);
  return { x: e - E0, z: -(n - N0) };
}
