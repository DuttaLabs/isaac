import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR,
  ConstantMaterial,
  OpticalSystem,
  Point3,
  Surface,
  Vector3,
  entrancePupilRadius,
  fieldForImageHeight,
  generateChiefRay,
  generatePupilGrid,
  generateRay,
  generateRayFan,
  isObjectAtInfinity,
  paraxialImageHeight,
  paraxialProperties,
  traceRay,
  traceRays,
  withImageAtParaxialFocus,
} from '../src/index.ts';

const GLASS = new ConstantMaterial('DEMO-GLASS', 1.5);
const WAVELENGTH_NM = 587.5618;

/** The plano-convex singlet of trace.test.ts, with an aperture and fields attached. */
function singlet(
  overrides: {
    epd?: number;
    objectThickness?: number;
    radius?: number;
    semiDiameter?: number;
  } = {},
): OpticalSystem {
  const { epd = 10, objectThickness = Infinity, radius = 50, semiDiameter = 25 } = overrides;
  return new OpticalSystem({
    name: 'Plano-convex singlet',
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: epd },
    fields: [{ angleDeg: 0 }, { angleDeg: 5 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: objectThickness, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius,
        thickness: 5,
        semiDiameter,
        // Clipped at the semi-diameter, which is now something a surface has to
        // declare rather than something every surface does.
        aperture: { kind: 'FLOATING' },
        material: GLASS,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: Infinity,
        thickness: 96.6667,
        semiDiameter,
        aperture: { kind: 'FLOATING' },
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });
}

test('entrance pupil radius comes from the aperture definition', () => {
  assert.equal(entrancePupilRadius(singlet({ epd: 10 })), 5);
  assert.equal(isObjectAtInfinity(singlet()), true);

  const noAperture = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
  assert.throws(() => entrancePupilRadius(noAperture), /no aperture/);
});

test('object-space NA sizes the pupil from the object distance', () => {
  const system = new OpticalSystem({
    aperture: { type: 'OBJECT_SPACE_NA', value: 0.1 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: 100 }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 5,
        semiDiameter: 25,
        material: GLASS,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
  // r = L · tan(asin(NA / n_object)) with n_object = 1.
  assert.ok(Math.abs(entrancePupilRadius(system) - 100 * Math.tan(Math.asin(0.1))) < 1e-12);
});

test('FLOAT_BY_STOP is sized by the stop surface', () => {
  const noStop = singlet().with({ aperture: { type: 'FLOAT_BY_STOP' } });
  assert.throws(() => entrancePupilRadius(noStop), /no surface marked as the aperture stop/);

  // With the stop on the first surface the entrance pupil is the stop itself.
  const withStop = noStop.withSurfaceAt(
    1,
    noStop.surfaceAt(1).with({ semiDiameter: 4, isStop: true }),
  );
  assert.equal(entrancePupilRadius(withStop), 4);
});

test('an on-axis ray at infinity launches collimated through its pupil point', () => {
  const system = singlet({ epd: 10 });
  const ray = generateRay(system, { px: 0, py: 1 });

  assert.ok(ray.direction.equals(new Vector3(0, 0, 1), 1e-12));
  assert.equal(ray.origin.y, 5); // pupil rim at half the entrance pupil diameter
  // Default launch plane: 1 unit ahead of a first surface whose vertex is frontmost.
  assert.equal(ray.origin.z, -1);
  assert.equal(ray.wavelengthNm, WAVELENGTH_NM);
  assert.equal(ray.medium, 'AIR');
});

test('an off-axis ray at infinity is aimed through its pupil point at the field angle', () => {
  const system = singlet({ epd: 10 });
  const angleRad = (5 * Math.PI) / 180;
  const ray = generateRay(system, { px: 0, py: 0 }, { field: 1 }); // fields[1] = 5°

  assert.ok(ray.direction.equals(new Vector3(0, Math.sin(angleRad), Math.cos(angleRad)), 1e-12));
  // Walking forward from the launch plane must land on the pupil center at z = 0.
  const atPupil = ray.at(-ray.origin.z / ray.direction.z);
  assert.ok(Math.abs(atPupil.y) < 1e-12, `chief ray misses the pupil center by ${atPupil.y}`);
  assert.ok(Math.abs(atPupil.z) < 1e-12);

  // An explicit field object works the same as a field index.
  const explicit = generateRay(system, { px: 0, py: 0 }, { field: { angleDeg: 5 } });
  assert.ok(explicit.direction.equals(ray.direction, 1e-12));
});

test('a finite object launches rays from the object plane toward the pupil', () => {
  const system = singlet({ objectThickness: 200 });
  const ray = generateRay(system, { px: 0, py: 1 }, { field: { objectHeight: 2 } });

  assert.equal(isObjectAtInfinity(system), false);
  assert.ok(ray.origin.equals(new Point3(0, 2, -200), 1e-12));
  // From (0, 2, −200) to the pupil rim at (0, 5, 0).
  assert.ok(ray.direction.equals(new Vector3(0, 3, 200).normalized(), 1e-12));
});

test('field definitions must match the object conjugate', () => {
  assert.throws(
    () => generateRay(singlet(), { px: 0, py: 0 }, { field: { objectHeight: 1 } }),
    /field angles/,
  );
  assert.throws(
    () =>
      generateRay(singlet({ objectThickness: 200 }), { px: 0, py: 0 }, { field: { angleDeg: 5 } }),
    /object heights/,
  );
  assert.throws(
    () => generateRay(singlet(), { px: 0, py: 0 }, { field: 7 }),
    /No field at index 7/,
  );
});

test('the default launch plane clears a first surface that bulges toward the object', () => {
  const system = singlet({ radius: -50, epd: 10 });
  const ray = generateRay(system, { px: 0, py: 1 });

  // Sag of R = −50 at the pupil rim h = 5 is negative, so the edge is ahead of the vertex.
  const sagAtRim = (-0.02 * 25) / (1 + Math.sqrt(1 - 0.02 * 0.02 * 25));
  assert.ok(sagAtRim < 0);
  assert.ok(
    ray.origin.z < sagAtRim,
    `launch plane z=${ray.origin.z} is not ahead of sag ${sagAtRim}`,
  );
});

test('a ray fan samples the pupil diameter symmetrically', () => {
  const system = singlet({ epd: 10 });
  const fan = generateRayFan(system, { count: 5 });

  assert.equal(fan.length, 5);
  assert.deepEqual(
    fan.map((ray) => ray.origin.y),
    [-5, -2.5, 0, 2.5, 5],
  );
  assert.ok(fan.every((ray) => ray.origin.x === 0));

  const sagittal = generateRayFan(system, { count: 3, axis: 'x' });
  assert.deepEqual(
    sagittal.map((ray) => ray.origin.x),
    [-5, 0, 5],
  );
  assert.ok(sagittal.every((ray) => ray.origin.y === 0));

  assert.deepEqual(
    generateRayFan(system, { count: 1 }).map((ray) => ray.origin.y),
    [0],
  );
  assert.throws(() => generateRayFan(system, { count: 0 }), /positive integer/);
});

test('a pupil grid is clipped to the pupil rim', () => {
  const system = singlet({ epd: 10 });
  const grid = generatePupilGrid(system, { count: 5 });

  // Of the 25 square samples, the 12 outside the unit circle are dropped.
  assert.equal(grid.length, 13);
  assert.ok(grid.every((ray) => Math.hypot(ray.origin.x, ray.origin.y) <= 5 + 1e-9));
});

test('a generated fan traces to a tight, symmetric focus', () => {
  const system = singlet({ epd: 10 });
  const results = traceRays(system, generateRayFan(system, { count: 9 }));

  assert.ok(results.every((result) => result.status === 'TERMINATED'));

  const heights = results.map((result) => result.finalRay.origin.y);
  assert.ok(Math.abs(heights[4]!) < 1e-12, 'the axial ray should land on axis');
  // A rotationally symmetric system on axis: the fan is antisymmetric about the axis.
  for (let i = 0; i < heights.length; i += 1) {
    const mirrored = heights[heights.length - 1 - i]!;
    assert.ok(Math.abs(heights[i]! + mirrored) < 1e-12);
  }
  // Residual spherical aberration only; the marginal ray stays close to the axis.
  assert.ok(Math.abs(heights[0]!) < 0.5, `marginal ray height ${heights[0]} is too large`);
});

test('rays outside the clear aperture are reported as blocked', () => {
  const system = singlet({ epd: 30, semiDiameter: 5 });
  const results = traceRays(system, generateRayFan(system, { count: 3 }));

  assert.deepEqual(
    results.map((result) => result.status),
    ['BLOCKED', 'TERMINATED', 'BLOCKED'],
  );
});

/**
 * **An object-space NA is an angle at the object, and the ray it names ends on
 * the rim of the entrance pupil.** Measuring that cone to *surface 1* instead is
 * right whenever the pupil happens to sit there and wrong by the distance
 * between them otherwise — which is why it survived every test here: the singlet
 * above has its stop on the first surface.
 *
 * Found by cross-checking `Liang2006c.zmx` against OpticStudio, where the stop
 * images to a pupil 59.3 mm past a first surface 0.15 mm from the object. The
 * pupil came out **396 times too small**, so every ray traced was near-axial and
 * the design looked diffraction-limited.
 *
 * The assertion is the definition rather than a number: generate the marginal
 * ray, and the sine of its angle at the object must be the NA.
 */
function objectSpaceNaSystem(stopSetback: number): OpticalSystem {
  return new OpticalSystem({
    name: 'NA-defined system',
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'OBJECT_SPACE_NA', value: 0.25 },
    fields: [{ objectHeight: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: 20, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: Infinity,
        thickness: stopSetback,
        semiDiameter: 40,
        material: AIR,
      }),
      new Surface({
        id: 'stop',
        type: 'STANDARD',
        radius: Infinity,
        thickness: 30,
        semiDiameter: 40,
        material: AIR,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 40 }),
    ],
  });
}

test('an object-space NA is the angle of the ray that reaches the pupil rim', () => {
  for (const setback of [0, 15, 40]) {
    const system = objectSpaceNaSystem(setback);
    const marginal = generateRay(
      system,
      { px: 0, py: 1 },
      { field: 0, wavelengthNm: WAVELENGTH_NM },
    );
    const direction = marginal.direction;
    const sine = Math.abs(direction.y) / Math.hypot(direction.y, direction.z);
    assert.ok(
      Math.abs(sine - 0.25) < 1e-9,
      `stop ${setback} past the first surface: marginal ray leaves at sin ${sine}, not the stated NA 0.25`,
    );
  }
});

test('the NA cone is measured to the pupil, not to the first surface', () => {
  // With the stop 40 past surface 1 the two references differ by a factor of 3,
  // and the pupil is the plane in a system of plane surfaces.
  const system = objectSpaceNaSystem(40);
  const expected = 60 * Math.tan(Math.asin(0.25));
  assert.ok(
    Math.abs(entrancePupilRadius(system) - expected) < 1e-9,
    `pupil radius ${entrancePupilRadius(system)}, expected ${expected}`,
  );
});

/**
 * **A field can be stated as a height on the image, which is how eyes are
 * specified** — a retinal height is what a clinician measures and what an eye
 * model quotes, and it is Zemax's field type 2.
 *
 * It is a statement about where the chief ray *lands*, so launching one means
 * solving for the object-space field that puts it there. Paraxial optics is
 * linear in field, so the solve is exact rather than iterative: one probe ray
 * gives the constant of proportionality. For an object at infinity the linear
 * quantity is `tan θ` and not θ, which is the easy thing to get wrong — it is
 * invisible at 1° and 4% out by 20°.
 */
function imageHeightSystem(lastThickness = 95): OpticalSystem {
  return new OpticalSystem({
    name: 'stated by image height',
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    fields: [{ imageHeight: 0 }, { imageHeight: 8 }, { imageHeight: 17 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 5,
        semiDiameter: 15,
        material: GLASS,
        isStop: true,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: Infinity,
        thickness: lastThickness,
        semiDiameter: 15,
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 30 }),
    ],
  });
}

test('an image-height field is the height its chief ray lands at', () => {
  const system = imageHeightSystem();
  for (const height of [-17, -3, 0, 8, 17]) {
    const field = fieldForImageHeight(system, height);
    assert.ok(
      Math.abs(paraxialImageHeight(system, field) - height) < 1e-9,
      `asked for ${height}, the solved field lands at ${paraxialImageHeight(system, field)}`,
    );
  }
});

test('the field angle it solves for follows the tangent, not the degrees', () => {
  const system = imageHeightSystem();
  // f·tanθ with f = 100: reading the relation as linear in degrees would put the
  // 20° point 4% out, and that error grows with field — exactly where an eye
  // model lives.
  const focalLength = paraxialProperties(system).effectiveFocalLength;
  for (const degrees of [1, 20, 40]) {
    const height = focalLength * Math.tan((degrees * Math.PI) / 180);
    const solved = fieldForImageHeight(system, height);
    assert.ok(
      Math.abs((solved.angleDeg ?? 0) - degrees) < 1e-9,
      `image height ${height} should be ${degrees}°, solved ${solved.angleDeg}`,
    );
  }
});

test('an image-height field means the same thing however the image plane moves', () => {
  // A refractive error *is* a defocus, so an eye model is routinely out of focus
  // on purpose. Measuring the field at the image surface rather than at the
  // paraxial image would make Quick focus silently change which field points a
  // design has.
  const heights = [60, 95, 130].map((thickness) =>
    paraxialImageHeight(imageHeightSystem(thickness), { angleDeg: 5 }),
  );
  for (const height of heights) {
    assert.ok(Math.abs(height - heights[0]!) < 1e-12, `field height moved with the image plane`);
  }
});

test('a ray generated for an image-height field lands where it said', () => {
  const system = imageHeightSystem();
  const focused = withImageAtParaxialFocus(system);
  for (const wanted of [3, 8]) {
    const chief = generateChiefRay(focused, { field: { imageHeight: wanted } });
    const result = traceRay(focused, chief);
    assert.equal(result.status, 'TERMINATED');
    const landed = result.intersections[result.intersections.length - 1]!.point.y;
    // A real ray carries the distortion a paraxial one does not, so this is a
    // sanity bound rather than an identity — it is the difference between
    // "the solve is right" and "the solve is nonsense".
    assert.ok(
      Math.abs(landed - wanted) < 0.02 * Math.abs(wanted) + 1e-9,
      `asked for image height ${wanted}, the traced chief ray landed at ${landed}`,
    );
  }
});

test('a system with no power cannot state a field as an image height', () => {
  const afocal = new OpticalSystem({
    name: 'no power',
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    fields: [{ imageHeight: 1 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: Infinity,
        thickness: 50,
        semiDiameter: 15,
        material: AIR,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 15 }),
    ],
  });
  assert.throws(() => fieldForImageHeight(afocal, 1), /no paraxial image/);
});
