import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ConstantMaterial,
  generateRayFan,
  paraxialProperties,
  traceRays,
  type Material,
} from '@isaac/optical-core';
import { UNKNOWN_GLASS_INDEX, ZmxImportError, importZmx } from '../src/index.ts';

const DOUBLET = readFileSync(fileURLToPath(new URL('./fixtures/doublet.zmx', import.meta.url)), 'utf8');

/** The file names SCHOTT BK7 and F2, which the core catalogue does not carry. */
const SCHOTT: ReadonlyMap<string, Material> = new Map([
  ['BK7', new ConstantMaterial('BK7', 1.5168)],
  ['F2', new ConstantMaterial('F2', 1.62)],
]);
const resolveMaterial = (name: string): Material | undefined => SCHOTT.get(name.trim().toUpperCase());

function importDoublet(overrides = DOUBLET) {
  return importZmx(overrides, { resolveMaterial });
}

test('a doublet file maps onto the optical-core model', () => {
  const { system, warnings } = importDoublet();

  assert.equal(system.name, 'A SIMPLE DOUBLET USING A CROWN AND A FLINT.');
  assert.equal(system.units, 'mm');
  assert.deepEqual(system.aperture, { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 });
  assert.equal(system.stopIndex, 1);
  assert.deepEqual(warnings, []);

  // FTYP declares 3 wavelengths, so the file's padding entries are dropped,
  // and PWAV 2 selects the middle one. WAVM is in micrometres.
  assert.deepEqual(system.wavelengthsNm, [486, 589, 656]);
  assert.equal(system.primaryWavelengthNm, 589);

  // FTYP field type 0 = angle, 1 field.
  assert.deepEqual(system.fields, [{ angleDeg: 0 }]);
});

test('surface records become surfaces, with curvature inverted to radius', () => {
  const { system } = importDoublet();
  const [object, crown, flint, back, image] = system.surfaces;

  assert.equal(object!.type, 'OBJECT');
  assert.equal(object!.thickness, Infinity); // DISZ INFINITY
  assert.equal(object!.semiDiameter, Infinity); // DIAM 0 means "no aperture", not zero
  assert.equal(object!.radius, Infinity); // CURV 0

  assert.ok(Math.abs(crown!.radius - 1 / 1.0770399607790001e-2) < 1e-9);
  assert.equal(crown!.thickness, 6);
  assert.equal(crown!.semiDiameter, 15); // DIAM is the semi-diameter
  assert.equal(crown!.material.name, 'BK7');
  assert.equal(crown!.isStop, true);

  assert.ok(flint!.radius < 0);
  assert.equal(flint!.material.name, 'F2');
  assert.equal(back!.material.name, 'AIR'); // no GLAS record ⇒ air after the surface

  assert.equal(image!.type, 'IMAGE');
  assert.equal(image!.thickness, 0);
});

test('the imported system reproduces the file’s own back focal distance', () => {
  const { system } = importDoublet();
  const properties = paraxialProperties(system);

  // A 100 mm achromat: the file's last thickness (97.376) is its back focus.
  assert.ok(Math.abs(properties.effectiveFocalLength - 100) < 0.05);
  assert.ok(
    Math.abs(properties.backFocalDistance - 97.37604742911) < 0.05,
    `computed BFD ${properties.backFocalDistance}, file says 97.376`,
  );
  assert.ok(Math.abs(properties.imageSurfaceZ - properties.paraxialImageZ) < 0.05);
});

test('rays trace through the imported system to a real focus', () => {
  const { system } = importDoublet();
  const results = traceRays(system, generateRayFan(system, { count: 9 }));

  assert.ok(results.every((result) => result.status === 'TERMINATED'));
  const spread = Math.max(...results.map((result) => Math.abs(result.finalRay.origin.y)));
  assert.ok(spread < 0.01, `f/5 achromat should focus tightly; spread was ${spread} mm`);
});

test('unresolved glass fails the import unless explicitly allowed', () => {
  assert.throws(() => importZmx(DOUBLET), (error: unknown) => {
    assert.ok(error instanceof ZmxImportError);
    assert.match(error.message, /Unknown glass "BK7" on surface 1/);
    return true;
  });

  const { system, warnings, glasses } = importZmx(DOUBLET, { allowUnknownGlass: true });
  assert.equal(system.surfaceAt(1).material.indexAt(589), UNKNOWN_GLASS_INDEX);
  assert.ok(warnings.some((warning) => /will not trace correctly/.test(warning)));
  assert.deepEqual(glasses, [
    { name: 'BK7', surfaceNumber: 1, resolved: false },
    { name: 'F2', surfaceNumber: 2, resolved: false },
  ]);
});

test('resolved glasses are reported alongside the system', () => {
  const { glasses } = importDoublet();
  assert.deepEqual(glasses, [
    { name: 'BK7', surfaceNumber: 1, resolved: true },
    { name: 'F2', surfaceNumber: 2, resolved: true },
  ]);
});

test('tokens the reader does not interpret are reported, not silently dropped', () => {
  const { ignoredTokens } = importDoublet();

  for (const token of ['HIDE', 'MIRR', 'FLAP', 'GCAT', 'VERS', 'TOL', 'MNUM']) {
    assert.ok(ignoredTokens.includes(token), `expected ${token} to be reported as ignored`);
  }
  // Interpreted tokens must not appear in the ignored list.
  for (const token of ['CURV', 'DISZ', 'DIAM', 'GLAS', 'STOP', 'ENPD', 'WAVM']) {
    assert.ok(!ignoredTokens.includes(token));
  }
});

test('geometry the core cannot model is rejected rather than approximated', () => {
  assert.throws(
    () => importDoublet(DOUBLET.replace('MODE SEQ', 'MODE NONSEQ')),
    /Only sequential/,
  );
  assert.throws(
    () => importDoublet(DOUBLET.replace('  TYPE STANDARD\n  CURV 1.07', '  TYPE EVENASPH\n  CURV 1.07')),
    /only STANDARD surfaces/,
  );
  // A conic constant would change the surface shape, so it cannot be ignored.
  assert.throws(
    () => importDoublet(DOUBLET.replace('  DISZ 6.0', '  CONI -1.0\n  DISZ 6.0')),
    /conic constant/,
  );
  assert.throws(() => importDoublet('MODE SEQ\nSURF 0\n  DISZ 0\n'), /at least an object and an image/);
});

test('ambiguous or unsupported header data becomes a warning', () => {
  // Two aperture records: the first in file order wins, and the clash is reported.
  const twoApertures = importDoublet(DOUBLET.replace('ENPD 2.0E+1', 'ENPD 2.0E+1\nFNUM 5.0'));
  assert.deepEqual(twoApertures.system.aperture, { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 });
  assert.ok(twoApertures.warnings.some((warning) => /Several aperture records/.test(warning)));

  // Field type 3 is a real image height, which the core cannot express.
  const imageHeightFields = importDoublet(DOUBLET.replace('FTYP 0 0 1 3', 'FTYP 3 0 1 3'));
  assert.deepEqual(imageHeightFields.system.fields, []);
  assert.ok(imageHeightFields.warnings.some((warning) => /Field type 3/.test(warning)));

  // A stop marked on the image surface cannot be honoured.
  const stopOnImage = importDoublet(DOUBLET.replace('SURF 4\n  TYPE', 'SURF 4\n  STOP\n  TYPE'));
  assert.equal(stopOnImage.system.stopIndex, 1); // still surface 1
  assert.ok(stopOnImage.warnings.some((warning) => /marked STOP but is the IMAGE surface/.test(warning)));

  const oddUnits = importDoublet(DOUBLET.replace('UNIT MM', 'UNIT FURLONG'));
  assert.equal(oddUnits.system.units, 'mm');
  assert.ok(oddUnits.warnings.some((warning) => /Unrecognised UNIT/.test(warning)));
});

test('a file supplied as raw UTF-16 bytes imports identically', () => {
  const bytes = new Uint8Array((DOUBLET.length + 1) * 2);
  const withBom = `﻿${DOUBLET}`;
  for (let i = 0; i < withBom.length; i += 1) {
    const code = withBom.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }

  const fromBytes = importZmx(bytes, { resolveMaterial });
  assert.equal(fromBytes.system.name, importDoublet().system.name);
  assert.equal(fromBytes.system.surfaces.length, 5);
});
