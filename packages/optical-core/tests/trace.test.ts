import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR,
  ConstantMaterial,
  OpticalSystem,
  Point3,
  Ray,
  generateChiefRay,
  normalizeAperture,
  surfaceProfileSag,
  Surface,
  type SurfaceApertureConfig,
  Vector3,
  traceRay,
} from '../src/index.ts';

/**
 * A plano-convex singlet: curved surface (R = 50) facing the object, flat back.
 * Glass n = 1.5, center thickness 5. Lensmaker's equation gives an effective
 * focal length f = R / (n − 1) = 100. For a thick lens the back focal distance
 * from the rear (flat) vertex is
 *
 *   BFD = f · (1 − (n − 1) · d / (n · R1)) = 100 · (1 − 0.5·5 / (1.5·50)) = 96.6667.
 *
 * The rear vertex sits at z = 5, so paraxial rays should cross the axis at
 * z ≈ 101.6667.
 */
const GLASS = new ConstantMaterial('DEMO-GLASS', 1.5);
const EXPECTED_FOCUS_Z = 5 + 100 * (1 - (0.5 * 5) / (1.5 * 50));

/**
 * A singlet whose faces are clipped at their semi-diameter — which now has to be
 * *said*, with the floating aperture that means exactly that, rather than being
 * implied by the semi-diameter itself. `FLAP` is the commonest record in the
 * sample corpus for the same reason.
 */
function planoConvexSinglet(semiDiameter = 25): OpticalSystem {
  const clipped = { kind: 'FLOATING' } as const;
  return new OpticalSystem({
    name: 'Plano-convex singlet',
    units: 'mm',
    wavelengthsNm: [587.5618],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 5,
        semiDiameter,
        aperture: clipped,
        material: GLASS,
      }),
      new Surface({
        id: 's2',
        type: 'STANDARD',
        radius: Infinity,
        thickness: 100,
        semiDiameter,
        aperture: clipped,
        material: AIR,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });
}

/** A collimated ray entering at (x, y) — the off-axis corner an aperture shape turns on. */
function collimatedRayAt(x: number, y: number): Ray {
  return new Ray(new Point3(x, y, -10), new Vector3(0, 0, 1), { wavelengthNm: 587.5618 });
}

/** Where the outgoing segment from a given intersection crosses the optical axis. */
function axisCrossingZ(point: Point3, direction: Vector3): number {
  const s = -point.y / direction.y;
  return point.z + direction.z * s;
}

function collimatedRay(height: number): Ray {
  return new Ray(new Point3(0, height, -10), new Vector3(0, 0, 1), { wavelengthNm: 587.5618 });
}

test('an on-axis ray passes straight through the singlet to the image plane', () => {
  const result = traceRay(planoConvexSinglet(), collimatedRay(0));

  assert.equal(result.status, 'TERMINATED');
  assert.equal(result.intersections.length, 3); // S1, S2, IMAGE
  assert.ok(result.finalRay.direction.equals(new Vector3(0, 0, 1), 1e-12));
  assert.ok(result.finalRay.origin.equals(new Point3(0, 0, 105), 1e-9));

  // Indices recorded across each interface: air → glass → air.
  const [s1, s2] = result.intersections;
  assert.equal(s1!.indexBefore, 1);
  assert.equal(s1!.indexAfter, 1.5);
  assert.equal(s2!.indexBefore, 1.5);
  assert.equal(s2!.indexAfter, 1);
});

test('a collimated ray focuses at the paraxial back focal distance', () => {
  const result = traceRay(planoConvexSinglet(), collimatedRay(0.1));
  assert.equal(result.status, 'TERMINATED');

  const rearExit = result.intersections[1]!; // exit from the flat rear surface
  const crossing = axisCrossingZ(rearExit.point, rearExit.outgoingDirection);
  assert.ok(
    Math.abs(crossing - EXPECTED_FOCUS_Z) < 0.05,
    `focus at z=${crossing.toFixed(4)}, expected ≈ ${EXPECTED_FOCUS_Z.toFixed(4)}`,
  );
});

test('rays at two paraxial heights focus at the same axial point', () => {
  const near = traceRay(planoConvexSinglet(), collimatedRay(0.1));
  const nearer = traceRay(planoConvexSinglet(), collimatedRay(0.2));

  const a = axisCrossingZ(near.intersections[1]!.point, near.intersections[1]!.outgoingDirection);
  const b = axisCrossingZ(
    nearer.intersections[1]!.point,
    nearer.intersections[1]!.outgoingDirection,
  );
  assert.ok(Math.abs(a - b) < 1e-3, `focus drift ${Math.abs(a - b)} too large`);
});

test('optical path length accumulates geometric length times index', () => {
  const result = traceRay(planoConvexSinglet(), collimatedRay(0));
  // On axis: 10 mm in air to S1, 5 mm of glass (×1.5), 100 mm of air to the image.
  const expectedOpl = 10 * 1 + 5 * 1.5 + 100 * 1;
  assert.ok(Math.abs(result.finalRay.opticalPathLength - expectedOpl) < 1e-9);
});

test('a ray outside the clear aperture is blocked', () => {
  const result = traceRay(planoConvexSinglet(5), collimatedRay(10));
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.terminatedAtSurface, 1);
});

test('a semi-diameter alone stops nothing: it says how large to draw the glass', () => {
  // The rule Isaac used to have backwards, and the reason a Hubble imported with
  // ten of its eleven fan rays "blocked" at a surface that vignettes nothing.
  // Drawn extent and clear aperture are two facts, and a file states them
  // separately.
  const drawnOnly = new OpticalSystem({
    name: 'Unapertured singlet',
    units: 'mm',
    wavelengthsNm: [587.5618],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 5,
        semiDiameter: 5,
        material: GLASS,
      }),
      new Surface({ id: 's2', type: 'STANDARD', thickness: 100, semiDiameter: 5, material: AIR }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, material: AIR }),
    ],
  });
  assert.equal(traceRay(drawnOnly, collimatedRay(10)).status, 'TERMINATED');
});

test('an obscuration stops the middle of the beam and passes the rest', () => {
  // The Hubble's baffle: a disc in the way, which is the opposite of a hole.
  const withBaffle = planoConvexSinglet(25).withSurfaceAt(
    1,
    planoConvexSinglet(25)
      .surfaceAt(1)
      .with({ aperture: { kind: 'CIRCULAR_OBSCURATION', maxRadius: 6 } }),
  );
  assert.equal(traceRay(withBaffle, collimatedRay(3)).status, 'BLOCKED');
  assert.equal(traceRay(withBaffle, collimatedRay(10)).status, 'TERMINATED');
});

test('an annular aperture passes the ring between its two radii', () => {
  const annulus = planoConvexSinglet(25).withSurfaceAt(
    1,
    planoConvexSinglet(25)
      .surfaceAt(1)
      .with({ aperture: { kind: 'CIRCULAR', minRadius: 4, maxRadius: 12 } }),
  );
  assert.equal(traceRay(annulus, collimatedRay(2)).status, 'BLOCKED');
  assert.equal(traceRay(annulus, collimatedRay(8)).status, 'TERMINATED');
  assert.equal(traceRay(annulus, collimatedRay(20)).status, 'BLOCKED');
});

test('an aperture decenter moves the hole, not the surface', () => {
  const offset = planoConvexSinglet(25).withSurfaceAt(
    1,
    planoConvexSinglet(25)
      .surfaceAt(1)
      .with({ aperture: { kind: 'CIRCULAR', maxRadius: 3, decenterY: 10 } }),
  );
  assert.equal(traceRay(offset, collimatedRay(10)).status, 'TERMINATED');
  assert.equal(traceRay(offset, collimatedRay(0)).status, 'BLOCKED');
});

test('OpticalSystem validates its surface list and axial geometry', () => {
  const system = planoConvexSinglet();
  assert.equal(system.vertexZAt(1), 0);
  assert.equal(system.vertexZAt(2), 5);
  assert.equal(system.vertexZAt(3), 105);
  assert.equal(system.objectSurface.type, 'OBJECT');
  assert.equal(system.imageSurface.type, 'IMAGE');

  assert.throws(
    () =>
      new OpticalSystem({
        surfaces: [new Surface({ id: 'a', type: 'STANDARD', thickness: 1 })],
      }),
    /at least/,
  );
});

test('a rectangular aperture passes a rectangle and an ellipse an ellipse', () => {
  const singlet = planoConvexSinglet(25);
  const withAperture = (aperture: SurfaceApertureConfig): OpticalSystem =>
    singlet.withSurfaceAt(1, singlet.surfaceAt(1).with({ aperture }));

  // 6 across, 12 up: a slit. The corner is what tells the two shapes apart —
  // (5, 10) is inside the rectangle and outside the ellipse that fits in the
  // same box, which is the whole of the difference between SQAP and ELAP.
  const slit = withAperture({ kind: 'RECTANGULAR', halfWidthX: 6, halfWidthY: 12 });
  assert.equal(traceRay(slit, collimatedRay(11)).status, 'TERMINATED');
  assert.equal(traceRay(slit, collimatedRay(13)).status, 'BLOCKED');
  assert.equal(traceRay(slit, collimatedRayAt(5, 10)).status, 'TERMINATED');

  const oval = withAperture({ kind: 'ELLIPTICAL', halfWidthX: 6, halfWidthY: 12 });
  assert.equal(traceRay(oval, collimatedRay(11)).status, 'TERMINATED');
  assert.equal(traceRay(oval, collimatedRayAt(5, 10)).status, 'BLOCKED');

  // And the obscurations are each the same boundary, read the other way round.
  const bar = withAperture({ kind: 'RECTANGULAR_OBSCURATION', halfWidthX: 6, halfWidthY: 12 });
  assert.equal(traceRay(bar, collimatedRay(11)).status, 'BLOCKED');
  assert.equal(traceRay(bar, collimatedRay(13)).status, 'TERMINATED');

  const blob = withAperture({ kind: 'ELLIPTICAL_OBSCURATION', halfWidthX: 6, halfWidthY: 12 });
  assert.equal(traceRay(blob, collimatedRayAt(5, 10)).status, 'TERMINATED');
  assert.equal(traceRay(blob, collimatedRay(11)).status, 'BLOCKED');
});

test('a radius and a half-width are different quantities, and cannot be mixed', () => {
  // The same rule that stops a PARAXIAL surface carrying a radius: two
  // contradictory statements of one size, silently keeping whichever the code
  // happens to read, is how a file comes back as a different lens.
  assert.throws(
    () => normalizeAperture({ kind: 'RECTANGULAR', halfWidthX: 5, halfWidthY: 5, maxRadius: 9 }),
    /bounded by half-widths, not by radii/,
  );
  assert.throws(
    () => normalizeAperture({ kind: 'CIRCULAR', maxRadius: 9, halfWidthX: 5 }),
    /bounded by radii, not by half-widths/,
  );
  // But a normalized aperture is handed back to the same function every time a
  // Surface is copied, and it carries zeros for the family it is not in.
  const rectangle = normalizeAperture({ kind: 'ELLIPTICAL', halfWidthX: 3, halfWidthY: 4 })!;
  assert.deepEqual(normalizeAperture(rectangle), rectangle);
});

test('a remote stop is traced through: the prescription may step backwards', () => {
  // The telecentric idiom, and the reason it exists: putting the aperture stop
  // far downstream makes the chief ray parallel to the axis in object space. The
  // file writes it as a step out to the stop and a negative step back to where
  // the glass is — which means every ray reaches the surface after the stop by a
  // *negative* distance. A microscopy design from a Nature Protocols paper opens
  // exactly this way, and refusing the backward step reported all 34 of its
  // surfaces as MISSED.
  const remoteStop = new OpticalSystem({
    name: 'Remote stop',
    wavelengthsNm: [587.5618],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 10 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 'out', type: 'STANDARD', thickness: 1200 }),
      new Surface({ id: 'stop', type: 'STANDARD', thickness: -1200, isStop: true }),
      new Surface({
        id: 'lens',
        type: 'STANDARD',
        radius: 100,
        thickness: 6,
        semiDiameter: 25,
        material: GLASS,
      }),
      new Surface({ id: 'back', type: 'STANDARD', thickness: 190, semiDiameter: 25 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });

  const result = traceRay(remoteStop, collimatedRay(4));
  assert.equal(result.status, 'TERMINATED');
  // The step home is genuinely backwards: the lens sits 1200 before the stop.
  assert.equal(remoteStop.vertexZAt(2), 1200);
  assert.equal(remoteStop.vertexZAt(3), 0);
  const atLens = result.intersections.find((one) => one.surfaceIndex === 3);
  assert.ok(atLens, 'the ray reaches the lens after stepping back');
});

test('a surface the prescription puts ahead is still missed when the ray cannot reach it', () => {
  // The other half of the rule, and what keeps a focus search honest: an image
  // plane buried inside the last surface is nominally *ahead*, so a ray that can
  // only meet it behind itself has not met it. Reporting a hit there hands the
  // search a fake perfect score — one ray on axis, scoring zero.
  const buried = planoConvexSinglet(25);
  const collapsed = buried.withSurfaceAt(2, buried.surfaceAt(2).with({ thickness: 0 }));

  // The rim of the curved front surface is downstream of the flat rear one's
  // vertex, so a marginal ray exits past the image plane.
  assert.equal(traceRay(collapsed, collimatedRay(24)).status, 'MISSED');
});

test('a tilted surface is a plane at an angle, and refracts like one', () => {
  // Zemax's TILTSURF: `z = x·tx + y·ty`, the two tangents being the whole shape.
  // A 3° wedge is `tan 3° = 0.0524`, which is exactly what the sample prism
  // writes.
  const wedge = Math.tan((3 * Math.PI) / 180);
  const prism = new OpticalSystem({
    name: 'Wedge',
    wavelengthsNm: [587.5618],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({
        id: 'front',
        type: 'STANDARD',
        thickness: 10,
        semiDiameter: 12,
        material: GLASS,
      }),
      new Surface({
        id: 'back',
        type: 'TILTED',
        tiltTangents: { x: 0, y: wedge },
        thickness: 50,
        semiDiameter: 12,
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });

  // The axial ray meets the tilted face at the vertex, where the plane passes
  // through the origin, and is deviated because the face is not square to it.
  const axial = traceRay(prism, collimatedRay(0));
  assert.equal(axial.status, 'TERMINATED');
  const atFace = axial.intersections.find((one) => one.surfaceIndex === 2)!;
  assert.ok(
    Math.abs(atFace.point.z - 10) < 1e-9,
    'the vertex of a tilted plane is still its vertex',
  );
  // Deviated by the wedge: n·tan for a thin wedge, so roughly (n − 1)·3°.
  const deviation = Math.atan2(axial.finalRay.direction.y, axial.finalRay.direction.z);
  const expected = ((GLASS.indexAt(587.5618) - 1) * (3 * Math.PI)) / 180;
  assert.ok(
    Math.abs(Math.abs(deviation) - expected) < 0.002,
    `deviated ${deviation} rad, expected about ${expected}`,
  );

  // Off the axis the face has moved along z, by the tangent times the height:
  // that is what makes it tilted rather than merely a plane.
  const high = traceRay(prism, collimatedRay(6));
  const atHigh = high.intersections.find((one) => one.surfaceIndex === 2)!;
  assert.ok(
    Math.abs(atHigh.point.z - (10 + 6 * wedge)) < 1e-9,
    `met the face at z=${atHigh.point.z}`,
  );
});

test('a tilted surface has no shape but its tangents', () => {
  const make = (changes: object) => () =>
    new Surface({
      id: 't',
      type: 'TILTED',
      thickness: 5,
      tiltTangents: { x: 0, y: 0.1 },
      ...changes,
    });
  assert.throws(make({ radius: 100 }), /cannot have a radius/);
  assert.throws(make({ conic: -1 }), /cannot have a conic/);
  assert.throws(
    () => new Surface({ id: 't', type: 'TILTED', thickness: 5 }),
    /requires its two tangents/,
  );
  assert.throws(
    () => new Surface({ id: 's', type: 'STANDARD', thickness: 5, tiltTangents: { x: 0, y: 1 } }),
    /only meaningful on a TILTED surface/,
  );
});

/**
 * **A curved image surface is met where it is, not at a plane through its
 * vertex.** The obvious case is a retina — every schematic eye has one — and a
 * curved detector and a field flattener's last face are others. It matters for
 * the spot diagram before anything else: a ray landing 0.006 mm short of the
 * vertex plane arrives at a different height there, and on a fast eye model that
 * is most of the blur.
 *
 * Nothing had to be added for this — `intersectSurface` does not care which type
 * a surface is — but nothing tested it either, and the lens grid refused to let
 * anyone type the radius until now, so it was reachable only through a file or
 * the help assistant.
 */
test('rays meet a curved image surface on the curve, not at its vertex', () => {
  const radius = -20;
  const system = new OpticalSystem({
    name: 'curved detector',
    wavelengthsNm: [587.5618],
    fields: [{ angleDeg: 0 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 20 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 's1',
        type: 'STANDARD',
        radius: 50,
        thickness: 40,
        semiDiameter: 15,
        material: AIR,
        isStop: true,
      }),
      new Surface({ id: 'img', type: 'IMAGE', radius, thickness: 0, semiDiameter: 15 }),
    ],
  });

  const vertexZ = system.axialPositionAt(2);
  for (const height of [0, 4, 8]) {
    const result = traceRay(
      system,
      new Ray(new Point3(0, height, -10), new Vector3(0, 0, 1), { wavelengthNm: 587.5618 }),
    );
    const landing = result.intersections[result.intersections.length - 1]!.point;
    // The sag of a sphere at the height the ray actually arrives at.
    const sag = surfaceProfileSag(system.imageSurface.shape, Math.hypot(landing.x, landing.y));
    assert.ok(
      Math.abs(landing.z - (vertexZ + sag)) < 1e-9,
      `ray at ${height} landed at z ${landing.z}, not on the surface at ${vertexZ + sag}`,
    );
    if (height > 0) {
      assert.ok(
        Math.abs(landing.z - vertexZ) > 1e-6,
        `ray at ${height} landed on the vertex plane, so the curvature was ignored`,
      );
    }
  }
});

/**
 * **A prescription may step backwards, and then the optical path length goes
 * down.** Zero is the launch plane, and for an object at infinity that plane is
 * one Isaac picked — "just in front of the first surface" — so there is nothing
 * physical about it to count up from. A **remote stop** is written as a negative
 * thickness, and the surface it puts behind the one before it is reached along a
 * negative distance.
 *
 * `Yu2024.zmx` found this: surface 1 has a thickness of −1, so an on-axis ray
 * landed on exactly 0.00000000 after that step and traced, while a ray at 1°
 * landed on −0.00001031 and threw. A well-formed lens, and every field but the
 * axis came back as an internal invariant rather than an optical outcome.
 */
test('a ray that steps backwards keeps tracing, and its path length may go negative', () => {
  // The launch plane sits one unit ahead of the *pupil*, so for the running total
  // to go under zero the backward step has to be longer than that — which is the
  // ordinary case, a remote stop being remote. Here the stop is the first surface,
  // putting the pupil on it, and the prescription then steps back five.
  const system = new OpticalSystem({
    name: 'remote stop',
    wavelengthsNm: [587.5618],
    fields: [{ angleDeg: 0 }, { angleDeg: 2 }],
    aperture: { type: 'ENTRANCE_PUPIL_DIAMETER', value: 6 },
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({
        id: 'stop',
        type: 'STANDARD',
        thickness: -5,
        semiDiameter: 20,
        material: AIR,
        isStop: true,
      }),
      new Surface({
        id: 'behind',
        type: 'STANDARD',
        thickness: 5,
        semiDiameter: 20,
        material: AIR,
      }),
      new Surface({
        id: 'lens',
        type: 'STANDARD',
        radius: 50,
        thickness: 96,
        semiDiameter: 20,
        material: new ConstantMaterial('DEMO-GLASS', 1.5),
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 20 }),
    ],
  });

  for (const angleDeg of [0, 2]) {
    const result = traceRay(system, generateChiefRay(system, { field: { angleDeg } }));
    assert.equal(result.status, 'TERMINATED', `the ${angleDeg}° chief ray did not reach the image`);
  }
  // And the model has to allow the value in the first place, which is the
  // invariant this rests on.
  assert.doesNotThrow(
    () =>
      new Ray(new Point3(0, 0, 0), new Vector3(0, 0, 1), {
        wavelengthNm: 587.5618,
        opticalPathLength: -4,
      }),
  );
});

test('an optical path length that is not a number is still refused', () => {
  assert.throws(
    () =>
      new Ray(new Point3(0, 0, 0), new Vector3(0, 0, 1), {
        wavelengthNm: 550,
        opticalPathLength: Number.NaN,
      }),
    /finite/,
  );
});
