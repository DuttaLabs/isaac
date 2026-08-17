import assert from 'node:assert/strict';
import test from 'node:test';
import { N_BK7 } from '@isaac/optical-core';
import {
  D_LINE_NM,
  GlassCatalog,
  GlassMaterial,
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

test('the catalog carries the SCHOTT glasses with usable Sellmeier fits', () => {
  assert.equal(SCHOTT.size, SCHOTT_GLASSES.length);
  assert.ok(SCHOTT.size > 150, `expected a full catalog, got ${SCHOTT.size} glasses`);
  assert.ok(SCHOTT.names().includes('N-BK7'));
  assert.ok(SCHOTT.names().includes('F2'));

  // Every record must be a complete three-term fit over a positive range.
  for (const record of SCHOTT_GLASSES) {
    const [min, max] = record.rangeNm;
    assert.ok(min > 0 && max > min, `${record.name} has a bad range ${min}–${max}`);
    assert.equal(record.manufacturer, 'SCHOTT');
    for (const key of ['b1', 'b2', 'b3', 'c1', 'c2', 'c3'] as const) {
      assert.ok(Number.isFinite(record.coefficients[key]), `${record.name}.${key} is not finite`);
    }
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

test('obsolete names resolve only when legacy substitution is enabled', () => {
  // BK7 was replaced by the lead-free N-BK7 and is no longer in the catalog.
  assert.equal(SCHOTT.get('BK7'), undefined);

  const lenient = SCHOTT.with({ allowLegacyNames: true });
  const lookup = lenient.lookup('BK7');
  assert.equal(lookup?.glass.name, 'N-BK7');
  assert.equal(lookup?.substitutedFor, 'BK7');

  // A name with no N- counterpart stays unresolved even when lenient.
  assert.equal(lenient.get('NOT-A-GLASS'), undefined);
  // Glasses that are still in the catalog are never substituted.
  assert.equal(lenient.lookup('F2')?.substitutedFor, undefined);
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
    catalog: 'infrared',
    coefficients: { b1: 1, b2: 0, b3: 0, c1: 0.01, c2: 0, c3: 0 },
    rangeNm: [1000, 5000],
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
  assert.equal(resolve('BK7'), undefined);
  assert.equal(SCHOTT.with({ allowLegacyNames: true }).resolver()('BK7')?.name, 'N-BK7');
});
