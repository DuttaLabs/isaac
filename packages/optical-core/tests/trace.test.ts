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
