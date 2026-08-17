import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR, ModelGlassMaterial, SPECTRAL_LINES } from '@isaac/optical-core';
import { importZmx } from '@isaac/zemax-io';
import {
  GLASS_CATALOG,
  MODEL_MATERIAL_LABEL,
  isModelGlass,
  materialFromText,
  materialLabel,
  modelGlassFrom,
  modelGlassFromText,
  modelGlassParameters,
  modelGlassText,
} from '../src/lib/materials.ts';

const N_BK7 = GLASS_CATALOG.get('N-BK7')!;

/** Unwraps a parse the test expects to succeed. */
function parsed(text: string) {
  const result = modelGlassFromText(text);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value;
}

test('a named glass keeps its name, and air stays blank', () => {
  assert.equal(materialLabel(AIR), '');
  assert.equal(materialLabel(N_BK7), 'N-BK7');
  assert.equal(isModelGlass(N_BK7), false);
  assert.equal(modelGlassText(N_BK7), undefined, 'a catalog glass has no model parameters');

  // Names still resolve the way they did before the column was renamed,
  // including the blank-means-air and legacy-name cases.
  assert.equal(materialFromText('', AIR), AIR);
  assert.equal(materialFromText('  ', N_BK7), AIR);
  assert.equal(materialFromText('air', N_BK7), AIR);
  assert.equal(materialFromText('n bk7', AIR)?.name, 'N-BK7');
  assert.equal(materialFromText('BK7', AIR)?.name, 'N-BK7', 'legacy names are allowed');
  assert.equal(materialFromText('not a glass', AIR), undefined);
});

test('MODEL turns a real glass into its own numbers', () => {
  const converted = materialFromText(MODEL_MATERIAL_LABEL, N_BK7);
  assert.ok(converted instanceof ModelGlassMaterial);

  // The Abbe number is measured at the three lines it is defined by, so the
  // conversion must reproduce the catalog's own published pair exactly.
  assert.ok(Math.abs(converted.nd - N_BK7.nd) < 1e-12, `nd ${converted.nd} vs ${N_BK7.nd}`);
  assert.ok(
    Math.abs(converted.abbeNumber - N_BK7.abbeNumber) < 1e-9,
    `Vd ${converted.abbeNumber} vs ${N_BK7.abbeNumber}`,
  );
  assert.equal(materialLabel(converted), MODEL_MATERIAL_LABEL);
  assert.equal(modelGlassText(converted), '1.5168 / 64.17');

  // And it must trace like the glass it came from, not merely report its
  // numbers: this is the whole claim of a model glass.
  let worst = 0;
  for (let wavelength = 400; wavelength <= 700; wavelength += 5) {
    worst = Math.max(worst, Math.abs(converted.indexAt(wavelength) - N_BK7.indexAt(wavelength)));
  }
  assert.ok(worst < 1e-4, `worst index error across the visible is ${worst.toExponential(2)}`);
});

test('MODEL over a model glass keeps the glass it already has', () => {
  const glass = parsed('1.6200 / 36.37');
  // Identity, not equality. A fresh but equal glass would re-render the design
  // and push an undo step for a cell the user only tabbed through.
  assert.equal(materialFromText(MODEL_MATERIAL_LABEL, glass), glass);
  assert.equal(materialFromText('model', glass), glass, 'the label is not case-sensitive');
});

test('air has no dispersion to convert, so it starts from a placeholder', () => {
  const fresh = modelGlassFrom(AIR);
  // Air's index is exactly 1, which is not a glass; carrying it over would make
  // a "glass" that bends nothing and an Abbe number of 0/0.
  assert.equal(fresh.nd, 1.5);
  assert.equal(fresh.abbeNumber, 50);
  assert.equal(modelGlassText(fresh), '1.5000 / 50.00');
});

test('the parameters survive a round trip through the cell', () => {
  for (const text of ['1.5168 / 64.17', '1.6200 / 36.37', '1.7550 / 27.58 / -0.0210']) {
    assert.equal(modelGlassText(parsed(text)), text, `${text} did not round trip`);
  }
});

test('separators are loose, since the cell holds three numbers', () => {
  const expected = '1.5168 / 64.17';
  for (const text of [
    '1.5168 / 64.17',
    '1.5168/64.17',
    '1.5168, 64.17',
    '1.5168 64.17',
    '  1.5168,64.17  ',
  ]) {
    assert.equal(modelGlassText(parsed(text)), expected, `${text} did not parse`);
  }
  // A pasted minus sign is U+2212, and ΔPg,F is the parameter that is negative.
  assert.equal(modelGlassText(parsed('1.755 / 27.58 / −0.021')), '1.7550 / 27.58 / -0.0210');
});

test('nonsense is refused with a reason, not quietly accepted', () => {
  const refusals: [string, RegExp][] = [
    ['1.5168', /index and an Abbe number/],
    ['', /index and an Abbe number/],
    ['1.5 / 64 / 0 / 3', /index and an Abbe number/],
    ['crown / 64.17', /not a number/],
    ['0 / 64.17', /nd must be positive/],
    ['-1.5 / 64.17', /nd must be positive/],
    ['1.5168 / -10', /disperse backwards/],
  ];
  for (const [text, reason] of refusals) {
    const result = modelGlassFromText(text);
    assert.equal(result.ok, false, `"${text}" should be refused`);
    if (!result.ok) {
      assert.match(result.error, reason);
    }
  }
});

test('an Abbe number of zero means an index and no dispersion', () => {
  const glass = parsed('1.5605 / 0');
  // Not a ModelGlassMaterial: with no dispersion there is no curve to fit, and
  // this is exactly what a lens file's Vd = 0 says.
  assert.ok(!(glass instanceof ModelGlassMaterial));
  assert.equal(glass.indexAt(SPECTRAL_LINES.F), glass.indexAt(SPECTRAL_LINES.C));

  // It still belongs to the model glass column, and still reads back.
  assert.equal(materialLabel(glass), MODEL_MATERIAL_LABEL);
  assert.equal(modelGlassText(glass), '1.5605 / 0.00');
});

test('ΔPg,F changes the glass rather than just labeling it', () => {
  const normal = parsed('1.7550 / 27.58');
  const raised = parsed('1.7550 / 27.58 / 0.0400');

  const spread = (material: { indexAt(nm: number): number }): number =>
    material.indexAt(SPECTRAL_LINES.F) - material.indexAt(SPECTRAL_LINES.C);

  // ΔPg,F moves the blue end while leaving nd and nF − nC — the two numbers the
  // other parameters fix — where they were.
  assert.ok(Math.abs(spread(normal) - spread(raised)) < 1e-12, 'Vd must be untouched');
  assert.ok(
    raised.indexAt(SPECTRAL_LINES.g) - normal.indexAt(SPECTRAL_LINES.g) > 1e-4,
    'a raised partial dispersion must lift the index at the g line',
  );
  assert.equal(modelGlassParameters(raised)?.deltaPgF, 0.04);
});

/**
 * A patent design has no glass names in it, so this is the case the ~77 imported
 * lens files actually exercise: the file describes its glass inline and the
 * editor has to show it as parameters rather than as an unresolvable name.
 */
const MODEL_GLASS_FILE = `VERS 130404 0 24485
MODE SEQ
NAME MODEL GLASS SINGLET
UNIT MM X W X CM MR CPMM
ENPD 1.0E+1
FTYP 0 0 1 1 0 0 0
XFLN 0 0 0 0
YFLN 0 0 0 0
WAVM 1 5.876E-1 1
PWAV 1
SURF 0
  TYPE STANDARD
  CURV 0.0
  DISZ INFINITY
SURF 1
  STOP
  TYPE STANDARD
  CURV 2.0E-2
  DISZ 5.0
  GLAS ___BLANK 1 0 1.5168 6.417E+1 0 0 0 0 0 0
  DIAM 1.0E+1
SURF 2
  TYPE STANDARD
  CURV -2.0E-2
  DISZ 9.0E+1
  DIAM 1.0E+1
SURF 3
  TYPE STANDARD
  CURV 0.0
  DISZ 0
  DIAM 1.0E+1
`;

test('an imported model glass shows up as MODEL with its parameters', () => {
  const { system, warnings } = importZmx(MODEL_GLASS_FILE);
  const material = system.surfaceAt(1).material;

  // Before the column existed this cell showed the importer's internal name,
  // "___BLANK 1.5168/64.17", flagged red because no catalog has it.
  assert.equal(materialLabel(material), MODEL_MATERIAL_LABEL);
  assert.equal(modelGlassText(material), '1.5168 / 64.17');
  assert.ok(
    warnings.some((warning) => /model glass/i.test(warning)),
    'the import still says the glass is an approximation',
  );

  // Editing the cell replaces the glass without going through a name.
  const edited = modelGlassFromText('1.6200 / 36.37');
  assert.ok(edited.ok, edited.ok ? '' : edited.error);
  assert.ok(edited.value.indexAt(SPECTRAL_LINES.d) > material.indexAt(SPECTRAL_LINES.d));
});

test('a file giving an index but no Abbe number reads back as such', () => {
  const { system } = importZmx(
    MODEL_GLASS_FILE.replace(
      'GLAS ___BLANK 1 0 1.5168 6.417E+1 0 0 0 0 0 0',
      'GLAS ___BLANK 1 0 1.5605 0 0 0 0 0 0 0',
    ),
  );
  const material = system.surfaceAt(1).material;

  assert.equal(materialLabel(material), MODEL_MATERIAL_LABEL);
  assert.equal(modelGlassText(material), '1.5605 / 0.00');
});
