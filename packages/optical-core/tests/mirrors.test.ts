import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIR,
  N_BK7,
  OpticalSystem,
  Point3,
  Ray,
  Surface,
  Vector3,
  entrancePupil,
  exitPupil,
  paraxialProperties,
  signedMediaIndices,
  traceRay,
  withImageAtParaxialFocus,
} from '../src/index.ts';

const WAVELENGTH_NM = 587.5618;
const alongZ = new Vector3(0, 0, 1);

/**
 * A single concave mirror facing the incoming light: radius negative, so the
 * center of curvature is behind the light and the mirror converges. The image
 * lands at R/2, in *front* of the mirror, so the thickness to it is negative —
 * the convention every reflecting `.zmx` file is written in.
 */
function singleMirror(radius = -100, conic = 0): OpticalSystem {
  return new OpticalSystem({
    name: 'concave mirror',
    wavelengthsNm: [WAVELENGTH_NM],
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'mirror',
        type: 'STANDARD',
        radius,
        conic,
        thickness: radius / 2,
        semiDiameter: 20,
        reflective: true,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 20 }),
    ],
  });
}

test('the medium after a mirror is signed, so the light is known to be going back', () => {
  const media = signedMediaIndices(singleMirror());
  // Object space, then image space on the far side of one reflection.
  assert.deepEqual(media, [1, -1, -1]);

  // Two mirrors turn it round again — which is why a Cassegrain has a positive
  // focal length and a Newtonian does not.
  const twice = singleMirror().with({
    surfaces: [
      ...singleMirror().surfaces.slice(0, 2),
      new Surface({
        id: 'second',
        type: 'STANDARD',
        radius: 200,
        thickness: 60,
        semiDiameter: 5,
        reflective: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
  assert.deepEqual(signedMediaIndices(twice), [1, -1, 1, 1]);
});

test('a concave mirror focuses at R/2, and the real ray agrees with the paraxial one', () => {
  const system = singleMirror(-100);
  const properties = paraxialProperties(system);

  // |EFL| is R/2. The sign is negative because image space runs backwards after
  // an odd number of reflections; it is the same fact as the negative thickness.
  assert.ok(Math.abs(properties.effectiveFocalLength + 50) < 1e-9);
  assert.ok(Math.abs(properties.backFocalDistance + 50) < 1e-9);
  assert.ok(Math.abs(properties.paraxialImageZ + 50) < 1e-9);

  // A parabola makes it exact at every height, so paraxial and real must agree
  // out to the rim rather than only near the axis.
  const parabolic = singleMirror(-100, -1);
  for (const height of [1e-6, 5, 15, 19]) {
    const result = traceRay(
      parabolic,
      new Ray(new Point3(0, height, -200), alongZ, { wavelengthNm: WAVELENGTH_NM }),
    );
    assert.equal(result.status, 'TERMINATED');
    assert.ok(
      Math.abs(result.finalRay.origin.y) < 1e-9,
      `ray from h=${height} landed at y=${result.finalRay.origin.y}`,
    );
  }
});

test('the Hubble telescope comes out at its real focal length', () => {
  // Ritchey–Chrétien, from OpticStudio's own Hubble.zmx, in meters. Two mirrors,
  // so image space is forward again: EFL positive, 57.6 m at f/24 on a 2.4 m
  // aperture. Worth pinning against a system whose numbers are public.
  const hubble = new OpticalSystem({
    name: 'HST',
    units: 'm',
    wavelengthsNm: [500],
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 2.4 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 's1', type: 'STANDARD', thickness: 5, semiDiameter: 0.155 }),
      new Surface({
        id: 'primary',
        type: 'STANDARD',
        radius: 1 / -9.05797101e-2,
        conic: -1.0022985,
        thickness: -4.906071,
        semiDiameter: 1.20009107,
        reflective: true,
        isStop: true,
      }),
      new Surface({
        id: 'secondary',
        type: 'STANDARD',
        radius: 1 / -7.36377025e-1,
        conic: -1.49686,
        thickness: 6.4061995389968676,
        semiDiameter: 0.14055935,
        reflective: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', radius: 1 / -1.5845871615, thickness: 0 }),
    ],
  });

  const properties = paraxialProperties(hubble);
  assert.ok(
    Math.abs(properties.effectiveFocalLength - 57.6) < 0.01,
    `EFL ${properties.effectiveFocalLength}, expected 57.6 m`,
  );
  assert.ok(Math.abs(properties.effectiveFocalLength / 2.4 - 24) < 0.01); // f/24
  // The file's own last thickness is the back focus Zemax computed.
  assert.ok(Math.abs(properties.backFocalDistance - 6.4061995) < 1e-6);

  // The image plane the file ships is already at the paraxial focus.
  assert.ok(Math.abs(properties.imageSurfaceZ - properties.paraxialImageZ) < 1e-6);

  // The entrance pupil is the primary seen through a plane: itself, unmagnified.
  const entrance = entrancePupil(hubble);
  assert.ok(Math.abs(entrance.z - 5) < 1e-12);
  assert.ok(Math.abs(entrance.radius - 1.20009107) < 1e-12);
  // The exit pupil is virtual and sits in front of the secondary, as a
  // Cassegrain's does. The check that means something is that it reproduces the
  // f/# from the other side: the image is f/24 worth of distance away from it.
  const exit = exitPupil(hubble);
  assert.ok(exit.z < hubble.vertexZAt(3));
  const workingFNumber = (properties.paraxialImageZ - exit.z) / (2 * exit.radius);
  assert.ok(Math.abs(workingFNumber - 24) < 0.02, `working f/${workingFNumber}`);

  // Independent of all of the above: a real ray a hair off the axis.
  const probe = traceRay(hubble, new Ray(new Point3(0, 1e-6, -1), alongZ, { wavelengthNm: 500 }));
  assert.equal(probe.status, 'TERMINATED');
  const exitFace = probe.intersections[probe.intersections.length - 2]!;
  const slope = exitFace.outgoingDirection.y / exitFace.outgoingDirection.z;
  assert.ok(Math.abs(-1e-6 / slope - properties.effectiveFocalLength) < 1e-3);
});

test('solving the image plane of a mirror system moves it the right way', () => {
  const system = singleMirror(-100).withSurfaceAt(
    1,
    singleMirror(-100).surfaceAt(1).with({ thickness: -30 }), // well short of focus
  );
  const solved = withImageAtParaxialFocus(system);
  // Negative, because the focus is in front of the mirror. A solve that returned
  // +50 would put the image behind it, where no light goes.
  assert.ok(Math.abs(solved.surfaceAt(1).thickness + 50) < 1e-9);
  const after = paraxialProperties(solved);
  assert.ok(Math.abs(after.imageSurfaceZ - after.paraxialImageZ) < 1e-9);
});

test('an ideal lens after a mirror converges, rather than diverging', () => {
  // A slope is measured against +Z and does not know which way the light runs,
  // so the paraxial bend has to be applied with the sign of travel. Without it
  // this system diverges — and still traces, and still draws, which is exactly
  // why it is pinned here.
  const system = new OpticalSystem({
    name: 'mirror then ideal lens',
    wavelengthsNm: [WAVELENGTH_NM],
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'flat-mirror',
        type: 'STANDARD',
        thickness: -40,
        semiDiameter: 20,
        reflective: true,
        isStop: true,
      }),
      new Surface({ id: 'lens', type: 'PARAXIAL', focalLength: 100, thickness: -100 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });

  // Collimated in, flat mirror, then a 100 mm ideal lens: the focus is 100 mm
  // beyond the lens along the light's path, which is −100 in z.
  const properties = paraxialProperties(system);
  assert.ok(Math.abs(properties.backFocalDistance + 100) < 1e-9);
  assert.ok(Math.abs(properties.effectiveFocalLength + 100) < 1e-9);

  for (const height of [1, 3, 5]) {
    const result = traceRay(
      system,
      new Ray(new Point3(0, height, -10), alongZ, { wavelengthNm: WAVELENGTH_NM }),
    );
    assert.equal(result.status, 'TERMINATED');
    assert.ok(
      Math.abs(result.finalRay.origin.y) < 1e-9,
      `ideal lens sent h=${height} to y=${result.finalRay.origin.y}`,
    );
  }
});

test('a mirror inside glass keeps the glass, and the model refuses one that does not', () => {
  // A Mangin mirror: light enters glass, reflects off the silvered rear face,
  // and comes back out through the front. The reflecting surface's medium is the
  // glass, because that is where the light goes next.
  const glass = N_BK7; // the file's glass, and the same fit the catalog uses
  const mangin = (mirrorMaterial = glass): Surface[] => [
    new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
    new Surface({
      id: 'front',
      type: 'STANDARD',
      radius: 1 / -9.84313146e-3,
      thickness: 2,
      semiDiameter: 20,
      material: glass,
      isStop: true,
    }),
    new Surface({
      id: 'silvered',
      type: 'STANDARD',
      radius: 1 / -6.58749195e-3,
      thickness: -2,
      semiDiameter: 20.18,
      material: mirrorMaterial,
      reflective: true,
    }),
    new Surface({
      id: 'back-out',
      type: 'STANDARD',
      radius: 1 / -9.84313146e-3,
      thickness: -98.691724705765381,
      semiDiameter: 19.66,
      material: AIR,
    }),
    new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
  ];

  const system = new OpticalSystem({
    name: 'Mangin mirror',
    wavelengthsNm: [550],
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 40 },
    surfaces: mangin(),
  });
  const n = N_BK7.indexAt(550);
  assert.deepEqual(signedMediaIndices(system, 550), [1, n, -n, -1, -1]);
  // The file ships its image plane at focus; the same number must come back out.
  const properties = paraxialProperties(system, 550);
  assert.ok(Math.abs(properties.imageDistance + 98.6917247) < 1e-3);

  // Claiming air on the far side of a mirror standing in glass is refused, not
  // quietly corrected: the real tracer reads that material and would lose the
  // second pass through the glass.
  assert.throws(
    () =>
      new OpticalSystem({
        name: 'broken Mangin',
        wavelengthsNm: [550],
        surfaces: mangin(AIR),
      }),
    /the medium after it must be the medium before it \(N-BK7\), not AIR/,
  );
});

test('a Gregorian has a negative focal length, because its image is erect', () => {
  // The counterpart to the Hubble above, and the case that shows the sign of an
  // EFL carries *two* independent facts rather than one.
  //
  // Both are two-mirror telescopes, so image space runs forwards in each and the
  // mirror count contributes nothing to the sign. What differs is where the
  // secondary sits: a Cassegrain's is *before* the prime focus, so the beam
  // never crosses the axis inside the system and the image is inverted; a
  // Gregorian's is *beyond* it, so the beam crosses once and the image comes out
  // erect. EFL is −y₁/u′, and that one crossing flips u′.
  //
  // Numbers from Zemax's own `Unobscured Gregorian` sample, which reports
  // EFFL = −1237.63 mm. Isaac agrees to the last digit, and it is worth a test
  // because a negative focal length on a two-mirror telescope reads as a bug.
  const gregorian = new OpticalSystem({
    name: 'Gregorian',
    units: 'mm',
    wavelengthsNm: [550],
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 100 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 'dummy', type: 'STANDARD', thickness: 200 }),
      new Surface({ id: 'stop', type: 'STANDARD', thickness: 60, semiDiameter: 50, isStop: true }),
      new Surface({
        id: 'primary',
        type: 'STANDARD',
        radius: 1 / -3.2866648831e-3,
        conic: -1.00869694,
        thickness: -178.59,
        reflective: true,
      }),
      new Surface({
        id: 'secondary',
        type: 'STANDARD',
        radius: 1 / 2.1219123523e-2,
        conic: -0.568372493,
        thickness: 26.702,
        semiDiameter: 28,
        aperture: { kind: 'FLOATING' },
        reflective: true,
      }),
      new Surface({ id: 'relay', type: 'STANDARD', thickness: 189.140889 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });

  const properties = paraxialProperties(gregorian);
  assert.ok(
    Math.abs(properties.effectiveFocalLength + 1237.63) < 0.01,
    `EFL ${properties.effectiveFocalLength}, expected −1237.63 mm`,
  );
  // The magnitude is the textbook two-mirror product: the parent's 152.13 mm
  // times the secondary's magnification.
  assert.ok(Math.abs(Math.abs(properties.effectiveFocalLength) - 152.13 * 8.135) < 5);
});
