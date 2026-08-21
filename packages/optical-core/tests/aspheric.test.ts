import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIR,
  ConstantMaterial,
  OpticalSystem,
  Point3,
  Surface,
  Vector3,
  intersectSurface,
  maximumSagRadius,
  paraxialProperties,
  surfaceSag,
  traceRay,
  Ray,
} from '../src/index.ts';

const alongZ = new Vector3(0, 0, 1);
const shape = (
  curvature: number,
  conic = 0,
  asphericCoefficients: readonly number[] = [],
): { curvature: number; conic: number; asphericCoefficients: readonly number[] } => ({
  curvature,
  conic,
  asphericCoefficients,
});

test('a paraboloid sags exactly r²/2R, where a sphere of the same vertex does not', () => {
  const radius = 50;
  for (const r of [1, 5, 20, 40]) {
    const parabola = surfaceSag(shape(1 / radius, -1), r);
    assert.ok(Math.abs(parabola! - (r * r) / (2 * radius)) < 1e-12);
    // The sphere agrees only to second order; by the rim it has departed visibly,
    // which is the whole reason a conic constant is worth carrying.
    const sphere = surfaceSag(shape(1 / radius, 0), r)!;
    assert.ok(sphere > parabola!);
  }
  assert.ok(surfaceSag(shape(1 / 50, 0), 4) !== null);
});

test('a closing conic has no surface past its rim, and an open one goes on forever', () => {
  const sphere = shape(1 / 50);
  assert.equal(maximumSagRadius(sphere), 50);
  assert.equal(surfaceSag(sphere, 60), null);
  // At the rim the sag is the center of curvature, and it is defined there.
  assert.ok(Math.abs(surfaceSag(sphere, 50)! - 50) < 1e-9);

  assert.equal(maximumSagRadius(shape(1 / 50, -1)), Infinity);
  assert.equal(maximumSagRadius(shape(1 / 50, -3)), Infinity);
  assert.equal(maximumSagRadius(shape(0, 0)), Infinity);
  // An oblate ellipsoid closes sooner than a sphere of the same vertex curvature.
  assert.ok(maximumSagRadius(shape(1 / 50, 3)) < 50);
});

test('a parabola reached through the conic and through an r² coefficient are the same surface', () => {
  const radius = 50;
  const asConic = shape(1 / radius, -1);
  // z = r²/2R is both the conic k = −1 on curvature 1/R and a *plane* carrying the
  // single coefficient α₁ = 1/2R. The two take completely different code paths —
  // the closed-form quadric and the Newton refinement — so agreeing to machine
  // precision says the iteration lands where the algebra says it should.
  const asPolynomial = shape(0, 0, [1 / (2 * radius)]);

  for (const height of [0.5, 3, 12, 25]) {
    const origin = new Point3(0, height, -30);
    const conicHit = intersectSurface(origin, alongZ, asConic)!;
    const polynomialHit = intersectSurface(origin, alongZ, asPolynomial)!;
    assert.ok(Math.abs(conicHit.distance - polynomialHit.distance) < 1e-11);
    assert.ok(conicHit.normal.equals(polynomialHit.normal, 1e-10));
  }
});

test('a parabolic mirror brings every collimated ray to one focus, however wide the aperture', () => {
  // The defining property of a paraboloid, and the sharpest available check that
  // the conic intersection and its normal are both right: the reflected ray must
  // cross the axis at R/2 for a marginal ray just as for a paraxial one.
  const radius = -100; // concave toward the incoming light
  const mirror = shape(1 / radius, -1);
  for (const height of [0.1, 10, 30, 49]) {
    const hit = intersectSurface(new Point3(0, height, -200), alongZ, mirror)!;
    const reflected = alongZ.subtract(hit.normal.scale(2 * alongZ.dot(hit.normal)));
    // Travel from the hit point to y = 0 and read off where that happens.
    const crossing = hit.point.z + (-hit.point.y / reflected.y) * reflected.z;
    assert.ok(Math.abs(crossing - radius / 2) < 1e-9, `focus at ${crossing} for h=${height}`);
  }
});

test('an ellipsoidal surface images collimated light stigmatically into glass', () => {
  // Fermat gives the exact aplanatic shape for an infinite conjugate refracting
  // into index n: a conic of k = −1/n², focusing at nR/(n−1). A real trace of it
  // must put every ray on the axis, not merely close to it.
  const n = 1.6;
  const radius = 30;
  const glass = new ConstantMaterial('TEST', n);
  const system = new OpticalSystem({
    name: 'aplanatic single surface',
    wavelengthsNm: [587.5618],
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 40 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'ellipsoid',
        type: 'STANDARD',
        radius,
        conic: -1 / (n * n),
        thickness: (n * radius) / (n - 1),
        semiDiameter: 25,
        material: glass,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: glass }),
    ],
  });

  for (const height of [1, 8, 16, 22]) {
    const result = traceRay(
      system,
      new Ray(new Point3(0, height, -10), alongZ, { wavelengthNm: 587.5618 }),
    );
    assert.equal(result.status, 'TERMINATED');
    assert.ok(
      Math.abs(result.finalRay.origin.y) < 1e-9,
      `ray from h=${height} landed at y=${result.finalRay.origin.y}`,
    );
  }

  // A sphere of the same radius does not: this is what the conic is buying.
  const spherical = system.withSurfaceAt(1, system.surfaceAt(1).with({ conic: 0 }));
  const marginal = traceRay(
    spherical,
    new Ray(new Point3(0, 22, -10), alongZ, { wavelengthNm: 587.5618 }),
  );
  assert.ok(Math.abs(marginal.finalRay.origin.y) > 0.5);
});

test('a traced aspheric ray lands on the surface, not merely near it', () => {
  // A cell-phone-scale asphere: short radius, strong conic, terms out to r¹⁰.
  const asphere = shape(1 / 2.2, -0.9, [0, 1.4e-3, -2.6e-4, 3.1e-5, -1.8e-6]);
  for (const height of [0.05, 0.4, 0.9, 1.4]) {
    for (const slope of [0, 0.15, -0.3]) {
      const direction = new Vector3(0, slope, 1).normalized();
      const hit = intersectSurface(new Point3(0, height, -5), direction, asphere)!;
      assert.ok(hit !== null, `no hit at h=${height}, u=${slope}`);
      const r = Math.hypot(hit.point.x, hit.point.y);
      assert.ok(
        Math.abs(hit.point.z - surfaceSag(asphere, r)!) < 1e-12,
        `off the surface by ${hit.point.z - surfaceSag(asphere, r)!}`,
      );
      // The normal must be a unit vector and lean the way the surface does.
      assert.ok(Math.abs(hit.normal.length - 1) < 1e-12);
    }
  }
});

test('the first aspheric coefficient carries power, and the conic constant does not', () => {
  const radius = 60;
  const lens = (surface: Surface): OpticalSystem =>
    new OpticalSystem({
      name: 'single element',
      wavelengthsNm: [587.5618],
      fields: [{ angleDeg: 0 }],
      aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
      surfaces: [
        new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
        surface,
        new Surface({ id: 'back', type: 'STANDARD', radius: Infinity, thickness: 50 }),
        new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
      ],
    });

  const glass = new ConstantMaterial('TEST', 1.5);
  const spherical = new Surface({
    id: 'front',
    type: 'STANDARD',
    radius,
    thickness: 4,
    material: glass,
    isStop: true,
  });
  // A *plane* whose only shape is α₁ = 1/2R is, to second order, a sphere of
  // radius R — so it must have exactly the same focal length.
  const byCoefficient = new Surface({
    id: 'front',
    type: 'EVEN_ASPHERE',
    radius: Infinity,
    asphericCoefficients: [1 / (2 * radius)],
    thickness: 4,
    material: glass,
    isStop: true,
  });

  const sphericalEfl = paraxialProperties(lens(spherical)).effectiveFocalLength;
  const coefficientEfl = paraxialProperties(lens(byCoefficient)).effectiveFocalLength;
  assert.ok(Math.abs(sphericalEfl - coefficientEfl) < 1e-9);

  // The conic changes the shape but not the first-order layout.
  const conic = lens(spherical.with({ conic: -4 }));
  assert.ok(Math.abs(paraxialProperties(conic).effectiveFocalLength - sphericalEfl) < 1e-9);
});

test('the model puts conics and coefficients only where they mean something', () => {
  const base = { id: 's', thickness: 5 } as const;

  assert.throws(
    () => new Surface({ ...base, type: 'PARAXIAL', focalLength: 100, conic: -1 }),
    /cannot have a conic constant/,
  );
  assert.throws(
    () => new Surface({ ...base, type: 'STANDARD', radius: 20, asphericCoefficients: [1e-4] }),
    /only meaningful on an EVEN_ASPHERE surface/,
  );
  assert.throws(
    () =>
      new Surface({ ...base, type: 'EVEN_ASPHERE', radius: 20, asphericCoefficients: [Infinity] }),
    /finite numbers/,
  );
  assert.throws(
    () => new Surface({ ...base, type: 'STANDARD', radius: 20, conic: Number.NaN }),
    /finite number/,
  );

  // Trailing zeros are dropped, so "no polynomial" has exactly one spelling and
  // the tracer's closed-form path is taken whenever it applies. Interior zeros
  // stay: they are positions in the series.
  const padded = new Surface({
    ...base,
    type: 'EVEN_ASPHERE',
    radius: 20,
    asphericCoefficients: [0, 0, 3e-6, 0, 0, 0],
  });
  assert.deepEqual([...padded.asphericCoefficients], [0, 0, 3e-6]);
  const allZero = padded.with({ asphericCoefficients: [0, 0, 0] });
  assert.equal(allZero.hasAsphericTerms, false);
  assert.equal(allZero.paraxialCurvature, allZero.curvature);

  // An even asphere may be the stop and may be a mirror.
  const stop = new Surface({ ...base, type: 'EVEN_ASPHERE', radius: 20, isStop: true });
  assert.equal(stop.isStop, true);
  assert.equal(new Surface({ ...base, type: 'EVEN_ASPHERE', reflective: true }).reflective, true);
  assert.equal(new Surface({ ...base, type: 'OBJECT', radius: 30, conic: -2 }).conic, -2);
  assert.equal(new Surface({ ...base, type: 'STANDARD', material: AIR }).conic, 0);
});
