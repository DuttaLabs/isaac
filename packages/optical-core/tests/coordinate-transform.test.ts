import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR,
  N_BK7,
  OpticalSystem,
  Point3,
  Ray,
  Surface,
  Transform3,
  Vector3,
  paraxialProperties,
  traceRay,
  type CoordinateTransform,
} from '../src/index.ts';

function look(changes: Partial<CoordinateTransform> = {}): CoordinateTransform {
  return {
    decenterX: 0,
    decenterY: 0,
    tiltXDeg: 0,
    tiltYDeg: 0,
    tiltZDeg: 0,
    tiltFirst: false,
    ...changes,
  };
}

function transformSurface(
  id: string,
  thickness: number,
  changes: Partial<CoordinateTransform>,
): Surface {
  return new Surface({
    id,
    type: 'COORDINATE_TRANSFORM',
    thickness,
    coordinateTransform: look(changes),
  });
}

test('a transform with nothing set changes nothing at all', () => {
  const identity = transformSurface('ct', 0, {}).frameChange;
  assert.ok(identity.isAxial);
  assert.ok(identity.apply(new Point3(1, 2, 3)).equals(new Point3(1, 2, 3)));
});

test('tilts are right-handed about the positive axes, in degrees', () => {
  // A 90° tilt about x carries +y onto +z: the right-handed sense.
  const tilted = transformSurface('ct', 0, { tiltXDeg: 90 }).frameChange;
  assert.ok(tilted.apply(new Point3(0, 1, 0)).equals(new Point3(0, 0, 1), 1e-12));

  // About y, +z onto +x.
  const aboutY = transformSurface('ct', 0, { tiltYDeg: 90 }).frameChange;
  assert.ok(aboutY.apply(new Point3(0, 0, 1)).equals(new Point3(1, 0, 0), 1e-12));

  // About z, +x onto +y.
  const aboutZ = transformSurface('ct', 0, { tiltZDeg: 90 }).frameChange;
  assert.ok(aboutZ.apply(new Point3(1, 0, 0)).equals(new Point3(0, 1, 0), 1e-12));
});

test('the order flag decides whether the decenter is tilted with the frame', () => {
  const parameters = { decenterY: 10, tiltXDeg: 90 };
  // Order 0: decenter first, along the *old* axes, then tilt. The origin lands
  // where the decenter put it.
  const decenterFirst = transformSurface('a', 0, parameters).frameChange;
  assert.ok(decenterFirst.origin.equals(new Point3(0, 10, 0), 1e-12));

  // Order 1: tilt first, then decenter along the *new* axes. The same 10 in y
  // now points along global z, because y has been rotated onto it.
  const tiltFirst = transformSurface('b', 0, { ...parameters, tiltFirst: true }).frameChange;
  assert.ok(tiltFirst.origin.equals(new Point3(0, 0, 10), 1e-12));
});

test('one transform undoes another by negating everything and flipping the order', () => {
  // The manual calls this out as the reason the order flag exists, and it is the
  // property that makes a tilted element possible: transform, element, undo.
  const parameters = { decenterX: 3, decenterY: -7, tiltXDeg: 12, tiltYDeg: -5, tiltZDeg: 30 };
  const applied = transformSurface('a', 0, parameters).frameChange;
  const undone = transformSurface('b', 0, {
    decenterX: -parameters.decenterX,
    decenterY: -parameters.decenterY,
    tiltXDeg: -parameters.tiltXDeg,
    tiltYDeg: -parameters.tiltYDeg,
    tiltZDeg: -parameters.tiltZDeg,
    tiltFirst: true,
  }).frameChange;

  const round = applied.compose(undone);
  const probe = new Point3(2, -4, 9);
  assert.ok(
    round.apply(probe).equals(probe, 1e-12),
    'a transform and its inverse leave the frame alone',
  );
});

/**
 * A Newtonian telescope, modelled on `Archive/sc_newtonian3.zmx` from the sample
 * corpus: a curved primary, then the diagonal folding the beam out to the side
 * through a pair of −45° transforms. This is the three-surface idiom the corpus is
 * full of, and it is worth taking from a real file rather than inventing —
 * getting the *signs* right is the whole difficulty.
 *
 * Note what the file does with thickness: −700 after the primary, because the
 * light is running backwards, and +100 after the diagonal, because a second
 * mirror turns it round again. That is the plain signed-thickness convention
 * mirrors already used, and coordinate transforms needed nothing added to it.
 */
function newtonian(): OpticalSystem {
  return new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 'dummy', type: 'STANDARD', thickness: 800, semiDiameter: 60 }),
      new Surface({
        id: 'primary',
        type: 'STANDARD',
        radius: -1600,
        thickness: -700,
        semiDiameter: 60,
        reflective: true,
      }),
      transformSurface('ct-in', 0, { tiltXDeg: -45 }),
      new Surface({
        id: 'diagonal',
        type: 'STANDARD',
        thickness: 0,
        semiDiameter: 40,
        reflective: true,
      }),
      transformSurface('ct-out', 100, { tiltXDeg: -45 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 60 }),
    ],
  });
}

test('a fold mirror turns the axis, and the surfaces after it follow', () => {
  const system = newtonian();
  assert.equal(system.isCentered, false);

  // Everything up to the transform is still on the axis: the primary sits 800 along
  // it, and the diagonal 700 back from there.
  assert.ok(system.poseAt(2).isAxial);
  assert.equal(system.vertexZAt(2), 800);
  assert.ok(system.poseAt(4).origin.equals(new Point3(0, 0, 100), 1e-9));

  // Two −45° tilts compose to −90°, so the image plane has left the z axis
  // entirely and sits out to the side — where a Newtonian's eyepiece is.
  assert.ok(system.poseAt(6).origin.equals(new Point3(0, 100, 100), 1e-9));
});

test('the axial coordinate is unfolded, so first-order data survives the fold', () => {
  const system = newtonian();
  // Along the axis: 800 out to the primary, 700 back, 100 out to the image. The
  // transforms contribute no distance, and the bend does not shorten the path.
  assert.equal(system.axialPositionAt(2), 800);
  assert.equal(system.axialPositionAt(4), 100);
  assert.equal(system.axialPositionAt(6), 200);

  // A transform has no power, so the folded telescope has the focal length of its
  // primary alone: half the radius, 800. Positive, because the flat diagonal is
  // still a mirror — it bends no rays but it is the *second* reflection, and
  // image space runs forward again after an even number of them.
  const properties = paraxialProperties(system);
  assert.ok(
    Math.abs(properties.effectiveFocalLength - 800) < 1e-9,
    `EFL ${properties.effectiveFocalLength}, expected 800`,
  );
});

test('a ray follows the fold, and the trace records no interaction at the transform', () => {
  const system = newtonian();
  const ray = new Ray(new Point3(0, 10, -10), new Vector3(0, 0, 1), { wavelengthNm: 587.5618 });
  const result = traceRay(system, ray);
  assert.equal(result.status, 'TERMINATED');

  // The transforms are dummies: they meet no ray, so they contribute no
  // intersections. Surfaces 3 and 5 are absent from the record entirely.
  assert.deepEqual(
    result.intersections.map((hit) => hit.surfaceIndex),
    [1, 2, 4, 6],
  );

  // The diagonal sends the beam out along +y, which is the point of a Newtonian.
  // Not *exactly* +y: the beam is converging toward focus, and that convergence
  // is the small residual left in z.
  const atDiagonal = result.intersections[2]!;
  assert.ok(
    atDiagonal.outgoingDirection.y > 0.999,
    `expected the fold to send the ray along +y, got ${atDiagonal.outgoingDirection.y}`,
  );
  assert.ok(
    Math.abs(atDiagonal.outgoingDirection.z) < 0.02,
    `the beam should have left z, got ${atDiagonal.outgoingDirection.z}`,
  );

  // And the image lands beside the tube, not beyond it: 100 out along +y from
  // the diagonal, which itself sits at z = 100.
  const atImage = result.intersections[3]!;
  assert.ok(Math.abs(atImage.point.z - 100) < 0.01, `image z ${atImage.point.z}`);
  assert.ok(Math.abs(atImage.point.y - 100) < 0.01, `image y ${atImage.point.y}`);
});

test('a decentered element is hit off-axis, and its aperture is its own', () => {
  // The clear aperture is radial about the surface's own axis. If it were
  // measured globally, decentering an element would vignette it by the decenter.
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      transformSurface('ct', 0, { decenterY: 5 }),
      new Surface({
        id: 's',
        type: 'STANDARD',
        radius: 50,
        thickness: 20,
        semiDiameter: 2,
        // Clipped at the semi-diameter, said out loud: that is what this test is
        // about, and a semi-diameter on its own no longer stops anything.
        aperture: { kind: 'FLOATING' },
        material: N_BK7,
      }),
      new Surface({ id: 's2', type: 'STANDARD', thickness: 20, semiDiameter: 10 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 30 }),
    ],
  });

  // A ray up the global axis is 5 below the decentered element's centre, so it
  // misses a 2 mm semi-diameter entirely.
  const onGlobalAxis = traceRay(
    system,
    new Ray(new Point3(0, 0, -10), new Vector3(0, 0, 1), { wavelengthNm: 587.5618 }),
  );
  assert.equal(onGlobalAxis.status, 'BLOCKED');

  // A ray up the *element's* axis passes cleanly.
  const onElementAxis = traceRay(
    system,
    new Ray(new Point3(0, 5, -10), new Vector3(0, 0, 1), { wavelengthNm: 587.5618 }),
  );
  assert.equal(onElementAxis.status, 'TERMINATED');
});

test('a coordinate transform refuses everything that would make it optical', () => {
  const parameters = look({ tiltXDeg: 5 });
  const make =
    (config: Record<string, unknown>): (() => Surface) =>
    () =>
      new Surface({
        id: 'ct',
        type: 'COORDINATE_TRANSFORM',
        thickness: 0,
        coordinateTransform: parameters,
        ...config,
      });

  assert.throws(make({ radius: 100 }), /no shape, so it cannot have a radius/);
  assert.throws(make({ conic: -1 }), /no shape, so it cannot have a conic/);
  assert.throws(make({ reflective: true }), /cannot be a mirror/);
  assert.throws(make({ semiDiameter: 10 }), /meets no ray, so it cannot have a clear aperture/);
  assert.throws(make({ isStop: true }), /can be the aperture stop/);
  assert.throws(
    () => new Surface({ id: 'ct', type: 'COORDINATE_TRANSFORM', thickness: 0 }),
    /requires its decenters and tilts/,
  );
  // And the parameters are refused anywhere they would mean nothing.
  assert.throws(
    () => new Surface({ id: 's', type: 'STANDARD', thickness: 0, coordinateTransform: parameters }),
    /only meaningful on a COORDINATE_TRANSFORM/,
  );
});

test('a coordinate transform cannot be a boundary between two media', () => {
  assert.throws(
    () =>
      new OpticalSystem({
        surfaces: [
          new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
          new Surface({ id: 's', type: 'STANDARD', radius: 50, thickness: 5, material: N_BK7 }),
          // Inside the glass, but claiming air after it.
          new Surface({
            id: 'ct',
            type: 'COORDINATE_TRANSFORM',
            thickness: 0,
            coordinateTransform: look({ tiltXDeg: 2 }),
            material: AIR,
          }),
          new Surface({ id: 's2', type: 'STANDARD', thickness: 20 }),
          new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
        ],
      }),
    /the medium after it must be the medium before it/,
  );
});

test('Transform3 inverts by transpose, and composes in surface order', () => {
  const rotation = Transform3.rotationX(0.3).compose(Transform3.rotationY(-0.7));
  const shifted = Transform3.axialShift(4).compose(rotation);
  const probe = new Point3(1, -2, 3);
  assert.ok(shifted.toLocal(shifted.apply(probe)).equals(probe, 1e-12));

  const direction = new Vector3(0.2, -0.5, 1).normalized();
  const there = shifted.applyDirection(direction);
  assert.ok(Math.abs(there.length - 1) < 1e-12, 'a rotation preserves length');
  assert.ok(shifted.toLocalDirection(there).equals(direction, 1e-12));

  assert.throws(() => new Transform3([1, 0, 0], Point3.origin()), /needs 9 elements/);
});

/**
 * LSST's baffles, which is the case {@link Transform3.roll} exists for.
 *
 * Surfaces 4-8 of `LSST_Baseline_Design_Spiders_Baffles.ZMX` are a +45° z tilt,
 * a baffle, then two -45° z tilts and a second baffle -- and the two baffles
 * carry the *identical* record, `SQOB 400 1600`. They are at right angles in the
 * telescope, and nothing in either aperture says so.
 */
function lsstBaffles(): OpticalSystem {
  const baffle = (id: string, thickness: number): Surface =>
    new Surface({
      id,
      type: 'STANDARD',
      thickness,
      semiDiameter: 1600,
      aperture: { kind: 'RECTANGULAR_OBSCURATION', halfWidthX: 400, halfWidthY: 1600 },
    });

  return new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      transformSurface('ct-a', 0, { tiltZDeg: 45 }),
      baffle('baffle-1', 0),
      transformSurface('ct-b', 0, { tiltZDeg: -45 }),
      transformSurface('ct-c', 0, { tiltZDeg: -45 }),
      baffle('baffle-2', 100),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });
}

const degrees = (radians: number): number => (radians * 180) / Math.PI;

test('a z tilt turns the frame about its own axis, and the turns add', () => {
  assert.ok(Math.abs(Transform3.identity().roll) < 1e-12);
  assert.ok(Math.abs(Transform3.rotationZ(Math.PI / 2).roll - Math.PI / 2) < 1e-12);

  // Two of them compose to a single turn of the sum, which is the whole of what
  // a *cumulative* roll means.
  const composed = Transform3.rotationZ(0.3).compose(Transform3.rotationZ(0.4));
  assert.ok(Math.abs(composed.roll - 0.7) < 1e-12);
});

test('a tilt out of the plane is not a roll', () => {
  // A tilt about x or y turns the surface *out of* its own plane. Seen face on,
  // which is how the aperture icon draws it, nothing has turned -- and the roll
  // says so rather than inventing an angle out of the foreshortening.
  assert.ok(Math.abs(Transform3.rotationX(Math.PI / 4).roll) < 1e-12);
  assert.ok(Math.abs(Transform3.rotationY(-0.7).roll) < 1e-12);

  // Including a real fold: the Newtonian's diagonal is tilted 45° about x, and
  // its aperture is no more turned on the mirror for that.
  assert.ok(Math.abs(newtonian().poseAt(4).roll) < 1e-12);
});

test('two identical aperture records can be at right angles, and the roll is what says so', () => {
  const system = lsstBaffles();

  // The records are indistinguishable, which is exactly the problem.
  assert.deepEqual(system.surfaces[2]!.aperture, system.surfaces[5]!.aperture);

  assert.ok(Math.abs(degrees(system.poseAt(2).roll) - 45) < 1e-9);
  assert.ok(Math.abs(degrees(system.poseAt(5).roll) + 45) < 1e-9);
  assert.ok(Math.abs(degrees(system.poseAt(2).roll - system.poseAt(5).roll) - 90) < 1e-9);
});

test('a roll survives being tilted out of the plane and back', () => {
  // Rolling, tilting away and tilting back leaves the roll where it was: the
  // swing is undone and the twist is what is left. A rule that summed the z
  // tilts alone would agree here; one that read the angle off the projected x
  // axis would not.
  const there = Transform3.rotationZ(0.5)
    .compose(Transform3.rotationX(0.9))
    .compose(Transform3.rotationX(-0.9));
  assert.ok(Math.abs(there.roll - 0.5) < 1e-12);
});
