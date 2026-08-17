import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR, ConstantMaterial, N_BK7, SellmeierMaterial } from '../src/index.ts';

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
