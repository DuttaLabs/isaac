import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR, N_BK7, OpticalSystem, Surface } from '@isaac/optical-core';
import {
  allFieldIndices,
  computeFirstOrderRays,
  computeLayoutTraces,
  computeVolumeTraces,
} from '../src/lib/analysis.ts';

const WAVELENGTH_NM = 587.5618;

function singlet(angles: number[]): OpticalSystem {
  return new OpticalSystem({
    name: 'singlet',
    wavelengthsNm: [WAVELENGTH_NM],
    fields: angles.map((angleDeg) => ({ angleDeg })),
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 12 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 60,
        thickness: 5,
        semiDiameter: 15,
        material: N_BK7,
        isStop: true,
      }),
      new Surface({ id: 's2', type: 'STANDARD', radius: -60, thickness: 60, semiDiameter: 15 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 20 }),
    ],
  });
}

const fieldsIn = (traces: { fieldIndex: number }[]): number[] =>
  [...new Set(traces.map((trace) => trace.fieldIndex))].sort();

test('the layout traces only the fields it is given', () => {
  const system = singlet([0, 3, 5]);
  const all = computeLayoutTraces(system, { raysPerFan: 5, wavelengthIndices: [0] });
  assert.ok(all.ok);
  assert.deepEqual(fieldsIn(all.value), [0, 1, 2]);

  const some = computeLayoutTraces(system, {
    raysPerFan: 5,
    wavelengthIndices: [0],
    fieldIndices: [0, 2],
  });
  assert.ok(some.ok);
  assert.deepEqual(fieldsIn(some.value), [0, 2]);
  // Hiding a field costs its rays, not just their visibility: nothing is traced
  // for it at all.
  assert.equal(some.value.length, (all.value.length * 2) / 3);
});

test('the 3-D view honors the same field list', () => {
  const system = singlet([0, 3, 5]);
  const some = computeVolumeTraces(system, {
    gridCount: 3,
    wavelengthIndices: [0],
    fieldIndices: [1],
  });
  assert.ok(some.ok);
  assert.deepEqual(fieldsIn(some.value), [1]);
});

test('no fields to draw means no rays, not an error', () => {
  const empty = computeLayoutTraces(singlet([0, 3]), {
    raysPerFan: 5,
    wavelengthIndices: [0],
    fieldIndices: [],
  });
  assert.ok(empty.ok);
  assert.deepEqual(empty.value, []);
});

test('the construction rays come from the fields still on screen', () => {
  const system = singlet([0, 3, 5]);

  // With everything drawn, the chief ray belongs to the widest field.
  const all = computeFirstOrderRays(system);
  assert.ok(all.ok);
  assert.equal(all.value.chiefField, '5°');

  // Hide that one and it steps in to the next widest, rather than staying on a
  // field that is no longer being drawn.
  const narrowed = computeFirstOrderRays(system, [0, 1]);
  assert.ok(narrowed.ok);
  assert.equal(narrowed.value.chiefField, '3°');

  // The marginal ray comes from the innermost field on offer, so hiding the
  // axial one moves it too.
  const offAxis = computeFirstOrderRays(system, [1, 2]);
  assert.ok(offAxis.ok);
  assert.equal(offAxis.value.chiefField, '5°');
  const angle = Math.atan2(
    offAxis.value.marginal.inputRay.direction.y,
    offAxis.value.marginal.inputRay.direction.z,
  );
  assert.ok(Math.abs(angle - (3 * Math.PI) / 180) < 1e-12, 'marginal ray took the 3° field');
});

test('a system with no field list still has one bundle to draw', () => {
  // Fields are optional; the on-axis bundle is not.
  assert.deepEqual(allFieldIndices(singlet([])), [0]);
  const traces = computeLayoutTraces(singlet([]), { raysPerFan: 3, wavelengthIndices: [0] });
  assert.ok(traces.ok);
  assert.deepEqual(fieldsIn(traces.value), [0]);
});
