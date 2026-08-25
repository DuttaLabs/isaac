import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR,
  N_BK7,
  OpticalSystem,
  Surface,
  entrancePupil,
  entrancePupilRadius,
} from '@isaac/optical-core';
import { computeFirstOrderRays } from '../src/lib/analysis.ts';
import { pupilAim } from '../src/lib/layout.ts';

const WAVELENGTH_NM = 587.5618;

/** A singlet with the stop behind it, so the entrance pupil is not at a vertex. */
function singlet(fields: { angleDeg: number }[]): OpticalSystem {
  return new OpticalSystem({
    name: 'singlet',
    wavelengthsNm: [WAVELENGTH_NM],
    fields,
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
      }),
      new Surface({ id: 's2', type: 'STANDARD', radius: -60, thickness: 10, semiDiameter: 15 }),
      new Surface({ id: 'stop', type: 'STANDARD', thickness: 90, semiDiameter: 8, isStop: true }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 20 }),
    ],
  });
}

/** Height of a ray at a given z, from its launch point and direction. */
function heightAt(
  origin: { y: number; z: number },
  direction: { y: number; z: number },
  z: number,
) {
  return origin.y + ((z - origin.z) / direction.z) * direction.y;
}

test('the marginal ray grazes the pupil rim and the chief ray goes through its center', () => {
  // This is the whole definition, and the reason the overlay is worth drawing:
  // one ray meets the aperture, the other meets the field.
  const system = singlet([{ angleDeg: 0 }, { angleDeg: 4 }]);
  const result = computeFirstOrderRays(system);
  assert.ok(result.ok);

  const pupil = entrancePupil(system);
  const radius = entrancePupilRadius(system);

  const marginal = result.value.marginal.inputRay;
  assert.ok(
    Math.abs(heightAt(marginal.origin, marginal.direction, pupil.z) - radius) < 1e-9,
    'the marginal ray must reach the pupil at exactly its rim',
  );

  const chief = result.value.chief.inputRay;
  assert.ok(
    Math.abs(heightAt(chief.origin, chief.direction, pupil.z)) < 1e-9,
    'the chief ray must cross the axis in the pupil plane',
  );
  // ...and away from that plane it is well off axis, so it really is the field
  // ray rather than an axial one that happens to pass through the center.
  assert.ok(Math.abs(heightAt(chief.origin, chief.direction, 0)) > 1);
});

test('the marginal ray is taken from the axis and the chief ray from the outermost field', () => {
  const system = singlet([{ angleDeg: 0 }, { angleDeg: 4 }]);
  const { marginal, chief } = (() => {
    const result = computeFirstOrderRays(system);
    assert.ok(result.ok);
    return result.value;
  })();

  // Field 0 is on axis: a collimated marginal ray runs parallel to it.
  assert.ok(Math.abs(marginal.inputRay.direction.y) < 1e-12);
  // The chief ray carries the 4° field angle.
  assert.ok(
    Math.abs(
      Math.atan2(chief.inputRay.direction.y, chief.inputRay.direction.z) - (4 * Math.PI) / 180,
    ) < 1e-12,
  );
});

test('the outermost field is found rather than assumed to be last', () => {
  // Nothing makes a design list its fields in order, and taking the last one
  // would draw the chief ray of whichever field happened to be typed last.
  const shuffled = computeFirstOrderRays(
    singlet([{ angleDeg: 0 }, { angleDeg: 6 }, { angleDeg: 3 }]),
  );
  assert.ok(shuffled.ok);
  assert.equal(shuffled.value.chiefField, '6°');

  const negative = computeFirstOrderRays(singlet([{ angleDeg: 0 }, { angleDeg: -7 }]));
  assert.ok(negative.ok);
  assert.equal(negative.value.chiefField, '-7°');
});

test('a system with no fields still gives both rays, on axis', () => {
  const result = computeFirstOrderRays(singlet([]));
  assert.ok(result.ok);
  assert.equal(result.value.chiefField, 'on axis');
  assert.ok(Math.abs(result.value.chief.inputRay.direction.y) < 1e-12);
});

test('a system with no aperture is refused rather than drawn wrong', () => {
  const system = singlet([{ angleDeg: 0 }]).with({ aperture: undefined });
  // FLOAT_BY_STOP would still work; an aperture that cannot size the pupil at
  // all must come back as an error the panel can show, not as a blank overlay.
  const noStop = new OpticalSystem({
    name: 'no stop',
    wavelengthsNm: [WAVELENGTH_NM],
    fields: [{ angleDeg: 0 }],
    surfaces: system.surfaces.map((surface) => surface.with({ isStop: false })),
  });
  const result = computeFirstOrderRays(noStop);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /aperture/i);
});

test('the marginal ray produced undeviated lands on the pupil rim', () => {
  // The drawn construction, checked as geometry rather than by eye: continue the
  // ray as it arrived, ignoring the refraction at the first surface, and it must
  // reach the pupil plane at exactly the pupil radius. That equality is the
  // whole claim the dashed extension makes on screen.
  const system = singlet([{ angleDeg: 0 }]);
  const result = computeFirstOrderRays(system);
  assert.ok(result.ok);

  const pupil = entrancePupil(system);
  const aim = pupilAim(result.value.marginal, pupil.z);
  assert.ok(aim);
  assert.ok(
    Math.abs(aim.atPupil.v - entrancePupilRadius(system)) < 1e-9,
    `produced ray reaches the pupil at ${aim.atPupil.v}, rim is ${entrancePupilRadius(system)}`,
  );

  // This system's stop is behind the glass, so the pupil is virtual and inside
  // it: there really is something to produce, and the segment runs forwards.
  assert.equal(aim.produced, true);
  assert.ok(pupil.z > aim.contact.h);
});

test('nothing is produced when the pupil sits in front of the glass', () => {
  // With the stop on the first surface the entrance pupil is at its vertex, so
  // the traced ray already passes through it. Drawing a dashed extension there
  // would just be laid over the solid ray.
  const system = singlet([{ angleDeg: 0 }]).with({
    surfaces: singlet([{ angleDeg: 0 }]).surfaces.map((surface, index) =>
      surface.with({ isStop: index === 1 }),
    ),
  });
  const result = computeFirstOrderRays(system);
  assert.ok(result.ok);

  const aim = pupilAim(result.value.marginal, entrancePupil(system).z);
  assert.ok(aim);
  assert.equal(aim.produced, false);
  // The crossing is still the pupil rim, which is what the dot marks.
  assert.ok(Math.abs(aim.atPupil.v - entrancePupilRadius(system)) < 1e-9);
});

test('a ray that never reaches a surface has no pupil construction to draw', () => {
  const system = singlet([{ angleDeg: 0 }]);
  const result = computeFirstOrderRays(system);
  assert.ok(result.ok);
  const missed = { ...result.value.marginal, intersections: [] };
  assert.equal(pupilAim(missed, 0), undefined);
});
