import assert from 'node:assert/strict';
import test from 'node:test';
import { DISPERSION_FORMULA, N_BK7 } from '@isaac/optical-core';
import {
  ALL_GLASSES,
  D_LINE_NM,
  GlassCatalog,
  GlassMaterial,
  OHARA,
  OHARA_GLASSES,
  SCHOTT,
  SCHOTT_GLASSES,
  normalizeGlassName,
} from '../src/index.ts';

/**
 * SCHOTT's published datasheet values. If a fit is transcribed wrongly these
 * are the numbers that move, so they are the check that matters most.
 */
const PUBLISHED: readonly (readonly [string, number, number])[] = [
  ['N-BK7', 1.5168, 64.17],
  ['F2', 1.62004, 36.37],
  ['N-SF11', 1.78472, 25.68],
  ['SF2', 1.64769, 33.85],
  ['N-SK16', 1.62041, 60.32],
  ['N-BAK4', 1.56883, 55.98],
];

test("the catalog reproduces SCHOTT's own, entry for entry", () => {
  assert.equal(SCHOTT.size, SCHOTT_GLASSES.length);
  assert.equal(SCHOTT.size, 366, 'the June 2025 catalog publishes 366 glasses');
  assert.ok(SCHOTT.names().includes('N-BK7'));
  assert.ok(SCHOTT.names().includes('F2'));

  for (const record of SCHOTT_GLASSES) {
    const [min, max] = record.rangeNm;
    assert.ok(min > 0 && max > min, `${record.name} has a bad range ${min}–${max}`);
    assert.equal(record.manufacturer, 'SCHOTT');
    assert.ok(record.coefficients.length > 0, `${record.name} has no coefficients`);
    for (const [index, value] of record.coefficients.entries()) {
      assert.ok(Number.isFinite(value), `${record.name} coefficient ${index} is not finite`);
    }
    assert.ok(record.nd > 1 && record.nd < 3, `${record.name} has an implausible nd ${record.nd}`);
    assert.ok(record.abbeNumber > 0, `${record.name} has a non-positive Abbe number`);
  }
});

test('a retired name is an entry of its own, not an alias', () => {
  // SCHOTT still publishes BK7 alongside N-BK7, so both resolve directly and
  // nothing has to map one onto the other. Their optical fits are identical...
  const bk7 = SCHOTT.get('BK7')!;
  const nbk7 = SCHOTT.get('N-BK7')!;
  assert.equal(bk7.name, 'BK7');
  assert.equal(nbk7.name, 'N-BK7');
  assert.deepEqual(bk7.record.coefficients, nbk7.record.coefficients);

  // ...but the records are not, which is the reason to keep both. They are
  // different products: SCHOTT publishes different valid ranges for them.
  assert.deepEqual(bk7.record.rangeNm, [310, 2325]);
  assert.deepEqual(nbk7.record.rangeNm, [300, 2500]);
  assert.equal(bk7.record.status, 'OBSOLETE');
  assert.equal(nbk7.record.status, 'PREFERRED');
});

test('each glass carries the dispersion formula its coefficients belong to', () => {
  // Nearly all of SCHOTT's catalog is Sellmeier, which is exactly why the one
  // exception has to travel with the glass rather than be assumed globally.
  const b270 = SCHOTT.get('B270')!;
  assert.equal(b270.record.formula, DISPERSION_FORMULA.SCHOTT);
  assert.equal(SCHOTT.get('N-BK7')!.record.formula, DISPERSION_FORMULA.SELLMEIER_1);

  const onSchottFormula = SCHOTT_GLASSES.filter(
    (record) => record.formula === DISPERSION_FORMULA.SCHOTT,
  );
  assert.deepEqual(
    onSchottFormula.map((record) => record.name),
    ['B270'],
  );

  // B270 is the glass that motivated a second formula: it blocks more sample
  // lens files than any other single name.
  assert.ok(Math.abs(b270.nd - 1.52308) < 5e-5, `B270 nd ${b270.nd}`);
  assert.ok(Math.abs(b270.abbeNumber - 58.571369) < 0.01, `B270 Vd ${b270.abbeNumber}`);
});

test("every fit reproduces the catalog's own printed nd and Abbe number", () => {
  // The strongest integrity check available: the catalog prints nd and Vd
  // independently of the coefficients, so recomputing them from the fit catches
  // a column read wrongly or a fit handed to the wrong equation.
  for (const record of SCHOTT_GLASSES) {
    const glass = SCHOTT.get(record.name)!;
    if (!glass.isWithinRange(486.1327) || !glass.isWithinRange(656.2725)) {
      continue; // an infrared fit has no F or C line to check against
    }
    assert.ok(
      Math.abs(glass.nd - record.nd) < 5e-5,
      `${record.name}: fit gives nd ${glass.nd.toFixed(6)}, catalog prints ${record.nd}`,
    );
    assert.ok(
      Math.abs(glass.abbeNumber - record.abbeNumber) < 0.01,
      `${record.name}: fit gives Vd ${glass.abbeNumber.toFixed(4)}, catalog prints ${record.abbeNumber}`,
    );
  }
});

test('computed nd and Abbe numbers match the published datasheet values', () => {
  for (const [name, nd, vd] of PUBLISHED) {
    const glass = SCHOTT.get(name);
    assert.ok(glass, `${name} is missing from the catalog`);
    assert.ok(
      Math.abs(glass.nd - nd) < 5e-5,
      `${name}: nd ${glass.nd.toFixed(5)}, published ${nd}`,
    );
    assert.ok(
      Math.abs(glass.abbeNumber - vd) < 0.01,
      `${name}: vd ${glass.abbeNumber.toFixed(2)}, published ${vd}`,
    );
  }
});

test('the catalog agrees with the copy of N-BK7 built into optical-core', () => {
  const fromCatalog = SCHOTT.get('N-BK7')!;
  for (const wavelength of [400, 486.1327, 587.5618, 656.2725, 1000, 2000]) {
    assert.ok(
      Math.abs(fromCatalog.indexAt(wavelength) - N_BK7.indexAt(wavelength)) < 1e-12,
      `N-BK7 disagrees at ${wavelength} nm`,
    );
  }
});

test('lookup ignores case and the separators lens files vary on', () => {
  const canonical = SCHOTT.get('N-BK7')!;
  for (const spelling of ['n-bk7', 'N BK7', 'nbk7', '  N-BK7  ', 'N_BK7']) {
    assert.equal(SCHOTT.get(spelling)?.name, canonical.name, `failed to resolve "${spelling}"`);
  }
  assert.equal(normalizeGlassName(' n_bk 7 '), 'NBK7');

  assert.equal(SCHOTT.get('NOT-A-GLASS'), undefined);
  assert.equal(SCHOTT.has('NOT-A-GLASS'), false);
});

test('an index outside the published fit range is refused, not extrapolated', () => {
  const nbk7 = SCHOTT.get('N-BK7')!;
  assert.deepEqual(nbk7.record.rangeNm, [300, 2500]);
  assert.ok(nbk7.isWithinRange(587.5618));
  assert.ok(!nbk7.isWithinRange(250));

  assert.throws(() => nbk7.indexAt(250), /outside the published fit range 300–2500 nm/);
  assert.throws(() => nbk7.indexAt(10000), /outside the published fit range/);

  // Extrapolation is available, but only by asking for it.
  const lenient = nbk7.with({ strictRange: false });
  assert.ok(Number.isFinite(lenient.indexAt(250)));
  assert.equal(lenient.indexAt(D_LINE_NM), nbk7.indexAt(D_LINE_NM));
});

test('nd and the Abbe number are refused when the fit does not cover the visible', () => {
  const infrared = new GlassMaterial({
    name: 'TEST-IR',
    manufacturer: 'SCHOTT',
    formula: DISPERSION_FORMULA.SELLMEIER_1,
    coefficients: [1, 0.01, 0, 0, 0, 0],
    rangeNm: [1000, 5000],
    nd: 1.5,
    abbeNumber: 50,
    status: 'SPECIAL',
  });

  assert.throws(() => infrared.nd, /needs the F and C lines/);
  assert.throws(() => infrared.abbeNumber, /needs the F and C lines/);
  assert.ok(Number.isFinite(infrared.indexAt(2000)));
});

test('a catalog rejects names that collide once normalized', () => {
  const record = SCHOTT_GLASSES[0]!;
  assert.throws(
    () => new GlassCatalog([record, { ...record, name: record.name.toLowerCase() }]),
    /indistinguishable after normalization/,
  );
});

test('the catalog exposes a resolver shaped for lens-file import', () => {
  const resolve = SCHOTT.resolver();
  assert.equal(resolve('N-BK7')?.name, 'N-BK7');
  // A retired name resolves to itself now that the catalog carries it, so a
  // file naming BK7 traces BK7 and the import reports no substitution at all.
  assert.equal(resolve('BK7')?.name, 'BK7');
});

test("Ohara's catalog is carried the same way SCHOTT's is", () => {
  assert.equal(OHARA.size, OHARA_GLASSES.length);
  assert.equal(OHARA.size, 433, "Ohara publishes 433 glasses, matching OpticStudio's library");
  for (const record of OHARA_GLASSES) {
    assert.equal(record.manufacturer, 'OHARA');
  }

  // S-BSL7 is Ohara's answer to N-BK7: the same workhorse crown, and a
  // genuinely different glass — nd 1.516330 against N-BK7's 1.516800. Both
  // catalogs are present at once and neither name reaches the other's entry.
  const bsl7 = OHARA.get('S-BSL7')!;
  assert.ok(Math.abs(bsl7.nd - 1.51633) < 5e-5, `S-BSL7 nd ${bsl7.nd}`);
  assert.ok(Math.abs(bsl7.abbeNumber - 64.142022) < 0.01, `S-BSL7 Vd ${bsl7.abbeNumber}`);
  assert.equal(SCHOTT.get('S-BSL7'), undefined);
  assert.equal(OHARA.get('N-BK7'), undefined);
});

test('Ohara leans on the Schott formula, which is why it had to exist', () => {
  // 188 of Ohara's 433 use dispersion formula 1. Added for B270 — one SCHOTT
  // glass — it turns out to carry 43% of the next catalog through the door.
  const onSchottFormula = OHARA_GLASSES.filter(
    (record) => record.formula === DISPERSION_FORMULA.SCHOTT,
  );
  assert.equal(onSchottFormula.length, 188);

  // Whichever formula a glass uses, its fit must rebuild the printed nd and Vd.
  for (const record of OHARA_GLASSES) {
    const glass = OHARA.get(record.name)!;
    if (!glass.isWithinRange(486.1327) || !glass.isWithinRange(656.2725)) {
      continue;
    }
    assert.ok(
      Math.abs(glass.nd - record.nd) < 5e-5,
      `${record.name}: fit gives nd ${glass.nd.toFixed(6)}, catalog prints ${record.nd}`,
    );
    assert.ok(
      Math.abs(glass.abbeNumber - record.abbeNumber) < 0.01,
      `${record.name}: fit gives Vd ${glass.abbeNumber.toFixed(4)}, prints ${record.abbeNumber}`,
    );
  }
});

test('one catalog spans every manufacturer, and refuses an ambiguous name', () => {
  // A .zmx names a glass, not the catalog it came from, so lookup has to span
  // makers. Both of these resolve from the one catalog.
  assert.equal(ALL_GLASSES.size, SCHOTT.size + OHARA.size);
  assert.equal(ALL_GLASSES.get('N-BK7')?.name, 'N-BK7');
  assert.equal(ALL_GLASSES.get('S-BSL7')?.name, 'S-BSL7');
  assert.equal(ALL_GLASSES.get('B270')?.record.manufacturer, 'SCHOTT');
  assert.equal(ALL_GLASSES.get('S-FPL51')?.record.manufacturer, 'OHARA');

  // If two makers ever ship one name, the combined catalog must not pick a
  // winner silently — the file would be ambiguous and the wrong glass traces.
  const schottRecord = SCHOTT_GLASSES[0]!;
  assert.throws(
    () => new GlassCatalog([schottRecord, { ...schottRecord, manufacturer: 'OHARA' }]),
    /indistinguishable after normalization/,
  );
});
