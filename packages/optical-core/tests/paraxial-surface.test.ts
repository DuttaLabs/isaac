import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR,
  ConstantMaterial,
  OpticalSystem,
  Point3,
  Ray,
  Surface,
  Vector3,
  entrancePupil,
  generateRayFan,
  paraxialProperties,
  paraxialTrace,
  surfacePower,
  traceRay,
} from '../src/index.ts';

const WAVELENGTH_NM = 587.5618;

/** A ray heading into the lens from 10 units in front, at the given height. */
function rayAt(height: number, direction: Vector3): Ray {
  return new Ray(new Point3(0, height, -10), direction, { wavelengthNm: WAVELENGTH_NM });
}

/** A single ideal lens of focal length f in air, with the image plane at its focus. */
function idealLens(focalLength: number, imageDistance = focalLength): OpticalSystem {
  return new OpticalSystem({
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    fields: [{ angleDeg: 0 }, { angleDeg: 5 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 'lens',
        type: 'PARAXIAL',
        focalLength,
        thickness: imageDistance,
        semiDiameter: 25,
        material: AIR,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
}

test('a paraxial surface takes its power from the focal length, not a curvature', () => {
  const lens = new Surface({ id: 'p', type: 'PARAXIAL', focalLength: 50, thickness: 50 });
  assert.equal(lens.focalLength, 50);
  assert.equal(lens.curvature, 0);
  assert.equal(lens.isPlane, true);
  assert.equal(surfacePower(lens, 1, 1), 1 / 50);

  // Power is what a thin lens carries regardless of the media around it, and it
  // is the same in both directions — the reversed traces rely on that.
  assert.equal(surfacePower(lens, 1.5, 1), 1 / 50);
  assert.equal(surfacePower(lens, 1, 1.5), 1 / 50);
});

test('the model rejects a paraxial surface that is over- or under-specified', () => {
  assert.throws(
    () => new Surface({ id: 'p', type: 'PARAXIAL', thickness: 10 }),
    /requires a focalLength/,
  );
  assert.throws(
    () => new Surface({ id: 'p', type: 'PARAXIAL', focalLength: 0, thickness: 10 }),
    /finite and non-zero/,
  );
  assert.throws(
    () => new Surface({ id: 'p', type: 'PARAXIAL', focalLength: Infinity, thickness: 10 }),
    /finite and non-zero/,
  );
  // A radius would be a second, contradictory source of the same power.
  assert.throws(
    () => new Surface({ id: 'p', type: 'PARAXIAL', focalLength: 50, radius: 100, thickness: 10 }),
    /power comes from focalLength/,
  );
  assert.throws(
    () =>
      new Surface({ id: 'p', type: 'PARAXIAL', focalLength: 50, thickness: 10, reflective: true }),
    /cannot be reflective/,
  );
  assert.throws(
    () => new Surface({ id: 's', type: 'STANDARD', radius: 50, thickness: 10, focalLength: 50 }),
    /only meaningful on a PARAXIAL surface/,
  );
});

test('an ideal lens has exactly the first-order properties it was given', () => {
  const properties = paraxialProperties(idealLens(100), WAVELENGTH_NM);
  assert.ok(Math.abs(properties.effectiveFocalLength - 100) < 1e-12);
  // A thin lens has no thickness to separate its principal planes from its vertex.
  assert.ok(Math.abs(properties.backFocalDistance - 100) < 1e-12);
  assert.ok(Math.abs(properties.frontFocalDistance + 100) < 1e-12);
  assert.ok(Math.abs(properties.paraxialImageZ - 100) < 1e-12);

  const negative = paraxialProperties(idealLens(-100, 50), WAVELENGTH_NM);
  assert.ok(Math.abs(negative.effectiveFocalLength + 100) < 1e-12);
});

test('a paraxial surface obeys the same recurrence as a refracting one', () => {
  const states = paraxialTrace(idealLens(100), { height: 1, angle: 0 }, WAVELENGTH_NM);
  assert.equal(states.length, 1);
  const [lens] = states;
  assert.equal(lens!.power, 1 / 100);
  assert.equal(lens!.height, 1);
  assert.equal(lens!.angleBefore, 0);
  // n'u' = nu − yφ, in air: u' = −1/100.
  assert.ok(Math.abs(lens!.angleAfter + 0.01) < 1e-15);
});

test('an ideal lens images perfectly, at any aperture', () => {
  const system = idealLens(100);
  const focalPlaneZ = 100;

  // Rays from a collimated bundle, out to the very edge of a wide lens: every
  // one must cross the axis at the same point. A real singlet would not.
  for (const height of [0.001, 1, 5, 10, 20, 24]) {
    const ray = rayAt(height, new Vector3(0, 0, 1));
    const result = traceRay(system, ray);
    assert.equal(result.status, 'TERMINATED');
    const landing = result.finalRay.origin;
    assert.ok(Math.abs(landing.z - focalPlaneZ) < 1e-9);
    assert.ok(
      Math.abs(landing.y) < 1e-9,
      `ray at height ${height} landed at y = ${landing.y}, not on axis`,
    );
  }
});

test('an off-axis collimated bundle images to height f·tan θ, with no spread', () => {
  const system = idealLens(100);
  const slope = Math.tan((5 * Math.PI) / 180);
  const direction = new Vector3(0, slope, 1).normalized();

  const landings = [-20, -10, 0, 10, 20].map((height) => {
    const result = traceRay(system, rayAt(height, direction));
    assert.equal(result.status, 'TERMINATED');
    return result.finalRay.origin.y;
  });

  // The ideal lens maps slope to height exactly: y' = f·u, for every ray in the bundle.
  for (const y of landings) {
    assert.ok(Math.abs(y - 100 * slope) < 1e-9, `landed at ${y}, expected ${100 * slope}`);
  }
});

test('the real trace and the paraxial recurrence agree on a paraxial surface', () => {
  const system = idealLens(100);
  const states = paraxialTrace(system, { height: 3, angle: 0 }, WAVELENGTH_NM);
  const result = traceRay(system, rayAt(3, new Vector3(0, 0, 1)));

  const bend = result.intersections[0]!;
  assert.equal(bend.kind, 'PARAXIAL');
  assert.equal(bend.surfaceIndex, 1);
  assert.ok(Math.abs(bend.point.y - 3) < 1e-12);
  const realSlope = bend.outgoingDirection.y / bend.outgoingDirection.z;
  assert.ok(Math.abs(realSlope - states[0]!.angleAfter) < 1e-12);
});

test('a paraxial surface carries the stop and defines the pupils', () => {
  const system = idealLens(100);
  assert.equal(system.stopIndex, 1);

  // The stop is the first surface, so the entrance pupil sits on it, unmagnified.
  const pupil = entrancePupil(system, WAVELENGTH_NM);
  assert.ok(Math.abs(pupil.z) < 1e-12);
  assert.ok(Math.abs(pupil.radius - 25) < 1e-12);
  assert.ok(Math.abs(pupil.magnification - 1) < 1e-12);

  // Generated rays aim at that pupil and get through.
  const fan = generateRayFan(system, {
    field: system.fields[1]!,
    wavelengthNm: WAVELENGTH_NM,
    count: 5,
  });
  for (const ray of fan) {
    assert.equal(traceRay(system, ray).status, 'TERMINATED');
  }
});

test('a paraxial surface in glass focuses at n′·f, the reciprocal of its power', () => {
  // The focal length is read as 1/φ, so the image-space medium stretches the
  // distance to focus. Documented on `surfacePower`; pinned here.
  const glass = new ConstantMaterial('DEMO-GLASS', 1.5);
  const system = new OpticalSystem({
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 'lens',
        type: 'PARAXIAL',
        focalLength: 100,
        thickness: 150,
        semiDiameter: 25,
        material: glass,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });

  const properties = paraxialProperties(system, WAVELENGTH_NM);
  assert.ok(Math.abs(properties.backFocalDistance - 150) < 1e-12);

  const result = traceRay(system, rayAt(8, new Vector3(0, 0, 1)));
  assert.equal(result.status, 'TERMINATED');
  assert.ok(Math.abs(result.finalRay.origin.y) < 1e-9);
});

test('an ideal lens still blocks rays outside its clear aperture', () => {
  const system = idealLens(100);
  const result = traceRay(system, rayAt(30, new Vector3(0, 0, 1)));
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.terminatedAtSurface, 1);
});
