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
 * Glass n = 1.5, centre thickness 5. Lensmaker's equation gives an effective
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

function planoConvexSinglet(semiDiameter = 25): OpticalSystem {
  return new OpticalSystem({
    name: 'Plano-convex singlet',
    units: 'mm',
    wavelengthsNm: [587.5618],
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity, material: AIR }),
      new Surface({ id: 's1', type: 'STANDARD', radius: 50, thickness: 5, semiDiameter, material: GLASS }),
      new Surface({ id: 's2', type: 'STANDARD', radius: Infinity, thickness: 100, semiDiameter, material: AIR }),
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
  const b = axisCrossingZ(nearer.intersections[1]!.point, nearer.intersections[1]!.outgoingDirection);
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
