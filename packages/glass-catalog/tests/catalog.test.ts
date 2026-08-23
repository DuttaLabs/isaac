import assert from 'node:assert/strict';
import test from 'node:test';
import { N_BK7 } from '@isaac/optical-core';
import {
  D_LINE_NM,
  GlassCatalog,
  GlassMaterial,
  SCHOTT,
  SCHOTT_GLASSES,
  SCHOTT_RENAMES,
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

test('a retired name resolves to the same glass without being asked', () => {
  // BK7 is the name SCHOTT retired for N-BK7. It needs no opt-in, because the
  // two are not different glasses: SCHOTT's own catalog gives the retired name
  // the dispersion N-BK7 has, which is how the pair was verified.
  const lookup = SCHOTT.lookup('BK7');
  assert.equal(lookup?.glass.name, 'N-BK7');
  assert.equal(lookup?.renamedFrom, 'BK7');
  // A rename is not a substitution, and must not be reported as one.
  assert.equal(lookup?.substitutedFor, undefined);

  // Spelling is normalized before the rename is looked up, as for any name.
  assert.equal(SCHOTT.get('bafn 10')?.name, 'N-BAF10');
  // Glasses still in the catalog under their own name are untouched.
  assert.equal(SCHOTT.lookup('F2')?.renamedFrom, undefined);
});

test('a guess from the spelling is a substitution, and stays opt-in', () => {
  // BAF10 is not in SCHOTT's catalog at all, so there is nothing to verify it
  // against: reaching N-BAF10 from it is inference from the name. Contrast
  // BAFN10, which SCHOTT does still list and which was checked against N-BAF10.
  assert.equal(SCHOTT.get('BAF10'), undefined);
  assert.equal(SCHOTT.get('BAFN10')?.name, 'N-BAF10');

  const lenient = SCHOTT.with({ allowLegacyNames: true });
  const lookup = lenient.lookup('BAF10');
  assert.equal(lookup?.glass.name, 'N-BAF10');
  assert.equal(lookup?.substitutedFor, 'BAF10');
  assert.equal(lookup?.renamedFrom, undefined);

  // A name with no N- counterpart stays unresolved even when lenient.
  assert.equal(lenient.get('NOT-A-GLASS'), undefined);
  // Enabling substitution does not turn a verified rename into one.
  assert.equal(lenient.lookup('BAFN10')?.substitutedFor, undefined);
  assert.equal(lenient.lookup('BAFN10')?.renamedFrom, 'BAFN10');
});

test('every retired name points at a glass that is actually in the catalog', () => {
  // The table is generated against a specific schott.ts; if that file is
  // regenerated and a glass disappears, the alias must not resolve to nothing.
  for (const [legacy, current] of SCHOTT_RENAMES) {
    assert.ok(SCHOTT.has(current), `${legacy} points at missing glass ${current}`);
    assert.equal(SCHOTT.get(legacy)?.name, current, `${legacy} did not resolve to ${current}`);
  }
});

test('a retired name that is also a live glass is a contradiction, and refused', () => {
  const record = SCHOTT.records().find((entry) => entry.name === 'N-BK7')!;
  assert.throws(
    () => new GlassCatalog([record], {}, [['N-BK7', 'N-BK7']]),
    /is itself in the catalog/,
  );
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
  assert.equal(resolve('BK7')?.name, 'N-BK7'); // retired name, same glass
  assert.equal(resolve('BAF10'), undefined); // a guess, so it needs opting in
  assert.equal(SCHOTT.with({ allowLegacyNames: true }).resolver()('BAF10')?.name, 'N-BAF10');
});
