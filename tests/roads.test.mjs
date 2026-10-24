import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOverrides, pinEnds, resample, simplify3D, smoothHeights } from '../tools/vallromanes/build-roads.mjs';
import { matchNames, measureEdge, propagateNames, samplePolyline, SegmentIndex } from '../tools/vallromanes/road-attributes.mjs';

test('resample keeps the ends and spaces vertices evenly', () => {
  const pts = resample([[0, 0, 0], [10, 0, 5], [10, 10, 5]], 1);
  assert.deepEqual(pts[0], [0, 0, 0]);
  assert.deepEqual(pts[pts.length - 1], [10, 10, 5]);
  assert.equal(pts.length, 21);
  assert.ok(Math.abs(pts[5][2] - 2.5) < 1e-9);
});

test('smoothHeights removes noise but keeps a straight grade', () => {
  const ramp = Array.from({ length: 41 }, (_, i) => [i, 0, i * 0.05 + (i % 2 ? 0.3 : -0.3)]);
  const s = smoothHeights(ramp, 6);
  for (let i = 8; i < 33; i++) assert.ok(Math.abs(s[i][2] - i * 0.05) < 0.12, `i=${i}: ${s[i][2]}`);
  const flat = smoothHeights(Array.from({ length: 10 }, (_, i) => [i, 0, 7]), 5);
  assert.ok(flat.every((p) => Math.abs(p[2] - 7) < 1e-9));
});

test('pinEnds bends the ends to the node heights and leaves the middle alone', () => {
  const pts = Array.from({ length: 41 }, (_, i) => [i, 0, 100]);
  const p = pinEnds(pts, 101, 99, 10);
  assert.equal(p[0][2], 101);
  assert.equal(p[40][2], 99);
  assert.equal(p[20][2], 100);
  assert.ok(p[5][2] > 100 && p[5][2] < 101);
  const short = pinEnds([[0, 0, 0], [1, 0, 0]], 2, 3, 12); // shorter than twice the blend: still meets both ends
  assert.ok(Math.abs(short[0][2] - 2) < 1e-9 && Math.abs(short[1][2] - 3) < 1e-9);
});

test('simplify3D drops collinear vertices but keeps a height break', () => {
  const line = Array.from({ length: 21 }, (_, i) => [i, 0, i * 0.1]);
  assert.equal(simplify3D(line, 0.05).length, 2);
  const bent = Array.from({ length: 21 }, (_, i) => [i, 0, i <= 10 ? 0 : (i - 10) * 0.5]);
  const s = simplify3D(bent, 0.05);
  assert.ok(s.length === 3 && s[1][0] === 10);
});

test('applyOverrides replaces only the listed fields', () => {
  const rec = { id: 'x', name: null, halfL: 3, halfR: 3, speed: 30 };
  const out = applyOverrides(rec, { name: 'Carrer Nou', speed: 20, unknown: 1 });
  assert.deepEqual(out, { id: 'x', name: 'Carrer Nou', halfL: 3, halfR: 3, speed: 20 });
  assert.equal(applyOverrides(rec, undefined), rec);
});

test('SegmentIndex rays hit the nearest segment and ignore those behind or out of reach', () => {
  const idx = new SegmentIndex();
  idx.addPolyline([[-50, 3], [50, 3]]);
  idx.addPolyline([[-50, -5], [50, -5]]);
  assert.ok(Math.abs(idx.rayHit(0, 0, 0, 1, 14) - 3) < 1e-9);
  assert.ok(Math.abs(idx.rayHit(0, 0, 0, -1, 14) - 5) < 1e-9);
  assert.equal(idx.rayHit(0, 0, 1, 0, 14), Infinity);
  assert.equal(idx.rayHit(0, 0, 0, 1, 2), Infinity);
  const closed = new SegmentIndex();
  closed.addPolyline([[10, -5], [20, -5], [20, 5], [10, 5]], true);
  assert.ok(Math.abs(closed.rayHit(0, 0, 1, 0, 14) - 10) < 1e-9);
});

test('samplePolyline gives evenly spaced samples with unit tangents', () => {
  const s = samplePolyline([[0, 0, 0], [20, 0, 0]], 5);
  assert.deepEqual(s.map((p) => p.x), [2.5, 7.5, 12.5, 17.5]);
  assert.ok(s.every((p) => p.tx === 1 && p.tz === 0));
  assert.equal(samplePolyline([[0, 0, 0], [1, 0, 0]], 5).length, 1);
});

test('measureEdge finds half widths from kerbs and the pavement beyond them', () => {
  const idx = { kerb: new SegmentIndex(), edge: new SegmentIndex(), trackEdge: new SegmentIndex(), limit: new SegmentIndex(), obstacle: new SegmentIndex() };
  idx.kerb.addPolyline([[-40, 3], [40, 3]]); // kerb 3 m to +z
  idx.kerb.addPolyline([[-40, -2.5], [40, -2.5]]); // 2.5 m to -z
  idx.limit.addPolyline([[-40, 4.8], [40, 4.8]]); // pavement limit 1.8 m beyond the +z kerb
  const edge = { cls: 'urban', pts: [[-30, 0, 0], [30, 0, 0]] };
  const m = measureEdge(edge, idx);
  // Travelling +x, the left normal is (-tz, tx) = (0, 1): +z is the left side
  assert.equal(m.halfL, 3);
  assert.equal(m.halfR, 2.5);
  assert.equal(m.swL, 1.8);
  assert.equal(m.swR, 1.5); // kerb but no limit nearby: the default
  assert.ok(m.kerbL && m.kerbR && m.measured);
  const lone = measureEdge({ cls: 'urban', pts: [[0, 100, 0], [30, 100, 0]] }, idx);
  assert.equal(lone.halfL, 3);
  assert.equal(lone.measured, false);
  assert.equal(lone.swL, 0);
  const track = measureEdge({ cls: 'track', pts: [[0, 100, 0], [30, 100, 0]] }, idx);
  assert.equal(track.halfL, 1.75);
});

test('matchNames uses the CAD angle (counter-clockwise from east), picks the nearest parallel edge and propagates straight on', () => {
  // Edge 0 runs east-west, edge 1 north-south (z = -north), edge 2 continues edge 0 to the east
  const edges = [
    { cls: 'urban', a: 0, b: 1, pts: [[0, 0, 0], [50, 0, 0]] },
    { cls: 'urban', a: 1, b: 2, pts: [[50, 0, 0], [50, -50, 0]] },
    { cls: 'urban', a: 1, b: 3, pts: [[50, 0, 0], [100, 0, 0]] }
  ];
  const labels = [
    { x: 25, z: 3, angle: 0, text: 'Carrer Est' },
    { x: 52, z: -25, angle: 90, text: 'Carrer Nord' }
  ];
  const { names, matched } = matchNames(edges, labels);
  assert.deepEqual(names, ['Carrer Est', 'Carrer Nord', null]);
  assert.equal(matched, 2);
  const nodes = [0, 1, 2, 3].map((id) => ({ id }));
  const prop = propagateNames(edges, nodes, names);
  assert.equal(prop[2], 'Carrer Est'); // straight on from edge 0 rather than the 90 degree turn to edge 1
  const wrong = matchNames(edges, [{ x: 25, z: 3, angle: 90, text: 'X' }]); // a label across the edge direction
  assert.equal(wrong.matched, 0);
});
