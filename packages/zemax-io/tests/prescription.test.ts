import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConstantMaterial, OpticalSystem, Surface, type Material } from '@isaac/optical-core';
import {
  comparePrescription,
  importZmx,
  inferMaskedDecimals,
  parsePrescription,
  parsePrescriptionValue,
  primaryWavelengthNm,
  valueContains,
  type PrescriptionComparison,
} from '../src/index.ts';

const here = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const REPORT = readFileSync(here('prescription.txt'), 'utf8');
const DOUBLET = readFileSync(here('doublet.zmx'), 'utf8');

/**
 * `zemax-io` must not depend on `glass-catalog`, so the two glasses the doublet
 * names are stood in for here. The indices are SCHOTT's own at 589 nm — the
 * file's primary wavelength, and the only one anything is compared at — so the
 * fixture report agrees with this system and with one resolved against the real
 * catalog, and `npm run compare` on the pair doubles as a smoke test of the CLI.
 */
const SCHOTT: ReadonlyMap<string, Material> = new Map([
  ['BK7', new ConstantMaterial('BK7', 1.51674012046)],
  ['F2', new ConstantMaterial('F2', 1.61991622509)],
]);

function value(text: string) {
  const parsed = parsePrescriptionValue(text);
  assert.ok(parsed !== undefined, `${text} should parse`);
  return parsed;
}

// ---------------------------------------------------------------------------
// A masked value is a range, and the range has to be right in both directions.
//
// The four cases below are the ones the real export actually produces, checked
// against radii whose true values are known from the .zmx the report was made
// from. Each one broke a simpler rule than the one now in place.
// ---------------------------------------------------------------------------

test('a masked digit is an unknown digit in its own place', () => {
  const radius = value('-325.055X');
  assert.equal(radius.maskedDigits, 1);
  assert.equal(radius.significantDigits, 6);
  assert.ok(valueContains(radius, -325.055504));
  assert.ok(!valueContains(radius, -325.0549));
  assert.ok(!valueContains(radius, -325.056));
});

test('a suppressed trailing zero is not a missing digit', () => {
  // 1188.659668 prints as `1188.66` because seven significant figures round to
  // 1188.660 and the zero is dropped. Reading the slack off the printed length
  // would give a half-unit either side — a range so wide it proves nothing.
  const radius = value('1188.66');
  assert.equal(radius.maskedDigits, 0);
  assert.ok(valueContains(radius, 1188.659668));
  assert.ok(!valueContains(radius, 1188.7));
  assert.ok(radius.high - radius.low < 0.002);
});

test('significant figures run out before the decimal place does', () => {
  // -109987.496020 prints as `-109987.5`: seven figures leave one decimal, so
  // the interval must be half a unit there and not at the third decimal.
  const radius = value('-109987.5');
  assert.ok(valueContains(radius, -109987.49602));
  assert.ok(!valueContains(radius, -109987.4));
});

test('a printed zero means zero, not anything under a half', () => {
  const conic = value('0');
  assert.ok(valueContains(conic, 0));
  assert.ok(!valueContains(conic, -0.3), 'a real conic must not pass as an unstated one');
  assert.ok(!valueContains(conic, 0.01));
});

test('a masked exponential keeps its sign outside the mantissa', () => {
  const coefficient = value('-3.585XXXe-15');
  assert.ok(coefficient.low < coefficient.high);
  assert.ok(valueContains(coefficient, -3.58560604e-15));
  assert.ok(!valueContains(coefficient, -3.586e-15));
  assert.ok(!valueContains(coefficient, -3.584e-15));
});

test('a value that pinned nothing says so', () => {
  const apodization = value('0.000XXE+00');
  assert.equal(apodization.significantDigits, 0);
  assert.ok(apodization.maskedDigits > 0);
});

test('Infinity is exact', () => {
  const radius = value('Infinity');
  assert.ok(valueContains(radius, Infinity));
  assert.ok(!valueContains(radius, 1e12));
});

test('the masking precision is counted from the report, not assumed', () => {
  assert.equal(inferMaskedDecimals(REPORT), 3);
  assert.equal(inferMaskedDecimals('Radius : 12.3456789'), undefined);
  assert.equal(inferMaskedDecimals('a 1.2XX and a 3.45678X'), 5);
});

// ---------------------------------------------------------------------------
// Reading the report
// ---------------------------------------------------------------------------

test('the surface table stops where the surface table stops', () => {
  // The first version of this read 393 rows from a 65-surface lens, because the
  // row shape also matches EDGE THICKNESS DATA and everything after it. The
  // fixture carries that section for exactly this reason.
  const prescription = parsePrescription(REPORT);
  assert.ok(prescription.sections.includes('EDGE THICKNESS DATA:'));
  assert.equal(prescription.surfaces.length, 5);
  assert.deepEqual(
    prescription.surfaces.map((surface) => surface.label),
    ['OBJ', 'STO', '2', '3', 'IMA'],
  );
});

test('OBJ, STO and IMA are positions, not names', () => {
  const prescription = parsePrescription(REPORT);
  // `'STO'.replace('STO', '')` is `''` and `Number('')` is 0, so a stop read by
  // stripping its label lands on the object plane and every later surface is
  // compared against its neighbour.
  const stop = prescription.surfaces.find((surface) => surface.isStop);
  assert.equal(stop?.index, 1);
  assert.equal(prescription.surfaces[0]!.index, 0);
  assert.equal(prescription.surfaces.at(-1)!.index, 4);
});

test('the aspheric series starts at r squared', () => {
  const prescription = parsePrescription(REPORT);
  const asphere = prescription.surfaces[3]!;
  // PARM 1 / the first printed coefficient multiplies r², which is Isaac's
  // `asphericCoefficients[0]`. Off by one power and the lens still traces.
  assert.equal(asphere.asphericCoefficients.length, 8);
  assert.equal(asphere.asphericCoefficients[0]?.text, '0');
  assert.equal(asphere.asphericCoefficients[1]?.text, '1.234XXXXe-08');
});

test('the report states its own reference frame, and it is kept', () => {
  const prescription = parsePrescription(REPORT);
  assert.equal(prescription.conventions.length, 3);
  assert.ok(
    prescription.conventions.some((sentence) =>
      /image space positions are measured with respect to the image surface/i.test(sentence),
    ),
  );
});

test('the primary wavelength is the one named, not the first listed', () => {
  const prescription = parsePrescription(REPORT);
  assert.equal(prescription.wavelengths.length, 3);
  assert.equal(prescription.wavelengths[0]!.um, 0.486);
  assert.ok(Math.abs(primaryWavelengthNm(prescription)! - 589) < 0.5);
});

test('a clear diameter is halved and a clear semi-diameter is not', () => {
  const asDiameter = parsePrescription(REPORT).surfaces[1]!;
  assert.equal(asDiameter.clearDiameterIsSemi, false);

  const asSemi = parsePrescription(
    REPORT.replace('\tClear Diam          \t', '\tClear Semi-Diam     \t'),
  ).surfaces[1]!;
  assert.equal(asSemi.clearDiameterIsSemi, true);
  assert.equal(asSemi.clearDiameter?.text, asDiameter.clearDiameter?.text);
});

test('the general block is read even where one label appears twice', () => {
  const prescription = parsePrescription(REPORT);
  const inAir = prescription.general.filter((entry) => entry.label === 'Effective Focal Length');
  assert.equal(inAir.length, 2);
  assert.ok(inAir[0]!.extra.some((note) => note.includes('in air')));
  assert.ok(inAir[1]!.extra.some((note) => note.includes('image space')));
});

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

function compareFixture(report = REPORT): PrescriptionComparison {
  const { system } = importZmx(DOUBLET, { resolveMaterial: (name) => SCHOTT.get(name) });
  return comparePrescription(system, parsePrescription(report));
}

const disagreements = (comparison: PrescriptionComparison) =>
  comparison.checks.filter((check) => check.outcome === 'disagree').map((check) => check.item);

test('the fixture agrees everywhere except the error planted in it', () => {
  const comparison = compareFixture();
  // The fixture states an aspheric coefficient the doublet does not have, so
  // that this test proves a disagreement is *caught* rather than only that
  // agreement is reported. A comparison that silently skipped a row would pass
  // the first half of this and fail the second.
  assert.deepEqual(disagreements(comparison), ['surface 3 r^4']);
  assert.ok(comparison.agreed > 50);
});

test('a wrong radius is caught', () => {
  const comparison = compareFixture(REPORT.replace('92.847XX', '92.947XX'));
  assert.ok(disagreements(comparison).includes('surface STO radius'));
});

test('a wrong thickness is caught', () => {
  const comparison = compareFixture(
    REPORT.replace('\t                   6\t', '\t                   7\t'),
  );
  assert.ok(disagreements(comparison).includes('surface STO thickness'));
});

// ---------------------------------------------------------------------------
// The conventions, on a system whose answers are known by hand
//
// This is the check that matters, and the one the corpus could not make: every
// sample lens sits in air, where all three focal lengths coincide and the image
// surface is at the last vertex, so a comparison that ignored both conventions
// would pass on all of them. Here image space is a liquid of index 1.5.
// ---------------------------------------------------------------------------

/**
 * One refracting surface, R = 100, air into n = 1.5, with the image plane at the
 * focus. Then φ = 0.005, so the EFL is 200 while the image-space focal length is
 * n′/φ = 300 — and OpticStudio prints the first.
 */
function immersedSinglet(): OpticalSystem {
  return new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 100,
        thickness: 300,
        material: new ConstantMaterial('DEMO-LIQUID', 1.5),
        semiDiameter: 10,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    wavelengthsNm: [550],
  });
}

/**
 * The same lens as OpticStudio would report it. Every number here is derived by
 * hand from φ = 0.005 and n′ = 1.5, not taken from Isaac.
 */
function immersedReport(overrides: Record<string, string> = {}): string {
  const rows = {
    focalLengthObject: '-200',
    focalLengthImage: '200',
    focalPlaneObject: '-200',
    focalPlaneImage: '0',
    principalObject: '0',
    principalImage: '-200',
    ...overrides,
  };
  return [
    'System/Prescription Data',
    '',
    'GENERAL LENS DATA:',
    '',
    'Surfaces                : \t2',
    'Stop                    : \t1',
    'Effective Focal Length  : \t200\t(in air at system temperature and pressure)',
    'Primary Wavelength [µm] : \t0.55',
    ' ',
    'SURFACE DATA SUMMARY:',
    '',
    'Surf       \tType        \tRadius        \tThickness           \tGlass      \tClear Diam          \tConic        \tComment',
    ' OBJ\t STANDARD\t       Infinity\t       Infinity\t                     \t             0\t              0\t ',
    ' STO\t STANDARD\t            100\t            300\t        DEMO-LIQUID\t            20\t              0\t ',
    ' IMA\t STANDARD\t       Infinity\t               \t                     \t             0\t              0\t ',
    ' ',
    'CARDINAL POINTS:',
    '',
    'Object space positions are measured with respect to surface 1.',
    'Image space positions are measured with respect to the image surface.',
    'The index in both the object space and image space is considered.',
    '',
    '                                 \tObject Space           \tImage Space',
    'W = \t0.550000\t(Primary)',
    `Focal Length          : \t${rows.focalLengthObject}\t${rows.focalLengthImage}`,
    `Focal Planes          : \t${rows.focalPlaneObject}\t${rows.focalPlaneImage}`,
    `Principal Planes      : \t${rows.principalObject}\t${rows.principalImage}`,
    '',
  ].join('\r\n');
}

function immersedChecks(overrides?: Record<string, string>) {
  return comparePrescription(immersedSinglet(), parsePrescription(immersedReport(overrides)));
}

test('the focal length compared is the one referred to air', () => {
  const comparison = immersedChecks();
  const focal = comparison.checks.find((check) => check.item === 'focal length (image space)');
  assert.equal(focal?.outcome, 'agree');
  assert.equal(focal?.expected, '200');
});

test('a focal length that is neither reading is caught', () => {
  // The two legitimate readings are 200 (referred to air) and 300 (`n'/\u03c6`, in
  // the liquid). Anything else is a disagreement, which is what keeps this check
  // strong despite having to accept both.
  const comparison = immersedChecks({ focalLengthImage: '250' });
  assert.ok(disagreements(comparison).includes('focal length (image space)'));
  assert.ok(
    comparison.warnings.some((warning) =>
      /neither Isaac\u2019s EFL nor the EFL times/.test(warning),
    ),
  );
});

/**
 * **The same optic is reported two ways and both are correct**, which took two
 * exports of one lithography objective to discover: `7301707.zmx` states its
 * image space referred to air — focal length `1/\u03c6`, distances divided by the
 * water — and `7301707-spherical.zmx` states it in the water's own units, focal
 * length `n'/\u03c6` and distances left alone. Both reports carry the identical
 * sentence about the index being considered, so the frame has to be read off the
 * numbers rather than the prose.
 */
test('both ways of stating image space are accepted, and scale the positions with them', () => {
  const referredToAir = immersedChecks();
  assert.deepEqual(disagreements(referredToAir), []);

  // In the liquid's own units every image-space length is 1.5x the air-referred
  // one: the focal length, and the principal plane 200 mm of liquid back.
  const inTheLiquid = immersedChecks({ focalLengthImage: '300', principalImage: '-300' });
  assert.deepEqual(disagreements(inTheLiquid), []);

  // And the two are not interchangeable: air-referred numbers in a report the
  // focal length says is in the medium do not pass.
  assert.ok(
    disagreements(immersedChecks({ focalLengthImage: '300' })).includes('rear principal plane'),
    'a medium-referred focal length must scale the positions with it',
  );
});

test('an image-space position is measured from the image surface, index out', () => {
  const comparison = immersedChecks();
  for (const item of ['rear focal plane', 'rear principal plane']) {
    const check = comparison.checks.find((candidate) => candidate.item === item);
    assert.equal(check?.outcome, 'agree', `${item}: ${check?.expected} vs ${check?.actual}`);
  }
  // The rear principal plane is at the vertex, 300 mm of liquid before the image
  // surface: -300/1.5 = -200. Measuring from the last vertex would give 0, and
  // forgetting the index would give -300.
  for (const wrong of ['0', '-300']) {
    assert.ok(
      disagreements(immersedChecks({ principalImage: wrong })).includes('rear principal plane'),
      `${wrong} should not pass as the rear principal plane`,
    );
  }
});

test('an object-space position is measured from surface 1', () => {
  const comparison = immersedChecks();
  for (const item of ['front focal plane', 'front principal plane']) {
    assert.equal(
      comparison.checks.find((candidate) => candidate.item === item)?.outcome,
      'agree',
      item,
    );
  }
  assert.ok(
    disagreements(immersedChecks({ focalPlaneObject: '-300' })).includes('front focal plane'),
  );
});

test('a report that lists no fields is not read as a lens with none', () => {
  const comparison = immersedChecks();
  const fields = comparison.checks.find((check) => check.item === 'fields');
  assert.equal(fields?.outcome, 'unchecked');
});
