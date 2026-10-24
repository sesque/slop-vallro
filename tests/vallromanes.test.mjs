import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeLayer } from './helpers/shp-writer.mjs';
import { E0, N0, H0, toLocal, toUtm } from '../tools/vallromanes/frame.mjs';
import { parseCas, parseDecimal, readBue, readDbf, readShp } from '../tools/vallromanes/read-bue.mjs';
import { bounds, inventory, validate } from '../tools/vallromanes/inventory.mjs';

const E = 441400;
const N = 4598000;
const square = [[E, N, 150], [E + 10, N, 150], [E + 10, N + 10, 150], [E, N + 10, 150], [E, N, 150]];

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bue-fixture-'));
  const P = 'BUE1M08296';
  writeLayer(dir, P, 's', [
    { CAS: 'CON_01pol_PL', DESCRIPCIO: 'Polígon d\'edifici', parts: [square] },
    { CAS: 'CON_13_PL', DESCRIPCIO: 'Illa', parts: [square] }
  ]);
  writeLayer(dir, P, 'l', [
    { CAS: 'COM_18_LN', DESCRIPCIO: 'Eix de via urbana pavimentada', parts: [[[E, N, 120.5], [E + 50, N + 5, 121.25]]] },
    { CAS: 'COM_17LS_LN', DESCRIPCIO: 'Vorera (LTP)', parts: [[[E, N, 120], [E + 20, N, 121]], [[E, N + 2, 120], [E + 20, N + 2, 121]]] },
    { CAS: 'CON_18ES_LN_C', DESCRIPCIO: 'Construcció (elevat)', parts: [[[E, N, 130], [E + 1, N, 130]]] }
  ]);
  writeLayer(dir, P, 'p', [
    { CAS: 'ORO_03_PT', DESCRIPCIO: 'Cota', ANGLE: '0', ALTITUD: '169,43', parts: [[[E + 3, N + 3, 169.43]]] }
  ]);
  writeLayer(dir, P, 't', [
    { CAS: 'TOP_09EQ_TX', DESCRIPCIO: 'Equipament', ANGLE: '12.5', TEXT: 'Ajuntament', parts: [[[E + 4, N + 4, 0]]] },
    { CAS: 'TOP_05CR_TX', DESCRIPCIO: 'Via urbana', ANGLE: '90', TEXT: 'Carrer de Barcelona', parts: [[[E + 5, N + 5, 0]]] }
  ]);
  return dir;
}

test('frame: local axes, north is -z, round trip', () => {
  assert.deepEqual(toLocal(E0 + 10, N0, H0), [10, 0, -0]);
  assert.equal(toLocal(E0, N0 + 25, H0 + 7).join(), '0,7,-25');
  const back = toUtm(...toLocal(441234.5, 4598765.25, 201.5));
  assert.deepEqual(back.map((v) => +v.toFixed(6)), [441234.5, 4598765.25, 201.5]);
});

test('parseDecimal handles the decimal comma', () => {
  assert.equal(parseDecimal('169,43'), 169.43);
  assert.equal(parseDecimal('12.5'), 12.5);
  assert.equal(parseDecimal(''), null);
  assert.equal(parseDecimal('abc'), null);
});

test('parseCas strips the revision suffix and reads LTP / elevated flags', () => {
  assert.deepEqual(parseCas('CON_01pol_PL'), { base: 'CON_01pol_PL', fieldRevised: false, ltp: undefined, elevated: false });
  assert.deepEqual(parseCas('COM_17LS_LN'), { base: 'COM_17LS_LN', fieldRevised: false, ltp: true, elevated: false });
  assert.equal(parseCas('COM_14LN_LN').ltp, false);
  assert.equal(parseCas('COM_13ES_LN').elevated, true);
  const rev = parseCas('CON_18ES_LN_C');
  assert.equal(rev.base, 'CON_18ES_LN');
  assert.equal(rev.fieldRevised, true);
  assert.equal(rev.elevated, true);
  assert.equal(parseCas('CON_18polLS_PL').ltp, true);
});

test('readShp keeps Z values for point, line and polygon records', () => {
  const dir = makeFixture();
  try {
    const poly = readShp(fs.readFileSync(path.join(dir, 'BUE1M08296s.shp')));
    assert.equal(poly.length, 2);
    assert.equal(poly[0].parts[0].length, 5);
    assert.equal(poly[0].parts[0][2][2], 150);
    const line = readShp(fs.readFileSync(path.join(dir, 'BUE1M08296l.shp')));
    assert.equal(line[1].parts.length, 2);
    assert.deepEqual(line[0].parts[0][1], [E + 50, N + 5, 121.25]);
    const pt = readShp(fs.readFileSync(path.join(dir, 'BUE1M08296p.shp')));
    assert.deepEqual(pt[0].parts[0][0], [E + 3, N + 3, 169.43]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readDbf decodes UTF-8', () => {
  const dir = makeFixture();
  try {
    const rows = readDbf(fs.readFileSync(path.join(dir, 'BUE1M08296s.dbf')));
    assert.equal(rows[0].CAS, 'CON_01pol_PL');
    assert.equal(rows[0].DESCRIPCIO, 'Polígon d\'edifici');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readBue normalises features and applies the transform', () => {
  const dir = makeFixture();
  try {
    const raw = readBue(dir);
    assert.equal(raw.length, 2 + 3 + 1 + 2);
    const spot = raw.find((f) => f.cas === 'ORO_03_PT');
    assert.equal(spot.altitud, 169.43);
    assert.equal(spot.kind, 'point');
    const constr = raw.find((f) => f.cas === 'CON_18ES_LN');
    assert.ok(constr.fieldRevised && constr.elevated);
    assert.equal(raw.find((f) => f.cas === 'COM_17LS_LN').ltp, true);
    assert.equal(raw.find((f) => f.cas === 'TOP_09EQ_TX').text, 'Ajuntament');
    assert.equal(raw.find((f) => f.cas === 'TOP_09EQ_TX').angle, 12.5);

    const local = readBue(dir, { transform: toLocal });
    const b = local.find((f) => f.cas === 'CON_01pol_PL');
    assert.deepEqual(b.coords[0], toLocal(E, N, 150));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readBue throws when shapes and DBF rows disagree', () => {
  const dir = makeFixture();
  try {
    const dbf = path.join(dir, 'BUE1M08296s.dbf');
    const buf = fs.readFileSync(dbf);
    buf.writeUInt32LE(5, 4);
    fs.writeFileSync(dbf, buf);
    assert.throws(() => readBue(dir), /DBF rows|out of range|Offset/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inventory counts per CAS and groups, and bounds are finite', () => {
  const dir = makeFixture();
  try {
    const features = readBue(dir);
    const inv = inventory(features);
    assert.equal(inv.byKind.poly, 2);
    assert.equal(inv.byCas.find((e) => e.cas === 'COM_17LS_LN').count, 1);
    const kerb = inv.checks.find((c) => c.label === 'kerb');
    assert.equal(kerb.actual, 1);
    assert.equal(kerb.ok, false); // fixture is far smaller than the real delivery
    const names = inv.checks.find((c) => c.label === 'distinct street names');
    assert.equal(names.actual, 1);
    const b = bounds(features);
    assert.equal(b.minE, E);
    assert.equal(b.maxN, N + 10);
    assert.equal(b.minH, 120);
    assert.equal(b.maxH, 169.43);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate fails loudly on empty layers, NaN and out-of-bounds data', () => {
  const dir = makeFixture();
  try {
    const features = readBue(dir);
    const b = bounds(features);
    assert.doesNotThrow(() => validate(features, b));
    assert.throws(() => validate([], b), /No features/);
    assert.throws(() => validate(features.filter((f) => f.kind !== 'text'), b), /empty/);
    assert.throws(() => validate(features, { ...b, maxE: 450000 }), /Bbox out of bounds/);
    assert.throws(() => validate(features, { ...b, minH: H0 - 5 }), /below H0/);
    const bad = features.map((f) => ({ ...f }));
    bad[0].parts = [[[NaN, 1, 1]]];
    assert.throws(() => bounds(bad), /Non-finite/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
