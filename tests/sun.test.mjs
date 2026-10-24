import assert from 'node:assert/strict';
import test from 'node:test';
import { declination, directionTo, LATITUDE, lightAt, MOON_DIRECTION, solarHours, solarPosition, sunAt } from '../js/geo/sun.js';

const deg = (r) => (r * 180) / Math.PI;

test('declination: about +23.4 at the June solstice, -23.4 in December, 0 at the equinoxes', () => {
  assert.ok(Math.abs(deg(declination(172)) - 23.4) < 0.3);
  assert.ok(Math.abs(deg(declination(355)) + 23.4) < 0.5);
  assert.ok(Math.abs(deg(declination(81))) < 0.01);
});

test('at solar noon the sun is due south at 90 - latitude + declination', () => {
  const p = solarPosition(LATITUDE, 172, 12);
  assert.ok(Math.abs(deg(p.elevation) - (90 - LATITUDE + 23.44)) < 0.1);
  assert.ok(Math.abs(deg(p.azimuth) - 180) < 1e-6);
  const equinox = solarPosition(LATITUDE, 81, 12);
  assert.ok(Math.abs(deg(equinox.elevation) - (90 - LATITUDE)) < 0.01);
});

test('morning sun is in the east, evening sun in the west; the local frame has x east and z = -north', () => {
  const am = solarPosition(LATITUDE, 258, 9), pm = solarPosition(LATITUDE, 258, 15);
  assert.ok(deg(am.azimuth) > 90 && deg(am.azimuth) < 180);
  assert.ok(deg(pm.azimuth) > 180 && deg(pm.azimuth) < 270);
  const noon = directionTo(...Object.values(solarPosition(LATITUDE, 258, 12)));
  assert.ok(noon[2] > 0 && Math.abs(noon[0]) < 1e-9, 'due south: +z, no east or west');
  assert.ok(directionTo(0.3, deg(90) * Math.PI / 180 / deg(1) * 0 + Math.PI / 2)[0] > 0.9, 'azimuth 90 degrees is east: +x');
  assert.ok(directionTo(0.3, (3 * Math.PI) / 2)[0] < -0.9, 'azimuth 270 degrees is west: -x');
  assert.ok(Math.abs(Math.hypot(...directionTo(0.7, 2.1)) - 1) < 1e-12);
});

test('clock time to solar time for Catalan summer time', () => {
  // solar noon in Vallromanes comes about 13:46 in mid-September (UTC+2, longitude 2.3 east, equation of time +4.5 min)
  assert.ok(Math.abs(solarHours(13 + 46 / 60) - 12) < 0.02);
  assert.ok(solarHours(14) > 12);
});

test('the presets: midday is high and southern, the golden hour low in the west, the blue hour just above the horizon', () => {
  const midday = sunAt(13.75), golden = sunAt(18.75);
  assert.ok(deg(midday.elevation) > 49 && deg(midday.elevation) < 52, `midday ${deg(midday.elevation)}`);
  assert.ok(midday.direction[2] > 0.6, 'to the south');
  assert.ok(deg(golden.elevation) > 9 && deg(golden.elevation) < 17, `golden ${deg(golden.elevation)}`);
  assert.ok(golden.direction[0] < -0.9 && golden.direction[2] > 0, 'west-south-west');
  // sunset is about 20:00: after it the sun is below the horizon, but the light never points up from underneath
  assert.ok(sunAt(20.1).elevation < 0);
  const blue = lightAt(20.1, 4);
  assert.ok(Math.abs(Math.asin(blue[1]) * 180 / Math.PI - 4) < 1e-9);
  assert.ok(blue[0] < -0.95);
  assert.ok(lightAt(13.75, 4)[1] > 0.7, 'a sun above the minimum is unchanged');
  assert.ok(MOON_DIRECTION[1] > 0.7 && MOON_DIRECTION[2] > 0 && MOON_DIRECTION[0] > 0);
});
