import assert from 'node:assert/strict';
import test from 'node:test';
import { OpticalSystem, Surface, type CoordinateTransform } from '@isaac/optical-core';
import { buildLayout } from '../src/lib/layout.ts';
import { setSurfaceType, updateCoordinateTransform } from '../src/lib/edits.ts';

function look(changes: Partial<CoordinateTransform>): CoordinateTransform {
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

/** A fold: dummy, mirror, transform, mirror, transform, image — the Newtonian shape. */
function folded(): OpticalSystem {
  return new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 'd', type: 'STANDARD', thickness: 800, semiDiameter: 60 }),
      new Surface({
        id: 'primary',
        type: 'STANDARD',
        radius: -1600,
        thickness: -700,
        semiDiameter: 60,
        reflective: true,
      }),
      new Surface({
        id: 'ct1',
        type: 'COORDINATE_TRANSFORM',
        thickness: 0,
        coordinateTransform: look({ tiltXDeg: -45 }),
      }),
      new Surface({
        id: 'diag',
        type: 'STANDARD',
        thickness: 0,
        semiDiameter: 40,
        reflective: true,
      }),
      new Surface({
        id: 'ct2',
        type: 'COORDINATE_TRANSFORM',
        thickness: 100,
        coordinateTransform: look({ tiltXDeg: -45 }),
      }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0, semiDiameter: 60 }),
    ],
  });
}

test('the layout draws no profile for a coordinate transform', () => {
  const geometry = buildLayout(folded(), [], 10);
  const drawn = geometry.profiles.map((profile) => profile.surfaceIndex);
  // A transform has no shape and no aperture. Drawing one would put a full-height
  // plane across the fold, which is the one place it would be most misleading.
  assert.deepEqual(drawn, [1, 2, 4, 6]);
});

test('a tilted surface is drawn tilted, in the meridional plane', () => {
  const geometry = buildLayout(folded(), [], 10);
  const diagonal = geometry.profiles.find((profile) => profile.surfaceIndex === 4)!;

  // The diagonal is a flat mirror at 45°, so its profile is a straight line at
  // 45° in the y–z plane rather than a vertical one. Tilts about x keep the
  // fold in exactly the plane the 2-D view draws, which is why it can show it.
  const first = diagonal.points[0]!;
  const last = diagonal.points[diagonal.points.length - 1]!;
  const run = last.z - first.z;
  const rise = last.y - first.y;
  assert.ok(Math.abs(Math.abs(run / rise) - 1) < 1e-9, `slope ${run / rise}, expected ±1`);

  // The image plane has left the axis entirely.
  const image = geometry.profiles.find((profile) => profile.surfaceIndex === 6)!;
  const centre = image.points[Math.floor(image.points.length / 2)]!;
  assert.ok(centre.y > 90, `image drawn at y ${centre.y}, expected out near 100`);
});

test('making a surface a coordinate transform drops what it cannot carry', () => {
  const system = new OpticalSystem({
    surfaces: [
      new Surface({ id: 'obj', type: 'OBJECT', thickness: Infinity }),
      new Surface({ id: 'a', type: 'STANDARD', radius: 50, thickness: 5, semiDiameter: 10 }),
      new Surface({ id: 'b', type: 'STANDARD', radius: -50, thickness: 20, semiDiameter: 10 }),
      new Surface({ id: 'img', type: 'IMAGE', thickness: 0 }),
    ],
  });

  const converted = setSurfaceType(system, 2, 'COORDINATE_TRANSFORM');
  assert.ok(converted.ok, converted.ok ? '' : converted.error);
  const surface = converted.value.surfaceAt(2);
  assert.equal(surface.type, 'COORDINATE_TRANSFORM');
  // The shape and aperture are gone — the model refuses them — and the transform
  // starts flat, to be aimed afterwards.
  assert.equal(surface.radius, Infinity);
  assert.equal(surface.semiDiameter, Infinity);
  assert.deepEqual(surface.coordinateTransform, look({}));
  // Its thickness and its place in the list survive.
  assert.equal(surface.thickness, 20);

  const tilted = updateCoordinateTransform(converted.value, 2, { tiltXDeg: 30 });
  assert.ok(tilted.ok, tilted.ok ? '' : tilted.error);
  assert.equal(tilted.value.surfaceAt(2).coordinateTransform?.tiltXDeg, 30);
  assert.equal(tilted.value.isCentered, false);
});
