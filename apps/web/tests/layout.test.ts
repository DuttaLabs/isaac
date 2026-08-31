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
import { VIEW_PLANES } from '../src/lib/view-plane.ts';

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

/** The same one-element system, but with the object a finite distance away. */
function finiteObject(objectDistance: number): OpticalSystem {
  return new OpticalSystem({
    name: 'finite',
    wavelengthsNm: [WAVELENGTH_NM],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    fields: [{ objectHeight: 0 }],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: objectDistance, material: AIR }),
      new Surface({
        id: 'front',
        type: 'STANDARD',
        radius: 100,
        thickness: 6,
        semiDiameter: 10,
        material: N_BK7,
      }),
      new Surface({ id: 'back', type: 'STANDARD', radius: -100, thickness: 90, semiDiameter: 10 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });
}

test('an object at infinity is not drawn — it is nowhere to draw', () => {
  const layout = buildLayout(
    element({ frontRadius: 100, backRadius: -100, thickness: 6, frontSemiDiameter: 10 }),
    [],
    DEFAULT_SEMI_DIAMETER,
  );
  assert.ok(!layout.profiles.some((profile) => profile.surfaceIndex === 0));
});

test('an object at a finite distance is drawn, at its own place on the axis', () => {
  const distance = 200;
  const layout = buildLayout(finiteObject(distance), [], DEFAULT_SEMI_DIAMETER);
  const object = layout.profiles.find((profile) => profile.surfaceIndex === 0);
  assert.ok(object !== undefined, 'the object plane should be drawn');
  // Surface 1 sits at z = 0, so the object is one object-distance behind it.
  for (const point of object.points) {
    assert.ok(Math.abs(point.h - -distance) < 1e-9, `expected h = ${-distance}, got ${point.h}`);
  }
});

test('drawing the object plane does not invent an element out of it', () => {
  // Bodies are glass runs, and the object is not one. Adding its profile must
  // not give the walk a new front face to close a body on.
  const withInfinity = buildLayout(
    element({ frontRadius: 100, backRadius: -100, thickness: 6, frontSemiDiameter: 10 }),
    [],
    DEFAULT_SEMI_DIAMETER,
  );
  const withFinite = buildLayout(finiteObject(200), [], DEFAULT_SEMI_DIAMETER);
  assert.equal(withFinite.bodies.length, withInfinity.bodies.length);
  assert.ok(!withFinite.bodies.some((body) => body.frontIndex === 0));
});

test('a mirror with an annular aperture is drawn with the hole left out', () => {
  // The Hubble's primary: light comes back through the middle of the mirror it
  // just bounced off, so the material is a ring and the drawing has to say so.
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'm1',
        type: 'STANDARD',
        radius: -20,
        thickness: -10,
        semiDiameter: 12,
        aperture: { kind: 'CIRCULAR', minRadius: 3, maxRadius: 12 },
        reflective: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 2 }),
    ],
  });

  const profile = buildLayout(system, [], DEFAULT_SEMI_DIAMETER).profiles.find(
    (one) => one.surfaceIndex === 1,
  );
  assert.ok(profile?.hole, 'expected the mirror to be drawn with a hole');
  // Every sample the stroke skips is inside the hole, and the ones either side
  // of the run are not: the gap is exactly the missing material.
  const heights = profile.points.map((point) => point.v);
  for (let i = profile.hole.from; i <= profile.hole.to; i += 1) {
    assert.ok(Math.abs(heights[i]!) < 3, `sample ${i} at ${heights[i]} should be inside the hole`);
  }
  assert.ok(Math.abs(heights[profile.hole.from - 1]!) >= 3);
  assert.ok(Math.abs(heights[profile.hole.to + 1]!) >= 3);

  // An obscuration is the opposite case and leaves no hole: the middle is all
  // there is, and the surface is already drawn at the extent that says so.
  const baffled = system.withSurfaceAt(
    1,
    system.surfaceAt(1).with({ aperture: { kind: 'CIRCULAR_OBSCURATION', maxRadius: 3 } }),
  );
  assert.equal(buildLayout(baffled, [], DEFAULT_SEMI_DIAMETER).profiles[1]?.hole, undefined);
});

test('a decentered aperture is drawn where the aperture is, not where the axis is', () => {
  // Zemax's Unobscured Gregorian in miniature: a parent conic whose vertex is
  // put 100 off the beam by a coordinate break, with a 55 circle taken out of it
  // back on the beam. Drawing the parent disc instead would draw a mirror nobody
  // has, straddling the axis the design exists to keep clear.
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'ct',
        type: 'COORDINATE_TRANSFORM',
        thickness: 0,
        coordinateTransform: {
          decenterX: 0,
          decenterY: 100,
          tiltXDeg: 0,
          tiltYDeg: 0,
          tiltZDeg: 0,
          tiltFirst: false,
        },
      }),
      new Surface({
        id: 'oap',
        type: 'STANDARD',
        radius: -304.26,
        conic: -1.0087,
        thickness: -178.59,
        // No stated extent, exactly as the sample file has it: the aperture is
        // the only thing that says how big this mirror is.
        aperture: { kind: 'CIRCULAR', maxRadius: 55, decenterY: -100 },
        reflective: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });

  const profile = buildLayout(system, [], DEFAULT_SEMI_DIAMETER).profiles.find(
    (one) => one.surfaceIndex === 2,
  );
  assert.ok(profile);
  const heights = profile.points.map((point) => point.v);
  const low = Math.min(...heights);
  const high = Math.max(...heights);

  // The frame is 100 up and the aperture 100 back down, so the piece drawn
  // straddles the global axis — which is the whole point of the idiom.
  assert.ok(Math.abs(low + 55) < 1e-6, `bottom of the drawn piece is ${low}`);
  assert.ok(Math.abs(high - 55) < 1e-6, `top of the drawn piece is ${high}`);
  // And no hole: this aperture has no inner radius, decentered or not.
  assert.equal(profile.hole, undefined);
});

test('an obscuration smaller than its surface is drawn, not left invisible', () => {
  // Seven of the twenty-two obscurations in the sample corpus are smaller than
  // the surface they sit on — both Newtonians' diagonals among them — and every
  // one of those was drawn nowhere at all: the trace stopped the rays and the
  // picture showed nothing stopping them.
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'baffled',
        type: 'STANDARD',
        thickness: 40,
        semiDiameter: 20,
        aperture: { kind: 'CIRCULAR_OBSCURATION', maxRadius: 5 },
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 20 }),
    ],
  });

  const profile = buildLayout(system, [], DEFAULT_SEMI_DIAMETER).profiles.find(
    (one) => one.surfaceIndex === 1,
  );
  assert.equal(profile?.obscured?.length, 1, 'expected one obscured run');
  const heights = profile.points.map((point) => point.v);
  // This plane does nothing but obscure, so what is drawn *is* the obscuration:
  // every sample is inside it, and the 20 rim — a number nobody can see — is not
  // drawn at all. Inclusive at the edge, because the trace is: a ray arriving
  // exactly there meets it.
  const run = profile.obscured[0]!;
  assert.equal(run.from, 0);
  assert.equal(run.to, profile.points.length - 1);
  for (const height of heights) {
    assert.ok(Math.abs(height) <= 5, `sample at ${height} is outside the obscuration`);
  }

  // A clear aperture leaves a hole instead, and never an obscured run.
  const holed = system.withSurfaceAt(
    1,
    system.surfaceAt(1).with({ aperture: { kind: 'CIRCULAR', minRadius: 5, maxRadius: 20 } }),
  );
  const other = buildLayout(holed, [], DEFAULT_SEMI_DIAMETER).profiles.find(
    (one) => one.surfaceIndex === 1,
  );
  assert.ok(other?.hole);
  assert.equal(other.obscured, undefined);
});

test('a section through a decentered piece is cut through the piece, not the parent axis', () => {
  // Reported from the X–Z view of Zemax's Unobscured Gregorian: the rays visibly
  // missed the primary. The section was being cut at zero on the *other*
  // transverse axis — through the parent parabola's own axis — while the mirror
  // is a 55 mm circle taken 100 mm off it. The drawing was a slice of a surface
  // the light never touches, near the parent's vertex, while the rays met the
  // real piece far down the paraboloid.
  const parent = { radius: -304.2598, conic: -1.0087 };
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'ct',
        type: 'COORDINATE_TRANSFORM',
        thickness: 0,
        coordinateTransform: {
          decenterX: 0,
          decenterY: 100,
          tiltXDeg: 0,
          tiltYDeg: 0,
          tiltZDeg: 0,
          tiltFirst: false,
        },
      }),
      new Surface({
        id: 'oap',
        type: 'STANDARD',
        radius: parent.radius,
        conic: parent.conic,
        thickness: -178.59,
        aperture: { kind: 'CIRCULAR', maxRadius: 55, decenterY: -100 },
        reflective: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 10 }),
    ],
  });

  const sagittal = buildLayout(system, [], DEFAULT_SEMI_DIAMETER, VIEW_PLANES.XZ).profiles.find(
    (one) => one.surfaceIndex === 2,
  );
  assert.ok(sagittal);

  // The middle of the drawn section is the middle of the piece, which is 100 off
  // the parent's axis — so its depth is the parent's sag at 100, not at 0.
  const middle = sagittal.points[Math.floor(sagittal.points.length / 2)]!;
  const sagAt100 = sagFromConic(parent.radius, parent.conic, 100);
  assert.ok(
    Math.abs(middle.h - sagAt100) < 0.5,
    `section middle sits at ${middle.h}, expected the parent's sag at 100 (${sagAt100})`,
  );
  // And the ends are at the piece's rim in x, 55 either side of its center.
  const across = sagittal.points.map((point) => point.v);
  assert.ok(Math.abs(Math.min(...across) + 55) < 1e-6);
  assert.ok(Math.abs(Math.max(...across) - 55) < 1e-6);
});

test('a spider is drawn where its arms cross the section, which is more than once', () => {
  // Three vanes at 0°, 120° and 240°: the meridional plane crosses two of them,
  // so a single span could not describe it. The runs come from `blocksAt` — the
  // same function the tracer asks — so the picture cannot show an obscuration
  // the trace does not have, or miss one it does.
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'vaned',
        type: 'STANDARD',
        thickness: 40,
        semiDiameter: 20,
        aperture: { kind: 'SPIDER', armCount: 3, armWidth: 4 },
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 20 }),
    ],
  });

  const profile = buildLayout(system, [], DEFAULT_SEMI_DIAMETER).profiles.find(
    (one) => one.surfaceIndex === 1,
  );
  assert.ok(profile?.obscured);
  // Every drawn sample is one the surface really stops light at, and every
  // undrawn one is not.
  const surface = system.surfaceAt(1);
  const drawn = new Set<number>();
  for (const run of profile.obscured) {
    for (let i = run.from; i <= run.to; i += 1) {
      drawn.add(i);
    }
  }
  for (const [index, point] of profile.points.entries()) {
    assert.equal(
      drawn.has(index),
      surface.blocksAt(0, point.v),
      `sample ${index} at y=${point.v} disagrees with the trace`,
    );
  }
});

/** The conic sag, written out so the test does not ask the code under test. */
function sagFromConic(radius: number, conic: number, r: number): number {
  const c = 1 / radius;
  return (c * r * r) / (1 + Math.sqrt(1 - (1 + conic) * c * c * r * r));
}

test('an aperture with no outer limit does not decide how large to draw the surface', () => {
  // `Schmidt-Cassegrain spider obscuration.zmx` carries `CLAP 4 1e+10` on a
  // surface drawn at 12.18: that is how a file says "an annulus with no outer
  // limit". Taking the aperture's word for the extent drew the surface ten
  // billion units tall and squeezed the whole telescope into a vertical line.
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'unbounded',
        type: 'STANDARD',
        thickness: 40,
        semiDiameter: 12.18,
        aperture: { kind: 'CIRCULAR', minRadius: 4, maxRadius: 1e10 },
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const geometry = buildLayout(system, [], DEFAULT_SEMI_DIAMETER);
  assert.ok(geometry.bounds.maxV < 13, `drawn to ${geometry.bounds.maxV}, expected the 12.18 rim`);
  // The inner radius still applies: it is a real hole, and only the outer bound
  // was a stand-in for "no limit".
  assert.ok(geometry.profiles.find((one) => one.surfaceIndex === 1)?.hole);

  // Where the semi-diameter states nothing, the aperture is still all there is —
  // which is the off-axis case the rule was built for.
  const unstated = system.withSurfaceAt(
    1,
    system
      .surfaceAt(1)
      .with({ semiDiameter: Infinity, aperture: { kind: 'CIRCULAR', maxRadius: 55 } }),
  );
  assert.ok(Math.abs(buildLayout(unstated, [], DEFAULT_SEMI_DIAMETER).bounds.maxV - 55) < 1e-9);
});

test('a surface that only obscures has no outline, and does not stretch the picture', () => {
  // The 2-D half of the same rule the 3-D view follows: the Newtonian's diagonal
  // sits on a dummy plane whose computed semi-diameter is larger than any of the
  // optics, so drawing its rim both invents a pane and sets the scale for
  // everything else.
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'shadow',
        type: 'STANDARD',
        thickness: 30,
        semiDiameter: 78,
        aperture: { kind: 'CIRCULAR_OBSCURATION', maxRadius: 42.5 },
      }),
      new Surface({
        id: 'mirror',
        type: 'STANDARD',
        radius: -200,
        thickness: -60,
        semiDiameter: 50,
        reflective: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });

  const geometry = buildLayout(system, [], DEFAULT_SEMI_DIAMETER);
  const dummy = geometry.profiles.find((one) => one.surfaceIndex === 1);
  assert.equal(dummy?.obscuringOnly, true);
  assert.ok(dummy?.obscured?.length, 'what it does is still drawn');
  // And the 78 rim no longer sets the scale: the drawing reaches the 50 mirror
  // and the 42.5 shadow, not a plane nobody can see.
  assert.ok(geometry.bounds.maxV <= 50.001, `drawing reaches ${geometry.bounds.maxV}`);

  // A surface that is a face of some glass keeps its outline, obscuration or
  // not: there really is a rim there.
  const lens = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'front',
        type: 'STANDARD',
        radius: 100,
        thickness: 6,
        semiDiameter: 20,
        aperture: { kind: 'CIRCULAR_OBSCURATION', maxRadius: 4 },
        material: N_BK7,
      }),
      new Surface({ id: 'back', type: 'STANDARD', radius: -100, thickness: 90, semiDiameter: 20 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 5 }),
    ],
  });
  const face = buildLayout(lens, [], DEFAULT_SEMI_DIAMETER).profiles.find(
    (one) => one.surfaceIndex === 1,
  );
  assert.notEqual(face?.obscuringOnly, true, 'a face of glass has a rim of its own');
  assert.ok(face?.obscured?.length, 'and the spot on it is still drawn');
});
