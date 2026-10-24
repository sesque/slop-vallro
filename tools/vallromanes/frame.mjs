// Local world frame for Vallromanes (spec §2). Source CRS is EPSG:25831 (ETRS89 / UTM 31N), metres.
//   x = E - E0   (east is +x)
//   z = -(N - N0) (north is -z, the three.js and upstream convention)
//   y = H - H0   (up)
// No rotation: there is no dominant street grid.

export const CRS = 'EPSG:25831';

// Origin at the "Ajuntament" TOP_09EQ label point (441416.78, 4598030.37), rounded to the metre.
export const E0 = 441417;
export const N0 = 4598030;
// 10 m floor below the lowest DTM height in the download window (82.65 m, in the 200 m margin outside the
// municipality; 104.07 m inside the boundary). Keeps y >= 0 for the whole terrain including the visual skirt.
export const H0 = 70;

export const frame = { E0, N0, H0, crs: CRS };

export function toLocal(e, n, h = 0) {
  return [e - E0, h - H0, -(n - N0)];
}

export function toUtm(x, y, z) {
  return [x + E0, -z + N0, y + H0];
}
