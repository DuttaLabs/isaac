import assert from 'node:assert/strict';
import test from 'node:test';
import { generateRayFan, paraxialProperties, traceRays } from '@isaac/optical-core';
import { importZmx } from '@isaac/zemax-io';
import { SCHOTT } from '../src/index.ts';

/**
 * The classic crown/flint doublet, written in ZMX form. It names BK7 and F2 —
 * BK7 being the name SCHOTT has retired for N-BK7, so it resolves to the same
 * glass under the current name.
 * A 100 mm f/5 achromat: the last thickness is the designer's back focus.
 */
const DOUBLET = `MODE SEQ
NAME A SIMPLE DOUBLET USING A CROWN AND A FLINT.
UNIT MM X W X CM MR CPMM
ENPD 2.0E+1
FTYP 0 0 1 3 0 0 0
XFLN 0 0 0
YFLN 0 0 0
WAVM 1 4.861327E-1 1
WAVM 2 5.875618E-1 1
WAVM 3 6.562725E-1 1
PWAV 2
SURF 0
  TYPE STANDARD
  CURV 0.0
  DISZ INFINITY
  DIAM 0
SURF 1
  STOP
  TYPE STANDARD
  CURV 1.077039960779000100E-002
  DISZ 6.0
  GLAS BK7
  DIAM 1.5E+1
SURF 2
  TYPE STANDARD
  CURV -3.255623054351999800E-002
  DISZ 3.0
  GLAS F2
  DIAM 1.5E+1
SURF 3
  TYPE STANDARD
  CURV -1.278816413287784900E-002
  DISZ 9.737604742911E+1
  DIAM 1.5E+1
SURF 4
  TYPE STANDARD
  CURV 0.0
  DISZ 0
  DIAM 1.0
`;

test('a lens file resolves its glasses straight from the catalog', () => {
  const { system, glasses, warnings } = importZmx(DOUBLET, { resolveMaterial: SCHOTT.resolver() });

  // The file's name and the catalog's differ, so the import says so rather than
  // quietly tracing a name the file never used. It does not claim to know
  // whether that is a rename or a substitution — only the resolver knows.
  assert.deepEqual(warnings, [
    'Glass "BK7" is not in the catalog under that name and was traced as "N-BK7"; ' +
      'that may be the same glass renamed or a different one substituted for it, ' +
      'which the resolver does not say.',
  ]);
  assert.deepEqual(glasses, [
    { name: 'BK7', surfaceNumber: 1, resolved: true, resolvedAs: 'N-BK7' },
    { name: 'F2', surfaceNumber: 2, resolved: true }, // still in the catalog under its own name
  ]);
  assert.equal(system.surfaceAt(1).material.name, 'N-BK7');
  assert.equal(system.surfaceAt(2).material.name, 'F2');
});

test('a name that can only be guessed at is refused rather than approximated', () => {
  // BAF10 is not in SCHOTT's catalog under any name, so reaching N-BAF10 from
  // it is inference from the spelling — off unless the caller asks for it.
  const guessable = DOUBLET.replace('GLAS BK7', 'GLAS BAF10');
  assert.throws(
    () => importZmx(guessable, { resolveMaterial: SCHOTT.resolver() }),
    /Unknown glass "BAF10" on surface 1/,
  );

  const lenient = SCHOTT.with({ allowLegacyNames: true });
  const { system } = importZmx(guessable, { resolveMaterial: lenient.resolver() });
  assert.equal(system.surfaceAt(1).material.name, 'N-BAF10');
});

test('with real dispersion the doublet reproduces its designed first-order data', () => {
  const { system } = importZmx(DOUBLET, { resolveMaterial: SCHOTT.resolver() });
  const properties = paraxialProperties(system);

  // Designed as a 100 mm lens; the file's last thickness (97.376) is its back focus.
  assert.ok(
    Math.abs(properties.effectiveFocalLength - 100) < 0.5,
    `EFL ${properties.effectiveFocalLength}`,
  );
  assert.ok(
    Math.abs(properties.backFocalDistance - 97.37604742911) < 0.5,
    `BFD ${properties.backFocalDistance}, file says 97.376`,
  );
});

test('the crown/flint pair suppresses color compared with a single crown element', () => {
  const { system } = importZmx(DOUBLET, { resolveMaterial: SCHOTT.resolver() });

  const [blue, green, red] = system.wavelengthsNm.map(
    (wavelength) => paraxialProperties(system, wavelength).backFocalDistance,
  );

  // Ordinary dispersion, so the focus walks out monotonically with wavelength.
  assert.ok(blue! < green! && green! < red!, `focus order was ${blue}, ${green}, ${red}`);

  // A thin single element of focal length f spreads its F-to-C foci by about
  // f/vd. Pairing the crown with a flint has to beat that by a wide margin, or
  // the dispersion data is not reaching the calculation.
  const focalLength = paraxialProperties(system).effectiveFocalLength;
  const singletSplit = focalLength / SCHOTT.get('N-BK7')!.abbeNumber; // ≈ 1.56 mm
  const doubletSplit = red! - blue!;

  assert.ok(
    doubletSplit < singletSplit / 5,
    `doublet F–C split ${doubletSplit.toFixed(3)} mm vs a lone crown's ${singletSplit.toFixed(3)} mm`,
  );
  // This sample is only partially corrected: a true achromat would bring F and C
  // together (split ≈ 0), and this one leaves about 0.13 mm.
  assert.ok(doubletSplit > 0.05, `split ${doubletSplit} mm is smaller than this design achieves`);
});

test('rays trace through the catalog-resolved system to a real focus', () => {
  const { system } = importZmx(DOUBLET, { resolveMaterial: SCHOTT.resolver() });
  const results = traceRays(system, generateRayFan(system, { count: 9 }));

  assert.ok(results.every((result) => result.status === 'TERMINATED'));
  const spread = Math.max(...results.map((result) => Math.abs(result.finalRay.origin.y)));
  assert.ok(spread < 0.02, `f/5 achromat should focus tightly; spread was ${spread} mm`);
});
