import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR,
  ConstantMaterial,
  DISPERSION_FORMULA,
  N_BK7,
  SchottDispersionMaterial,
  SellmeierMaterial,
  dispersionMaterial,
} from '../src/index.ts';

test('AIR has unit index at any wavelength', () => {
  assert.equal(AIR.indexAt(486.1), 1);
  assert.equal(AIR.indexAt(656.3), 1);
});

test('ConstantMaterial is non-dispersive and validated', () => {
  const glass = new ConstantMaterial('DEMO', 1.5);
  assert.equal(glass.indexAt(400), 1.5);
  assert.equal(glass.indexAt(700), 1.5);
  assert.throws(() => new ConstantMaterial('BAD', 0), /positive/);
});

test('N-BK7 reproduces catalog indices via Sellmeier', () => {
  // Reference values for Schott N-BK7 at the standard spectral lines.
  assert.ok(Math.abs(N_BK7.indexAt(587.5618) - 1.5168) < 1e-4); // d-line
  assert.ok(Math.abs(N_BK7.indexAt(486.1327) - 1.52238) < 1e-4); // F-line
  assert.ok(Math.abs(N_BK7.indexAt(656.2725) - 1.51432) < 1e-4); // C-line
  // Normal dispersion: shorter wavelength → higher index.
  assert.ok(N_BK7.indexAt(486) > N_BK7.indexAt(656));
});

test('SellmeierMaterial rejects invalid wavelengths', () => {
  const m = new SellmeierMaterial('DEMO', { b1: 1, b2: 0, b3: 0, c1: 0.01, c2: 0.02, c3: 100 });
  assert.throws(() => m.indexAt(0), /positive/);
});

/**
 * SCHOTT's published fit for B270, a soda-lime sheet glass and the one entry in
 * their catalog still written on the older Schott formula rather than Sellmeier.
 * The catalog prints nd = 1.523080 and Vd = 58.571369 independently of these
 * coefficients, so rebuilding both from the fit is what checks the equation.
 */
const B270 = [2.286575, -0.0087334582, 0.011742884, 0.00029041756, -0.000012506695, 9.2646253e-7];

test('the Schott formula reproduces B270 as its catalog prints it', () => {
  const glass = new SchottDispersionMaterial('B270', {
    a0: B270[0]!,
    a1: B270[1]!,
    a2: B270[2]!,
    a3: B270[3]!,
    a4: B270[4]!,
    a5: B270[5]!,
  });

  const nd = glass.indexAt(587.5618);
  const vd = (nd - 1) / (glass.indexAt(486.1327) - glass.indexAt(656.2725));
  assert.ok(Math.abs(nd - 1.52308) < 1e-6, `nd ${nd}`);
  assert.ok(Math.abs(vd - 58.571369) < 1e-4, `Vd ${vd}`);
  assert.ok(glass.indexAt(486) > glass.indexAt(656), 'normal dispersion');
  assert.throws(() => glass.indexAt(0), /positive/);
});

test('a catalog entry is built from its own formula number, not an assumed one', () => {
  const asSchott = dispersionMaterial('B270', DISPERSION_FORMULA.SCHOTT, B270);
  assert.ok(asSchott instanceof SchottDispersionMaterial);
  assert.ok(Math.abs(asSchott.indexAt(587.5618) - 1.52308) < 1e-6);

  // The same six numbers read as a Sellmeier fit still return an index — which
  // is exactly why the formula number has to travel with the coefficients
  // rather than being assumed from the manufacturer.
  const asSellmeier = dispersionMaterial('B270', DISPERSION_FORMULA.SELLMEIER_1, B270);
  assert.ok(asSellmeier instanceof SellmeierMaterial);
  assert.ok(
    Math.abs(asSellmeier.indexAt(587.5618) - 1.52308) > 0.1,
    'a wrong reading is not close',
  );

  // Sellmeier coefficients are interleaved B C B C B C in a catalog, and the
  // material wants them grouped; getting that wrong is a silent transposition.
  const nbk7 = dispersionMaterial(
    'N-BK7',
    DISPERSION_FORMULA.SELLMEIER_1,
    [1.03961212, 0.00600069867, 0.231792344, 0.0200179144, 1.01046945, 103.560653],
  );
  assert.ok(Math.abs(nbk7.indexAt(587.5618) - N_BK7.indexAt(587.5618)) < 1e-12);
});

test('an unimplemented dispersion formula is refused, not approximated', () => {
  // Formula 3 is Herzberger; no SCHOTT glass uses it, so it is not implemented
  // and must say so rather than fall through to whichever one is handy.
  assert.throws(() => dispersionMaterial('X', 3, B270), /formula 3 is not implemented/);
  assert.throws(() => dispersionMaterial('X', 3, B270), /2 \(SELLMEIER_1\)/);
  // Too few coefficients is a truncated record, not a usable fit.
  assert.throws(() => dispersionMaterial('X', DISPERSION_FORMULA.SCHOTT, [1, 2]), /needs 6/);
});
