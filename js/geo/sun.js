// js/geo/sun.js
// Where the sun is over Vallromanes. Local frame: x east, y up, z = -north, so the sun at noon (south) has z > 0.

export const LATITUDE = 41.54; // degrees north
export const LONGITUDE = 2.3; // degrees east
const DEG = Math.PI / 180;

/** Solar declination (radians) for a day of the year (1 = 1 January), accurate to about 0.5 degree. */
export function declination(dayOfYear) {
  return 23.44 * DEG * Math.sin(((360 / 365) * (dayOfYear - 81)) * DEG);
}

/**
 * Local clock time (hours, 24 h) to solar time: noon is when the sun is due south. `utcOffset` is the clock's offset from
 * UTC (2 in Catalan summer), `eqTimeMin` the equation of time in minutes (about +4.5 in mid-September).
 */
export function solarHours(clockHours, longitude = LONGITUDE, utcOffset = 2, eqTimeMin = 4.5) {
  return clockHours - utcOffset + longitude / 15 + eqTimeMin / 60;
}

/** Elevation above the horizon and azimuth (clockwise from north), both in radians. */
export function solarPosition(latitudeDeg, dayOfYear, solarTime) {
  const phi = latitudeDeg * DEG, delta = declination(dayOfYear), hour = (solarTime - 12) * 15 * DEG;
  const sinE = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(hour);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinE)));
  const azimuth = Math.atan2(Math.sin(hour), Math.cos(hour) * Math.sin(phi) - Math.tan(delta) * Math.cos(phi)) + Math.PI;
  return { elevation, azimuth };
}

/** Unit vector towards the sun in the local frame (x east, y up, z = -north). */
export function directionTo(elevation, azimuth) {
  return [Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), -Math.cos(elevation) * Math.cos(azimuth)];
}

export const DAY_OF_YEAR = 258; // 15 September: the light of the presets

/** The sun direction at a local clock time (CEST) on DAY_OF_YEAR in Vallromanes. */
export function sunAt(clockHours, day = DAY_OF_YEAR) {
  const { elevation, azimuth } = solarPosition(LATITUDE, day, solarHours(clockHours));
  return { elevation, azimuth, direction: directionTo(elevation, azimuth) };
}

/**
 * The direction of the light of a preset at a local clock time: the sun, but never below `minElevationDeg` (a sun under
 * the horizon would light the ground from beneath, so the blue hour keeps a low sun just above it).
 */
export function lightAt(clockHours, minElevationDeg = 0) {
  const { elevation, azimuth } = sunAt(clockHours);
  return directionTo(Math.max(elevation, minElevationDeg * DEG), azimuth);
}

/** A fixed moon for the night preset: high in the south-east, so night scenes have a soft shadow direction. */
export const MOON_DIRECTION = directionTo(52 * DEG, 150 * DEG);
