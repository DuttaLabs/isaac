import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR,
  ConstantMaterial,
  N_BK7,
  OpticalSystem,
  Point3,
  Ray,
  Surface,
  Vector3,
  entrancePupilRadius,
  imageSpaceFNumber,
  paraxialProperties,
  paraxialTrace,
  traceRay,
  withImageAtParaxialFocus,
} from '../src/index.ts';

const GLASS = new ConstantMaterial('DEMO-GLASS', 1.5);
const WAVELENGTH_NM = 587.5618;

/** Plano-convex singlet: R = 50, flat back, n = 1.5, d = 5 ⇒ f = 100, BFD = 96.6667. */
function planoConvexSinglet(): OpticalSystem {
  return new OpticalSystem({
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 5,
        semiDiameter: 25,
        material: GLASS,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: Infinity,
        thickness: 80,
        semiDiameter: 25,
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });
}

/** Equiconvex lens of vanishing thickness: f = 1/((n−1)(1/R₁ − 1/R₂)) = 50. */
function thinLens(objectThickness = Infinity): OpticalSystem {
  return new OpticalSystem({
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: objectThickness, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 1e-9,
        semiDiameter: 25,
        material: GLASS,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: -50,
        thickness: 50,
        semiDiameter: 25,
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });
}

test('paraxial properties reproduce the thick-lens formulas for a singlet', () => {
  const properties = paraxialProperties(planoConvexSinglet());

  assert.ok(Math.abs(properties.effectiveFocalLength - 100) < 1e-9);
  assert.ok(Math.abs(properties.power - 0.01) < 1e-12);
  // BFD = f · (1 − (n − 1)d / (n R₁)).
  assert.ok(Math.abs(properties.backFocalDistance - 100 * (1 - (0.5 * 5) / (1.5 * 50))) < 1e-9);
  // With a flat rear surface the front focal point sits one focal length ahead of S1.
  assert.ok(Math.abs(properties.frontFocalDistance + 100) < 1e-9);
  assert.equal(properties.lastRefractingSurface, 2);
  assert.equal(properties.magnification, 0); // object at infinity
});

test('the thin-lens limit matches the lensmaker equation', () => {
  const properties = paraxialProperties(thinLens());

  assert.ok(Math.abs(properties.effectiveFocalLength - 50) < 1e-6);
  assert.ok(Math.abs(properties.backFocalDistance - 50) < 1e-6);
  assert.ok(Math.abs(properties.frontFocalDistance + 50) < 1e-6);
});

test('a finite conjugate at 2f images at 2f with unit inverted magnification', () => {
  const properties = paraxialProperties(thinLens(100));

  assert.ok(Math.abs(properties.imageDistance - 100) < 1e-6);
  assert.ok(Math.abs(properties.magnification + 1) < 1e-9);
  assert.ok(Math.abs(properties.paraxialImageZ - 100) < 1e-6); // S2 vertex is at z ≈ 0
});

test('the paraxial image plane agrees with a real ray traced near the axis', () => {
  const system = planoConvexSinglet();
  const properties = paraxialProperties(system);

  const ray = new Ray(new Point3(0, 1e-4, -10), new Vector3(0, 0, 1), {
    wavelengthNm: WAVELENGTH_NM,
  });
  const exit = traceRay(system, ray).intersections[1]!; // leaving the rear surface
  const crossingZ =
    exit.point.z - (exit.point.y / exit.outgoingDirection.y) * exit.outgoingDirection.z;

  assert.ok(
    Math.abs(crossingZ - properties.paraxialImageZ) < 1e-6,
    `real ray crosses at ${crossingZ}, paraxial predicts ${properties.paraxialImageZ}`,
  );
});

test('paraxialTrace reports per-surface heights, angles, and powers', () => {
  const states = paraxialTrace(planoConvexSinglet(), { height: 1, angle: 0 });

  assert.equal(states.length, 2); // the IMAGE surface does not refract
  const [s1, s2] = states;
  assert.equal(s1!.surfaceIndex, 1);
  assert.equal(s1!.height, 1);
  assert.equal(s1!.angleBefore, 0);
  assert.ok(Math.abs(s1!.power - 0.01) < 1e-12); // (1.5 − 1) / 50
  assert.ok(Math.abs(s1!.angleAfter + 0.01 / 1.5) < 1e-12);
  // Height falls by the in-glass slope over the 5 mm center thickness.
  assert.ok(Math.abs(s2!.height - (1 - (0.01 / 1.5) * 5)) < 1e-12);
  assert.ok(s2!.power === 0); // flat rear surface (signed zero is fine)
  assert.ok(Math.abs(s2!.angleAfter + 0.01) < 1e-12);
});

test('solving the last thickness puts the image surface at the paraxial focus', () => {
  const system = planoConvexSinglet(); // rear thickness is 80, well short of focus
  const before = paraxialProperties(system);
  assert.ok(Math.abs(before.imageSurfaceZ - before.paraxialImageZ) > 15);

  const solved = withImageAtParaxialFocus(system);
  const after = paraxialProperties(solved);
  assert.ok(Math.abs(after.imageSurfaceZ - after.paraxialImageZ) < 1e-9);
  assert.ok(Math.abs(solved.surfaceAt(2).thickness - before.backFocalDistance) < 1e-9);

  // The original system is untouched.
  assert.equal(system.surfaceAt(2).thickness, 80);

  // A near-axis real ray now lands on the image surface essentially on axis.
  const ray = new Ray(new Point3(0, 1e-4, -10), new Vector3(0, 0, 1), {
    wavelengthNm: WAVELENGTH_NM,
  });
  const result = traceRay(solved, ray);
  assert.equal(result.status, 'TERMINATED');
  assert.ok(Math.abs(result.finalRay.origin.y) < 1e-9);
});

test('an image-space F/# aperture is sized from the effective focal length', () => {
  const system = thinLens().with({ aperture: { type: 'IMAGE_SPACE_FNUM', value: 4 } });

  assert.ok(Math.abs(entrancePupilRadius(system) - 50 / 8) < 1e-6); // f/(2·F#)
  assert.ok(Math.abs(imageSpaceFNumber(system) - 4) < 1e-9);
  // The EPD form gives the same F/# for the same pupil.
  const byDiameter = thinLens().with({
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 12.5 },
  });
  assert.ok(Math.abs(imageSpaceFNumber(byDiameter) - 4) < 1e-6);

  assert.throws(
    () =>
      entrancePupilRadius(thinLens(100).with({ aperture: { type: 'IMAGE_SPACE_FNUM', value: 4 } })),
    /object at infinity/,
  );
});

test('dispersion shifts the focal length with wavelength', () => {
  const system = new OpticalSystem({
    wavelengthsNm: [486.1327, 587.5618, 656.2725],
    primaryWavelengthIndex: 1,
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 4,
        semiDiameter: 12,
        material: N_BK7,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: -50,
        thickness: 45,
        semiDiameter: 12,
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });

  const blue = paraxialProperties(system, 486.1327).effectiveFocalLength;
  const green = paraxialProperties(system).effectiveFocalLength;
  const red = paraxialProperties(system, 656.2725).effectiveFocalLength;

  // Normal dispersion: shorter wavelengths are refracted more, so they focus shorter.
  assert.ok(
    blue < green && green < red,
    `expected f(blue) < f(green) < f(red), got ${blue}, ${green}, ${red}`,
  );
  assert.ok(
    Math.abs(green - paraxialProperties(system, system.primaryWavelengthNm).effectiveFocalLength) <
      1e-12,
  );
});

test('paraxial analysis refuses systems it cannot model yet', () => {
  const withMirror = planoConvexSinglet().withSurfaceAt(
    1,
    planoConvexSinglet().surfaceAt(1).with({ reflective: true }),
  );
  assert.throws(() => paraxialProperties(withMirror), /mirrors/);

  const empty = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
  assert.throws(() => paraxialProperties(empty), /at least one refracting surface/);
});

test('Surface.with and OpticalSystem.withSurfaceAt copy rather than mutate', () => {
  const surface = new Surface({
    id: 's1',
    type: 'STANDARD',
    radius: 50,
    thickness: 5,
    semiDiameter: 25,
  });
  const moved = surface.with({ thickness: 7 });

  assert.equal(surface.thickness, 5);
  assert.equal(moved.thickness, 7);
  assert.equal(moved.radius, 50);
  assert.equal(moved.id, 's1');

  const system = planoConvexSinglet();
  const restacked = system.withSurfaceAt(1, system.surfaceAt(1).with({ thickness: 9 }));
  assert.equal(system.vertexZAt(2), 5);
  assert.equal(restacked.vertexZAt(2), 9); // axial geometry is recomputed
  assert.equal(restacked.name, system.name);
  assert.throws(() => system.withSurfaceAt(9, system.surfaceAt(1)), /No surface at index 9/);
});
