import assert from 'node:assert/strict';
import test from 'node:test';
import { ConstantMaterial, paraxialProperties, type Material } from '@isaac/optical-core';
import { ZmxImportError, importZmx } from '../src/index.ts';

const resolveMaterial = (name: string): Material | undefined =>
  name.trim().toUpperCase() === 'BK7' ? new ConstantMaterial('BK7', 1.5168) : undefined;

/**
 * A relay built around a single ideal lens: an object at infinity, a PARAXIAL
 * surface of focal length 100, and the image plane at its focus.
 */
function paraxialFile(surfaceRecords: string, thickness = '1.0E+2'): string {
  return [
    'VERS 130404 0 24485',
    'MODE SEQ',
    'NAME IDEAL LENS',
    'UNIT MM X W X CM MR CPMM',
    'ENPD 2.0E+1',
    'FTYP 0 0 1 1 0 0 0',
    'XFLN 0 0 0 0',
    'YFLN 0 0 0 0',
    'WAVM 1 5.875618E-1 1',
    'PWAV 1',
    'SURF 0',
    '  TYPE STANDARD',
    '  CURV 0.0 0 0 0 0 ""',
    '  DISZ INFINITY',
    '  DIAM 0 0 0 0 1 ""',
    'SURF 1',
    '  STOP',
    surfaceRecords,
    `  DISZ ${thickness}`,
    '  DIAM 1.0E+1 1 0 0 1 ""',
    'SURF 2',
    '  TYPE STANDARD',
    '  CURV 0.0 0 0 0 0 ""',
    '  DISZ 0',
    '  DIAM 0 0 0 0 1 ""',
  ].join('\n');
}

const IDEAL_LENS = ['  TYPE PARAXIAL', '  PARM 1 1.0E+2', '  PARM 2 1'].join('\n');

test('a PARAXIAL surface imports with the focal length from PARM 1', () => {
  const { system, warnings } = importZmx(paraxialFile(IDEAL_LENS), { resolveMaterial });

  const lens = system.surfaceAt(1);
  assert.equal(lens.type, 'PARAXIAL');
  assert.equal(lens.focalLength, 100);
  assert.equal(lens.radius, Infinity);
  assert.equal(lens.semiDiameter, 10);
  assert.equal(lens.isStop, true);
  assert.deepEqual(warnings, []);

  // The imported system has exactly the first order the file described.
  const properties = paraxialProperties(system);
  assert.ok(Math.abs(properties.effectiveFocalLength - 100) < 1e-9);
  assert.ok(Math.abs(properties.paraxialImageZ - properties.imageSurfaceZ) < 1e-9);
});

test('PARM counts as handled on a paraxial surface', () => {
  const { ignoredTokens } = importZmx(paraxialFile(IDEAL_LENS), { resolveMaterial });
  // PARM counts as handled on a paraxial surface: PARM 1 was consumed.
  assert.ok(!ignoredTokens.includes('PARM'));
});

test('PARM on a surface that is not paraxial stays in ignoredTokens', () => {
  const standardWithParm = ['  TYPE STANDARD', '  CURV 0.0 0 0 0 0 ""', '  PARM 1 3'].join('\n');
  const { ignoredTokens } = importZmx(paraxialFile(standardWithParm), { resolveMaterial });
  assert.ok(ignoredTokens.includes('PARM'));
});

test('a paraxial surface with no focal length is refused, not defaulted', () => {
  assert.throws(
    () => importZmx(paraxialFile('  TYPE PARAXIAL'), { resolveMaterial }),
    (error: unknown) =>
      error instanceof ZmxImportError && /carries no PARM 1 record/.test(error.message),
  );

  assert.throws(
    () =>
      importZmx(paraxialFile(['  TYPE PARAXIAL', '  PARM 1 0'].join('\n')), { resolveMaterial }),
    (error: unknown) => error instanceof ZmxImportError && /focal length of 0/.test(error.message),
  );
});

test('an unrecognised PARM on a paraxial surface is refused rather than guessed at', () => {
  assert.throws(
    () =>
      importZmx(paraxialFile(['  TYPE PARAXIAL', '  PARM 1 1.0E+2', '  PARM 3 7'].join('\n')), {
        resolveMaterial,
      }),
    (error: unknown) =>
      error instanceof ZmxImportError && /unrecognised PARM 3/.test(error.message),
  );
});

test('a paraxial surface immersed in glass is refused, since the convention is unverified', () => {
  const inGlass = ['  TYPE PARAXIAL', '  PARM 1 1.0E+2', '  GLAS BK7 0 0 0 0 0 0 0 0 0 0'].join(
    '\n',
  );

  assert.throws(
    () => importZmx(paraxialFile(inGlass), { resolveMaterial }),
    (error: unknown) => error instanceof ZmxImportError && /immersed in glass/.test(error.message),
  );
});

test('other surface types are still refused, and say so by name', () => {
  assert.throws(
    () => importZmx(paraxialFile('  TYPE COORDBRK'), { resolveMaterial }),
    (error: unknown) =>
      error instanceof ZmxImportError &&
      /only STANDARD and PARAXIAL surfaces are supported/.test(error.message),
  );
});
