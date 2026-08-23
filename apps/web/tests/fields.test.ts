import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AIR, N_BK7, OpticalSystem, Surface } from '@isaac/optical-core';
import {
  FIELD_COLOR_VARIABLES,
  FIELD_OVERFLOW_VARIABLE,
  fieldLabel,
  fieldStyle,
} from '../src/lib/fields.ts';
import { buildLayout } from '../src/lib/layout.ts';
import { computeLayoutTraces } from '../src/lib/analysis.ts';

test('each field gets its own hue, in a fixed order', () => {
  const seen = FIELD_COLOR_VARIABLES.map((_, index) => fieldStyle(undefined, index).colorVariable);
  assert.deepEqual(seen, [...FIELD_COLOR_VARIABLES]);
  assert.equal(new Set(seen).size, seen.length, 'no hue is used twice');
});

test('fields past the palette share one neutral rather than reusing a hue', () => {
  // A repeated color would say two fields are the same thing. The legend names
  // the group instead.
  const beyond = FIELD_COLOR_VARIABLES.length;
  assert.equal(fieldStyle(undefined, beyond).colorVariable, FIELD_OVERFLOW_VARIABLE);
  assert.equal(fieldStyle(undefined, beyond + 5).colorVariable, FIELD_OVERFLOW_VARIABLE);
});

test('a field keeps its color when other fields are switched off', () => {
  // The rule that makes the Display checkboxes safe to use: color follows the
  // field's place in the system, never its place among the ones being drawn. If
  // it followed the drawn order, hiding field 0 would repaint every other field.
  const system = new OpticalSystem({
    name: 'three fields',
    wavelengthsNm: [587.5618],
    fields: [{ angleDeg: 0 }, { angleDeg: 3 }, { angleDeg: 5 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 60,
        thickness: 4,
        semiDiameter: 12,
        material: N_BK7,
        isStop: true,
      }),
      new Surface({ id: 's2', type: 'STANDARD', radius: -60, thickness: 55, semiDiameter: 12 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 12 }),
    ],
  });

  const colorsFor = (fieldIndices: number[]): string[] => {
    const traces = computeLayoutTraces(system, {
      raysPerFan: 3,
      wavelengthIndices: [0],
      fieldIndices,
    });
    assert.ok(traces.ok);
    const layout = buildLayout(system, traces.value, 10);
    return [
      ...new Set(
        layout.rayPaths.map((path) => fieldStyle(undefined, path.fieldIndex).colorVariable),
      ),
    ];
  };

  const everything = colorsFor([0, 1, 2]);
  assert.deepEqual(everything, [
    FIELD_COLOR_VARIABLES[0],
    FIELD_COLOR_VARIABLES[1],
    FIELD_COLOR_VARIABLES[2],
  ]);

  // Drop the middle field: the survivors keep slots 1 and 3, not 1 and 2.
  assert.deepEqual(colorsFor([0, 2]), [FIELD_COLOR_VARIABLES[0], FIELD_COLOR_VARIABLES[2]]);
  // Drop the axial one: the 5° field is still the third hue.
  assert.deepEqual(colorsFor([2]), [FIELD_COLOR_VARIABLES[2]]);
});

test('a field reads by its angle or height, and by name when it has neither', () => {
  assert.equal(fieldLabel({ angleDeg: 5 }), '5°');
  assert.equal(fieldLabel({ angleDeg: -7.25 }), '-7.25°');
  assert.equal(fieldLabel({ objectHeight: 12 }), '12 height');
  assert.equal(fieldLabel(undefined), 'on axis');
});

test('every series token is defined in all three theme scopes', () => {
  // The palette is three parallel blocks — light, the dark media query, and the
  // dark toggle stamp — and a token added to one and not the others falls back
  // to nothing in whichever theme was missed, which stays invisible until
  // somebody switches theme.
  const css = readFileSync(fileURLToPath(new URL('../src/theme.css', import.meta.url)), 'utf8');
  const tokens = [
    ...FIELD_COLOR_VARIABLES,
    FIELD_OVERFLOW_VARIABLE,
    '--marginal-ray',
    '--chief-ray',
    '--pupil',
    '--mirror',
    '--wave-blue',
    '--wave-green',
    '--wave-red',
  ];
  for (const token of tokens) {
    const declarations = css.match(new RegExp(`${token}:`, 'g')) ?? [];
    assert.equal(
      declarations.length,
      3,
      `${token} is declared ${declarations.length} times, want 3`,
    );
  }
});
