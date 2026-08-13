import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR,
  ConstantMaterial,
  OpticalSystem,
  Surface,
  entrancePupil,
  entrancePupilRadius,
  entrancePupilZ,
  exitPupil,
  generateChiefRay,
  generateMarginalRay,
  generateRay,
  traceRay,
} from '../src/index.ts';

const GLASS = new ConstantMaterial('DEMO-GLASS', 1.5);
const WAVELENGTH_NM = 587.5618;

/** An equiconvex thin lens of focal length 50, as a pair of surfaces. */
function thinLensSurfaces(gapAfter: number, semiDiameter = 25): Surface[] {
  return [
    new Surface({ id: 'l1', type: 'STANDARD', radius: 50, thickness: 1e-9, semiDiameter, material: GLASS }),
    new Surface({ id: 'l2', type: 'STANDARD', radius: -50, thickness: gapAfter, semiDiameter, material: AIR }),
  ];
}

/**
 * Lens first, stop 25 behind it (= f/2). Imaging the stop back through the lens
 * with 1/v = 1/f + 1/u, u = −25, f = 50 puts the entrance pupil at v = −50 in
 * the reversed frame — i.e. 50 *behind* the lens — magnified ×2.
 */
function stopBehindLens(stopSemiDiameter = 5): OpticalSystem {
  return new OpticalSystem({
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'FLOAT_BY_STOP' },
    fields: [{ angleDeg: 0 }, { angleDeg: 5 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      ...thinLensSurfaces(25),
      new Surface({
        id: 'stop',
        type: 'STANDARD',
        radius: Infinity,
        thickness: 25,
        semiDiameter: stopSemiDiameter,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
}

/** The mirror image of the above: stop 25 in front of the lens. */
function stopBeforeLens(): OpticalSystem {
  return new OpticalSystem({
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'FLOAT_BY_STOP' },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'stop',
        type: 'STANDARD',
        radius: Infinity,
        thickness: 25,
        semiDiameter: 5,
        isStop: true,
      }),
      ...thinLensSurfaces(50),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
}

test('the model accepts exactly one stop, and only on a standard surface', () => {
  const system = stopBehindLens();
  assert.equal(system.stopIndex, 3);
  assert.equal(system.surfaceAt(3).isStop, true);
  assert.equal(stopBeforeLens().stopIndex, 1);

  assert.throws(
    () => new Surface({ id: 'img', type: 'IMAGE', thickness: 0, isStop: true }),
    /Only a STANDARD surface/,
  );
  assert.throws(
    () =>
      new OpticalSystem({
        surfaces: [
          new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
          new Surface({ id: 'a', type: 'STANDARD', radius: 50, thickness: 5, semiDiameter: 5, isStop: true }),
          new Surface({ id: 'b', type: 'STANDARD', radius: -50, thickness: 5, semiDiameter: 5, isStop: true }),
          new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
        ],
      }),
    /at most one aperture stop/,
  );
});

test('a stop behind the lens images to a magnified virtual entrance pupil', () => {
  const pupil = entrancePupil(stopBehindLens());

  assert.ok(Math.abs(pupil.z - 50) < 1e-6, `entrance pupil at z=${pupil.z}, expected 50`);
  assert.ok(Math.abs(pupil.magnification - 2) < 1e-6);
  assert.ok(Math.abs(pupil.radius - 10) < 1e-6);
  assert.equal(pupil.stopIndex, 3);

  // Nothing follows the stop, so the exit pupil is the stop itself.
  const exit = exitPupil(stopBehindLens());
  assert.ok(Math.abs(exit.z - 25) < 1e-6);
  assert.ok(Math.abs(exit.radius - 5) < 1e-6);
  assert.ok(Math.abs(exit.magnification - 1) < 1e-9);
});

test('a stop in front of the lens is its own entrance pupil and images to the exit pupil', () => {
  const system = stopBeforeLens();

  const entrance = entrancePupil(system);
  assert.ok(Math.abs(entrance.z - 0) < 1e-9); // the stop is surface 1, anchored at z = 0
  assert.ok(Math.abs(entrance.radius - 5) < 1e-9);
  assert.ok(Math.abs(entrance.magnification - 1) < 1e-9);

  // The lens sits at z = 25; the stop images 50 to its left, magnified ×2.
  const exit = exitPupil(system);
  assert.ok(Math.abs(exit.z + 25) < 1e-6, `exit pupil at z=${exit.z}, expected −25`);
  assert.ok(Math.abs(exit.radius - 10) < 1e-6);
  assert.ok(Math.abs(exit.magnification - 2) < 1e-6);
});

test('a stop at the rear focal plane makes object space telecentric', () => {
  // A single refracting surface of power (n′−n)/R = 0.01 focuses collimated light
  // at n′/φ = 150 inside the glass. A stop there images to infinity in object
  // space, so there is no finite entrance pupil to aim at.
  const system = new OpticalSystem({
    wavelengthsNm: [WAVELENGTH_NM],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 's1', type: 'STANDARD', radius: 50, thickness: 150, semiDiameter: 25, material: GLASS }),
      new Surface({ id: 'stop', type: 'STANDARD', radius: Infinity, thickness: 10, semiDiameter: 5, isStop: true }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
  assert.throws(() => entrancePupil(system), /object-space telecentric/);
});

test('FLOAT_BY_STOP sizes the pupil from the stop image', () => {
  assert.ok(Math.abs(entrancePupilRadius(stopBehindLens()) - 10) < 1e-6);
  assert.ok(Math.abs(entrancePupilZ(stopBehindLens()) - 50) < 1e-6);
  // Doubling the stop doubles the pupil.
  assert.ok(Math.abs(entrancePupilRadius(stopBehindLens(10)) - 20) < 1e-6);
});

test('the stop needs a finite semi-diameter to define a pupil', () => {
  const system = stopBehindLens();
  const unbounded = system.withSurfaceAt(3, system.surfaceAt(3).with({ semiDiameter: Infinity }));
  assert.throws(() => entrancePupil(unbounded), /finite semi-diameter/);
});

test('chief and marginal rays are aimed at the solved pupil, not at surface 1', () => {
  const system = stopBehindLens();
  const pupil = entrancePupil(system);

  const chief = generateChiefRay(system, { field: 1 }); // 5°
  // The chief ray must cross the axis in the entrance pupil plane at z = 50.
  const toPupil = (pupil.z - chief.origin.z) / chief.direction.z;
  const atPupil = chief.at(toPupil);
  assert.ok(Math.abs(atPupil.y) < 1e-9, `chief ray misses the pupil centre by ${atPupil.y}`);
  // Aiming at surface 1 instead would have put it on axis at z = 0; it is not.
  const atSurface1 = chief.at((0 - chief.origin.z) / chief.direction.z);
  assert.ok(Math.abs(atSurface1.y) > 1, 'chief ray should not cross the axis at the first surface');

  const marginal = generateMarginalRay(system, { field: 1 });
  const marginalAtPupil = marginal.at((pupil.z - marginal.origin.z) / marginal.direction.z);
  assert.ok(Math.abs(marginalAtPupil.y - pupil.radius) < 1e-9);
  assert.ok(Math.abs(generateMarginalRay(system, { edge: -1 }).origin.y + pupil.radius) < 1e-9);
});

/**
 * A physically proportioned singlet with the stop 20 mm behind it. Used for real
 * ray tracing, where the idealized thin lens above would be degenerate (its two
 * sags overlap at large heights).
 */
function singletWithInternalStop(): OpticalSystem {
  return new OpticalSystem({
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'FLOAT_BY_STOP' },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 's1', type: 'STANDARD', radius: 50, thickness: 5, semiDiameter: 25, material: GLASS }),
      new Surface({ id: 's2', type: 'STANDARD', radius: Infinity, thickness: 20, semiDiameter: 25 }),
      new Surface({ id: 'stop', type: 'STANDARD', radius: Infinity, thickness: 80, semiDiameter: 3, isStop: true }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
}

test('the solved pupil maps real rays onto the stop', () => {
  const system = singletWithInternalStop();
  const stopRadius = system.surfaceAt(3).semiDiameter;

  // A positive lens in front magnifies the stop into a virtual pupil behind it.
  const pupil = entrancePupil(system);
  assert.ok(pupil.radius > stopRadius);
  assert.ok(pupil.z > system.vertexZAt(3));

  const inner = traceRay(system, generateRay(system, { px: 0, py: 0.99 }));
  assert.equal(inner.status, 'TERMINATED');
  const atStop = inner.intersections.find((hit) => hit.surfaceIndex === 3)!;
  assert.ok(
    Math.abs(atStop.point.y - 0.99 * stopRadius) < 0.01,
    `ray at 99% of the pupil reaches y=${atStop.point.y}, expected ≈ ${0.99 * stopRadius}`,
  );

  // The chief ray runs down the axis for the on-axis field.
  const chief = traceRay(system, generateChiefRay(system));
  assert.equal(chief.status, 'TERMINATED');
  assert.ok(Math.abs(chief.finalRay.origin.y) < 1e-12);
});

test('pupil aiming is paraxial, so the rim maps onto the stop edge only to first order', () => {
  const system = singletWithInternalStop();
  const stopRadius = system.surfaceAt(3).semiDiameter;

  // Aimed exactly at the pupil rim, the real ray misses the stop edge by its
  // residual spherical aberration and is clipped. Closing that gap needs
  // iterative (real) ray aiming, which is not implemented.
  const rim = traceRay(system, generateMarginalRay(system));
  assert.equal(rim.status, 'BLOCKED');
  assert.equal(rim.terminatedAtSurface, 3);
  const missBy = rim.finalRay.origin.y - stopRadius;
  assert.ok(missBy > 0 && missBy < 0.01, `rim ray overshot the stop edge by ${missBy}`);
});

test('a ray outside the solved pupil is clipped by the stop itself', () => {
  const system = singletWithInternalStop();
  const overfilled = traceRay(system, generateRay(system, { px: 0, py: 1.15 }));

  assert.equal(overfilled.status, 'BLOCKED');
  assert.equal(overfilled.terminatedAtSurface, 3); // blocked at the stop, not at the lens
});
