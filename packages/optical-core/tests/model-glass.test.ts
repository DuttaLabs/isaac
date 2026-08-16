import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelGlassMaterial,
  N_BK7,
  SPECTRAL_LINES,
  normalLinePartialDispersion,
} from '../src/index.ts';

const { d, F, C, g } = SPECTRAL_LINES;

/** Abbe number as measured from a material, rather than as declared. */
function abbeNumberOf(material: { indexAt(nm: number): number }): number {
  return (material.indexAt(d) - 1) / (material.indexAt(F) - material.indexAt(C));
}

function partialDispersionOf(material: { indexAt(nm: number): number }): number {
  return (material.indexAt(g) - material.indexAt(F)) / (material.indexAt(F) - material.indexAt(C));
}

test('a model glass hits the three numbers it was built from', () => {
  const glass = new ModelGlassMaterial('test', 1.5168, 64.17, { deltaPgF: -0.001 });

  assert.ok(Math.abs(glass.indexAt(d) - 1.5168) < 1e-12, 'nd is exact by construction');
  assert.ok(Math.abs(abbeNumberOf(glass) - 64.17) < 1e-9);
  assert.ok(
    Math.abs(partialDispersionOf(glass) - (normalLinePartialDispersion(64.17) - 0.001)) < 1e-9,
  );
});

test('the normal line is the one drawn through K7 and F2', () => {
  // Recomputing the line from those two glasses' real Sellmeier fits gives
  // 0.6442 − 0.001688·Vd, so these constants are right to four decimals.
  assert.ok(Math.abs(normalLinePartialDispersion(0) - 0.6438) < 1e-12);
  assert.ok(Math.abs(normalLinePartialDispersion(100) - (0.6438 - 0.1682)) < 1e-12);
  // A crown sits above a flint on the partial-dispersion axis.
  assert.ok(normalLinePartialDispersion(64) < normalLinePartialDispersion(36));
});

test('a model glass reproduces a real measured glass across the visible', () => {
  // Build N-BK7 from only the three numbers a patent would quote, then compare
  // against the measured Sellmeier fit the core carries.
  const nd = N_BK7.indexAt(d);
  const vd = abbeNumberOf(N_BK7);
  const model = new ModelGlassMaterial('N-BK7 (model)', nd, vd, {
    deltaPgF: partialDispersionOf(N_BK7) - normalLinePartialDispersion(vd),
  });

  let worst = 0;
  for (let nm = 400; nm <= 700; nm += 5) {
    worst = Math.max(worst, Math.abs(model.indexAt(nm) - N_BK7.indexAt(nm)));
  }
  assert.ok(worst < 1e-4, `model glass drifted ${worst} from the measured fit`);
});

test('dispersion runs the right way and is monotonic in the visible', () => {
  const glass = new ModelGlassMaterial('flint', 1.62, 36.37);

  // Normal dispersion: blue is bent more than red.
  assert.ok(glass.indexAt(F) > glass.indexAt(d));
  assert.ok(glass.indexAt(d) > glass.indexAt(C));

  let previous = Infinity;
  for (let nm = 420; nm <= 700; nm += 10) {
    const index = glass.indexAt(nm);
    assert.ok(index < previous, `index rose between ${nm - 10} and ${nm} nm`);
    previous = index;
  }
});

test('a lower Abbe number disperses more', () => {
  const crown = new ModelGlassMaterial('crown', 1.52, 64);
  const flint = new ModelGlassMaterial('flint', 1.62, 36);

  const spread = (m: ModelGlassMaterial): number => m.indexAt(F) - m.indexAt(C);
  assert.ok(spread(flint) > spread(crown));
});

test('inputs that cannot describe a glass are rejected', () => {
  assert.throws(() => new ModelGlassMaterial('x', 0, 64), /positive, finite nd/);
  assert.throws(() => new ModelGlassMaterial('x', Number.NaN, 64), /positive, finite nd/);
  // Vd = 0 would divide by zero; a negative one would disperse backwards.
  assert.throws(() => new ModelGlassMaterial('x', 1.5, 0), /positive, finite Abbe/);
  assert.throws(() => new ModelGlassMaterial('x', 1.5, -10), /positive, finite Abbe/);
  assert.throws(() => new ModelGlassMaterial('x', 1.5, 64).indexAt(0), /positive, finite/);
});
