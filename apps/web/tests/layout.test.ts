import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR,
  N_BK7,
  OpticalSystem,
  Surface,
  sphericalShape,
  type Material,
} from '@isaac/optical-core';
import { buildLayout, sag } from '../src/lib/layout.ts';

const WAVELENGTH_NM = 587.5618;
const DEFAULT_SEMI_DIAMETER = 10;

/**
 * Sag of a sphere, derived from the circle rather than from the formula under
 * test: a point at height y on a sphere of radius R whose vertex is at the
 * origin and whose center lies at z = R sits at z = R − √(R² − y²). Comparing
 * against this keeps the tests from simply restating the implementation.
 */
function sagFromCircle(radius: number, y: number): number {
  return radius - Math.sign(radius) * Math.sqrt(radius * radius - y * y);
}

/**
 * A system of one element: two curved surfaces with `material` between them,
 * then a long air space to the image.
 */
function element(options: {
  frontRadius: number;
  backRadius: number;
  thickness: number;
  frontSemiDiameter: number;
  backSemiDiameter?: number;
  material?: Material;
}): OpticalSystem {
  const { frontRadius, backRadius, thickness, frontSemiDiameter } = options;
  return new OpticalSystem({
    name: 'element',
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    fields: [{ angleDeg: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: frontRadius,
        thickness,
        semiDiameter: frontSemiDiameter,
        material: options.material ?? N_BK7,
        isStop: true,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: backRadius,
        thickness: 40,
        semiDiameter: options.backSemiDiameter ?? frontSemiDiameter,
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });
}

function onlyBody(system: OpticalSystem) {
  const { bodies } = buildLayout(system, [], DEFAULT_SEMI_DIAMETER);
  assert.equal(bodies.length, 1, 'expected exactly one glass body');
  return bodies[0]!;
}

test('sag is the sag of the circle the surface came from', () => {
  for (const radius of [50, -50, 12.5]) {
    for (const y of [0, 1, 5, 10]) {
      assert.ok(
        Math.abs(sag(sphericalShape(1 / radius), y) - sagFromCircle(radius, y)) < 1e-12,
        `sag disagrees at R=${radius}, y=${y}`,
      );
    }
  }
  assert.equal(sag(sphericalShape(0), 7), 0, 'a plane has no sag');
});

test('glass between two surfaces makes a body; air makes none', () => {
  const glass = buildLayout(
    element({ frontRadius: 50, backRadius: -50, thickness: 6, frontSemiDiameter: 10 }),
    [],
    DEFAULT_SEMI_DIAMETER,
  );
  assert.equal(glass.bodies.length, 1);
  assert.equal(glass.bodies[0]!.frontIndex, 1);
  assert.equal(glass.bodies[0]!.backIndex, 2);

  const air = buildLayout(
    element({
      frontRadius: 50,
      backRadius: -50,
      thickness: 6,
      frontSemiDiameter: 10,
      material: AIR,
    }),
    [],
    DEFAULT_SEMI_DIAMETER,
  );
  assert.equal(air.bodies.length, 0, 'an air space is not an element');
});

test('the ground edges run rim to rim, and slope when the rims differ', () => {
  const equal = onlyBody(
    element({ frontRadius: 50, backRadius: -50, thickness: 6, frontSemiDiameter: 10 }),
  );
  assert.deepEqual(
    [equal.topEdge[0]!.v, equal.topEdge[1]!.v],
    [10, 10],
    'equal semi-diameters give a straight edge',
  );
  assert.deepEqual([equal.bottomEdge[0]!.v, equal.bottomEdge[1]!.v], [-10, -10]);

  // The edge joins the two rims directly, so unequal apertures slope it rather
  // than squaring it off — squaring would draw glass that is not there.
  const stepped = onlyBody(
    element({
      frontRadius: 50,
      backRadius: -50,
      thickness: 6,
      frontSemiDiameter: 12,
      backSemiDiameter: 8,
    }),
  );
  assert.deepEqual([stepped.topEdge[0]!.v, stepped.topEdge[1]!.v], [12, 8]);
  assert.deepEqual([stepped.bottomEdge[0]!.v, stepped.bottomEdge[1]!.v], [-12, -8]);
});

test('a workable element reports the gap at its thinnest, and is not crossed', () => {
  const body = onlyBody(
    element({ frontRadius: 50, backRadius: -50, thickness: 6, frontSemiDiameter: 10 }),
  );

  // Biconvex, so the thinnest point is the rim: 6 of center thickness less the
  // sag each surface eats into it.
  const expected = 6 - 2 * sagFromCircle(50, 10);
  assert.ok(Math.abs(body.leastGap - expected) < 1e-9, `leastGap ${body.leastGap} ≠ ${expected}`);
  assert.equal(body.crossed, false);
});

test('opening the aperture until the surfaces meet marks the element crossed', () => {
  // Same element, aperture widened: each surface now eats 4.17 of the 6 it has.
  const body = onlyBody(
    element({ frontRadius: 50, backRadius: -50, thickness: 6, frontSemiDiameter: 20 }),
  );

  const expected = 6 - 2 * sagFromCircle(50, 20);
  assert.ok(expected < 0, 'the fixture must actually be impossible');
  assert.ok(Math.abs(body.leastGap - expected) < 1e-9, `leastGap ${body.leastGap} ≠ ${expected}`);
  assert.equal(body.crossed, true);
});

test('the front surface reaching past a smaller rear rim also counts as crossed', () => {
  // Over the aperture the two share (8) this element is comfortable, so a check
  // confined to that range would pass it. The fault is at the ground edge: the
  // front surface has bulged beyond where the rear surface ends, which folds
  // the edge back on itself.
  const body = onlyBody(
    element({
      frontRadius: 50,
      backRadius: -50,
      thickness: 6,
      frontSemiDiameter: 25,
      backSemiDiameter: 8,
    }),
  );

  const overSharedAperture = 6 - 2 * sagFromCircle(50, 8);
  assert.ok(overSharedAperture > 0, 'the shared aperture must look healthy');

  const rearRimZ = 6 - sagFromCircle(50, 8);
  const frontRimZ = sagFromCircle(50, 25);
  assert.ok(Math.abs(body.leastGap - (rearRimZ - frontRimZ)) < 1e-9);
  assert.equal(body.crossed, true);
});

test('the rim term does not double-count when the semi-diameters match', () => {
  // With equal rims the ground-edge measurement is just the rim sample of the
  // surface-to-surface one, so it must not shift the answer.
  for (const semiDiameter of [5, 10, 15]) {
    const body = onlyBody(
      element({ frontRadius: 50, backRadius: -50, thickness: 6, frontSemiDiameter: semiDiameter }),
    );
    const expected = 6 - 2 * sagFromCircle(50, semiDiameter);
    assert.ok(
      Math.abs(body.leastGap - expected) < 1e-9,
      `semi ${semiDiameter}: ${body.leastGap} ≠ ${expected}`,
    );
  }
});

test('a meniscus curving the same way is judged on the gap, not on the shape', () => {
  // Both centers on the same side: the surfaces run roughly parallel, so a thin
  // meniscus is perfectly buildable where a biconvex of the same thickness and
  // aperture would not be.
  const body = onlyBody(
    element({ frontRadius: 50, backRadius: 60, thickness: 3, frontSemiDiameter: 20 }),
  );
  assert.equal(body.crossed, false);

  const expected = 3 + sagFromCircle(60, 20) - sagFromCircle(50, 20);
  assert.ok(Math.abs(body.leastGap - expected) < 1e-9, `leastGap ${body.leastGap} ≠ ${expected}`);
});

test('a cemented pair makes one body per glass', () => {
  const doublet = new OpticalSystem({
    name: 'doublet',
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    fields: [{ angleDeg: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 60,
        thickness: 5,
        semiDiameter: 10,
        material: N_BK7,
        isStop: true,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: -40,
        thickness: 3,
        semiDiameter: 10,
        material: N_BK7,
      }),
      new Surface({
        id: 's3',
        type: 'STANDARD',
        radius: -120,
        thickness: 90,
        semiDiameter: 10,
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });

  const { bodies } = buildLayout(doublet, [], DEFAULT_SEMI_DIAMETER);
  assert.equal(bodies.length, 2);
  assert.deepEqual(
    bodies.map((body) => [body.frontIndex, body.backIndex]),
    [
      [1, 2],
      [2, 3],
    ],
  );
});

test('an unapertured surface falls back to the supplied semi-diameter', () => {
  const body = onlyBody(
    element({ frontRadius: 50, backRadius: -50, thickness: 6, frontSemiDiameter: Infinity }),
  );
  assert.equal(body.topEdge[0]!.v, DEFAULT_SEMI_DIAMETER, 'the fallback height is drawn');
  assert.equal(body.crossed, false);
});

test('the drawn profile follows the conic and the aspheric terms, not just the radius', () => {
  // The 2-D layout must draw the surface the tracer sees. A sphere and a
  // paraboloid of the same radius agree on the axis and separate toward the
  // rim, so comparing the two profiles is a direct check that the conic reached
  // the drawing at all.
  const radius = 50;
  const rim = 20;
  const spherical = sag(sphericalShape(1 / radius), rim);
  const parabolic = sag({ curvature: 1 / radius, conic: -1, asphericCoefficients: [] }, rim);
  assert.ok(Math.abs(parabolic - (rim * rim) / (2 * radius)) < 1e-12);
  assert.ok(spherical > parabolic);

  // And a polynomial term shows up on top of that conic base.
  const withTerm = sag({ curvature: 1 / radius, conic: -1, asphericCoefficients: [0, 1e-6] }, rim);
  assert.ok(Math.abs(withTerm - (parabolic + 1e-6 * rim ** 4)) < 1e-12);
});

test('a lens body is built from the aspheric profile the surfaces really have', () => {
  const asphere = (radius: number, conic: number): Surface[] => [
    new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
    new Surface({
      id: 's1',
      type: 'EVEN_ASPHERE',
      radius,
      conic,
      asphericCoefficients: [0, 4e-6],
      thickness: 6,
      semiDiameter: 10,
      material: N_BK7,
      isStop: true,
    }),
    new Surface({ id: 's2', type: 'STANDARD', radius: -radius, thickness: 40, semiDiameter: 10 }),
    new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
  ];
  const build = (conic: number) =>
    buildLayout(
      new OpticalSystem({
        name: 'aspheric singlet',
        wavelengthsNm: [WAVELENGTH_NM],
        fields: [{ angleDeg: 0 }],
        aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
        surfaces: asphere(50, conic),
      }),
      [],
      DEFAULT_SEMI_DIAMETER,
    );

  const rimOf = (layout: ReturnType<typeof build>): number =>
    layout.profiles[0]!.points[layout.profiles[0]!.points.length - 1]!.h;

  // A stronger conic pulls the rim of the front surface forward, and the glass
  // body drawn from it must follow — the body is built from the same points.
  assert.ok(rimOf(build(-4)) < rimOf(build(0)));
  const body = build(-4).bodies[0]!;
  assert.equal(body.points[0]!.h, build(-4).profiles[0]!.points[0]!.h);
});

test('an element behind a mirror is not condemned as self-intersecting', () => {
  // After a mirror the next surface sits at *smaller* z on purpose, so a gap
  // measured along +Z comes out negative for a perfectly buildable element.
  // Measuring along the light is what tells the two apart.
  const build = (reflective: boolean) =>
    buildLayout(
      new OpticalSystem({
        name: 'fold then element',
        wavelengthsNm: [WAVELENGTH_NM],
        fields: [{ angleDeg: 0 }],
        aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
        surfaces: [
          new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
          new Surface({
            id: 'fold',
            type: 'STANDARD',
            thickness: reflective ? -20 : 20,
            semiDiameter: 12,
            reflective,
            isStop: true,
          }),
          new Surface({
            id: 'front',
            type: 'STANDARD',
            radius: 60,
            thickness: reflective ? -5 : 5,
            semiDiameter: 10,
            material: N_BK7,
          }),
          new Surface({
            id: 'back',
            type: 'STANDARD',
            radius: -60,
            thickness: reflective ? -40 : 40,
            semiDiameter: 10,
          }),
          new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
        ],
      }),
      [],
      DEFAULT_SEMI_DIAMETER,
    );

  // Laid out forwards and behind a mirror, the element is buildable both ways.
  // The two gaps are not the same number — the surfaces still bulge toward +Z,
  // so the shape really does differ once the light comes the other way — but
  // both are positive, which is the claim that matters.
  const forward = build(false).bodies[0]!;
  const reflected = build(true).bodies[0]!;
  assert.equal(forward.crossed, false);
  assert.equal(reflected.crossed, false, 'an element behind a mirror is still buildable');
  assert.ok(forward.leastGap > 0 && reflected.leastGap > 0);

  // And the mirror itself is marked, so the view can draw it as metal.
  assert.equal(build(true).profiles[0]!.isMirror, true);
  assert.equal(build(false).profiles[0]!.isMirror, false);
});
